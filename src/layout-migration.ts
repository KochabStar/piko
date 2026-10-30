import {
  mkdir,
  readFile,
  readdir,
  rename,
  lstat,
  readlink,
  unlink,
  symlink,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  appFolder,
  installDirectory,
  packageFolder,
  persistentFolder,
} from "./layout.ts";
import { atomicJson, exists, fail, json, noLinks, sha256 } from "./util.ts";
import { Store, validateState } from "./store.ts";
import type { Install, State } from "./types.ts";

function targetState(before: State): State {
  validateState(before);
  const after = structuredClone(before),
    owners = new Map<string, string>();
  if (
    Object.keys(before.desktop ?? {}).length ||
    Object.keys(before.admin ?? {}).length ||
    Object.keys(before.bootstraps ?? {}).length ||
    Object.values(before.profiles ?? {}).some(
      (p) => Object.keys(p.approvals).length,
    )
  )
    fail(
      "Revoke active desktop, system, bootstrap and Shell approvals before directory migration",
    );
  const own = (name: string, source: Install["source"]) => {
    const folder = packageFolder(source, name).toLowerCase(),
      identity = JSON.stringify([source.identity, name]);
    if (owners.has(folder) && owners.get(folder) !== identity)
      fail(
        "Same-name sources collide in readable directories; reconcile explicitly before migration",
      );
    owners.set(folder, identity);
  };
  for (const i of Object.values(after.installs)) {
    own(i.name, i.source);
    if (i.kind !== "portable" && i.layout !== "named-v1")
      fail(
        "npm directory migration requires reinstall/export-lock; native portable installations may migrate",
      );
    i.layout = "named-v1";
    i.dir = installDirectory(i.source, i.name, i.version, i.key, i.layout);
  }
  for (const data of Object.values(after.data ?? {})) {
    own(data.name, data.source);
    data.layout = "named-v1";
  }
  after.schemaVersion = 8;
  after.revision = before.revision + 1;
  validateState(after);
  return after;
}
export async function planLayout(root: string) {
  const state = await new Store(root).read(),
    after = targetState(state);
  return {
    schemaVersion: 1,
    revision: state.revision,
    changes: Object.values(state.installs)
      .filter((i) => i.dir !== after.installs[i.id]!.dir)
      .map((i) => ({
        name: i.name,
        version: i.version,
        from: i.dir,
        to: after.installs[i.id]!.dir,
      })),
    data: Object.entries(state.data ?? {})
      .filter(
        ([key, d]) =>
          persistentFolder(d, key) !== persistentFolder(after.data![key]!, key),
      )
      .map(([key, d]) => ({
        name: d.name,
        from: join("persist", persistentFolder(d, key)),
        to: join("persist", persistentFolder(after.data![key]!, key)),
      })),
    binding: sha256(JSON.stringify([resolve(root), state, after])),
  };
}
async function withoutLock<T>(root: string, fn: () => Promise<T>) {
  await noLinks(root);
  const lock = join(root, "mutation.lock");
  try {
    await mkdir(lock);
  } catch {
    fail(
      "Another operation holds mutation.lock; inspect before directory migration",
    );
  }
  try {
    await atomicJson(join(lock, "owner.json"), {
      pid: process.pid,
      started: new Date().toISOString(),
    });
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
function stable(value: unknown) {
  return JSON.stringify(value);
}
async function preflight(root: string, before: State, after: State) {
  for (const name of [
    "persist",
    "install",
    "selection",
    "removal",
    "npm-rebuild",
    "data-removal",
    "self-update",
    "profile",
    "desktop",
  ]) {
    if (await exists(join(root, "operations", name + ".json")))
      fail("Finish existing operation before directory migration: " + name);
  }
  const groups = new Map<string, Install[]>();
  for (const i of Object.values(before.installs)) {
    const next = after.installs[i.id]!;
    await noLinks(join(root, i.dir));
    await noLinks(join(root, next.dir));
    if (i.dir !== next.dir && (await exists(join(root, next.dir))))
      fail("Readable version destination already exists: " + next.dir);
    if (
      appFolder(i) !== appFolder(next) &&
      (await exists(dirname(join(root, next.dir))))
    )
      fail("Readable package destination already exists: " + appFolder(next));
    if (
      stable(await json(join(root, i.dir, ".piko-install.json"))) !== stable(i)
    )
      fail("Installation receipt drift before directory migration");
    const group = appFolder(i);
    groups.set(group, [...(groups.get(group) ?? []), i]);
    const walk = async (dir: string, rel = ""): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, e.name),
          r = rel ? rel + "/" + e.name : e.name,
          s = await lstat(path);
        if (s.isSymbolicLink()) {
          if (
            !i.persist.includes(r) ||
            i.persistFiles?.[r] ||
            resolve(await readlink(path)).toLowerCase() !==
              resolve(
                join(root, "persist", persistentFolder(i, i.key), r),
              ).toLowerCase()
          )
            fail("Unexpected application link blocks directory migration");
        } else if (s.isDirectory()) await walk(path, r);
      }
    };
    await walk(join(root, i.dir));
    if (i.dir !== next.dir) {
      const manifest = JSON.parse(
        await readFile(
          join(root, "sources", i.source.identity, "index.json"),
          "utf8",
        ),
      );
      if (!manifest.packages[i.name])
        fail("Source index missing during migration");
      const sourceFile = manifest.packages[i.name].versions[i.version];
      const { loadManifest } = await import("./catalog.ts");
      const m = await loadManifest(
        root,
        i.source,
        sourceFile,
        i.name,
        i.version,
      );
      if (
        m.platforms["windows-x64"]?.configTemplates &&
        Object.keys(m.platforms["windows-x64"]!.configTemplates ?? {}).length
      )
        fail(
          "Path-bound configTemplates require explicit re-render/review before migration",
        );
    }
  }
  for (const [folder, installs] of groups) {
    const parent = join(root, "apps", folder),
      allowed = new Set(installs.map((i) => i.dir.split(/[\\/]/).at(-1)!));
    allowed.add("current");
    for (const e of await readdir(parent))
      if (!allowed.has(e))
        fail(
          "Untracked application content blocks directory migration: " +
            parent +
            "/" +
            e,
        );
    const current = join(parent, "current");
    if (await exists(current)) {
      const info = await lstat(current);
      if (!info.isSymbolicLink())
        fail("External current directory blocks migration");
      const target = resolve(await readlink(current));
      if (
        !info.isSymbolicLink() ||
        !installs.some(
          (i) =>
            resolve(join(root, i.dir)).toLowerCase() === target.toLowerCase(),
        )
      )
        fail("Unowned current link blocks migration");
    }
  }
  for (const [key, data] of Object.entries(before.data ?? {})) {
    const from = join(root, "persist", persistentFolder(data, key)),
      to = join(root, "persist", persistentFolder(after.data![key]!, key));
    await noLinks(from);
    await noLinks(to);
    if (from !== to && (await exists(to)))
      fail("Readable persistent data destination already exists");
  }
}
export async function migrateLayout(root: string, binding: string) {
  const plan = await planLayout(root);
  if (plan.binding !== binding)
    fail("Directory migration changed; preview again");
  if (!plan.changes.length && !plan.data.length)
    return { status: "already-readable", ...plan };
  return withoutLock(root, async () => {
    const before = await new Store(root).read(),
      after = targetState(before);
    if (sha256(JSON.stringify([resolve(root), before, after])) !== binding)
      fail("State changed since directory migration preview");
    await preflight(root, before, after);
    const operation = "layout-" + crypto.randomUUID(),
      backup = join(root, "apps/piko/layout-backups", operation);
    await noLinks(backup);
    await mkdir(backup, { recursive: true });
    await atomicJson(join(backup, "state-before.json"), before);
    for (const i of Object.values(before.installs))
      await atomicJson(join(backup, i.id + ".json"), i);
    await atomicJson(join(root, "operations/layout.json"), {
      schemaVersion: 1,
      operation,
      before,
      after,
      binding,
    });
    await finishLayout(root);
    return { status: "completed", backup, ...plan };
  });
}
export async function recoverLayout(root: string) {
  return withoutLock(root, async () => {
    await finishLayout(root);
    return { status: "recovered" };
  });
}
async function finishLayout(root: string) {
  const journal = join(root, "operations/layout.json");
  await noLinks(journal);
  if (!(await exists(journal))) return;
  const entry = await json(journal);
  if (
    entry.schemaVersion !== 1 ||
    !/^layout-[0-9a-f-]{36}$/.test(entry.operation)
  )
    fail("Invalid directory migration journal");
  const before = entry.before as State,
    after = targetState(before);
  if (
    stable(after) !== stable(entry.after) ||
    sha256(JSON.stringify([resolve(root), before, after])) !== entry.binding
  )
    fail("Directory migration journal differs from validated state");
  const current = await json(join(root, "apps/piko/state.json"));
  if (stable(current) !== stable(before) && stable(current) !== stable(after))
    fail("State changed during pending directory migration");
  // Stop all launches until every move and replacement link is complete.
  const parents = new Map<string, Install[]>();
  for (const i of Object.values(before.installs)) {
    const folder = appFolder(i);
    parents.set(folder, [...(parents.get(folder) ?? []), i]);
  }
  for (const [folder, installs] of parents) {
    const path = join(root, "apps", folder, "current");
    if (await exists(path)) {
      const info = await lstat(path);
      const target = resolve(await readlink(path)).toLowerCase();
      const allowed = installs
        .flatMap((i) => [
          join(root, i.dir),
          join(root, after.installs[i.id]!.dir),
        ])
        .some((p) => resolve(p).toLowerCase() === target);
      if (!info.isSymbolicLink() || !allowed)
        fail("Current link drift during migration");
      await unlink(path);
    }
  }
  for (const [key, data] of Object.entries(before.data ?? {})) {
    const from = join(root, "persist", persistentFolder(data, key)),
      to = join(root, "persist", persistentFolder(after.data![key]!, key));
    if (from === to) continue;
    await noLinks(from);
    await noLinks(to);
    if (await exists(from)) {
      if (await exists(to))
        fail("Both persistent data paths exist; preserve and inspect");
      await rename(from, to);
    } else if (!(await exists(to)))
      fail("Persistent data source/destination missing");
  }
  for (const i of Object.values(before.installs)) {
    const next = after.installs[i.id]!,
      from = join(root, i.dir),
      to = join(root, next.dir);
    await noLinks(from);
    await noLinks(to);
    if (from !== to && (await exists(from))) {
      if (await exists(to))
        fail("Both application paths exist; inspect before recovery");
      if (stable(await json(join(from, ".piko-install.json"))) !== stable(i))
        fail("Receipt changed during directory migration");
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
    }
    if (!(await exists(to))) fail("Application source/destination missing");
    const receipt = await json(join(to, ".piko-install.json"));
    if (stable(receipt) !== stable(i) && stable(receipt) !== stable(next))
      fail("Unrecognized migrated receipt");
    for (const path of i.persist) {
      if (i.persistFiles?.[path]) continue;
      const link = join(to, path),
        old = join(root, "persist", persistentFolder(i, i.key), path),
        target = join(root, "persist", persistentFolder(next, next.key), path);
      if (await exists(link)) {
        const info = await lstat(link);
        if (!info.isSymbolicLink())
          fail("Persistent link is not a managed junction");
        const actual = resolve(await readlink(link)).toLowerCase();
        if (
          ![resolve(old).toLowerCase(), resolve(target).toLowerCase()].includes(
            actual,
          )
        )
          fail("Persistent link target changed");
        await unlink(link);
      }
      await symlink(resolve(target), link, "junction");
    }
    await atomicJson(join(to, ".piko-install.json"), next);
  }
  for (const selection of Object.values(after.defaults)) {
    const i = after.installs[selection.id]!,
      path = join(root, "apps", appFolder(i), "current");
    if (await exists(path)) {
      const info = await lstat(path);
      if (
        !info.isSymbolicLink() ||
        resolve(await readlink(path)).toLowerCase() !==
          resolve(join(root, i.dir)).toLowerCase()
      )
        fail("New current destination occupied");
    } else await symlink(resolve(join(root, i.dir)), path, "junction");
  }
  await atomicJson(join(root, "apps/piko/state.json"), after);
  for (const folder of parents.keys()) {
    if (Object.values(after.installs).some((i) => appFolder(i) === folder))
      continue;
    const path = join(root, "apps", folder);
    await noLinks(path);
    if (await exists(path)) {
      if ((await readdir(path)).length)
        fail("Unexpected old-directory content; inspect before finishing");
      await rmdir(path);
    }
  }
  await rm(journal);
}
