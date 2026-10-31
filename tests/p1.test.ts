import { persistentFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { chooseVersion, normalizeIndex } from "../src/catalog.ts";
import {
  exportInventory,
  importInventory,
  planInventory,
  validateInventory,
} from "../src/inventory.ts";
import { sha256, exists, atomicJson } from "../src/util.ts";
import type { Index, Manifest } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-p1-")),
  bytes = Buffer.from("portable P1 fixture");
const versions = ["1.0.0", "1.1.0", "2.0.0", "3.0.0"];
const index: Index = {
  schemaVersion: 1,
  packages: Object.fromEntries(
    [
      "tool",
      "other",
      "runtime",
      "consumer",
      "java-temurin",
      "java-zulu",
      "cycle-a",
      "cycle-b",
    ].map((name) => [
      name,
      {
        latest: "3.0.0",
        versions: Object.fromEntries(
          versions.map((v) => [v, name + "/" + v + ".json"]),
        ),
        aliases: { lts: "1" },
        ...(name.startsWith("java-")
          ? { runtime: { family: "java", distribution: name.slice(5) } }
          : {}),
      },
    ]),
  ),
};
const overrides = new Map<string, Partial<Manifest["platforms"][string]>>();
let downloads = 0,
  unavailable = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json" || path === "/second/index.json")
      return unavailable
        ? new Response("offline", { status: 503 })
        : Response.json(index);
    if (path === "/file.exe") {
      downloads++;
      return new Response(bytes);
    }
    const match = /^\/(?:second\/)?([^/]+)\/(.+)\.json$/.exec(path);
    if (!match) return new Response("missing", { status: 404 });
    const [, name, version] = match;
    return Response.json({
      schemaVersion: 1,
      name,
      version,
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file.exe`,
          sha256: sha256(bytes),
          format: "file",
          file: "tool.exe",
          bin: {
            [name === "other"
              ? "tool"
              : name!.startsWith("java-")
                ? "java"
                : name!]: "tool.exe",
          },
          ...(name === "consumer"
            ? { depends: [{ package: "runtime@1", commands: ["runtime"] }] }
            : {}),
          ...(name === "tool" ? { persist: ["data"] } : {}),
          ...overrides.get(name + "/" + version),
        },
      },
    });
  },
});
const url = `http://127.0.0.1:${server.port}/`;
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function manager() {
  const p = new Packages(join(work, crypto.randomUUID()));
  await p.addSource("main", url);
  return p;
}
const run = async (root: string, args: string[]) => {
  const child = Bun.spawn(
    [join(import.meta.dir, "../dist/piko.exe"), ...args],
    {
      env: { ...process.env, PIKO_HOME: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
};

test("catalog channels reject recursion, collisions and invalid runtime identities", () => {
  expect(chooseVersion(versions, "lts", "3.0.0", { lts: "1" })).toBe("1.1.0");
  expect(
    chooseVersion(["release-x"], "stable", undefined, { stable: "release-x" }),
  ).toBe("release-x");
  const invalidAliases: Record<string, string>[] = [
    { latest: "1" },
    { lts: "stable", stable: "lts" },
    { lts: "9" },
    { lts: "^1" },
  ];
  for (const aliases of invalidAliases) {
    const value = structuredClone(index);
    value.packages.tool!.aliases = aliases;
    expect(() => normalizeIndex(value)).toThrow();
  }
  const value = structuredClone(index);
  value.packages.tool!.runtime = { family: "../java", distribution: "vendor" };
  expect(() => normalizeIndex(value)).toThrow();
});

test("install/use/update retain the channel request while the source changes its target", async () => {
  const p = await manager(),
    original = index.packages.tool!.aliases!.lts!;
  try {
    const i = await p.install("main/tool@lts");
    expect(i.version).toBe("1.1.0");
    await p.use("main/tool@lts");
    expect((await p.store.read()).defaults[i.key]?.request).toBe("lts");
    index.packages.tool!.aliases!.lts = "2";
    const before = await p.store.read(),
      count = downloads;
    const rows = await p.outdated("main/tool");
    expect(rows[0]).toMatchObject({
      current: "1.1.0",
      candidate: "2.0.0",
      request: "lts",
      status: "outdated",
    });
    expect(await p.store.read()).toEqual(before);
    expect(downloads).toBe(count);
    const updated = await p.update("main/tool");
    expect(updated.version).toBe("2.0.0");
    expect((await p.store.read()).defaults[i.key]?.request).toBe("lts");
    await p.aliasCommand("my-tool", "main/tool@lts", "tool");
  } finally {
    index.packages.tool!.aliases!.lts = original;
  }
});

test("runtime vendors resolve to distinct package identities without implicit command takeover", async () => {
  const p = await manager();
  expect(await p.runtimeSpec("main/java@1", "temurin")).toBe(
    "main/java-temurin@1",
  );
  const first = await p.install(await p.runtimeSpec("java@1", "temurin"));
  const second = await p.install(await p.runtimeSpec("java@1", "zulu"));
  expect(first.key).not.toBe(second.key);
  await p.use("main/java-temurin@1");
  await expect(p.use("main/java-zulu@1")).rejects.toThrow("Command conflict");
  await p.addSource("second", url + "second/");
  await expect(p.runtimeSpec("java@1", "temurin")).rejects.toThrow("Ambiguous");
  expect(await p.runtimeSpec("main/java@1", "temurin")).toBe(
    "main/java-temurin@1",
  );
});

test("outdated distinguishes pinned/current/blocked, continues across failures and never alters defaults", async () => {
  const p = await manager();
  await p.install("tool@1.0.0");
  await p.use("tool@1.0.0");
  await p.install("other@1.0.0");
  await p.use("other@1", { noCommands: true });
  const before = await p.store.read();
  expect((await p.outdated("tool"))[0]).toMatchObject({
    status: "pinned",
    candidate: "1.0.0",
    latest: "3.0.0",
  });
  overrides.set("other/1.1.0", { sha256: undefined });
  try {
    const rows = await p.outdated();
    expect(rows.some((r) => r.status === "blocked")).toBe(true);
    expect(rows.some((r) => r.status === "pinned")).toBe(true);
  } finally {
    overrides.delete("other/1.1.0");
  }
  expect(await p.store.read()).toEqual(before);
  unavailable = true;
  try {
    expect((await p.outdated()).every((r) => r.status === "blocked")).toBe(
      true,
    );
  } finally {
    unavailable = false;
  }
  expect(await p.store.read()).toEqual(before);
  await p.removeSource("main", true);
  expect((await p.outdated("tool"))[0]?.reason).toContain("Original source");
});

test("version cleanup previews, protects defaults, retains N other versions and preserves data/unknown directories", async () => {
  const p = await manager();
  for (const v of versions) await p.install("tool@" + v);
  await p.use("tool@1.0.0");
  const before = await p.store.read(),
    current = Object.values(before.installs).find(
      (i) => i.version === "1.0.0",
    )!;
  await writeFile(join(p.root, current.dir, "data/settings"), "user data");
  await mkdir(join(p.root, "apps/unknown/9"), { recursive: true });
  await writeFile(join(p.root, "apps/unknown/9/keep"), "external");
  const plan = await p.versionCleanupPlan("tool", 1);
  expect(
    plan.entries.filter((e) => e.action === "remove").map((e) => e.version),
  ).toEqual(["2.0.0", "1.1.0"]);
  expect(await p.store.read()).toEqual(before);
  await expect(p.cleanupVersions("tool", 1)).rejects.toThrow("confirmation");
  await p.use("tool@2.0.0");
  await expect(
    p.cleanupVersions("tool", 1, { confirmed: true, binding: plan.binding }),
  ).rejects.toThrow("changed");
  const next = await p.versionCleanupPlan("tool", 0);
  expect(
    (
      await p.cleanupVersions("tool", 0, {
        confirmed: true,
        binding: next.binding,
      })
    ).every((r) => r.status === "removed"),
  ).toBe(true);
  const state = await p.store.read();
  expect(Object.values(state.installs)).toHaveLength(1);
  expect(Object.values(state.installs)[0]?.version).toBe("2.0.0");
  expect(
    await readFile(
      join(
        p.root,
        "persist",
        persistentFolder(current, current.key),
        "data/settings",
      ),
      "utf8",
    ),
  ).toBe("user data");
  expect(await exists(join(p.root, "apps/unknown/9/keep"))).toBe(true);
});

test("version cleanup rejects invalid keep and altered receipts without deleting files", async () => {
  const p = await manager(),
    i = await p.install("tool@1.0.0");
  for (const keep of [-1, 0.5, NaN])
    await expect(p.versionCleanupPlan(undefined, keep)).rejects.toThrow(
      "--keep",
    );
  await atomicJson(join(p.root, i.dir, ".piko-install.json"), {
    ...i,
    checksum: "changed",
  });
  await expect(p.versionCleanupPlan("tool", 0)).rejects.toThrow(
    "receipt drift",
  );
  expect(await exists(join(p.root, i.dir, "tool.exe"))).toBe(true);
});

test("inventory round-trip restores exact versions, channels, command releases and aliases without copying state", async () => {
  const origin = await manager();
  await origin.install("tool@1.0.0");
  await origin.install("tool@1.1.0");
  await origin.use("tool@lts");
  await origin.install("other@1.0.0");
  await origin.use("other@1.0.0", { noCommands: true });
  await origin.aliasCommand("other-tool", "other", "tool");
  const inventory = exportInventory(await origin.store.read()),
    serialized = JSON.stringify(inventory);
  expect(serialized).not.toContain(origin.root);
  expect(serialized).not.toContain("manifestHash");
  expect(serialized).not.toContain("approvals");
  const target = new Packages(join(work, crypto.randomUUID())),
    before = await target.store.read();
  const plan = await planInventory(target, inventory);
  expect(plan.conflicts).toEqual([]);
  expect(await target.store.read()).toEqual(before);
  await expect(importInventory(target, inventory)).rejects.toThrow("--yes");
  await importInventory(target, inventory, {
    confirmed: true,
    binding: plan.binding,
  });
  expect(exportInventory(await target.store.read())).toEqual(inventory);
  const retry = await planInventory(target, inventory);
  expect(retry.conflicts).toEqual([]);
  await importInventory(target, inventory, {
    confirmed: true,
    binding: retry.binding,
  });
  expect(exportInventory(await target.store.read())).toEqual(inventory);
});

test("inventory orders explicit dependencies, preserves selected runtime and rejects cycles", async () => {
  const p = await manager();
  await p.install("runtime@1.0.0");
  await p.use("runtime@1");
  await p.install("consumer@1.0.0");
  await p.use("consumer@1");
  const inventory = exportInventory(await p.store.read());
  const target = new Packages(join(work, crypto.randomUUID())),
    plan = await planInventory(target, inventory);
  expect(plan.order).toEqual(["main/runtime", "main/consumer"]);
  expect(plan.conflicts).toEqual([]);
  await importInventory(target, inventory, {
    confirmed: true,
    binding: plan.binding,
  });
  expect(exportInventory(await target.store.read())).toEqual(inventory);
  const cycle = validateInventory({
    schemaVersion: 1,
    sources: inventory.sources,
    packages: ["cycle-a", "cycle-b"].map((name) => ({
      source: "main",
      name,
      versions: ["1.0.0"],
      selection: { version: "1.0.0", request: "1", commands: [name] },
    })),
    aliases: [],
  });
  overrides.set("cycle-a/1.0.0", { depends: [{ package: "cycle-b" }] });
  overrides.set("cycle-b/1.0.0", { depends: [{ package: "cycle-a" }] });
  try {
    expect((await planInventory(target, cycle)).conflicts).toContain(
      "Inventory dependency cycle",
    );
  } finally {
    overrides.delete("cycle-a/1.0.0");
    overrides.delete("cycle-b/1.0.0");
  }
});

test("inventory refuses credentials and malformed files, does not silently replace existing defaults or sources", async () => {
  const p = await manager();
  await p.install("tool@1.0.0");
  await p.use("tool@1");
  const inventory = exportInventory(await p.store.read());
  const secret = structuredClone(inventory);
  secret.sources[0]!.url += "?token=SECRET";
  expect(() => validateInventory(secret)).toThrow("credentials");
  expect(() => validateInventory({ ...inventory, approvals: {} })).toThrow();
  const duplicate = structuredClone(inventory);
  duplicate.packages[0]!.versions.push("1.0.0");
  expect(() => validateInventory(duplicate)).toThrow("Duplicate");
  const target = await manager();
  await target.install("tool@2.0.0");
  await target.use("tool@2");
  const before = await target.store.read();
  expect(
    (await planInventory(target, inventory)).conflicts.some((c) =>
      c.includes("replace an existing default"),
    ),
  ).toBe(true);
  await expect(
    importInventory(target, inventory, { confirmed: true }),
  ).rejects.toThrow("blocked");
  expect(await target.store.read()).toEqual(before);
  const other = new Packages(join(work, crypto.randomUUID()));
  await other.addSource("main", url + "second/");
  expect(
    (await planInventory(other, inventory)).conflicts.some((c) =>
      c.includes("identity"),
    ),
  ).toBe(true);
});

test("inventory confirmation binds state and manifests; interrupted restore is safely retryable", async () => {
  const p = await manager();
  await p.install("tool@1.0.0");
  await p.use("tool@1");
  const inventory = exportInventory(await p.store.read()),
    target = new Packages(join(work, crypto.randomUUID()));
  const preview = await planInventory(target, inventory);
  await target.store.mutate(async () => {});
  await expect(
    importInventory(target, inventory, {
      confirmed: true,
      binding: preview.binding,
    }),
  ).rejects.toThrow("changed");
  const current = await planInventory(target, inventory);
  overrides.set("tool/1.0.0", { configFiles: { "extra.ini": "new" } });
  try {
    await expect(
      importInventory(target, inventory, {
        confirmed: true,
        binding: current.binding,
      }),
    ).rejects.toThrow("changed");
  } finally {
    overrides.delete("tool/1.0.0");
  }
  const saved = target.install.bind(target);
  let once = true;
  target.install = async (...args) => {
    if (once) {
      once = false;
      throw new Error("simulated network failure");
    }
    return await saved(...args);
  };
  await expect(
    importInventory(target, inventory, { confirmed: true }),
  ).rejects.toThrow("simulated");
  expect(Object.keys((await target.store.read()).sources)).toEqual(["main"]);
  expect(Object.values((await target.store.read()).installs)).toEqual([]);
  await importInventory(target, inventory, { confirmed: true });
  expect(exportInventory(await target.store.read())).toEqual(inventory);
});

test("inventory refuses state or manifest drift between confirmation and installation", async () => {
  const origin = await manager();
  await origin.install("tool@1.0.0");
  await origin.use("tool@1");
  const inventory = exportInventory(await origin.store.read());
  const target = new Packages(join(work, crypto.randomUUID())),
    install = target.install.bind(target);
  target.install = async (...args) => {
    overrides.set("tool/1.0.0", {
      configFiles: { "changed.ini": "not approved" },
    });
    return await install(...args);
  };
  try {
    await expect(
      importInventory(target, inventory, { confirmed: true }),
    ).rejects.toThrow("Manifest changed");
  } finally {
    overrides.delete("tool/1.0.0");
  }
  expect(Object.values((await target.store.read()).installs)).toEqual([]);
  target.install = async (...args) => {
    await target.store.mutate(async () => {});
    return await install(...args);
  };
  await expect(
    importInventory(target, inventory, { confirmed: true }),
  ).rejects.toThrow("State changed");
  expect((await target.store.read()).defaults).toEqual({});
});

test("cleanup rechecks receipts inside the write lock rather than deleting drifted files", async () => {
  const p = await manager(),
    i = await p.install("tool@1.0.0"),
    uninstall = p.uninstall.bind(p);
  p.uninstall = async (...args) => {
    await atomicJson(join(p.root, i.dir, ".piko-install.json"), {
      ...i,
      checksum: "tampered",
    });
    return await uninstall(...args);
  };
  const result = await p.cleanupVersions("tool", 0, { confirmed: true });
  expect(result[0]?.status).toBe("failed");
  expect(result[0]?.error).toContain("receipt changed");
  expect(await exists(join(p.root, i.dir, "tool.exe"))).toBe(true);
  expect((await p.store.read()).installs[i.id]?.id).toBe(i.id);
});

test("dependency channel requests are resolved by their own source", async () => {
  const p = await manager();
  await p.install("runtime@1.0.0");
  await p.use("runtime@1");
  overrides.set("consumer/1.0.0", {
    depends: [{ package: "runtime@lts", commands: ["runtime"] }],
  });
  try {
    expect((await p.install("consumer@1.0.0")).version).toBe("1.0.0");
  } finally {
    overrides.delete("consumer/1.0.0");
  }
});

test("compiled P1 CLI exposes read-only status, runtime distribution, cleanup and confirmed inventory restore", async () => {
  const p = await manager();
  expect(
    (await run(p.root, ["install", "main/java@1", "--distribution", "temurin"]))
      .code,
  ).toBe(0);
  await p.install("tool@1.0.0");
  await p.install("tool@1.1.0");
  await p.use("tool@1");
  const before = await p.store.read();
  const status = await run(p.root, ["status", "main/tool", "--json"]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out)[0].candidate).toBe("1.1.0");
  expect((await run(p.root, ["update", "--all", "--dry-run"])).code).toBe(0);
  expect(await p.store.read()).toEqual(before);
  expect(
    (await run(p.root, ["cleanup", "main/tool", "--versions", "--keep", "0"]))
      .code,
  ).toBe(1);
  expect(
    (
      await run(p.root, [
        "cleanup",
        "main/tool",
        "--versions",
        "--keep",
        "0",
        "--yes",
      ])
    ).code,
  ).toBe(0);
  const file = join(work, "portable inventory.json");
  expect((await run(p.root, ["export", file])).code).toBe(0);
  expect((await run(p.root, ["export", file])).code).toBe(1);
  const target = new Packages(join(work, crypto.randomUUID()));
  const preview = await run(target.root, ["import", file, "--dry-run"]);
  expect(preview.code).toBe(0);
  expect((await run(target.root, ["import", file])).code).toBe(1);
  const restored = await run(target.root, [
    "import",
    file,
    "--yes",
    "--binding",
    JSON.parse(preview.out).binding,
  ]);
  if (restored.code) throw new Error(restored.err);
  expect(restored.code).toBe(0);
  expect(exportInventory(await target.store.read())).toEqual(
    JSON.parse(await readFile(file, "utf8")),
  );
}, 30000);
