import { test, expect, afterAll } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  readlink,
  symlink,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import {
  Store,
  emptyState,
  upgradeState,
  validateState,
  packageKey,
  installId,
} from "../src/store.ts";
import {
  appFolder,
  persistentFolder,
  installDirectory,
  readableVersion,
  packageFolder,
} from "../src/layout.ts";
import {
  migrateLayout,
  planLayout,
  recoverLayout,
} from "../src/layout-migration.ts";
import { makeSource } from "../src/catalog.ts";
import { atomicJson, exists, sha256, versionKey } from "../src/util.ts";
import type { Install } from "../src/types.ts";
const work = await mkdtemp(join(tmpdir(), "piko-layout-tests-"));
const artifact = Buffer.from("portable executable fixture");
const index = {
  schemaVersion: 1,
  packages: {
    tool: { latest: "1.2.3.4", versions: { "1.2.3.4": "tool.json" } },
    other: { latest: "1.0.0", versions: { "1.0.0": "other.json" } },
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/index.json")) return Response.json(index);
    if (path.endsWith("/file.exe")) return new Response(artifact);
    if (path.endsWith("/tool.json") || path.endsWith("/other.json"))
      return Response.json({
        schemaVersion: 1,
        name: path.endsWith("/other.json") ? "other" : "tool",
        version: path.endsWith("/other.json") ? "1.0.0" : "1.2.3.4",
        platforms: {
          "windows-x64": {
            url: url + "file.exe",
            sha256: sha256(artifact),
            format: "file",
            file: "tool.exe",
            bin: {
              [path.endsWith("/other.json") ? "other" : "tool"]: "tool.exe",
            },
            persist: ["data"],
          },
        },
      });
    return new Response(null, { status: 404 });
  },
});
const url: string = `http://127.0.0.1:${server.port}/`;
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function legacy(name: string, { alias = false, persist = true } = {}) {
  const root = join(work, name),
    source = makeSource("main", url, "http"),
    key = packageKey(source, "tool"),
    id = installId(key, "1.2.3.4"),
    dir = join("apps", key, versionKey("1.2.3.4"));
  const i: Install = {
    id,
    key,
    name: "tool",
    version: "1.2.3.4",
    request: "latest",
    source,
    dir,
    bins: { tool: { path: "tool.exe", kind: "native" } },
    persist: persist ? ["data"] : [],
    verified: true,
    checksum: sha256(artifact),
    manifestHash: "fixture",
    kind: "portable",
  };
  const state = emptyState();
  upgradeState(state);
  state.schemaVersion = 7;
  state.sources.main = source;
  state.installs[id] = i;
  state.defaults[key] = { id, request: "latest", commands: ["tool"] };
  state.commands.tool = key;
  if (persist) {
    state.data![key] = { name: i.name, source, paths: ["data"] };
    await mkdir(join(root, "persist", key, "data"), { recursive: true });
    await writeFile(
      join(root, "persist", key, "data", "user.txt"),
      "precious user data",
    );
  }
  if (alias) state.aliases!["my-tool"] = { key, command: "tool" };
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "tool.exe"), artifact);
  await atomicJson(join(root, dir, ".piko-install.json"), i);
  if (persist)
    await symlink(
      resolve(join(root, "persist", key, "data")),
      join(root, dir, "data"),
      "junction",
    );
  await symlink(
    resolve(join(root, dir)),
    join(root, "apps", key, "current"),
    "junction",
  );
  await atomicJson(join(root, "sources", source.identity, "index.json"), index);
  await atomicJson(join(root, "apps/piko/state.json"), state);
  return { root, source, key, id, i, state };
}

test("new installs use package/version folders while source identities remain internal", async () => {
  const p = new Packages(join(work, "new"));
  await p.addSource("main", url);
  const i = await p.install("main/tool@1.2.3.4");
  expect(i.key).toContain("--");
  expect(i.dir).toBe(join("apps", "tool", "1.2.3.4"));
  expect(i.layout).toBe("named-v1");
  await p.use("main/tool@1.2.3.4");
  expect(resolve(await readlink(join(p.root, "apps/tool/current")))).toBe(
    resolve(join(p.root, i.dir)),
  );
  expect(await exists(join(p.root, "persist/tool/data"))).toBe(true);
  expect((await p.store.read()).schemaVersion).toBe(8);
});
test("safe vendor versions are readable; path/device identifiers never become directories", () => {
  expect(readableVersion("5.2.6.32774")).toBe("5.2.6.32774");
  expect(readableVersion("4-4215")).toBe("4-4215");
  expect(readableVersion("26.05")).toBe("26.05");
  for (const v of ["../escape", "CON", "current", "a/b"])
    expect(readableVersion(v)).toMatch(/^v-/);
  expect(
    packageFolder(
      {
        alias: "npm",
        url: "https://registry.npmjs.org/",
        type: "npm",
        identity: "test",
      },
      "@scope/tool",
    ),
  ).toBe("npm-scope--tool");
});
test("legacy state remains readable and legacy version upgrades are not silently relocated", async () => {
  const f = await legacy("legacy");
  expect(
    (await new Store(f.root).read()).installs[f.id]!.layout,
  ).toBeUndefined();
  expect(appFolder(f.i)).toBe(f.key);
  expect(persistentFolder(f.i, f.key)).toBe(f.key);
  expect(installDirectory(f.source, "tool", f.i.version, f.key)).toBe(f.i.dir);
});
test("preview is inert and stale confirmation cannot move files", async () => {
  const f = await legacy("preview"),
    before = await readFile(join(f.root, "apps/piko/state.json"));
  const plan = await planLayout(f.root);
  expect(plan.changes[0]!.to).toBe(join("apps/tool/1.2.3.4"));
  expect(plan.data[0]!.to).toBe(join("persist/tool"));
  expect(await readFile(join(f.root, "apps/piko/state.json"))).toEqual(before);
  await expect(migrateLayout(f.root, "0".repeat(64))).rejects.toThrow(
    "changed",
  );
  expect(await exists(join(f.root, f.i.dir))).toBe(true);
});
test("migration preserves IDs, defaults, aliases, payload and data, replaces links and backs up receipts", async () => {
  const f = await legacy("migrate", { alias: true }),
    plan = await planLayout(f.root),
    result = await migrateLayout(f.root, plan.binding);
  expect(result.status).toBe("completed");
  const s = await new Store(f.root).read(),
    i = s.installs[f.id]!;
  expect(i.key).toBe(f.key);
  expect(i.id).toBe(f.id);
  expect(i.dir).toBe(join("apps/tool/1.2.3.4"));
  expect(s.defaults[f.key]).toEqual(f.state.defaults[f.key]);
  expect(s.aliases).toEqual(f.state.aliases);
  expect(await readFile(join(f.root, i.dir, "tool.exe"))).toEqual(artifact);
  expect(
    await readFile(join(f.root, "persist/tool/data/user.txt"), "utf8"),
  ).toBe("precious user data");
  expect(resolve(await readlink(join(f.root, i.dir, "data")))).toBe(
    resolve(join(f.root, "persist/tool/data")),
  );
  expect(resolve(await readlink(join(f.root, "apps/tool/current")))).toBe(
    resolve(join(f.root, i.dir)),
  );
  expect(await exists(join(f.root, "apps", f.key))).toBe(false);
  expect(await exists(join(f.root, "persist", f.key))).toBe(false);
  expect(
    JSON.parse(
      await readFile(join(f.root, i.dir, ".piko-install.json"), "utf8"),
    ),
  ).toEqual(i);
  expect(await exists(join(f.root, "operations/layout.json"))).toBe(false);
  expect((await readdir(join(f.root, "apps/piko/layout-backups"))).length).toBe(
    1,
  );
  const p = new Packages(f.root);
  await p.unuse("main/tool");
  await p.uninstall("main/tool@1.2.3.4");
  expect(
    await readFile(join(f.root, "persist/tool/data/user.txt"), "utf8"),
  ).toBe("precious user data");
  await p.cleanupData("main/tool", { confirmed: true });
  expect(await exists(join(f.root, "persist/tool/data"))).toBe(false);
});
test("pre-existing destination and receipt drift fail before any mutation", async () => {
  const f = await legacy("occupied"),
    plan = await planLayout(f.root);
  await mkdir(join(f.root, "apps/tool"));
  await writeFile(join(f.root, "apps/tool/keep"), "external");
  await expect(migrateLayout(f.root, plan.binding)).rejects.toThrow(
    "destination already exists",
  );
  expect(await readFile(join(f.root, "apps/tool/keep"), "utf8")).toBe(
    "external",
  );
  expect(await exists(join(f.root, f.i.dir))).toBe(true);
  expect(await exists(join(f.root, "operations/layout.json"))).toBe(false);
  await rm(join(f.root, "apps/tool"), { recursive: true });
  await atomicJson(join(f.root, f.i.dir, ".piko-install.json"), {
    ...f.i,
    request: "altered",
  });
  await expect(migrateLayout(f.root, plan.binding)).rejects.toThrow(
    "receipt drift",
  );
});
test("pending migration blocks all Store reads and recovers partially moved data and directories", async () => {
  const f = await legacy("recover"),
    before = f.state,
    after = structuredClone(before);
  after.schemaVersion = 8;
  after.revision++;
  after.installs[f.id]!.layout = "named-v1";
  after.installs[f.id]!.dir = join("apps/tool/1.2.3.4");
  after.data![f.key]!.layout = "named-v1";
  const binding = sha256(JSON.stringify([resolve(f.root), before, after]));
  await atomicJson(join(f.root, "operations/layout.json"), {
    schemaVersion: 1,
    operation: "layout-" + crypto.randomUUID(),
    before,
    after,
    binding,
  });
  await expect(new Store(f.root).read()).rejects.toThrow(
    "migration is pending",
  );
  await rename(join(f.root, "persist", f.key), join(f.root, "persist/tool"));
  await mkdir(dirname(join(f.root, after.installs[f.id]!.dir)), {
    recursive: true,
  });
  await rename(join(f.root, f.i.dir), join(f.root, after.installs[f.id]!.dir));
  await recoverLayout(f.root);
  expect((await new Store(f.root).read()).schemaVersion).toBe(8);
  expect(
    await readFile(join(f.root, "apps/tool/current/data/user.txt"), "utf8"),
  ).toBe("precious user data");
  expect(await exists(join(f.root, "operations/layout.json"))).toBe(false);
});
test("same-name cross-source directories are refused without touching the existing payload", async () => {
  const p = new Packages(join(work, "sources"));
  await p.addSource("first", url);
  await p.addSource("second", url + "other/");
  const i = await p.install("first/tool@1.2.3.4");
  await expect(p.install("second/tool@1.2.3.4")).rejects.toThrow(
    "another source",
  );
  expect(await readFile(join(p.root, i.dir, "tool.exe"))).toEqual(artifact);
});
test("schema 8 layout records cannot be read as old schema or redirect outside the root", async () => {
  const f = await legacy("validation");
  const s = structuredClone(f.state);
  s.installs[f.id]!.layout = "named-v1";
  s.installs[f.id]!.dir = join("apps/tool/1.2.3.4");
  expect(() => validateState(s)).toThrow("schema 8");
  s.schemaVersion = 8;
  s.data![f.key]!.layout = "named-v1";
  s.installs[f.id]!.dir = "../escape";
  expect(() => validateState(s)).toThrow("receipt");
  expect(await exists(join(f.root, f.i.dir))).toBe(true);
});
