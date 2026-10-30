import { persistentFolder } from "../src/layout.ts";
import { afterAll, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256, exists } from "../src/util.ts";
import { Store } from "../src/store.ts";
import { VERSION } from "../src/version.ts";
import metadata from "../package.json";

const root = await mkdtemp(join(tmpdir(), "piko-cleanup-cli-"));
const content = new TextEncoder().encode("fixture executable");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          saved: { latest: "1.0.0", versions: { "1.0.0": "saved.json" } },
        },
      });
    if (path === "/saved.json")
      return Response.json({
        schemaVersion: 1,
        name: "saved",
        version: "1.0.0",
        platforms: {
          "windows-x64": {
            url: `http://127.0.0.1:${server.port}/file.exe`,
            sha256: sha256(content),
            format: "file",
            file: "saved.exe",
            bin: { saved: "saved.exe" },
            persist: ["settings"],
          },
        },
      });
    if (path === "/file.exe") return new Response(content);
    return new Response("not found", { status: 404 });
  },
});
afterAll(async () => {
  server.stop(true);
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 15,
        retryDelay: 100,
      });
      break;
    } catch (error: any) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || attempt === 19)
        throw error;
      // Bun on Windows may retain compiled EXE directory handles briefly.
      await Bun.sleep(100);
    }
  }
});

test("compiled cleanup CLI previews and requires --data plus explicit non-interactive confirmation", async () => {
  expect(VERSION).toBe(metadata.version);
  const exe = join(root, "piko.exe");
  const built = await Bun.build({
    entrypoints: ["src/cli.ts"],
    compile: {
      target: "bun-windows-x64",
      outfile: exe,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  expect(built.success).toBe(true);
  const home = join(root, "install");
  const run = async (args: string[], expected = 0) => {
    const child = Bun.spawn([exe, ...args], {
      env: { ...process.env, PIKO_HOME: home },
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({
      code,
      expected,
      error: code === expected ? undefined : err,
    }).toEqual({ code: expected, expected, error: undefined });
    return { out, err };
  };
  await run(["setup"]);
  await run(["source", "add", "main", `http://127.0.0.1:${server.port}/`]);
  await run(["install", "main/saved@1.0.0"]);
  const stateBeforeDoctor = await readFile(
    join(home, "apps/piko/state.json"),
    "utf8",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const diagnostics = JSON.parse((await run(["doctor"])).out);
    expect(diagnostics.installs).toBe(1);
    expect(diagnostics.orphans).toEqual([]);
    expect(diagnostics.revision).toBe(JSON.parse(stateBeforeDoctor).revision);
    expect(await readFile(join(home, "apps/piko/state.json"), "utf8")).toBe(
      stateBeforeDoctor,
    );
  }
  const state = await new Store(home).read(),
    installation = Object.values(state.installs)[0]!,
    data = join(
      home,
      "persist",
      persistentFolder(installation, installation.key),
      "settings",
    );
  await writeFile(join(data, "keep.txt"), "user-settings");
  expect(
    (await run(["cleanup", "main/saved", "--data", "--yes"], 1)).err,
  ).toContain("installed");
  expect(
    JSON.parse((await run(["info", "main/saved"])).out).available[0].latest,
  ).toBe("1.0.0");
  expect(JSON.parse((await run(["update", "--all", "--dry-run"])).out)).toEqual(
    [],
  );
  expect(
    JSON.parse((await run(["cache", "list"])).out).some(
      (e: any) => e.kind === "artifacts",
    ),
  ).toBe(true);
  await run(["cache", "clean"], 1);
  await run(["cache", "clean", "--dry-run"]);
  await run(["cache", "clean", "--yes"]);
  await run(["uninstall", "main/saved@1.0.0"]);
  expect((await run(["cleanup", "main/saved"], 1)).err).toContain("--data");
  const preview = await run(["cleanup", "main/saved", "--data", "--dry-run"]);
  expect(JSON.parse(preview.out).paths).toEqual([data]);
  expect((await run(["cleanup", "main/saved", "--data"], 1)).err).toContain(
    "--yes",
  );
  expect(await readFile(join(data, "keep.txt"), "utf8")).toBe("user-settings");
  await mkdir(
    join(
      home,
      "persist",
      persistentFolder(installation, installation.key),
      "not-recorded",
    ),
  );
  await writeFile(
    join(
      home,
      "persist",
      persistentFolder(installation, installation.key),
      "not-recorded",
      "keep",
    ),
    "untouched",
  );
  await run(["cleanup", "main/saved", "--data", "--yes"]);
  expect(await exists(data)).toBe(false);
  expect(
    await readFile(
      join(
        home,
        "persist",
        persistentFolder(installation, installation.key),
        "not-recorded",
        "keep",
      ),
      "utf8",
    ),
  ).toBe("untouched");
}, 60000);
