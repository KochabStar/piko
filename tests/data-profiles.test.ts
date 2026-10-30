import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import {
  applyPersist,
  planPersist,
  recoverPersist,
  persistJournal,
} from "../src/data-profiles.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-data-profiles-"));
const bytes = Buffer.from("portable fixture payload");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          ["dingtalk", "wechat", "wecom", "tabbit"].map((name) => [
            name,
            { latest: "1", versions: { "1": name + ".json" } },
          ]),
        ),
      });
    if (path === "/file") return new Response(bytes);
    return Response.json({
      schemaVersion: 1,
      name: path.slice(1).replace(/\.json$/, ""),
      version: "1",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          sha256: sha256(bytes),
          format: "file",
          file: "app.exe",
          bin: {},
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
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function fixture(name = "dingtalk") {
  const folder = await mkdtemp(join(work, "case-")),
    p = new Packages(join(folder, "home"));
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const install = await p.install("main/" + name + "@1");
  await p.use("main/" + name + "@1");
  const folders = {
    local: join(folder, "local"),
    roaming: join(folder, "roaming"),
    documents: join(folder, "documents"),
  };
  for (const path of Object.values(folders))
    await mkdir(path, { recursive: true });
  const values = new Map<string, import("../src/types.ts").EffectValue>();
  const context = {
    folders,
    processes: async (_names: string[]) => [] as number[],
    registry: {
      read: async (key: string, name: string) =>
        values.get(key + "/" + name) ?? null,
      write: async (
        key: string,
        name: string,
        before: import("../src/types.ts").EffectValue,
        after: import("../src/types.ts").EffectValue,
      ) => {
        const id = key + "/" + name;
        if (JSON.stringify(values.get(id) ?? null) !== JSON.stringify(before))
          throw Error("Registry changed");
        values.set(id, after);
      },
    },
  };
  return { p, install, context, folders };
}

test("data-path registry settings are bound, restored and reject external drift", async () => {
  const { p, context } = await fixture("wecom");
  const key = "HKCU\\Software\\Tencent\\WXWork",
    name = "DataLocationPath";
  await context.registry.write(key, name, null, {
    type: "String",
    value: "E:\\old-chat",
  });
  const plan = await planPersist(p.store, "main/wecom", false, context);
  expect(plan.settings[0]!.before).toEqual({
    type: "String",
    value: "E:\\old-chat",
  });
  await applyPersist(p.store, "main/wecom", plan.binding, false, context);
  expect(await context.registry.read(key, name)).toEqual(
    plan.settings[0]!.after,
  );
  const remove = await planPersist(p.store, "main/wecom", true, context);
  await applyPersist(p.store, "main/wecom", remove.binding, true, context);
  expect(await context.registry.read(key, name)).toEqual({
    type: "String",
    value: "E:\\old-chat",
  });
});

test("fresh data preview is inert; apply archives but does not import originals, remove restores originals and retains new data", async () => {
  const { p, context, folders } = await fixture(),
    source = join(folders.roaming, "DingTalk");
  await mkdir(source);
  await writeFile(join(source, "old-chat"), "old-private-data");
  const snapshot = await readFile(p.store.statePath, "utf8"),
    plan = await planPersist(p.store, "main/dingtalk", false, context),
    m = plan.mappings[0]!;
  expect(await readdir(source)).toEqual(["old-chat"]);
  expect(await exists(m.target)).toBe(false);
  expect(await exists(m.backup)).toBe(false);
  await expect(
    applyPersist(p.store, "main/dingtalk", "stale", false, context),
  ).rejects.toThrow("preview");
  await applyPersist(p.store, "main/dingtalk", plan.binding, false, context);
  expect(resolve(await readlink(source))).toBe(m.target);
  expect(await readdir(m.target)).toEqual([]);
  const receipt = JSON.parse(
    await readFile(join(p.root, "apps/piko/data-profiles.json"), "utf8"),
  );
  const actual = Object.values(receipt.profiles)[0] as any;
  expect(
    await readFile(join(actual.mappings[0].backup, "old-chat"), "utf8"),
  ).toBe("old-private-data");
  await writeFile(join(source, "new-chat"), "new-data");
  expect(await readFile(join(m.target, "new-chat"), "utf8")).toBe("new-data");
  await expect(p.uninstall("main/dingtalk@1", true)).rejects.toThrow(
    "data-profile",
  );
  const remove = await planPersist(p.store, "main/dingtalk", true, context);
  await applyPersist(p.store, "main/dingtalk", remove.binding, true, context);
  expect(await readFile(join(source, "old-chat"), "utf8")).toBe(
    "old-private-data",
  );
  expect(await readFile(join(m.target, "new-chat"), "utf8")).toBe("new-data");
  expect(await readFile(p.store.statePath, "utf8")).toBe(snapshot);
  expect(await exists(persistJournal(p.root))).toBe(false);
});

test("running processes fail closed before mutation, including an app starting after preview", async () => {
  const { p, context } = await fixture("tabbit");
  let busy = false;
  context.processes = async () => (busy ? [123] : []);
  const plan = await planPersist(p.store, "main/tabbit", false, context);
  busy = true;
  await expect(
    applyPersist(p.store, "main/tabbit", plan.binding, false, context),
  ).rejects.toThrow("Close application");
  expect(
    (await planPersist(p.store, "main/tabbit", false, context)).blockedPids,
  ).toEqual([123]);
  expect(await exists(plan.mappings[0]!.target)).toBe(false);
  expect(await exists(persistJournal(p.root))).toBe(false);
});

test("preexisting target, linked source and stale source fingerprints never merge or overwrite", async () => {
  const { p, context, folders } = await fixture(),
    plan = await planPersist(p.store, "main/dingtalk", false, context),
    m = plan.mappings[0]!;
  await mkdir(m.target, { recursive: true });
  await writeFile(join(m.target, "keep"), "keep");
  await expect(
    applyPersist(p.store, "main/dingtalk", plan.binding, false, context),
  ).rejects.toThrow("Unowned");
  expect(await readFile(join(m.target, "keep"), "utf8")).toBe("keep");
  await rm(m.target, { recursive: true });
  const external = join(folders.local, "external");
  await mkdir(external);
  await symlink(external, m.source, "junction");
  await expect(
    planPersist(p.store, "main/dingtalk", false, context),
  ).rejects.toThrow("linked");
  await unlink(m.source);
  const current = await planPersist(p.store, "main/dingtalk", false, context);
  await mkdir(m.source);
  await expect(
    applyPersist(p.store, "main/dingtalk", current.binding, false, context),
  ).rejects.toThrow("preview");
});

test("multiple fixed user paths are redirected together; missing originals restore to absence", async () => {
  const { p, context } = await fixture("wecom"),
    plan = await planPersist(p.store, "main/wecom", false, context);
  expect(plan.mappings).toHaveLength(2);
  await applyPersist(p.store, "main/wecom", plan.binding, false, context);
  for (const m of plan.mappings)
    expect(resolve(await readlink(m.source))).toBe(m.target);
  const remove = await planPersist(p.store, "main/wecom", true, context);
  await applyPersist(p.store, "main/wecom", remove.binding, true, context);
  for (const m of plan.mappings) {
    expect(await exists(m.source)).toBe(false);
    expect(await exists(m.target)).toBe(true);
  }
});

test("drifted junctions and mutated original archives block removal without deleting either copy", async () => {
  const { p, context, folders } = await fixture(),
    source = join(folders.roaming, "DingTalk");
  await mkdir(source);
  const plan = await planPersist(p.store, "main/dingtalk", false, context);
  await applyPersist(p.store, "main/dingtalk", plan.binding, false, context);
  const receipt = JSON.parse(
      await readFile(join(p.root, "apps/piko/data-profiles.json"), "utf8"),
    ),
    profile = Object.values(receipt.profiles)[0] as any,
    m = profile.mappings[0];
  const removal = await planPersist(p.store, "main/dingtalk", true, context);
  await writeFile(join(m.backup, "later-edit"), "keep");
  await expect(
    applyPersist(p.store, "main/dingtalk", removal.binding, true, context),
  ).rejects.toThrow("Archived original");
  expect(await exists(join(m.backup, "later-edit"))).toBe(true);
  expect(resolve(await readlink(source))).toBe(m.target);
});

test("recovery validates exact fixed paths, blocks normal reads and rolls forward partially archived data", async () => {
  const { p, install, context, folders } = await fixture(),
    source = join(folders.roaming, "DingTalk");
  await mkdir(source);
  await writeFile(join(source, "old"), "old");
  const plan = await planPersist(p.store, "main/dingtalk", false, context),
    m = plan.mappings[0]!,
    operation = m.backup.split(".piko-before-").at(-1)!;
  const profile = {
      name: install.name,
      key: install.key,
      identity: install.source.identity,
      operation,
      mappings: plan.mappings,
      settings: [],
    },
    before = { schemaVersion: 1, profiles: {} },
    after = { schemaVersion: 1, profiles: { [install.key]: profile } },
    journal = { schemaVersion: 1, action: "enable", profile, before, after };
  await atomicJson(persistJournal(p.root), journal);
  await expect(p.store.read()).rejects.toThrow("persist --recover");
  await rename(source, m.backup);
  await recoverPersist(p.store, context);
  expect(resolve(await readlink(source))).toBe(m.target);
  expect(await readFile(join(m.backup, "old"), "utf8")).toBe("old");
  expect(await exists(persistJournal(p.root))).toBe(false);
  const removal = await planPersist(p.store, "main/dingtalk", true, context);
  await applyPersist(p.store, "main/dingtalk", removal.binding, true, context);
  // A forged journal can never redirect to an arbitrary external destination.
  journal.profile.mappings[0]!.target = join(folders.local, "unowned");
  await atomicJson(persistJournal(p.root), journal);
  await expect(recoverPersist(p.store, context)).rejects.toThrow("ownership");
  expect(await readFile(join(source, "old"), "utf8")).toBe("old");
  await unlink(persistJournal(p.root));
});
