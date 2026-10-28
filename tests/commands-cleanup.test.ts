import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { validateState } from "../src/store.ts";
import { resolveCommand } from "../src/commands.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const root = await mkdtemp(join(tmpdir(), "piko-next-"));
const bytes = new TextEncoder().encode("fixture-native-executable");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/artifact.exe") return new Response(bytes);
    if (url.pathname.endsWith("index.json"))
      return Response.json({
        schemaVersion: 1,
        packages: {
          first: {
            latest: "2.0.0",
            versions: { "1.0.0": "first-1.json", "2.0.0": "first-2.json" },
          },
          second: { latest: "1.0.0", versions: { "1.0.0": "second-1.json" } },
          stored: { latest: "1.0.0", versions: { "1.0.0": "stored-1.json" } },
        },
      });
    const basename = url.pathname.split("/").at(-1)!;
    const [name, series] = basename.replace(".json", "").split("-");
    if (!["first", "second", "stored"].includes(name!))
      return new Response("not found", { status: 404 });
    return Response.json({
      schemaVersion: 1,
      name,
      version: series === "2" ? "2.0.0" : "1.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/artifact.exe`,
          sha256: sha256(bytes),
          format: "file",
          file: "app.exe",
          bin: { tool: "app.exe" },
          ...(name === "stored" ? { persist: ["settings"] } : {}),
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function manager(name: string) {
  const p = new Packages(join(root, name));
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  return p;
}

test("explicit claim transfers only one command and survives version selection", async () => {
  const p = await manager("claim"),
    first = await p.install("first@1.0.0"),
    second = await p.install("second@1.0.0");
  await p.use("first@1.0.0");
  await p.use("second@1.0.0", { noCommands: true });
  expect((await p.store.read()).commands.tool).toBe(first.key);
  await p.claimCommand("tool", "second");
  let state = await p.store.read();
  expect(state.commands.tool).toBe(second.key);
  expect(state.defaults[first.key]?.id).toBe(first.id);
  await p.install("first@2.0.0");
  await p.use("first@2.0.0");
  state = await p.store.read();
  expect(state.commands.tool).toBe(second.key);
  expect(resolveCommand(state, "tool").install.id).toBe(second.id);
  await expect(p.claimCommand("missing", "first")).rejects.toThrow("provide");
  await p.unuse("second");
  expect((await p.store.read()).commands.tool).toBeUndefined();
});

test("aliases target real package commands, follow default versions and reject implicit overwrite", async () => {
  const p = await manager("alias"),
    first = await p.install("first@1.0.0");
  await p.install("first@2.0.0");
  await p.install("second@1.0.0");
  await p.use("first@1.0.0");
  await p.use("second@1.0.0", { noCommands: true });
  await p.aliasCommand("first-tool", "first", "tool");
  await p.aliasCommand("second-tool", "second", "tool");
  let state = await p.store.read();
  expect(resolveCommand(state, "first-tool").bin.path).toBe("app.exe");
  expect(resolveCommand(state, "first-tool").provided).toBe("tool");
  await p.use("first@2.0.0");
  state = await p.store.read();
  expect(resolveCommand(state, "first-tool").install.version).toBe("2.0.0");
  await expect(p.aliasCommand("tool", "second", "tool")).rejects.toThrow(
    "already",
  );
  await expect(p.aliasCommand("first-tool", "second", "tool")).rejects.toThrow(
    "already",
  );
  await expect(p.aliasCommand("piko", "first", "tool")).rejects.toThrow(
    "Reserved",
  );
  await expect(
    p.aliasCommand("recursive", "first", "first-tool"),
  ).rejects.toThrow("provide");
  await expect(p.claimCommand("first-tool", "first")).rejects.toThrow();
  await p.removeAlias("second-tool");
  expect((await p.store.read()).aliases?.["second-tool"]).toBeUndefined();
  await expect(p.removeAlias("tool")).rejects.toThrow("alias");
  await p.unuse("first");
  expect((await p.store.read()).aliases?.["first-tool"]).toBeUndefined();
  expect(await exists(join(p.root, "apps", first.key, "current"))).toBe(false);
});

test("invalid alias state is rejected and schema 1 remains readable before upgrade", async () => {
  const p = await manager("migration"),
    i = await p.install("first@1.0.0");
  await p.use("first@1.0.0");
  const state = await p.store.read();
  state.schemaVersion = 1;
  delete state.aliases;
  delete state.data;
  for (const selection of Object.values(state.defaults))
    delete selection.commands;
  await atomicJson(p.store.statePath, state);
  expect((await p.store.read()).schemaVersion).toBe(1);
  await p.aliasCommand("old-tool", "first", "tool");
  const updated = await p.store.read();
  expect(updated.schemaVersion).toBe(2);
  const bad = structuredClone(updated);
  bad.aliases!["tool"] = { key: i.key, command: "tool" };
  expect(() => validateState(bad)).toThrow();
  const stale = structuredClone(updated);
  stale.aliases!["bad"] = { key: i.key, command: "nonexistent" };
  expect(() => validateState(stale)).toThrow();
});

test("cleanup previews exact owned directories and requires confirmation after all versions are removed", async () => {
  const p = await manager("cleanup"),
    i = await p.install("stored@1.0.0"),
    data = join(p.root, "persist", i.key, "settings");
  await writeFile(join(data, "keep.txt"), "user-data");
  await expect(p.cleanupData("stored", { confirmed: true })).rejects.toThrow(
    "installed",
  );
  await p.uninstall("stored@1.0.0");
  expect(await readFile(join(data, "keep.txt"), "utf8")).toBe("user-data");
  const outside = join(p.root, "persist", i.key, "untracked.txt");
  await writeFile(outside, "not-owned");
  const preview = await p.cleanupData("main/stored", { dryRun: true });
  expect(preview.paths).toEqual([data]);
  await expect(p.cleanupData("stored")).rejects.toThrow("confirmation");
  expect(await exists(data)).toBe(true);
  await p.cleanupData("stored", {
    confirmed: true,
    expectedPaths: preview.paths,
  });
  expect(await exists(data)).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("not-owned");
  expect((await p.store.read()).data?.[i.key]).toBeUndefined();
});

test("cleanup refuses linked data, changed confirmation targets and ambiguous package sources", async () => {
  const p = await manager("cleanup-guards"),
    i = await p.install("stored@1.0.0");
  await p.uninstall("stored@1.0.0");
  const target = join(p.root, "persist", i.key, "settings"),
    external = join(root, "outside-data");
  await mkdir(external);
  await writeFile(join(external, "keep"), "external");
  await symlink(external, join(target, "external"), "junction");
  await expect(p.cleanupData("stored", { confirmed: true })).rejects.toThrow(
    "link",
  );
  expect(await readFile(join(external, "keep"), "utf8")).toBe("external");
  await rm(join(target, "external"));
  await expect(
    p.cleanupData("stored", {
      confirmed: true,
      expectedPaths: ["C:\\not-the-confirmed-directory"],
    }),
  ).rejects.toThrow("changed");
  await p.addSource("second", `http://127.0.0.1:${server.port}/second/`);
  await p.install("second/stored@1.0.0");
  await p.uninstall("second/stored@1.0.0");
  await expect(p.cleanupData("stored", { dryRun: true })).rejects.toThrow(
    "Ambiguous",
  );
  expect((await p.cleanupData("main/stored", { dryRun: true })).paths).toEqual([
    target,
  ]);
});

test("cleanup journal restores moved data before state commit and deletes only committed trash afterwards", async () => {
  const p = await manager("cleanup-recovery"),
    i = await p.install("stored@1.0.0");
  await p.uninstall("stored@1.0.0");
  const state = await p.store.read(),
    proof = state.data![i.key]!,
    data = join(p.root, "persist", i.key, "settings");
  await writeFile(join(data, "keep"), "recoverable");
  const operation = "data-cleanup-" + crypto.randomUUID(),
    stage = join(p.root, "staging", operation);
  await mkdir(stage, { recursive: true });
  await atomicJson(join(stage, ".piko-cleanup.json"), {
    key: i.key,
    data: proof,
  });
  await atomicJson(p.store.dataRemovalPath, {
    key: i.key,
    data: proof,
    operation,
  });
  const { rename } = await import("node:fs/promises");
  await rename(data, join(stage, "0"));
  await p.store.mutate(async () => {});
  expect(await readFile(join(data, "keep"), "utf8")).toBe("recoverable");
  expect(await exists(stage)).toBe(false);
  const operation2 = "data-cleanup-" + crypto.randomUUID(),
    stage2 = join(p.root, "staging", operation2);
  await mkdir(stage2, { recursive: true });
  await atomicJson(join(stage2, ".piko-cleanup.json"), {
    key: i.key,
    data: proof,
  });
  await atomicJson(p.store.dataRemovalPath, {
    key: i.key,
    data: proof,
    operation: operation2,
  });
  await rename(data, join(stage2, "0"));
  const committed = await p.store.read();
  committed.revision++;
  delete committed.data![i.key];
  await atomicJson(p.store.statePath, committed);
  await p.store.mutate(async () => {});
  expect(await exists(stage2)).toBe(false);
  expect(await exists(data)).toBe(false);
});

test("alias changes recover with default state without writing through current", async () => {
  const p = await manager("alias-recover"),
    i = await p.install("first@1.0.0");
  await p.use("first@1.0.0");
  const before = await p.store.read(),
    after = structuredClone(before);
  after.revision++;
  after.aliases ??= {};
  after.aliases["new-alias"] = { key: i.key, command: "tool" };
  await atomicJson(p.store.journalPath, { before, after });
  await p.store.mutate(async () => {});
  expect((await p.store.read()).aliases?.["new-alias"]).toBeUndefined();
  expect(
    resolve(
      await readlink(join(p.root, "apps", i.key, "current")),
    ).toLowerCase(),
  ).toBe(resolve(join(p.root, i.dir)).toLowerCase());
});
