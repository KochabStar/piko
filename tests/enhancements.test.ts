import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { npmTreeHash } from "../src/scripts.ts";
import { orphanPlan, quarantineOrphans } from "../src/maintenance.ts";
import { Packages } from "../src/packages.ts";
import { Store, packageKey, installId, sourceIdentity } from "../src/store.ts";
import { makeSource, normalizeManifest } from "../src/catalog.ts";
import {
  ensureSourceIndex,
  migrateSourceCache,
  readSourceIndex,
  refresh,
  removeSourceCache,
} from "../src/source-fetch.ts";
import { validateInventory } from "../src/inventory.ts";
import { pathDiagnostics } from "../src/windows.ts";
import { selectedEnvironment } from "../src/environment.ts";
import { artifactBytes, cleanCache } from "../src/cache.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";
import type { Install } from "../src/types.ts";
const work = await mkdtemp(join(tmpdir(), "piko-enhancements-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
);

test("parallel npm fingerprint preserves the existing canonical tree digest", async () => {
  const root = join(work, "digest");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "a.txt"), "alpha");
  await writeFile(join(root, "nested/b.txt"), "beta");
  await writeFile(
    join(root, ".piko-install.json"),
    "receipt metadata excluded",
  );
  expect(await npmTreeHash(root)).toBe(
    "b3c35c06f170a9ee0dc65240865d8f8bf5f7fe55b0b452c698c7b396f468db1d",
  );
  await writeFile(join(root, "a.txt"), "changed");
  expect(await npmTreeHash(root)).not.toBe(
    "b3c35c06f170a9ee0dc65240865d8f8bf5f7fe55b0b452c698c7b396f468db1d",
  );
});

test("verified artifact cache reuses bytes, detects tampering and protects referenced npm snapshots", async () => {
  const root = join(work, "cache"),
    bytes = Buffer.from("verified artifact");
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(bytes);
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/tool.exe`,
      hash = sha256(bytes);
    await artifactBytes(root, url, hash);
    await artifactBytes(root, "https://offline.invalid/tool.exe", hash);
    expect(requests).toBe(1);
    await writeFile(join(root, "cache/artifacts", hash), "corrupted");
    await expect(artifactBytes(root, url, hash)).rejects.toThrow("checksum");
    const state = await new Store(root).read();
    state.installs.fixture = {
      npmBuild: { inputHash: "a".repeat(64) },
    } as Install;
    await mkdir(join(root, "cache/npm-input", "a".repeat(64)), {
      recursive: true,
    });
    await mkdir(join(root, "cache/npm-input", "b".repeat(64)), {
      recursive: true,
    });
    expect(
      (await cleanCache(root, state)).filter((e) => e.removable),
    ).toHaveLength(2);
    await cleanCache(root, state, true);
    expect(await exists(join(root, "cache/npm-input", "a".repeat(64)))).toBe(
      true,
    );
    expect(await exists(join(root, "cache/npm-input", "b".repeat(64)))).toBe(
      false,
    );
  } finally {
    server.stop(true);
  }
});

test("journaled first install rolls forward across persistence and directory publication without selecting a default", async () => {
  for (const phase of ["before-map", "mapped", "published"]) {
    const root = join(work, phase),
      store = new Store(root),
      source = makeSource("main", "https://example.invalid/"),
      key = packageKey(source, "saved"),
      id = installId(key, "1.0.0"),
      operation = crypto.randomUUID(),
      stage = join(root, "staging", operation, "app");
    const i: Install = {
      id,
      key,
      name: "saved",
      version: "1.0.0",
      request: "1",
      source,
      dir: join("apps", key, "1.0.0"),
      bins: { saved: { path: "saved.exe", kind: "native" } },
      persist: ["settings"],
      verified: true,
      checksum: "fixture",
      kind: "portable",
      manifestHash: "fixture",
    };
    await mkdir(join(stage, "settings"), { recursive: true });
    await writeFile(join(stage, "saved.exe"), "fixture");
    await writeFile(join(stage, "settings", "keep.txt"), "data");
    await atomicJson(join(stage, ".piko-install.json"), i);
    if (phase === "before-map")
      await atomicJson(store.installPath, {
        installation: i,
        operation,
        payload: "app",
        created: ["settings"],
      });
    else {
      await store.publishInstall(i, stage, operation);
      if (phase === "mapped") {
        await mkdir(join(root, "staging", operation), { recursive: true });
        await rename(join(root, i.dir), stage);
      }
    }
    await store.mutate(async () => {});
    const state = await store.read();
    expect(state.installs[id]?.version).toBe("1.0.0");
    expect(state.defaults).toEqual({});
    expect(
      await readFile(
        join(root, "persist", key, "settings", "keep.txt"),
        "utf8",
      ),
    ).toBe("data");
    expect(await exists(store.installPath)).toBe(false);
  }
});

test("orphan quarantine preserves files and persistent targets and skips unrecognized directories", async () => {
  const root = join(work, "published"),
    store = new Store(root);
  await store.mutate(async (state) => {
    state.installs = {};
  });
  const unknown = join(root, "apps", "unknown", "1.0.0");
  await mkdir(unknown, { recursive: true });
  await writeFile(join(unknown, "keep"), "external");
  const state = await store.read(),
    plan = await orphanPlan(root, state);
  expect(plan.filter((i) => i.installation)).toHaveLength(1);
  expect(plan.filter((i) => i.issue)).toHaveLength(1);
  const preview = await quarantineOrphans(root, state);
  expect(preview.every((i) => !i.quarantined)).toBe(true);
  const result = await quarantineOrphans(root, state, true),
    moved = result.find((i) => "destination" in i)!;
  if (!("destination" in moved))
    throw new Error("Expected quarantine destination");
  expect(await exists(moved.path)).toBe(false);
  expect(
    await readFile(join(moved.destination!, "app", "saved.exe"), "utf8"),
  ).toBe("fixture");
  expect(
    await readFile(
      join(moved.destination!, "app", "settings", "keep.txt"),
      "utf8",
    ),
  ).toBe("data");
  expect(await readFile(join(unknown, "keep"), "utf8")).toBe("external");
});

test("declarative environments reject protected variables, expand per version and reject conflicting selections", async () => {
  const m: any = {
    schemaVersion: 1,
    name: "tool",
    version: "1.0.0",
    platforms: {
      "windows-x64": {
        url: "https://example.invalid/tool.exe",
        format: "file",
        file: "tool.exe",
        bin: { tool: "tool.exe" },
        env: {
          TOOL_HOME: "{root}",
          TOOL_DATA: "{persist}",
          TOOL_VERSION: "{version}",
        },
      },
    },
  };
  normalizeManifest(m, "tool", "1.0.0");
  for (const key of [
    "Path",
    "NODE_OPTIONS",
    "PIKO_HOME",
    "npm_config_ignore_scripts",
    "COMSPEC",
  ]) {
    m.platforms["windows-x64"].env = { [key]: "unsafe" };
    expect(() => normalizeManifest(m, "tool", "1.0.0")).toThrow("Protected");
  }
  const root = join(work, "env"),
    source = makeSource("main", "https://example.invalid/"),
    key = packageKey(source, "tool"),
    id = installId(key, "1.0.0"),
    s = await new Store(root).read();
  const i = {
    id,
    key,
    dir: join("apps", key, "1.0.0"),
    version: "1.0.0",
    name: "tool",
    request: "1",
    source,
    bins: {},
    persist: [],
    verified: true,
    checksum: "fixture",
    kind: "portable",
    manifestHash: "fixture",
    env: { TOOL_HOME: "{root}", TOOL_VERSION: "{version}" },
  } as Install;
  s.installs[id] = i;
  s.defaults[key] = { id, request: "1" };
  expect(selectedEnvironment(root, s).TOOL_VERSION).toBe("1.0.0");
  expect(selectedEnvironment(root, s).TOOL_HOME).toBe(join(root, i.dir));
  s.installs.other = { ...i, id: "other", env: { TOOL_VERSION: "2" } };
  s.defaults.other = { id: "other", request: "2" };
  expect(() => selectedEnvironment(root, s)).toThrow("conflict");
});

test("PATH diagnostics show external precedence without modifying files", async () => {
  const root = join(work, "paths"),
    external = join(root, "external"),
    shims = join(root, "shims");
  await mkdir(external, { recursive: true });
  await mkdir(shims, { recursive: true });
  await writeFile(join(external, "piko.cmd"), "external");
  await writeFile(join(shims, "piko.exe"), "managed");
  const s = await new Store(root).read(),
    bad = await pathDiagnostics(
      root,
      s,
      { PATH: external + ";" + shims, PATHEXT: ".EXE;.CMD" },
      work,
    );
  expect(bad[0]?.shadowed).toBe(true);
  expect(bad[0]?.resolved).toBe(join(external, "piko.CMD"));
  expect(
    (
      await pathDiagnostics(
        root,
        s,
        { PATH: shims + ";" + external, PATHEXT: ".EXE;.CMD" },
        work,
      )
    )[0]?.shadowed,
  ).toBe(false);
  expect(await readFile(join(external, "piko.cmd"), "utf8")).toBe("external");
});

test("batch update continues after one package fails and preserves that package default", async () => {
  const root = join(work, "batch"),
    bytes = Buffer.from("batch fixture"),
    hash = sha256(bytes);
  let failA = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      const base = `http://127.0.0.1:${server.port}/`;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: Object.fromEntries(
            ["a", "b"].map((name) => [
              name,
              {
                latest: "1.1.0",
                versions: {
                  "1.0.0": name + "-1.0.0.json",
                  "1.1.0": name + "-1.1.0.json",
                },
              },
            ]),
          ),
        });
      if (path === "/file.exe") return new Response(bytes);
      const match = /^\/([ab])-(1\.[01]\.0)\.json$/.exec(path);
      if (!match) return new Response("missing", { status: 404 });
      const [, name, version] = match;
      return Response.json({
        schemaVersion: 1,
        name,
        version,
        platforms: {
          "windows-x64": {
            url: base + "file.exe",
            sha256:
              failA && name === "a" && version === "1.1.0"
                ? "0".repeat(64)
                : hash,
            format: "file",
            file: name + ".exe",
            bin: { [name!]: name + ".exe" },
          },
        },
      });
    },
  });
  try {
    const p = new Packages(root);
    await p.addSource("main", `http://127.0.0.1:${server.port}/`);
    for (const name of ["a", "b"]) {
      await p.install(`main/${name}@1.0.0`);
      await p.use(`main/${name}@1`);
    }
    const before = await p.store.read();
    failA = true;
    const result = await p.updateAll();
    expect(result.map((r) => r.status)).toEqual(["failed", "updated"]);
    const state = await p.store.read(),
      a = Object.values(before.installs).find((i) => i.name === "a")!;
    expect(state.defaults[a.key]).toEqual(before.defaults[a.key]);
    expect(await exists(join(root, a.dir, "a.exe"))).toBe(true);
    const b = Object.values(state.installs).find(
      (i) => i.name === "b" && i.version === "1.1.0",
    )!;
    expect(state.defaults[b.key]?.id).toBe(b.id);
  } finally {
    server.stop(true);
  }
});

test("HTTP latest caches respect freshness, explicit refresh and offline failure safety", async () => {
  const root = join(work, "source-cache");
  let requests = 0;
  let latest = "1.0.0";
  let invalid = false;
  const index = () => ({
    schemaVersion: 1,
    packages: {
      tool: {
        latest,
        versions: { "1.0.0": "tool.json", "2.0.0": "tool2.json" },
      },
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/catalog/index.json");
      requests++;
      return Response.json(
        invalid ? { schemaVersion: 1, packages: { tool: {} } } : index(),
      );
    },
  });
  const url = `http://127.0.0.1:${server.port}/catalog/`;
  const source = makeSource("main", url);
  expect(source.identity).toBe(sourceIdentity("http", url));
  try {
    await ensureSourceIndex(root, source);
    expect(requests).toBe(1);
    expect(source.fetchedAt).toBeDefined();
    expect((await ensureSourceIndex(root, source)).packages.tool?.latest).toBe(
      "1.0.0",
    );
    expect(requests).toBe(1);
    const path = join(root, "sources", source.alias, "latest.json");
    expect(
      await exists(join(root, "sources", source.alias, "fetched-at.txt")),
    ).toBe(false);
    source.fetchedAt = new Date(
      Date.now() - 24 * 60 * 60 * 1000 - 1000,
    ).toISOString();
    latest = "2.0.0";
    expect(
      (await ensureSourceIndex(root, source, { offline: true })).packages.tool
        ?.latest,
    ).toBe("1.0.0");
    expect(requests).toBe(1);
    expect((await ensureSourceIndex(root, source)).packages.tool?.latest).toBe(
      "2.0.0",
    );
    expect(requests).toBe(2);
    await ensureSourceIndex(root, source, { refresh: true });
    expect(requests).toBe(3);
    const good = await readFile(path);
    const fetchedAt = source.fetchedAt;
    invalid = true;
    await expect(refresh(root, source)).rejects.toThrow("Invalid index entry");
    expect(await readFile(path)).toEqual(good);
    expect(source.fetchedAt).toBe(fetchedAt);
    expect((await readSourceIndex(root, source)).packages.tool?.latest).toBe(
      "2.0.0",
    );
    const count = requests;
    await expect(
      ensureSourceIndex(root, source, { offline: true, refresh: true }),
    ).rejects.toThrow("offline");
    expect(requests).toBe(count);
    invalid = false;
    const explicit = makeSource("explicit", url + "index.json");
    expect((await refresh(root, explicit)).packages.tool?.latest).toBe("2.0.0");
    await rm(path);
    await ensureSourceIndex(root, source);
    expect(requests).toBe(count + 2);
  } finally {
    server.stop(true);
  }
});

test("legacy HTTP cache migration preserves identity and unknown files without replacing newer latest", async () => {
  const root = join(work, "legacy-source-cache");
  const source = makeSource("main", "https://example.invalid/source/");
  const identity = source.identity;
  const old = {
    schemaVersion: 1 as const,
    packages: { tool: { latest: "1.0.0", versions: { "1.0.0": "tool.json" } } },
  };
  const recent = {
    schemaVersion: 1 as const,
    packages: {
      tool: { latest: "2.0.0", versions: { "2.0.0": "tool2.json" } },
    },
  };
  const dir = join(root, "sources", source.identity);
  const legacy = join(dir, "index.json");
  const latest = join(root, "sources", source.alias, "latest.json");
  await atomicJson(legacy, old);
  await writeFile(join(dir, "user-notes.txt"), "keep");
  expect(await readSourceIndex(root, source)).toEqual(old);
  expect(await exists(latest)).toBe(false);
  expect(await migrateSourceCache(root, source)).toBe(true);
  expect(source.identity).toBe(identity);
  expect(await exists(legacy)).toBe(false);
  expect(await readFile(join(dir, "user-notes.txt"), "utf8")).toBe("keep");
  await atomicJson(legacy, old);
  await atomicJson(latest, recent);
  await migrateSourceCache(root, source);
  expect(await readSourceIndex(root, source)).toEqual(recent);
  await removeSourceCache(root, source);
  expect(await exists(latest)).toBe(false);
  expect(await readFile(join(dir, "user-notes.txt"), "utf8")).toBe("keep");
});

test("legacy Git inventory imports fail explicitly instead of rewriting provenance", () => {
  const inventory = {
    schemaVersion: 1,
    sources: [
      {
        alias: "old",
        url: "https://example.invalid/source.git",
        type: "git",
        ref: "main",
      },
    ],
    packages: [],
    aliases: [],
  };
  expect(() => validateInventory(inventory)).toThrow(
    "cannot be converted automatically",
  );
});
