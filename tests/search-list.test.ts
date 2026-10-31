import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { makeSource } from "../src/catalog.ts";
import { installedRows, installedTable, table } from "../src/display.ts";
import { shellInit } from "../src/shell.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-search-list-"));
const bytes = await readFile(join(process.env.SystemRoot!, "System32/cmd.exe"));
let requests = 0;
let offline = false;
let latest = "1.0.0";
const index = () => ({
  schemaVersion: 1,
  packages: {
    tool: {
      latest,
      versions: { "1.0.0": "tool-1.json", "2.0.0": "tool-2.json" },
    },
    alpha: { latest: "1.0.0", versions: { "1.0.0": "alpha.json" } },
  },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    requests++;
    if (offline) return new Response("offline", { status: 503 });
    const path = new URL(request.url).pathname;
    if (path === "/index.json") return Response.json(index());
    if (path === "/file") return new Response(bytes);
    const name = path.includes("alpha") ? "alpha" : "tool";
    const version = path.includes("-2") ? "2.0.0" : "1.0.0";
    return Response.json({
      schemaVersion: 1,
      name,
      version,
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          sha256: sha256(bytes),
          format: "file",
          file: "tool.exe",
          bin: { [name]: "tool.exe" },
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});
const exe = join(import.meta.dir, "../dist/piko.exe");
async function cli(root: string, args: string[], expected = 0) {
  const child = Bun.spawn([exe, ...args], {
    env: { ...process.env, PIKO_HOME: root },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(expected);
  if (expected === 0) expect(err).toBe("");
  return { out, err };
}

test("cached HTTP and Git search is offline, read-only and lock-free; explicit refresh is opt-in", async () => {
  const root = join(work, "offline"),
    p = new Packages(root);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const git = makeSource(
    "git-source",
    "https://example.invalid/source.git",
    "git",
    "main",
  );
  await p.store.mutate(async (s) => {
    s.sources[git.alias] = git;
  });
  await mkdir(join(root, "sources", git.identity), { recursive: true });
  await atomicJson(join(root, "sources", git.identity, "index.json"), index());
  const before = await readFile(p.store.statePath);
  const count = requests;
  offline = true;
  try {
    expect((await p.search("TOOL")).map((r) => r.source)).toEqual([
      "git-source",
      "main",
    ]);
    expect((await p.search("MAIN/ALPHA"))[0]?.name).toBe("alpha");
    expect(await p.search("absent")).toEqual([]);
    expect(await exists(join(root, "mutation.lock"))).toBe(false);
    expect(await shellInit(p.store, join(root, "profile.ps1"))).toContain(
      "No approved",
    );
    // A read-only search does not steal or remove a real writer's lock.
    await mkdir(join(root, "mutation.lock"));
    try {
      expect((await p.search("tool")).length).toBe(2);
      expect(await shellInit(p.store, join(root, "profile.ps1"))).toContain(
        "No approved",
      );
      expect(await exists(join(root, "mutation.lock"))).toBe(true);
    } finally {
      await rm(join(root, "mutation.lock"), { recursive: true });
    }
    expect(requests).toBe(count);
    expect(await readFile(p.store.statePath)).toEqual(before);
  } finally {
    offline = false;
  }
  await p.removeSource(git.alias);
  latest = "2.0.0";
  try {
    expect((await p.search("tool"))[0]?.latest).toBe("1.0.0");
    expect((await p.search("tool", { refresh: true }))[0]?.latest).toBe(
      "2.0.0",
    );
    expect(requests).toBeGreaterThan(count);
  } finally {
    latest = "1.0.0";
  }
});

test("missing or invalid indexes fail closed without an implicit network request", async () => {
  const root = join(work, "invalid"),
    p = new Packages(root);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const state = await p.store.read(),
    source = state.sources.main!;
  const path = join(root, "sources", source.identity, "index.json");
  const count = requests;
  await rm(path);
  await expect(p.search("tool")).rejects.toThrow("piko source refresh main");
  await atomicJson(path, {
    schemaVersion: 1,
    packages: { tool: { latest: "missing", versions: {} } },
  });
  await expect(p.search("tool")).rejects.toThrow("Invalid index entry");
  await writeFile(path, "broken json");
  await expect(p.search("tool")).rejects.toThrow();
  expect(requests).toBe(count);
  expect(await exists(join(root, "mutation.lock"))).toBe(false);
});

test("compiled search/list tables, filters and JSON retain exact data without state changes", async () => {
  const root = join(work, "cli"),
    p = new Packages(root);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  await p.install("main/tool@1.0.0");
  await p.install("main/tool@2.0.0");
  await p.install("main/alpha@1.0.0");
  await p.use("main/tool@2.0.0");
  const before = await readFile(p.store.statePath),
    count = requests;
  offline = true;
  try {
    const list = (await cli(root, ["list"])).out;
    expect(list).toContain("PACKAGE");
    expect(list).toContain("SELECTED");
    expect(list.indexOf("main/alpha")).toBeLessThan(list.indexOf("main/tool"));
    expect(list.indexOf("2.0.0")).toBeLessThan(
      list.indexOf("1.0.0", list.indexOf("main/tool")),
    );
    expect(list).not.toContain(join(root, "apps"));
    const rows = JSON.parse((await cli(root, ["list", "TOOL", "--json"])).out);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      package: "main/tool",
      version: "2.0.0",
      default: true,
      request: "2.0.0",
      verified: true,
    });
    expect(rows[0].path).toContain("2.0.0");
    expect(
      JSON.parse((await cli(root, ["list", "--selected", "--json"])).out)
        .length,
    ).toBe(1);
    expect((await cli(root, ["list", "tool", "--verbose"])).out).toContain(
      rows[0].path,
    );
    expect((await cli(root, ["list", "missing"])).out).toContain(
      "No installed packages match",
    );
    expect((await cli(root, ["search", "TOOL"])).out).toContain("LATEST");
    expect(
      JSON.parse((await cli(root, ["search", "TOOL", "--json"])).out),
    ).toEqual([{ source: "main", name: "tool", latest: "1.0.0" }]);
    expect((await cli(root, ["search", "missing"])).out).toContain(
      "No packages match",
    );
    expect((await cli(root, ["search", "tool", "extra"], 1)).err).toContain(
      "Use search",
    );
    expect(requests).toBe(count);
    expect(await readFile(p.store.statePath)).toEqual(before);
    expect(await exists(join(root, "mutation.lock"))).toBe(false);
    expect(
      installedRows(root, await p.store.read(), "MAIN/TOOL", true).length,
    ).toBe(1);
    expect(installedTable([])).toContain("No installed packages match");
  } finally {
    offline = false;
  }
  latest = "2.0.0";
  try {
    expect(
      JSON.parse(
        (await cli(root, ["search", "tool", "--refresh", "--json"])).out,
      )[0].latest,
    ).toBe("2.0.0");
  } finally {
    latest = "1.0.0";
  }
});

test("tables escape terminal controls while retaining readable Unicode", () => {
  expect(table(["NAME"], [["中文\x1b[2J\nnext\tline"]])).toBe(
    "NAME\n中文?[2J?next?line",
  );
});
