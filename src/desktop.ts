import { appFolder, persistentFolder } from "./layout.ts";
import { lstat, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { contentHash } from "./shell.ts";
import { parseSpec } from "./catalog.ts";
import { validateDesktop } from "./integration-declarations.ts";
import {
  atomicJson,
  exists,
  fail,
  json,
  noLinks,
  record,
  sha256,
} from "./util.ts";
import {
  WindowsEffects,
  equalValue,
  quoteArgument,
} from "./windows-effects.ts";
import type {
  DesktopReceipt,
  Effect,
  EffectTarget,
  EffectValue,
  Install,
  State,
} from "./types.ts";
import type { Store } from "./store.ts";

export const desktopJournal = (root: string) =>
  join(root, "operations", "desktop.json");
const targetKey = (t: EffectTarget) =>
  JSON.stringify(
    t.kind === "file" ? [t.kind, t.path] : [t.kind, t.key, t.name],
  ).toLowerCase();
const normalizedPath = (p: string) => p.replace(/\\+$/, "").toLowerCase();
function pathParts(value: EffectValue): string[] {
  if (value === null) return [];
  if (
    "hash" in value ||
    !["String", "ExpandString"].includes(value.type) ||
    typeof value.value !== "string"
  )
    fail("User PATH has unsupported type");
  // Empty segments belong to the user's original PATH too; preserve them.
  return value.value === "" ? [] : value.value.split(";");
}
function pathValue(
  current: EffectValue,
  parts: string[],
  absent = false,
): EffectValue {
  if (!parts.length && absent) return null;
  return {
    type:
      current && "type" in current && current.type === "String"
        ? "String"
        : "ExpandString",
    value: parts.join(";"),
  };
}
export function validateEffect(value: unknown): asserts value is Effect {
  if (!record(value) || !record(value.target)) fail("Invalid desktop effect");
  const t = value.target;
  if (
    value.pathEntries !== undefined &&
    (t.kind !== "registry" ||
      t.key !== "HKCU\\Environment" ||
      t.name !== "Path" ||
      !Array.isArray(value.pathEntries) ||
      value.pathEntries.some(
        (p) => typeof p !== "string" || /[;\x00-\x1f]/.test(p),
      ))
  )
    fail("Invalid PATH segment ownership");
  if (t.kind === "registry") {
    if (
      typeof t.key !== "string" ||
      typeof t.name !== "string" ||
      /[\x00-\x1f]/.test(t.name)
    )
      fail("Invalid registry effect");
    new WindowsEffects().registryKey(t.key);
  } else if (
    t.kind !== "file" ||
    typeof t.path !== "string" ||
    resolve(t.path) !== t.path ||
    (t.font !== undefined && typeof t.font !== "boolean")
  )
    fail("Invalid file effect");
  for (const v of [value.before, value.after]) {
    if (v === null) continue;
    if (!record(v)) fail("Invalid effect value");
    if (t.kind === "file") {
      if (typeof v.hash !== "string" || !/^[a-f0-9]{64}$/.test(v.hash))
        fail("Invalid integration file hash");
    } else if (!(
      ((v.type === "String" || v.type === "ExpandString") &&
        typeof v.value === "string") ||
      (v.type === "DWord" && Number.isInteger(v.value)) ||
      (v.type === "MultiString" &&
        Array.isArray(v.value) &&
        v.value.every((x) => typeof x === "string"))
    ))
      fail("Unsupported registry effect value");
  }
}
export function validateDesktopReceipt(
  value: unknown,
): asserts value is DesktopReceipt {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    typeof value.binding !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.binding) ||
    !Array.isArray(value.effects) ||
    value.effects.length > 1024
  )
    fail("Invalid desktop ownership receipt");
  validateDesktop(value.declaration);
  const seen = new Set<string>();
  for (const effect of value.effects) {
    validateEffect(effect);
    const key = targetKey(effect.target);
    if (seen.has(key)) fail("Duplicate desktop ownership target");
    seen.add(key);
  }
}
export function installedForIntegration(
  state: State,
  spec: string,
  selected = false,
): Install {
  const parsed = parseSpec(spec),
    matches = Object.values(state.installs).filter(
      (i) =>
        i.name === parsed.name &&
        (!parsed.source || i.source.alias === parsed.source),
    );
  if (new Set(matches.map((i) => i.key)).size !== 1)
    fail("Unknown or ambiguous installed package; specify source/package");
  const choice = matches.find((i) => state.defaults[i.key]?.id === i.id);
  const install = parsed.request
    ? matches.find((i) => i.version === parsed.request)
    : (choice ?? (matches.length === 1 ? matches[0] : undefined));
  if (!install || (selected && choice?.id !== install.id))
    fail("Select the exact package version before desktop integration");
  return install;
}
export async function verifyInstall(root: string, install: Install) {
  if (!install.verified || install.kind !== "portable")
    fail("Integration requires a checksum-verified portable installation");
  const file = join(root, install.dir, ".piko-install.json");
  await noLinks(file);
  if (JSON.stringify(await json(file)) !== JSON.stringify(install))
    fail("Installation receipt changed");
}
export function integrationText(
  root: string,
  install: Install,
  value: string,
  stable = false,
) {
  return value.replace(/\{(root|persist|version)\}/g, (_, token) =>
    token === "root"
      ? stable
        ? join(root, "apps", appFolder(install), "current")
        : join(root, install.dir)
      : token === "persist"
        ? join(root, "persist", persistentFolder(install, install.key))
        : install.version,
  );
}
const blobPath = (root: string, hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("Invalid integration blob hash");
  return join(root, "apps/piko/integration-content", hash);
};
export async function saveEffectBytes(root: string, bytes: Uint8Array) {
  const hash = sha256(bytes),
    path = blobPath(root, hash);
  await noLinks(path);
  await mkdir(join(path, ".."), { recursive: true });
  if (!(await exists(path))) await writeFile(path, bytes, { flag: "wx" });
  else if (sha256(await readFile(path)) !== hash)
    fail("Integration blob cache changed");
  return { hash };
}
export async function effectBytes(
  root: string,
  value: EffectValue,
): Promise<Uint8Array | undefined> {
  if (!value || !("hash" in value)) return;
  const path = blobPath(root, value.hash);
  await noLinks(path);
  const bytes = await readFile(path);
  if (sha256(bytes) !== value.hash) fail("Integration content hash mismatch");
  return bytes;
}
export async function stageDesktopChange(
  root: string,
  state: State,
  key: string,
  effects: Effect[],
  after: DesktopReceipt | null,
  backend = new WindowsEffects(),
) {
  const journal = desktopJournal(root);
  await noLinks(journal);
  if (await exists(journal)) fail("Unrecovered desktop operation");
  for (const effect of effects) {
    validateEffect(effect);
    if (!equalValue(await backend.read(effect.target), effect.before))
      fail("Integration resource changed after confirmation");
  }
  const entry = {
    key,
    beforeRevision: state.revision,
    before: state.desktop?.[key] ?? null,
    after,
    effects,
  };
  if (Buffer.byteLength(JSON.stringify(entry)) > 4 * 1024 * 1024)
    fail("Desktop recovery journal too large");
  await atomicJson(journal, entry);
  for (const effect of effects)
    await backend.write(
      effect.target,
      effect.before,
      effect.after,
      await effectBytes(root, effect.after),
    );
}
export async function recoverDesktop(
  root: string,
  state: State,
  backend = new WindowsEffects(),
) {
  const journal = desktopJournal(root);
  await noLinks(journal);
  if (!(await exists(journal))) return;
  const info = await lstat(journal);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
    fail("Invalid desktop journal size/type");
  const j = await json(journal);
  if (
    !record(j) ||
    typeof j.key !== "string" ||
    !/^[a-z0-9._-]+--[a-f0-9]{16}$/.test(j.key) ||
    !Number.isSafeInteger(j.beforeRevision) ||
    j.beforeRevision < 0 ||
    !Array.isArray(j.effects) ||
    j.effects.length > 1024
  )
    fail("Invalid desktop journal");
  if (j.before !== null) validateDesktopReceipt(j.before);
  if (j.after !== null) validateDesktopReceipt(j.after);
  const current = state.desktop?.[j.key] ?? null,
    committed =
      state.revision === j.beforeRevision + 1 &&
      JSON.stringify(current) === JSON.stringify(j.after);
  if (
    !committed &&
    (state.revision !== j.beforeRevision ||
      JSON.stringify(current) !== JSON.stringify(j.before))
  )
    fail("Desktop recovery state changed; inspect manually");
  // Reconstruct the approved operation using its pre-operation snapshots.
  // Never use journal targets or replacement bytes merely because they parse.
  const snapshots = new Map<string, Effect>();
  for (const effect of j.effects) {
    validateEffect(effect);
    const key = targetKey(effect.target);
    if (snapshots.has(key)) fail("Duplicate desktop recovery target");
    snapshots.set(key, effect);
  }
  const receipt = j.after ?? j.before;
  if (!receipt) fail("Desktop recovery has no ownership transition");
  const install = state.installs[receipt.id];
  if (!install || install.key !== j.key)
    fail("Desktop recovery references missing installation");
  const beforeState = structuredClone(state);
  beforeState.revision = j.beforeRevision;
  beforeState.desktop ??= {};
  if (j.before) beforeState.desktop[j.key] = j.before;
  else delete beforeState.desktop[j.key];
  // A committed removal no longer has a state receipt to anchor its targets.
  // Validate the former receipt against the installed declaration as well.
  if (j.before) {
    const original = structuredClone(beforeState);
    delete original.desktop![j.key];
    const originalSnapshots = new Map<string, Effect>(
      j.before.effects.map((e: Effect) => [targetKey(e.target), e]),
    );
    const originalBackend = new WindowsEffects();
    originalBackend.folders = () => backend.folders();
    originalBackend.read = async (target) => {
      const effect = originalSnapshots.get(targetKey(target));
      if (!effect) fail("Desktop ownership resource snapshot missing");
      return effect.pathEntries === undefined
        ? structuredClone(effect.before)
        : pathValue(
            effect.after,
            pathParts(effect.after).filter(
              (p) =>
                !effect.pathEntries!.some(
                  (owned) => normalizedPath(p) === normalizedPath(owned),
                ),
            ),
            effect.before === null,
          );
    };
    const originalInstall = state.installs[j.before.id];
    if (!originalInstall || originalInstall.key !== j.key)
      fail("Prior desktop installation missing");
    const originalPlan = await desktopPlan(
      root,
      original,
      `${originalInstall.source.alias}/${originalInstall.name}@${originalInstall.version}`,
      false,
      originalBackend,
      true,
    );
    const originalEffects = originalPlan.receipt!.effects.map((e) => {
      if (e.pathEntries === undefined) return e;
      const owned = originalSnapshots.get(targetKey(e.target))!;
      // Reapproval preserves PATH order, including entries added since install.
      // Reconstructing the first append can move our segments to the end.
      if (
        owned.after === null ||
        !equalValue(
          pathValue(e.after, pathParts(e.after).sort()),
          pathValue(owned.after, pathParts(owned.after).sort()),
        )
      )
        fail("Desktop recovery PATH does not match declared segments");
      return { ...e, before: owned.before, after: owned.after };
    });
    if (
      JSON.stringify(originalPlan.receipt!.declaration) !==
        JSON.stringify(j.before.declaration) ||
      JSON.stringify(originalEffects) !== JSON.stringify(j.before.effects)
    )
      fail("Desktop recovery ownership does not match the declared plan");
  }
  const snapshotBackend = new WindowsEffects();
  snapshotBackend.folders = () => backend.folders();
  snapshotBackend.read = async (target) => {
    const effect = snapshots.get(targetKey(target));
    if (!effect) fail("Desktop recovery resource snapshot missing");
    return structuredClone(effect.before);
  };
  const plan = await desktopPlan(
    root,
    beforeState,
    `${install.source.alias}/${install.name}@${install.version}`,
    j.after === null,
    snapshotBackend,
    true,
  );
  if (
    plan.install.id !== install.id ||
    JSON.stringify(plan.operations) !== JSON.stringify(j.effects) ||
    JSON.stringify(plan.receipt) !== JSON.stringify(j.after)
  )
    fail("Desktop recovery effects do not match the declared plan");
  const effects: Effect[] = committed ? j.effects : [...j.effects].reverse();
  // Preflight every resource and blob before restoring any external resource.
  const changes = [];
  for (const effect of effects) {
    const desired = committed ? effect.after : effect.before,
      other = committed ? effect.before : effect.after,
      now = await backend.read(effect.target);
    if (equalValue(now, desired)) continue;
    if (!equalValue(now, other))
      fail(
        "External integration resource drift; journal retained for manual recovery",
      );
    changes.push({
      target: effect.target,
      now,
      desired,
      bytes: await effectBytes(root, desired),
    });
  }
  for (const { target, now, desired, bytes } of changes)
    await backend.write(target, now, desired, bytes);
  await backend.notify();
  await rm(journal);
}

async function desktopPlan(
  root: string,
  state: State,
  spec: string,
  remove: boolean,
  backend: WindowsEffects,
  recovery = false,
) {
  const rootTag = sha256(resolve(root).toLowerCase()).slice(0, 8);
  const install = installedForIntegration(state, spec, !remove && !recovery),
    prior = state.desktop?.[install.key];
  await verifyInstall(root, install);
  const retired: Effect[] = [];
  let effects: Effect[] = [],
    declaration = install.desktop;
  if (remove) {
    if (!prior) fail("No recorded desktop integration");
    declaration = prior.declaration;
    effects = [];
    for (const e of [...prior.effects].reverse()) {
      if (e.pathEntries !== undefined) {
        const current = await backend.read(e.target),
          parts = pathParts(current);
        if (
          e.pathEntries.some(
            (p) =>
              !parts.some((part) => normalizedPath(part) === normalizedPath(p)),
          )
        )
          fail(
            "Owned PATH segment was changed externally; reconcile before removal",
          );
        effects.push({
          target: e.target,
          before: current,
          after: pathValue(
            current,
            parts.filter(
              (p) =>
                !e.pathEntries!.some(
                  (owned) => normalizedPath(p) === normalizedPath(owned),
                ),
            ),
            e.before === null,
          ),
        });
      } else
        effects.push({ target: e.target, before: e.after, after: e.before });
    }
  } else {
    if (!declaration) fail("Package has no desktop declaration");
    validateDesktop(declaration);
    const folders = await backend.folders();
    const add = async (target: EffectTarget, value: EffectValue) => {
      const old = prior?.effects.find(
          (e) => targetKey(e.target) === targetKey(target),
        ),
        current = await backend.read(target);
      if (old && !equalValue(current, old.after))
        fail("Owned desktop resource was edited externally");
      if (
        !old &&
        state.desktop &&
        Object.entries(state.desktop).some(
          ([key, r]) =>
            key !== install.key &&
            r.effects.some((e) => targetKey(e.target) === targetKey(target)),
        )
      )
        fail("Desktop resource belongs to another package");
      if (target.kind === "file" && !old && current !== null)
        fail("Refusing to replace an existing external file");
      if (
        target.kind === "registry" &&
        target.name.toLowerCase() !== "path" &&
        !old &&
        current !== null &&
        !equalValue(current, value)
      )
        fail("Existing user registry value conflicts; resolve explicitly");
      effects.push({
        target,
        before: old ? old.before : current,
        after: value,
      });
    };
    for (const [name, text] of Object.entries(declaration.environment ?? {}))
      await add(
        { kind: "registry", key: "HKCU\\Environment", name },
        { type: "String", value: integrationText(root, install, text, true) },
      );
    if (declaration.path?.length) {
      const target: EffectTarget = {
          kind: "registry",
          key: "HKCU\\Environment",
          name: "Path",
        },
        old = prior?.effects.find(
          (e) => targetKey(e.target) === targetKey(target),
        ),
        current = await backend.read(target),
        parts = pathParts(current),
        owned = [...(old?.pathEntries ?? [])];
      if (
        owned.some(
          (p) =>
            !parts.some((part) => normalizedPath(part) === normalizedPath(p)),
        )
      )
        fail("Owned PATH segment changed; reconcile explicitly");
      for (const path of declaration.path) {
        const actual = join(root, "apps", appFolder(install), "current", path),
          live = join(root, install.dir, path);
        await noLinks(live);
        if (!(await lstat(live)).isDirectory() || /[;\x00-\x1f]/.test(actual))
          fail("User PATH entry is not a safe package directory");
        if (!parts.some((p) => normalizedPath(p) === normalizedPath(actual))) {
          parts.push(actual);
          owned.push(actual);
        }
      }
      effects.push({
        target,
        before: old ? old.before : current,
        after: pathValue(current, parts),
        pathEntries: owned,
      });
    }
    for (const shortcut of declaration.shortcuts ?? []) {
      const live = join(root, install.dir, shortcut.path);
      await noLinks(live);
      if (!(await lstat(live)).isFile()) fail("Shortcut target missing");
      const target = join(
          root,
          "apps",
          appFolder(install),
          "current",
          shortcut.path,
        ),
        args = (shortcut.args ?? [])
          .map((a) => quoteArgument(integrationText(root, install, a, true)))
          .join(" "),
        cache = join(
          root,
          "apps/piko/shortcut-recipes",
          sha256(JSON.stringify([target, args])) + ".json",
        );
      await noLinks(cache);
      let value: { hash: string };
      if (await exists(cache)) {
        value = await json(cache);
        await effectBytes(root, value);
      } else {
        if (recovery) fail("Desktop recovery shortcut recipe missing");
        value = await saveEffectBytes(
          root,
          await backend.shortcut(target, args),
        );
        await atomicJson(cache, value);
      }
      await add(
        {
          kind: "file",
          path: join(folders.startMenu, "Piko", shortcut.name + ".lnk"),
        },
        value,
      );
    }
    for (const path of declaration.fonts ?? []) {
      if (folders.build < 17763)
        fail("Per-user font installation requires Windows 10 1809 or newer");
      const live = join(root, install.dir, path);
      await noLinks(live);
      const info = await lstat(live);
      if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024)
        fail("Invalid font payload");
      const target = join(
        folders.fonts,
        "piko-" +
          rootTag +
          "-" +
          sha256(install.key).slice(0, 8) +
          "-" +
          basename(path),
      );
      const bytes = await readFile(live);
      if (!(
        [0, 1, 0, 0].every((n, i) => bytes[i] === n) ||
        bytes.subarray(0, 4).toString("ascii") === "OTTO"
      ))
        fail("Invalid TTF/OTF font signature");
      await add(
        { kind: "file", path: target, font: true },
        await saveEffectBytes(root, bytes),
      );
      await add(
        {
          kind: "registry",
          key: "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
          name: "Piko " + rootTag + " " + install.key + " " + basename(path),
        },
        { type: "String", value: target },
      );
    }
    for (const menu of declaration.menus ?? []) {
      const live = join(root, install.dir, menu.path);
      await noLinks(live);
      if (!(await lstat(live)).isFile()) fail("Context menu target missing");
      const scope =
          menu.target === "file"
            ? "*"
            : menu.target === "directory"
              ? "Directory"
              : "Directory\\Background",
        key = `HKCU\\Software\\Classes\\${scope}\\shell\\Piko-${rootTag}-${install.key}-${menu.id}`,
        command = [
          quoteArgument(
            join(root, "apps", appFolder(install), "current", menu.path),
          ),
          ...(menu.args ?? [menu.target === "background" ? "%V" : "%1"]).map(
            (a) =>
              a === "%1" || a === "%V"
                ? '"' + a + '"'
                : quoteArgument(integrationText(root, install, a, true)),
          ),
        ].join(" ");
      await add(
        { kind: "registry", key, name: "" },
        { type: "String", value: menu.label },
      );
      await add(
        { kind: "registry", key: key + "\\command", name: "" },
        { type: "String", value: command },
      );
    }
    for (const association of declaration.associations ?? []) {
      const live = join(root, install.dir, association.path);
      await noLinks(live);
      if (!(await lstat(live)).isFile())
        fail("File association executable missing");
      const progId = `Piko.${rootTag}.${install.key}.${association.extension.slice(1)}`,
        key = `HKCU\\Software\\Classes\\${progId}`;
      const command = [
        quoteArgument(
          join(root, "apps", appFolder(install), "current", association.path),
        ),
        ...(association.args ?? ["%1"]).map((a) =>
          a === "%1"
            ? '\"%1\"'
            : quoteArgument(integrationText(root, install, a, true)),
        ),
      ].join(" ");
      await add(
        { kind: "registry", key, name: "" },
        { type: "String", value: association.label },
      );
      await add(
        { kind: "registry", key: key + "\\shell\\open\\command", name: "" },
        { type: "String", value: command },
      );
      await add(
        {
          kind: "registry",
          key: `HKCU\\Software\\Classes\\${association.extension}\\OpenWithProgids`,
          name: progId,
        },
        { type: "String", value: "" },
      );
    }
    for (const old of prior?.effects ?? []) {
      if (effects.some((e) => targetKey(e.target) === targetKey(old.target)))
        continue;
      if (old.pathEntries !== undefined) {
        const current = await backend.read(old.target),
          parts = pathParts(current);
        if (
          old.pathEntries.some(
            (p) =>
              !parts.some((part) => normalizedPath(part) === normalizedPath(p)),
          )
        )
          fail("Owned PATH segment changed; reconcile explicitly");
        retired.push({
          target: old.target,
          before: current,
          after: pathValue(
            current,
            parts.filter(
              (p) =>
                !old.pathEntries!.some(
                  (owned) => normalizedPath(p) === normalizedPath(owned),
                ),
            ),
            old.before === null,
          ),
        });
      } else
        retired.push({
          target: old.target,
          before: old.after,
          after: old.before,
        });
    }
  }
  const operations: Effect[] = [...retired];
  for (const e of effects)
    operations.push({
      target: e.target,
      before:
        e.pathEntries !== undefined
          ? await backend.read(e.target)
          : remove
            ? e.before
            : (prior?.effects.find(
                (p) => targetKey(p.target) === targetKey(e.target),
              )?.after ?? e.before),
      after: e.after,
    });
  for (const effect of operations)
    if (!equalValue(await backend.read(effect.target), effect.before))
      fail("Desktop resource drift; preview/reconcile explicitly");
  const binding = sha256(
    JSON.stringify([
      state.revision,
      install,
      remove ? null : await contentHash(root, install),
      declaration,
      remove,
      operations,
    ]),
  );
  const receipt = remove
    ? null
    : { id: install.id, declaration: declaration!, effects, binding };
  if (receipt) validateDesktopReceipt(receipt);
  return { install, operations, receipt, binding };
}
// Stable external effects need no rewrite or renewed execution approval.
// Rebuild the plan against the candidate to check files and resource ownership.
export async function carryDesktopIntegration(
  root: string,
  state: State,
  install: Install,
  backend = new WindowsEffects(),
): Promise<void> {
  const prior = state.desktop?.[install.key];
  if (!prior || prior.id === install.id) return;
  if (JSON.stringify(prior.declaration) !== JSON.stringify(install.desktop))
    fail(
      "Desktop declaration changed; preview and explicitly reauthorize integration before switching versions",
    );
  const probe = structuredClone(state);
  probe.defaults[install.key] = {
    ...probe.defaults[install.key]!,
    id: install.id,
  };
  const plan = await desktopPlan(
    root,
    probe,
    `${install.source.alias}/${install.name}@${install.version}`,
    false,
    backend,
  );
  if (
    plan.operations.some((effect) => !equalValue(effect.before, effect.after))
  )
    fail(
      "Desktop effects changed; revoke and explicitly reauthorize integration before switching versions",
    );
  // The selection journal commits this receipt and current junction together.
  // There are no external writes to roll back.
  state.desktop![install.key] = plan.receipt!;
}

export async function planDesktopUpgrade(
  root: string,
  state: State,
  spec: string,
  backend = new WindowsEffects(),
) {
  const install = installedForIntegration(state, spec);
  if (!state.desktop?.[install.key] || !state.defaults[install.key])
    fail("Enable desktop integration for the current default first");
  const probe = structuredClone(state);
  probe.defaults[install.key] = {
    ...probe.defaults[install.key]!,
    id: install.id,
  };
  return await desktopPlan(root, probe, spec, false, backend);
}
export async function inspectDesktopUpgrade(
  store: Store,
  spec: string,
  backend = new WindowsEffects(),
) {
  const plan = await planDesktopUpgrade(
    store.root,
    await store.read(),
    spec,
    backend,
  );
  return {
    package: spec,
    action: "upgrade-desktop",
    binding: plan.binding,
    effects: plan.operations,
    warning:
      "One confirmation updates owned resources and selects the installed candidate. Unknown resources and user changes are preserved or rejected. Close applications using fonts.",
  };
}

export async function inspectDesktop(
  store: Store,
  spec: string,
  remove = false,
  backend = new WindowsEffects(),
) {
  const plan = await desktopPlan(
    store.root,
    await store.read(),
    spec,
    remove,
    backend,
  );
  return {
    package: spec,
    action: remove ? "remove-desktop" : "enable-desktop",
    binding: plan.binding,
    effects: plan.operations,
    warning:
      "User-level external effects only. Existing terminals/IDEs may need restart. Close applications using fonts before changing them. Registry values created by Piko are removed, but empty keys may remain.",
  };
}
export async function applyDesktop(
  store: Store,
  spec: string,
  options: { confirmed?: boolean; binding?: string; remove?: boolean },
  backend = new WindowsEffects(),
) {
  return await store.mutate(
    async (state) => {
      const plan = await desktopPlan(
        store.root,
        state,
        spec,
        !!options.remove,
        backend,
      );
      if (
        !options.confirmed ||
        !options.binding ||
        options.binding !== plan.binding
      )
        fail(
          "Desktop integration requires --yes and unchanged preview --binding",
        );
      await stageDesktopChange(
        store.root,
        state,
        plan.install.key,
        plan.operations,
        plan.receipt,
        backend,
      );
      state.schemaVersion = 6;
      state.aliases ??= {};
      state.data ??= {};
      state.desktop ??= {};
      if (plan.receipt) state.desktop[plan.install.key] = plan.receipt;
      else delete state.desktop[plan.install.key];
      return { status: "completed", restartApplications: true };
    },
    { effectsBackend: backend },
  );
}
