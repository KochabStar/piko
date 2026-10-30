import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { validateDesktop } from "./integration-declarations.ts";
import { integrationText, saveEffectBytes, effectBytes } from "./desktop.ts";
import {
  WindowsEffects,
  equalValue,
  quoteArgument,
} from "./windows-effects.ts";
import {
  fail,
  noLinks,
  record,
  sha256,
  json,
  exists,
  atomicJson,
} from "./util.ts";
import type { State, Install, Effect, StartMenuReceipt } from "./types.ts";

const entries = (install: Install) => install.desktop?.shortcuts ?? [];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function validateStartMenu(state: State) {
  if (state.startMenu === undefined) return;
  if (state.schemaVersion < 8 || !record(state.startMenu))
    fail("Invalid Start Menu receipts");
  for (const [key, receipt] of Object.entries(state.startMenu)) {
    if (
      !record(receipt) ||
      typeof receipt.id !== "string" ||
      !Array.isArray(receipt.entries)
    )
      fail("Invalid Start Menu receipt");
    for (const e of receipt.entries)
      if (
        !record(e) ||
        typeof e.name !== "string" ||
        typeof e.hash !== "string"
      )
        fail("Invalid Start Menu entry");
    const install = state.installs[receipt.id];
    if (
      !install ||
      install.key !== key ||
      !install.verified ||
      install.kind !== "portable" ||
      !Array.isArray(receipt.entries) ||
      receipt.entries.length !== entries(install).length ||
      !receipt.entries.length
    )
      fail("Start Menu owner/declaration changed");
    validateDesktop(install.desktop);
    for (let n = 0; n < receipt.entries.length; n++) {
      const e = receipt.entries[n]!;
      if (
        e.name !== entries(install)[n]!.name ||
        !/^[a-f0-9]{64}$/.test(e.hash)
      )
        fail("Invalid Start Menu entry");
    }
  }
}
async function shortcutBytes(
  root: string,
  install: Install,
  backend: WindowsEffects,
) {
  const result: StartMenuReceipt = { id: install.id, entries: [] };
  await noLinks(join(root, install.dir, ".piko-install.json"));
  if (!same(await json(join(root, install.dir, ".piko-install.json")), install))
    fail("Start Menu installation receipt changed");
  for (const entry of entries(install)) {
    const target = join(root, install.dir, entry.path);
    await noLinks(target);
    if (!(await lstat(target)).isFile()) fail("Start Menu executable missing");
    const args = (entry.args ?? [])
      .map((a) => quoteArgument(integrationText(root, install, a)))
      .join(" ");
    const cache = join(
      root,
      "apps/piko/start-menu-recipes",
      sha256(JSON.stringify([target, args])) + ".json",
    );
    await noLinks(cache);
    let value: { hash: string };
    if (await exists(cache)) {
      value = await json(cache);
      await effectBytes(root, value);
    } else {
      value = await saveEffectBytes(root, await backend.shortcut(target, args));
      await atomicJson(cache, value);
    }
    result.entries.push({ name: entry.name, hash: value.hash });
  }
  return result;
}
export async function enrollStartMenu(
  root: string,
  state: State,
  install: Install,
  backend = new WindowsEffects(),
) {
  if (
    !install.verified ||
    install.kind !== "portable" ||
    !entries(install).length
  )
    return;
  const selected = state.defaults[install.key];
  if (selected && selected.id !== install.id) return;
  state.startMenu ??= {};
  state.startMenu[install.key] = await shortcutBytes(root, install, backend);
  state.schemaVersion = 8;
}
async function resources(state: State, backend: WindowsEffects) {
  const map = new Map<string, { key: string; hash: string; path: string }>();
  if (!Object.keys(state.startMenu ?? {}).length) return map;
  const { startMenu } = await backend.folders();
  for (const [key, receipt] of Object.entries(state.startMenu ?? {})) {
    for (const entry of receipt.entries) {
      const path = join(startMenu, "Piko Apps", entry.name + ".lnk"),
        id = path.toLowerCase();
      if (map.has(id))
        fail("Start Menu shortcut name belongs to another package");
      map.set(id, { key, hash: entry.hash, path });
    }
  }
  return map;
}
// Called inside the selection transaction: installation does not select CLI defaults.
// Without a selected version the most recently installed GUI owns its launchers;
// with a selection, installing candidates never steals the selected GUI's entries.
export async function planStartMenu(
  root: string,
  before: State,
  after: State,
  backend = new WindowsEffects(),
) {
  const keys = new Set(
    [...Object.values(before.installs), ...Object.values(after.installs)].map(
      (i) => i.key,
    ),
  );
  for (const key of keys) {
    const old = Object.values(before.installs).filter((i) => i.key === key);
    const next = Object.values(after.installs).filter((i) => i.key === key);
    if (same(old, next) && same(before.defaults[key], after.defaults[key]))
      continue;
    const selected = after.defaults[key];
    const install = selected ? after.installs[selected.id] : next.at(-1);
    if (
      install?.verified &&
      install.kind === "portable" &&
      entries(install).length
    ) {
      validateDesktop(install.desktop);
      after.startMenu ??= {};
      after.startMenu[key] = await shortcutBytes(root, install, backend);
      after.schemaVersion = 8;
    } else if (after.startMenu) delete after.startMenu[key];
  }
  validateStartMenu(after);
  return await startMenuEffects(before, after, backend);
}
export async function startMenuEffects(
  before: State,
  after: State,
  backend = new WindowsEffects(),
): Promise<Effect[]> {
  validateStartMenu(before);
  validateStartMenu(after);
  const old = await resources(before, backend),
    next = await resources(after, backend),
    effects: Effect[] = [];
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id),
      b = next.get(id);
    if (a && b && a.key !== b.key)
      fail("Start Menu ownership transfer requires explicit removal first");
    if (a?.hash === b?.hash) continue;
    effects.push({
      target: { kind: "file", path: (b ?? a)!.path },
      before: a ? { hash: a.hash } : null,
      after: b ? { hash: b.hash } : null,
    });
  }
  return effects;
}
export async function checkStartMenu(
  effects: Effect[],
  backend = new WindowsEffects(),
) {
  for (const e of effects)
    if (!equalValue(await backend.read(e.target), e.before))
      fail(
        "Start Menu resource conflicts or was edited externally; preserve it and reconcile before retrying",
      );
}
export async function writeStartMenu(
  root: string,
  effects: Effect[],
  backend = new WindowsEffects(),
) {
  // All blobs are checked before the first external write.
  const bytes = await Promise.all(
    effects.map((e) => effectBytes(root, e.after)),
  );
  await checkStartMenu(effects, backend);
  for (let n = 0; n < effects.length; n++) {
    const e = effects[n]!;
    await backend.write(e.target, e.before, e.after, bytes[n]);
  }
}
export async function recoverStartMenu(
  root: string,
  before: State,
  after: State,
  chosen: State,
  recorded: unknown,
  backend = new WindowsEffects(),
) {
  const effects = await startMenuEffects(before, after, backend);
  if (!same(effects, recorded))
    fail(
      "Start Menu recovery does not match installed declarations and receipts",
    );
  const committed = chosen.revision === after.revision;
  const changes: Effect[] = [];
  for (const e of effects) {
    const now = await backend.read(e.target),
      desired = committed ? e.after : e.before;
    if (equalValue(now, desired)) continue;
    if (!equalValue(now, committed ? e.before : e.after))
      fail("Start Menu drift during recovery; preserve selection journal");
    changes.push({ target: e.target, before: now, after: desired });
  }
  await writeStartMenu(root, changes, backend);
}
