import {
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSpec } from "./catalog.ts";
import { validateState } from "./store.ts";
import { persistentFolder } from "./layout.ts";
import {
  atomicJson,
  capture,
  exists,
  fail,
  json,
  noLinks,
  record,
  sha256,
} from "./util.ts";
import { powershellExecutable } from "./windows.ts";
import { nativeRequest, equalValue } from "./windows-effects.ts";
import type { EffectValue } from "./types.ts";
import type { Store } from "./store.ts";
import type { Install, State } from "./types.ts";

type Folders = { local: string; roaming: string; documents: string };
type Context = {
  folders?: Folders;
  processes?: (names: string[]) => Promise<number[]>;
  registry?: {
    read(key: string, name: string): Promise<EffectValue>;
    write(
      key: string,
      name: string,
      before: EffectValue,
      after: EffectValue,
    ): Promise<void>;
  };
};
type Mapping = {
  slot: string;
  source: string;
  target: string;
  backup: string;
  existed: boolean;
  fingerprint: string | null;
};
type Profile = {
  name: string;
  key: string;
  identity: string;
  operation: string;
  mappings: Mapping[];
  settings: Setting[];
};
type Setting = {
  key: string;
  name: string;
  before: EffectValue;
  after: EffectValue;
};
type Profiles = { schemaVersion: 1; profiles: Record<string, Profile> };
type Journal = {
  schemaVersion: 1;
  action: "enable" | "remove";
  profile: Profile;
  before: Profiles;
  after: Profiles;
};
const recipes: Record<
  string,
  { processes: string[]; paths: [string, keyof Folders, string][] }
> = {
  tabbit: {
    processes: ["Tabbit Browser.exe"],
    paths: [["user-data", "local", "Tabbit Browser/User Data"]],
  },
  dingtalk: {
    processes: ["DingTalk.exe", "DingTalkUpdater.exe", "DingtalkLauncher.exe"],
    paths: [["roaming", "roaming", "DingTalk"]],
  },
  wechat: {
    processes: ["Weixin.exe", "WeChat.exe", "WeChatAppEx.exe"],
    paths: [
      ["roaming", "roaming", "Tencent/xwechat"],
      ["files", "documents", "xwechat_files"],
    ],
  },
  wecom: {
    processes: [
      "WXWork.exe",
      "WXWorkWeb.exe",
      "WXWorkXNet.exe",
      "WeChatAppEx.exe",
    ],
    paths: [
      ["roaming", "roaming", "Tencent/WXWork"],
      ["files", "documents", "WXWork"],
    ],
  },
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const persistJournal = (root: string) =>
  join(root, "operations/persist.json");
const receiptFile = (root: string) =>
  join(root, "apps/piko/data-profiles.json");
async function folders(context: Context): Promise<Folders> {
  if (context.folders) return context.folders;
  const {
    LOCALAPPDATA: local,
    APPDATA: roaming,
    USERPROFILE: home,
  } = process.env;
  if (!local || !roaming || !home)
    fail("Windows profile folders are unavailable");
  const known = await nativeRequest({ op: "folders" });
  if (!known.documents) fail("Windows Documents folder is unavailable");
  return { local, roaming, documents: known.documents };
}
async function running(name: string, context: Context) {
  const names = recipes[name]!.processes;
  if (context.processes) return await context.processes(names);
  const script =
    "$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1');$names=$env:PIKO_DATA_PROCESS_NAMES|ConvertFrom-Json;ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$names -contains $_.Name}|ForEach-Object {[int]$_.ProcessId})";
  return JSON.parse(
    await capture(
      powershellExecutable(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, PIKO_DATA_PROCESS_NAMES: JSON.stringify(names) },
      },
    ),
  ) as number[];
}
async function paths(
  root: string,
  install: Pick<Install, "name" | "key" | "source" | "layout">,
  operation: string,
  context: Context,
) {
  const recipe =
    recipes[install.name] ??
    fail("No reviewed fresh-data profile for this package");
  const base = await folders(context);
  return recipe.paths.map(([slot, kind, path]) => {
    const source = resolve(base[kind], path);
    return {
      slot,
      source,
      target: resolve(
        root,
        "persist",
        persistentFolder(install, install.key),
        "profile",
        slot,
      ),
      backup: source + ".piko-before-" + operation,
    };
  });
}
function settingsFor(name: string, mappings: Mapping[]) {
  const files = mappings.find((m) => m.slot === "files");
  return name === "wecom"
    ? [
        {
          key: "HKCU\\Software\\Tencent\\WXWork",
          name: "DataLocationPath",
          after: { type: "String" as const, value: files!.target },
        },
      ]
    : name === "wechat"
      ? [
          {
            key: "HKCU\\Software\\Tencent\\Weixin",
            name: "FileSavePath",
            after: { type: "String" as const, value: files!.target },
          },
        ]
      : [];
}
async function readSetting(
  context: Context,
  key: string,
  name: string,
): Promise<EffectValue> {
  return context.registry
    ? context.registry.read(key, name)
    : nativeRequest({ op: "read", key, name });
}
async function writeSetting(context: Context, s: Setting, remove: boolean) {
  const before = remove ? s.after : s.before,
    after = remove ? s.before : s.after;
  if (context.registry)
    await context.registry.write(s.key, s.name, before, after);
  else
    await nativeRequest({
      op: "write",
      key: s.key,
      name: s.name,
      before,
      value: after,
    });
}
async function readProfiles(root: string): Promise<Profiles> {
  const path = receiptFile(root);
  await noLinks(path);
  const value = (await exists(path))
    ? await json(path)
    : { schemaVersion: 1, profiles: {} };
  if (!record(value) || value.schemaVersion !== 1 || !record(value.profiles))
    fail("Invalid data-profile receipts");
  return value as Profiles;
}
function installation(state: State, spec: string) {
  const parsed = parseSpec(spec);
  const matches = Object.values(state.installs).filter(
    (i) =>
      i.name === parsed.name &&
      (!parsed.source || i.source.alias === parsed.source) &&
      (!parsed.request || i.version === parsed.request),
  );
  const selected = matches.filter((i) => state.defaults[i.key]?.id === i.id);
  if (
    selected.length !== 1 ||
    !selected[0]!.verified ||
    selected[0]!.kind !== "portable"
  )
    fail("Select one verified portable package before fresh-data integration");
  const install = selected[0]!;
  if (install.layout !== "named-v1")
    fail("Migrate to named directories before fresh-data integration");
  if (
    install.persist.some(
      (p) =>
        p.toLowerCase() === "profile" || p.toLowerCase().startsWith("profile/"),
    )
  )
    fail("Profile directory conflicts with package persistence declaration");
  return install;
}
async function fingerprint(path: string) {
  await noLinks(path);
  if (!(await exists(path))) return null;
  const info = await lstat(path);
  if (!info.isDirectory())
    fail("External profile is not an ordinary directory");
  return JSON.stringify([String(info.dev), String(info.ino), info.mtimeMs]);
}
async function isOwnedLink(mapping: Mapping) {
  await noLinks(dirname(mapping.source));
  if (!(await exists(mapping.source))) return false;
  const info = await lstat(mapping.source);
  return (
    info.isSymbolicLink() &&
    resolve(await readlink(mapping.source)).toLowerCase() ===
      mapping.target.toLowerCase()
  );
}
async function validateProfile(
  root: string,
  state: State,
  value: Profile,
  context: Context,
) {
  if (!record(value) || !recipes[value.name] || !uuid.test(value.operation))
    fail("Invalid data-profile operation");
  const install = Object.values(state.installs).find(
    (i) =>
      i.key === value.key &&
      i.name === value.name &&
      i.source.identity === value.identity,
  );
  if (!install)
    fail("Data-profile owner is not installed; preserve receipts and data");
  const expected = await paths(root, install, value.operation, context);
  const settingPaths = settingsFor(value.name, value.mappings);
  if (
    !Array.isArray(value.settings) ||
    value.settings.length !== settingPaths.length
  )
    fail("Invalid data-profile settings");
  for (let n = 0; n < settingPaths.length; n++) {
    const setting = value.settings[n]!,
      e = settingPaths[n]!;
    if (
      setting.key !== e.key ||
      setting.name !== e.name ||
      !equalValue(setting.after, e.after) ||
      (setting.before !== null &&
        (!("type" in setting.before) ||
          !["String", "ExpandString"].includes(setting.before.type) ||
          typeof setting.before.value !== "string"))
    )
      fail("Data-profile setting ownership changed");
  }
  if (
    !Array.isArray(value.mappings) ||
    value.mappings.length !== expected.length
  )
    fail("Invalid data-profile mappings");
  for (let n = 0; n < expected.length; n++) {
    const m = value.mappings[n]!;
    if (
      !same(
        { slot: m.slot, source: m.source, target: m.target, backup: m.backup },
        expected[n],
      ) ||
      typeof m.existed !== "boolean" ||
      !(m.fingerprint === null || typeof m.fingerprint === "string") ||
      m.existed !== (m.fingerprint !== null)
    )
      fail("Data-profile path ownership changed");
    await noLinks(m.target);
    await noLinks(m.backup);
    await noLinks(dirname(m.source));
  }
}
async function lock<T>(store: Store, action: () => Promise<T>) {
  const path = join(store.root, "mutation.lock");
  await noLinks(store.root);
  await mkdir(store.root, { recursive: true });
  try {
    await mkdir(path);
  } catch {
    fail("Another operation holds mutation.lock");
  }
  try {
    await atomicJson(join(path, "owner.json"), {
      pid: process.pid,
      started: new Date().toISOString(),
    });
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
async function stateForRecovery(store: Store): Promise<State> {
  // The journal deliberately blocks ordinary Store.read; validate via a
  // temporary independent Store validator without trusting journal state.
  await noLinks(store.statePath);
  const state = await json(store.statePath);
  validateState(state);
  return state;
}
async function finish(store: Store, context: Context) {
  const root = store.root,
    file = persistJournal(root);
  await noLinks(file);
  if (!(await exists(file))) return { status: "nothing-to-recover" };
  const j = (await json(file)) as Journal,
    state = await stateForRecovery(store);
  if (j.schemaVersion !== 1 || !["enable", "remove"].includes(j.action))
    fail("Invalid data-profile journal");
  await validateProfile(root, state, j.profile, context);
  if (
    j.before?.schemaVersion !== 1 ||
    !record(j.before.profiles) ||
    j.after?.schemaVersion !== 1 ||
    !record(j.after.profiles)
  )
    fail("Invalid data-profile journal receipts");
  const expected = structuredClone(j.before);
  if (j.action === "enable") {
    if (expected.profiles[j.profile.key])
      fail("Profile already owned before enable");
    expected.profiles[j.profile.key] = j.profile;
  } else {
    if (!same(expected.profiles[j.profile.key], j.profile))
      fail("Profile removal receipt differs");
    delete expected.profiles[j.profile.key];
  }
  if (!same(expected, j.after)) fail("Journal changes unrelated data profiles");
  const receipts = await readProfiles(root);
  if (!same(receipts, j.before) && !same(receipts, j.after))
    fail("Data-profile receipts changed during recovery");
  const pids = await running(j.profile.name, context);
  if (pids.length)
    fail(
      "Close application before changing its data paths; running PIDs: " +
        pids.join(","),
    );
  // Preflight every setting and mapping before moving any original data.
  for (const s of j.profile.settings) {
    const current = await readSetting(context, s.key, s.name);
    if (!equalValue(current, s.before) && !equalValue(current, s.after))
      fail("External data setting changed; preserve journal");
  }
  // Preflight every mapping before moving any original data.
  for (const m of j.profile.mappings) {
    await noLinks(m.target);
    await noLinks(m.backup);
    if ((await exists(m.target)) && !(await lstat(m.target)).isDirectory())
      fail("Profile target type changed");
    const linked = await isOwnedLink(m);
    if (
      (await exists(m.backup)) &&
      (await fingerprint(m.backup)) !== m.fingerprint
    )
      fail("Archived original profile changed; refusing operation");
    if (j.action === "enable") {
      if (linked) continue;
      if (await exists(m.backup)) {
        if (!m.existed || (await exists(m.source)))
          fail("Profile backup/source conflict");
      } else if ((await fingerprint(m.source)) !== m.fingerprint)
        fail("Original profile changed after preview");
    } else {
      if (!linked && (await exists(m.source))) {
        if (
          (await exists(m.backup)) ||
          (await fingerprint(m.source)) !== m.fingerprint
        )
          fail("External profile drift during removal");
      }
      if (m.existed && !(await exists(m.backup)) && !(await exists(m.source)))
        fail("Archived original profile missing");
    }
  }
  for (const m of j.profile.mappings) {
    if (j.action === "enable") {
      await mkdir(m.target, { recursive: true });
      if (await isOwnedLink(m)) continue;
      if (m.existed && !(await exists(m.backup)))
        await rename(m.source, m.backup);
      await mkdir(dirname(m.source), { recursive: true });
      await symlink(m.target, m.source, "junction");
    } else {
      if (await isOwnedLink(m)) await unlink(m.source);
      if (m.existed && (await exists(m.backup)))
        await rename(m.backup, m.source);
    }
  }
  for (const s of j.profile.settings) {
    const desired = j.action === "remove" ? s.before : s.after;
    if (!equalValue(await readSetting(context, s.key, s.name), desired))
      await writeSetting(context, s, j.action === "remove");
  }
  await atomicJson(receiptFile(root), j.after);
  await unlink(file);
  return {
    status: "completed",
    action: j.action,
    profile: j.profile,
    dataDeleted: false,
    oldDataImported: false,
  };
}
export async function planPersist(
  store: Store,
  spec: string,
  remove = false,
  context: Context = {},
) {
  const state = await store.read(),
    install = installation(state, spec),
    before = await readProfiles(store.root);
  let profile = before.profiles[install.key];
  if (profile) {
    await validateProfile(store.root, state, profile, context);
    for (const m of profile.mappings)
      if (!(await isOwnedLink(m)))
        fail("Owned data-profile junction drift; preserve both paths");
    if (!remove) fail("Fresh data profile is already enabled");
  } else {
    if (remove) fail("Fresh data profile is not enabled");
    const digest = sha256(
      JSON.stringify([store.root, state.revision, before, install.key]),
    );
    const operation = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 32),
    ].join("-");
    profile = {
      name: install.name,
      key: install.key,
      identity: install.source.identity,
      operation,
      mappings: [],
      settings: [],
    };
    // Stable operation identity keeps approved archive paths exact on apply.
    for (const path of await paths(store.root, install, operation, context)) {
      if (await exists(path.target))
        fail("Unowned profile target already exists; no merge or overwrite");
      const original = await fingerprint(path.source);
      profile.mappings.push({
        ...path,
        existed: original !== null,
        fingerprint: original,
      });
    }
  }
  if (!remove) {
    for (const setting of settingsFor(install.name, profile.mappings)) {
      const beforeValue = await readSetting(context, setting.key, setting.name);
      profile.settings.push({ ...setting, before: beforeValue });
    }
  } else {
    for (const setting of profile.settings)
      if (
        !equalValue(
          await readSetting(context, setting.key, setting.name),
          setting.after,
        )
      )
        fail("External data setting drift; preserve current values");
  }
  const pids = await running(install.name, context);
  const binding = sha256(
    JSON.stringify([
      resolve(store.root),
      state,
      before,
      remove,
      profile.settings,
      profile.mappings.map((m) => ({
        slot: m.slot,
        source: m.source,
        target: m.target,
        backup: m.backup,
        existed: m.existed,
        fingerprint: m.fingerprint,
      })),
    ]),
  );
  return {
    package: install.source.alias + "/" + install.name,
    action: remove ? "remove" : "enable-fresh",
    binding,
    blockedPids: pids,
    mappings: profile.mappings,
    settings: profile.settings,
    warning:
      "Global per-user paths become junctions into Piko persist. Existing directories are renamed beside their original path, never imported or deleted. Old app copies will also see the new paths. Close all related applications first. Removal restores archived paths but keeps Piko data. Browser passwords may be tied to the original executable by Windows encryption and are NOT migrated.",
  };
}
export async function applyPersist(
  store: Store,
  spec: string,
  binding: string,
  remove = false,
  context: Context = {},
) {
  return await lock(store, async () => {
    const plan = await planPersist(store, spec, remove, context);
    if (!binding || binding !== plan.binding)
      fail("Data paths or package state changed; preview again");
    if (plan.blockedPids.length)
      fail(
        "Close application before changing its data paths; running PIDs: " +
          plan.blockedPids.join(","),
      );
    for (const name of [
      "install",
      "selection",
      "removal",
      "data-removal",
      "npm-rebuild",
      "profile",
      "desktop",
      "self-update",
      "layout",
    ])
      if (await exists(join(store.root, "operations", name + ".json")))
        fail("Recover pending operation first: " + name);
    const state = await store.read(),
      install = installation(state, spec),
      before = await readProfiles(store.root),
      after = structuredClone(before);
    const profile = remove
      ? before.profiles[install.key]!
      : {
          name: install.name,
          key: install.key,
          identity: install.source.identity,
          operation: plan.mappings[0]!.backup.split(".piko-before-").at(-1)!,
          mappings: plan.mappings,
          settings: plan.settings,
        };
    if (remove) delete after.profiles[install.key];
    else after.profiles[install.key] = profile;
    await atomicJson(persistJournal(store.root), {
      schemaVersion: 1,
      action: remove ? "remove" : "enable",
      profile,
      before,
      after,
    });
    return await finish(store, context);
  });
}
export async function recoverPersist(store: Store, context: Context = {}) {
  return await lock(store, () => finish(store, context));
}
export async function assertNoDataProfile(root: string, key: string) {
  if ((await readProfiles(root)).profiles[key])
    fail(
      "Remove external data-profile integration with piko persist <package> --remove before uninstall/data cleanup",
    );
}
export async function dataProfileStatus(store: Store) {
  const state = await store.read(),
    receipts = await readProfiles(store.root),
    results = [];
  for (const profile of Object.values(receipts.profiles)) {
    try {
      await validateProfile(store.root, state, profile, {});
      for (const m of profile.mappings)
        if (!(await isOwnedLink(m))) fail("Data-profile junction drift");
      for (const s of profile.settings)
        if (!equalValue(await readSetting({}, s.key, s.name), s.after))
          fail("Data-profile registry setting drift");
      results.push({
        package: profile.name,
        status: "ready",
        mappings: profile.mappings,
      });
    } catch (e) {
      results.push({
        package: profile.name,
        status: "blocked",
        issue: String(e instanceof Error ? e.message : e),
      });
    }
  }
  return results;
}
