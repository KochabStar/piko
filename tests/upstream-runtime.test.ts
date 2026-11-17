import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packages } from "../src/packages.ts";
import { appendManifest } from "../src/manifest-template.ts";
import {
  exportInventorySnapshot,
  importInventory,
  planInventory,
} from "../src/inventory.ts";
import {
  resolutionSession,
  resolvePackageManifest,
} from "../src/package-resolution.ts";
import { installPackage } from "../src/ops/install.ts";
import { sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-upstream-runtime-"));
const servers: ReturnType<typeof Bun.serve>[] = [];
const executable = join(import.meta.dir, "../dist/piko.exe");
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

async function cli(root: string, args: string[], expected = 0) {
  const child = Bun.spawn([executable, ...args], {
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
  expect({ code, err: code === expected ? undefined : err }).toEqual({
    code: expected,
    err: undefined,
  });
  return { out, err };
}

async function fixture(trust: "publisher" | "https" = "publisher") {
  const settings = { version: "1.0.0", digest: "", fail: false };
  const requests = new Map<string, number>();
  const payload = (version: string) =>
    Buffer.concat([
      Buffer.from("MZ"),
      Buffer.alloc(62),
      Buffer.from(`upstream fixture ${version}; never executed`),
    ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      requests.set(path, (requests.get(path) ?? 0) + 1);
      if (settings.fail)
        return new Response("unexpected network", { status: 400 });
      const base = `http://127.0.0.1:${server.port}/`;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: Object.fromEntries(
            ["alpha", "beta"].map((name) => [
              name,
              {
                latest: "1.0.0",
                versions: { "1.0.0": `${name}.json` },
                aliases: { stable: "2" },
              },
            ]),
          ),
        });
      if (path === "/feed.json")
        return Response.json({
          version: settings.version,
          sha256: settings.digest || sha256(payload(settings.version)),
        });
      if (/^\/(alpha|beta)\.json$/.test(path)) {
        const name = path.slice(1, -5);
        const document = appendManifest(undefined, {
          schemaVersion: 1,
          name,
          version: "1.0.0",
          platforms: {
            "windows-x64": {
              url: base + "file-1.0.0.exe",
              sha256: sha256(payload("1.0.0")),
              format: "file",
              file: "tool.exe",
              bin: { [name]: "tool.exe" },
            },
          },
        });
        document.upstream = {
          provider: "json",
          trust,
          url: base + "feed.json",
          versionPath: "version",
          ...(trust === "publisher" ? { sha256Path: "sha256" } : {}),
          urlTemplate: base + "file-{version}.exe",
          maxBytes: 1024 * 1024,
        };
        return Response.json(document);
      }
      const version = /^\/file-(.+)\.exe$/.exec(path)?.[1];
      return version
        ? new Response(payload(version))
        : new Response("missing", { status: 404 });
    },
  });
  servers.push(server);
  const packages = new Packages(join(work, crypto.randomUUID()));
  await packages.addSource("main", `http://127.0.0.1:${server.port}/`);
  return { packages, settings, requests };
}

test("existing CLI updates a frozen source to an unindexed release and retains latest selection", async () => {
  const f = await fixture();
  await cli(f.packages.root, ["install", "main/alpha@1.0.0", "--json"]);
  await cli(f.packages.root, ["use", "main/alpha@latest", "--json"]);
  f.settings.version = "2.0.0";
  const preview = JSON.parse(
    (
      await cli(f.packages.root, [
        "update",
        "main/alpha",
        "--dry-run",
        "--json",
      ])
    ).out,
  );
  expect(preview[0]).toMatchObject({
    current: "1.0.0",
    candidate: "2.0.0",
    status: "outdated",
  });
  expect(f.requests.has("/file-2.0.0.exe")).toBe(false);
  await cli(f.packages.root, ["update", "main/alpha", "--json"]);
  const state = await f.packages.store.read();
  const old = Object.values(state.installs).find(
    (install) => install.version === "1.0.0",
  )!;
  expect(state.installs[state.defaults[old.key]!.id]!.version).toBe("2.0.0");
  expect(state.defaults[old.key]!.request).toBe("latest");
  const downloads = f.requests.get("/file-2.0.0.exe");
  await cli(f.packages.root, ["update", "main/alpha", "--json"]);
  expect(f.requests.get("/file-2.0.0.exe")).toBe(downloads);
  await cli(f.packages.root, ["use", "main/alpha@1.0.0", "--json"]);
  f.settings.version = "3.0.0";
  await cli(f.packages.root, ["update", "main/alpha", "--json"]);
  expect((await f.packages.store.read()).defaults[old.key]!.id).toBe(old.id);
});

test("batch shares provider metadata; bad advertised digests preserve defaults", async () => {
  const f = await fixture();
  for (const name of ["alpha", "beta"]) {
    await f.packages.install(`main/${name}@1.0.0`);
    await f.packages.use(`main/${name}@latest`);
  }
  f.settings.version = "2.0.0";
  f.requests.clear();
  expect((await f.packages.updateAll()).map((row) => row.status)).toEqual([
    "updated",
    "updated",
  ]);
  expect(f.requests.get("/feed.json")).toBe(1);
  expect(f.requests.get("/index.json")).toBe(1);
  const before = (await f.packages.store.read()).defaults;
  f.settings.version = "3.0.0";
  f.settings.digest = "1".repeat(64);
  expect(
    (await f.packages.updateAll()).every((row) => row.status === "failed"),
  ).toBe(true);
  expect((await f.packages.store.read()).defaults).toEqual(before);
  expect(
    Object.values((await f.packages.store.read()).installs).some(
      (install) => install.version === "3.0.0",
    ),
  ).toBe(false);
});

test("transport-trusted preview is metadata-only; exact offline and bound replay never probe", async () => {
  const f = await fixture("https");
  await f.packages.install("main/alpha@1.0.0");
  await f.packages.use("main/alpha@latest");
  f.settings.version = "2.0.0";
  expect((await f.packages.outdated())[0]).toMatchObject({
    candidate: "2.0.0",
    status: "outdated",
  });
  expect(f.requests.has("/file-2.0.0.exe")).toBe(false);
  const updated = await f.packages.update("main/alpha");
  const inventory = await exportInventorySnapshot(f.packages);
  expect(inventory.exactManifests?.["main/alpha@2.0.0"]?.manifestHash).toBe(
    updated.manifestHash,
  );
  const source = (await f.packages.store.read()).sources.main!;
  const state = await f.packages.store.read();
  const index = JSON.parse(
    await readFile(join(f.packages.root, "sources/main/latest.json"), "utf8"),
  );
  const manifest = await resolvePackageManifest(
    f.packages.root,
    state,
    source,
    "alpha",
    index.packages.alpha,
    "2.0.0",
  );
  const offline = new Packages(join(work, crypto.randomUUID()));
  await offline.store.mutate(async (current) => {
    current.sources.main = structuredClone(source);
  });
  await cp(join(f.packages.root, "sources"), join(offline.root, "sources"), {
    recursive: true,
  });
  await cp(join(f.packages.root, "cache"), join(offline.root, "cache"), {
    recursive: true,
  });
  f.settings.fail = true;
  const before = [...f.requests];
  const restored = await offline.install(
    "main/alpha@2.0.0",
    false,
    undefined,
    updated.manifestHash,
    undefined,
    { offline: true },
  );
  expect(restored.manifestHash).toBe(updated.manifestHash);
  const replay = new Packages(join(work, crypto.randomUUID()));
  await replay.store.mutate(async (current) => {
    current.sources.main = structuredClone(source);
  });
  await cp(join(f.packages.root, "cache"), join(replay.root, "cache"), {
    recursive: true,
  });
  expect(
    (
      await installPackage(replay, "main/alpha@2.0.0", {
        offline: true,
        bound: { source, name: "alpha", version: "2.0.0", manifest },
      })
    ).manifestHash,
  ).toBe(updated.manifestHash);
  expect([...f.requests]).toEqual(before);
});

test("per-consumer preflight is not inherited from a shared resolution session", async () => {
  const f = await fixture();
  f.settings.version = "2.0.0";
  const state = await f.packages.store.read();
  const source = state.sources.main!;
  const index = JSON.parse(
    await readFile(join(f.packages.root, "sources/main/latest.json"), "utf8"),
  );
  const session = resolutionSession();
  await resolvePackageManifest(
    f.packages.root,
    state,
    source,
    "alpha",
    index.packages.alpha,
    "latest",
    { session },
  );
  await expect(
    resolvePackageManifest(
      f.packages.root,
      state,
      source,
      "alpha",
      index.packages.alpha,
      "latest",
      {
        session,
        preflight: async () => {
          throw new Error("consumer authorization denied");
        },
      },
    ),
  ).rejects.toThrow("consumer authorization denied");
});

test("unindexed aliases retain their constraint and exact inventory restores do not follow the feed", async () => {
  const f = await fixture();
  f.settings.version = "2.0.0";
  const installed = await f.packages.install("main/alpha@stable");
  await f.packages.use("main/alpha@stable");
  expect(installed.version).toBe("2.0.0");
  expect((await f.packages.store.read()).defaults[installed.key]!.request).toBe(
    "stable",
  );
  const inventory = await exportInventorySnapshot(f.packages);
  f.settings.version = "3.0.0";
  const plan = await planInventory(f.packages, inventory);
  expect(plan.conflicts).toEqual([]);
  const target = new Packages(join(work, crypto.randomUUID()));
  const preview = await planInventory(target, inventory);
  expect(preview.conflicts).toEqual([]);
  await importInventory(target, inventory, {
    confirmed: true,
    binding: preview.binding,
  });
  const restored = await target.store.read();
  expect(restored.installs[restored.defaults[installed.key]!.id]!.version).toBe(
    "2.0.0",
  );
  expect(f.requests.has("/file-3.0.0.exe")).toBe(false);
  await expect(f.packages.update("main/alpha")).rejects.toThrow(
    "requested version/channel",
  );
  expect((await f.packages.store.read()).defaults[installed.key]!.id).toBe(
    installed.id,
  );
});
