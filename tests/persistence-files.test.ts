import { persistentFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { normalizeManifest } from "../src/catalog.ts";
import { sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-file-persist-"));
const bytes = Buffer.from("fixture executable");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          ["linked", "redirected"].map((name) => [
            name,
            {
              latest: "2.0.0",
              versions: {
                "1.0.0": `${name}/1.0.0.json`,
                "2.0.0": `${name}/2.0.0.json`,
              },
            },
          ]),
        ),
      });
    if (path === "/file") return new Response(bytes);
    const name = path.split("/")[1]!,
      version = path.split("/")[2]!.replace(".json", "");
    return Response.json(manifest(name, version));
  },
});
function manifest(name = "linked", version = "1.0.0") {
  return {
    schemaVersion: 1,
    name,
    version,
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        format: "file",
        file: "tool.exe",
        sha256: sha256(bytes),
        bin: { tool: "tool.exe" },
        persist: [
          {
            path: "config.ini",
            kind: "file",
            mode: name === "linked" ? "hardlink" : "seed",
            initial: "first-run",
          },
          "history",
        ],
        ...(name === "redirected"
          ? {
              configTemplates: {
                "config.ini": {
                  text: "[General]\nconfig={{persist}}/config.ini\n",
                },
              },
            }
          : {}),
      },
    },
  };
}
async function manager() {
  const p = new Packages(join(work, crypto.randomUUID()));
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  return p;
}
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 100,
  });
});

test("single-file hardlinks preserve shared data across versions, uninstall and explicit cleanup", async () => {
  const p = await manager(),
    first = await p.install("main/linked@1.0.0"),
    shared = join(
      p.root,
      "persist",
      persistentFolder(first, first.key),
      "config.ini",
    );
  expect(await readFile(shared, "utf8")).toBe("first-run");
  await writeFile(join(p.root, first.dir, "config.ini"), "user settings");
  const second = await p.install("main/linked@2.0.0");
  expect(await readFile(join(p.root, second.dir, "config.ini"), "utf8")).toBe(
    "user settings",
  );
  expect((await stat(shared)).nlink).toBe(3);
  await p.uninstall("main/linked@1.0.0");
  expect((await stat(shared)).nlink).toBe(2);
  await p.uninstall("main/linked@2.0.0");
  expect((await stat(shared)).nlink).toBe(1);
  expect(await readFile(shared, "utf8")).toBe("user settings");
  expect(
    (await p.cleanupData("main/linked", { dryRun: true })).paths,
  ).toContain(shared);
  await p.cleanupData("main/linked", { confirmed: true });
  await expect(readFile(shared)).rejects.toThrow();
});

test("atomic replacement hardlink drift blocks upgrade and uninstall without losing either file", async () => {
  const p = await manager(),
    first = await p.install("main/linked@1.0.0"),
    shared = join(
      p.root,
      "persist",
      persistentFolder(first, first.key),
      "config.ini",
    ),
    path = join(p.root, first.dir, "config.ini");
  await p.use("main/linked@1.0.0");
  await writeFile(path + ".tmp", "replacement");
  await rename(path + ".tmp", path);
  await expect(p.install("main/linked@2.0.0")).rejects.toThrow(
    "hardlink drift",
  );
  await expect(p.uninstall("main/linked@1.0.0", true)).rejects.toThrow(
    "hardlink drift",
  );
  expect(await readFile(shared, "utf8")).toBe("first-run");
  expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await p.store.read()).defaults[first.key]?.id).toBe(first.id);
});

test("source config templates redirect to seeded storage without linking config files", async () => {
  const p = await manager(),
    first = await p.install("main/redirected@1.0.0"),
    shared = join(
      p.root,
      "persist",
      persistentFolder(first, first.key),
      "config.ini",
    );
  await writeFile(shared, "personal config");
  const second = await p.install("main/redirected@2.0.0");
  expect(
    await readFile(join(p.root, second.dir, "config.ini"), "utf8"),
  ).toContain(shared.replaceAll("\\", "/"));
  expect(await readFile(shared, "utf8")).toBe("personal config");
  expect((await stat(shared)).nlink).toBe(1);
  await p.uninstall("main/redirected@1.0.0");
  await p.uninstall("main/redirected@2.0.0");
  expect(await readFile(shared, "utf8")).toBe("personal config");
});

test("file persistence and template declarations reject ambiguous or unsafe input", () => {
  for (const persist of [
    null,
    [
      "config.ini",
      { path: "CONFIG.ini", kind: "file", mode: "seed", initial: "" },
    ],
    [{ path: "../escape", kind: "file", mode: "seed", initial: "" }],
    [{ path: "settings", kind: "directory", mode: "seed", initial: "" }],
    [{ path: "settings", kind: "file", mode: "guess", initial: "" }],
  ]) {
    const m = manifest();
    Object.assign(m.platforms["windows-x64"], { persist });
    expect(() => normalizeManifest(m, m.name, m.version)).toThrow();
  }
  const m = manifest();
  Object.assign(m.platforms["windows-x64"], {
    configTemplates: { "config.ini": { text: "{{unknown}}" } },
  });
  expect(() => normalizeManifest(m, m.name, m.version)).toThrow("Unknown");
});
