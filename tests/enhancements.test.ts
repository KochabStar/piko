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
import { Store, packageKey, installId, validateState } from "../src/store.ts";
import { makeSource, normalizeManifest } from "../src/catalog.ts";
import { pathDiagnostics } from "../src/windows.ts";
import { selectedEnvironment } from "../src/environment.ts";
import { artifactBytes, cleanCache } from "../src/cache.ts";
import { atomicJson, capture, exists, sha256 } from "../src/util.ts";
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
    await artifactBytes(root, url, hash);
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
      source = makeSource("main", "https://example.invalid/", "http"),
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
    source = makeSource("main", "https://example.invalid/", "http"),
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

test("Git source installs pinned committed manifests, refreshes, handles deletion and never checks out hooks", async () => {
  const root = join(work, "git-home"),
    repo = join(work, "git-repo"),
    bare = join(work, "git.git");
  await mkdir(repo, { recursive: true });
  const artifact = Buffer.from("git source fixture");
  await writeFile(join(work, "file.exe"), artifact);
  const serverFile = join(work, "serve-git.cjs");
  await writeFile(
    serverFile,
    `const http=require('http'),fs=require('fs'),path=require('path');const root=process.argv[2];const s=http.createServer((q,r)=>{const p=decodeURIComponent(new URL(q.url,'http://localhost').pathname);if(p.includes('..')){r.writeHead(400);return r.end();}try{const b=fs.readFileSync(path.join(root,p));r.setHeader('Content-Type','application/octet-stream');r.end(b);}catch{r.writeHead(404);r.end();}});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`,
  );
  const server = Bun.spawn(["node", serverFile, work], {
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const ready = await server.stdout.getReader().read();
  const port = Number(Buffer.from(ready.value!).toString().trim());
  if (!Number.isInteger(port)) throw new Error("Fixture server failed");
  const url = `http://127.0.0.1:${port}/`;
  const git = (args: string[], cwd = repo) =>
    capture("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "NUL",
      },
    });
  try {
    await git(["init", "--initial-branch=main"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await git(["config", "user.name", "Fixture"]);
    const manifest = (version: string) => ({
      schemaVersion: 1,
      name: "tool",
      version,
      platforms: {
        "windows-x64": {
          url: url + "file.exe",
          sha256: sha256(artifact),
          format: "file",
          file: "tool.exe",
          bin: { tool: "tool.exe" },
          persist: ["settings"],
        },
      },
    });
    await writeFile(
      join(repo, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          tool: { latest: "1.0.0", versions: { "1.0.0": "tool.json" } },
        },
      }),
    );
    await writeFile(join(repo, "tool.json"), JSON.stringify(manifest("1.0.0")));
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
    await git(["clone", "--bare", repo, bare]);
    await git(["update-server-info"], bare);
    const p = new Packages(root);
    await p.addSource("git", url + "git.git", "git", "main");
    const i = await p.install("git/tool@1.0.0");
    expect(i.source.commit).toMatch(/^[a-f0-9]{40}$/);
    const saved = join(root, "persist", i.key, "settings", "kept.txt");
    await writeFile(saved, "user-data");
    const gitState = await p.store.read();
    expect(gitState.schemaVersion).toBe(4);
    const legacy = structuredClone(gitState);
    legacy.schemaVersion = 3;
    expect(() => validateState(legacy)).toThrow("requires schema 4");
    expect(
      await exists(
        join(root, "sources", i.source.identity, "repo", "tool.json"),
      ),
    ).toBe(false);
    await p.use("git/tool@1");
    await writeFile(
      join(repo, "tool2.json"),
      JSON.stringify(manifest("1.1.0")),
    );
    await writeFile(
      join(repo, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          tool: {
            latest: "1.1.0",
            versions: { "1.0.0": "tool.json", "1.1.0": "tool2.json" },
          },
        },
      }),
    );
    await git(["add", "."]);
    await git(["commit", "-m", "new release"]);
    await git(["push", bare, "main"]);
    await git(["update-server-info"], bare);
    expect((await p.info("git/tool")).available[0]?.versions).toHaveLength(2);
    expect((await p.update("git/tool")).version).toBe("1.1.0");
    const dry = await p.updateAll(true);
    expect(dry[0]?.status).toBe("planned");
    expect((await p.updateAll())[0]?.status).toBe("unchanged");
    await expect(p.removeSource("git")).rejects.toThrow("referenced");
    await p.removeSource("git", true);
    await expect(p.update("git/tool")).rejects.toThrow("Original source");
    await p.addSource("git", url + "git.git", "git", "main");
    const before = await p.store.read();
    expect((await p.updateAll())[0]?.status).toBe("unchanged");
    await rename(bare, bare + ".unavailable");
    await expect(p.refreshSources("git")).rejects.toThrow();
    expect((await p.updateAll())[0]?.status).toBe("failed");
    expect((await p.store.read()).defaults).toEqual(before.defaults);
    await p.uninstall("git/tool@1.0.0");
    await p.uninstall("git/tool@1.1.0", true);
    expect(await readFile(saved, "utf8")).toBe("user-data");
    await p.cleanupData("git/tool", { confirmed: true });
    expect(await exists(saved)).toBe(false);
  } finally {
    server.kill();
    await server.exited;
  }
}, 60000);
