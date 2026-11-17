import { lstat, readdir, mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  planDesktopRemoval,
  stageDesktopChange,
  validateDesktopReceipt,
  effectBytes,
} from "./desktop.ts";
import {
  profileBytes,
  editProfile,
  profileKey,
  profileMarkers,
  replaceProfile,
  stageProfileChange,
} from "./profiles.ts";
import { unregisterServices, preflightUnregisterServices } from "./service.ts";
import {
  validateServices,
  validateServiceReceipt,
} from "./service-declarations.ts";
import { validateAdmin } from "./integration-declarations.ts";
import { checkStartMenu, startMenuEffects } from "./start-menu.ts";
import { WindowsEffects, equalValue } from "./windows-effects.ts";
import { atomicJson, exists, fail, json, noLinks } from "./util.ts";
import { validateState } from "./store.ts";
import {
  preflightAdminRemoval,
  removeAdminIntegrationLocked,
} from "./execution.ts";
import type {
  AdminReceipt,
  BootstrapReceipt,
  Effect,
  EffectTarget,
  EffectValue,
  FileEffect,
  Install,
  InstallReceipt,
  ProfileIntegration,
  ShellEffect,
  State,
} from "./types.ts";
import type { Store } from "./store.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function bootstrapReceipt(value: unknown): asserts value is BootstrapReceipt {
  if (
    !object(value) ||
    !hash(value.binding) ||
    !timestamp(value.at) ||
    !["running", "failed", "completed"].includes(String(value.status)) ||
    (value.error !== undefined && typeof value.error !== "string")
  )
    fail("Invalid execution receipt");
}
function adminReceipt(
  value: unknown,
  id: string,
  action: "install" | "remove",
): asserts value is AdminReceipt {
  if (!object(value) || value.id !== id || value.action !== action)
    fail("Invalid admin receipt identity/action");
  bootstrapReceipt(value);
}
function fileValue(value: unknown): boolean {
  return (
    value === null ||
    (object(value) && Object.keys(value).length === 1 && hash(value.hash))
  );
}
function effectList(
  value: unknown,
  seen: Set<number>,
  label: string,
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024)
    fail(`Invalid ${label} receipt effects`);
  const entries: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (
      !object(entry) ||
      typeof entry.order !== "number" ||
      !Number.isSafeInteger(entry.order) ||
      entry.order < 0 ||
      seen.has(entry.order)
    )
      fail(`Invalid ${label} receipt order`);
    seen.add(entry.order);
    entries.push(entry);
  }
  return entries;
}

function validateReceipt(
  value: unknown,
  id: string,
  install: Install,
): asserts value is InstallReceipt {
  if (
    !object(value) ||
    value.packageId !== id ||
    !timestamp(value.installedAt) ||
    value.version !== install.version
  )
    fail("Invalid install receipt identity");
  const orders = new Set<number>();
  const targets = new Set<string>();
  for (const entry of effectList(value.desktop, orders, "desktop")) {
    validateDesktopReceipt(entry);
    if (entry.id !== id)
      fail("Desktop receipt belongs to another installation");
    for (const effect of entry.effects) {
      const target = JSON.stringify(effect.target).toLowerCase();
      if (targets.has(target)) fail("Duplicate install receipt resource");
      targets.add(target);
    }
  }
  const profiles = new Set<string>();
  for (const entry of effectList(value.shell, orders, "shell")) {
    if (
      entry.packageId !== id ||
      typeof entry.path !== "string" ||
      !isAbsolute(entry.path) ||
      resolve(entry.path) !== entry.path ||
      typeof entry.block !== "string" ||
      !entry.block ||
      entry.block.length > 16384 ||
      profiles.has(profileKey(entry.path))
    )
      fail("Invalid shell receipt effect");
    profiles.add(profileKey(entry.path));
  }
  const menuNames = new Set<string>();
  for (const entry of effectList(value.startMenu, orders, "Start Menu")) {
    if (
      entry.id !== id ||
      !Array.isArray(entry.entries) ||
      entry.entries.length > 1024
    )
      fail("Invalid Start Menu receipt effect");
    for (const item of entry.entries) {
      if (
        !object(item) ||
        typeof item.name !== "string" ||
        !item.name ||
        /[\\/:*?"<>|\x00-\x1f]/.test(item.name) ||
        !hash(item.hash) ||
        menuNames.has(item.name.toLowerCase())
      )
        fail("Invalid Start Menu entry");
      menuNames.add(item.name.toLowerCase());
    }
  }
  const services = new Set<string>();
  for (const entry of effectList(value.service, orders, "service")) {
    const declarations = [entry.declaration];
    validateServices(declarations);
    validateServiceReceipt(entry.receipt);
    if (
      entry.receipt.packageId !== id ||
      entry.receipt.installedVersion !== install.version ||
      entry.receipt.name.toLowerCase() !==
        declarations[0]!.name.toLowerCase() ||
      services.has(entry.receipt.name.toLowerCase())
    )
      fail("Invalid service receipt ownership");
    services.add(entry.receipt.name.toLowerCase());
  }
  if (value.admin !== undefined) {
    if (!object(value.admin)) fail("Invalid admin receipt effect");
    effectList([value.admin], orders, "admin");
    if (value.admin.install !== undefined)
      adminReceipt(value.admin.install, id, "install");
    if (value.admin.remove !== undefined)
      adminReceipt(value.admin.remove, id, "remove");
    if (value.admin.declaration !== undefined)
      validateAdmin(value.admin.declaration);
    if (value.admin.contentHash !== undefined && !hash(value.admin.contentHash))
      fail("Invalid approved system content hash");
  }
  for (const entry of effectList(value.bootstrap, orders, "bootstrap"))
    bootstrapReceipt(entry);
  const paths = new Set<string>();
  for (const entry of effectList(value.files, orders, "file")) {
    if (
      entry.packageId !== id ||
      typeof entry.path !== "string" ||
      !isAbsolute(entry.path) ||
      resolve(entry.path) !== entry.path ||
      !["file", "directory"].includes(String(entry.kind)) ||
      !fileValue(entry.before) ||
      !fileValue(entry.after) ||
      (entry.kind === "directory" &&
        (entry.before !== null || entry.after !== null)) ||
      paths.has(entry.path.toLowerCase())
    )
      fail("Invalid external file receipt ownership/snapshots");
    paths.add(entry.path.toLowerCase());
  }
}

/** Aggregate legacy transaction projections without renumbering existing effects. */
export function ensureInstallReceipt(
  state: State,
  install: Install,
): InstallReceipt {
  state.receipts ??= {};
  const receipt = (state.receipts[install.id] ??= {
    packageId: install.id,
    installedAt:
      state.admin?.[install.id]?.at ??
      state.bootstraps?.[install.id]?.at ??
      new Date(0).toISOString(),
    version: install.version,
  });
  let next =
    Math.max(
      -1,
      ...[
        ...(receipt.desktop ?? []),
        ...(receipt.shell ?? []),
        ...(receipt.startMenu ?? []),
        ...(receipt.service ?? []),
        ...(receipt.bootstrap ?? []),
        ...(receipt.files ?? []),
        ...(receipt.admin?.order === undefined
          ? []
          : [{ order: receipt.admin.order }]),
      ].map((effect) => effect.order),
    ) + 1;
  const ordered = <T>(
    value: T,
    previous?: { order: number },
  ): T & { order: number } => ({
    ...structuredClone(value),
    order: previous?.order ?? next++,
  });
  // A profile approval is package-level. Attribute it to the selected/latest
  // version, and only revoke it when the last version of that package leaves.
  const selected = state.defaults[install.key]?.id;
  const owner =
    selected && state.installs[selected]?.key === install.key
      ? selected
      : Object.values(state.installs)
          .filter((entry) => entry.key === install.key)
          .at(-1)?.id;
  const shell: ShellEffect[] = [];
  if (owner === install.id)
    for (const profile of Object.values(state.profiles ?? {}).sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      if (profile.approvals[install.key])
        shell.push(
          ordered(
            { packageId: install.id, path: profile.path, block: profile.block },
            receipt.shell?.find((entry) => entry.path === profile.path),
          ),
        );
    }
  if (shell.length) receipt.shell = shell;
  else delete receipt.shell;
  const bootstrap = state.bootstraps?.[install.id];
  if (bootstrap)
    receipt.bootstrap = [ordered(bootstrap, receipt.bootstrap?.[0])];
  else delete receipt.bootstrap;
  const desktop = state.desktop?.[install.key];
  if (desktop?.id === install.id)
    receipt.desktop = [ordered(desktop, receipt.desktop?.[0])];
  else delete receipt.desktop;
  const menu = state.startMenu?.[install.key];
  if (menu?.id === install.id)
    receipt.startMenu = [ordered(menu, receipt.startMenu?.[0])];
  else delete receipt.startMenu;
  const admin = state.admin?.[install.id];
  if (admin) {
    receipt.admin ??= { order: next++ };
    receipt.admin.order ??= next++;
    receipt.admin[admin.action] = structuredClone(admin);
    if (!receipt.admin.declaration && install.admin)
      receipt.admin.declaration = structuredClone(install.admin);
  }
  // Service and file effects are authoritative v9 records, not disposable views.
  for (const service of Object.values(state.services ?? {})
    .filter((entry) => entry.packageId === install.id)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const index =
      receipt.service?.findIndex((entry) => entry.receipt.id === service.id) ??
      -1;
    const previous = index < 0 ? undefined : receipt.service![index];
    const declaration =
      previous?.declaration ??
      install.services?.find(
        (entry) => entry.name.toLowerCase() === service.name.toLowerCase(),
      );
    if (!declaration) fail("Service receipt declaration is missing");
    const effect = ordered({ declaration, receipt: service }, previous);
    receipt.service ??= [];
    if (index < 0) receipt.service.push(effect);
    else receipt.service[index] = effect;
  }
  return receipt;
}

export function synchronizeReceipts(state: State): void {
  state.receipts ??= {};
  for (const install of Object.values(state.installs).sort((a, b) =>
    a.id.localeCompare(b.id),
  ))
    ensureInstallReceipt(state, install);
  for (const id of Object.keys(state.receipts))
    if (!state.installs[id]) delete state.receipts[id];
}

export function validateReceipts(state: State): void {
  if (state.receipts === undefined) return;
  if (!object(state.receipts)) fail("Invalid install receipts");
  const resources = new Set<string>();
  for (const [id, receipt] of Object.entries(state.receipts)) {
    const install = state.installs[id];
    if (!install || !hash(id)) fail("Receipt refers to an uninstalled package");
    validateReceipt(receipt, id, install);
    const paths = [
      ...(receipt.files ?? []).map((entry) => entry.path),
      ...(receipt.desktop ?? []).flatMap((entry) =>
        entry.effects.flatMap((effect) =>
          effect.target.kind === "file" ? [effect.target.path] : [],
        ),
      ),
    ];
    for (const path of paths) {
      const key = resolve(path).toLowerCase();
      if (resources.has(key))
        fail("External file belongs to multiple receipt effects");
      resources.add(key);
    }
  }
}

function assertExternalReceiptPath(root: string, path: string): void {
  const inside = relative(resolve(root), path);
  const ancestor = relative(path, resolve(root));
  const descendant =
    inside === "" ||
    (!isAbsolute(inside) &&
      inside !== ".." &&
      !inside.startsWith("..\\") &&
      !inside.startsWith("../"));
  const parent =
    ancestor === "" ||
    (!isAbsolute(ancestor) &&
      ancestor !== ".." &&
      !ancestor.startsWith("..\\") &&
      !ancestor.startsWith("../"));
  if (descendant || parent || dirname(path) === path)
    fail(
      "External file receipts must not own Piko installations or persistent data",
    );
}

export const receiptFileJournal = (root: string): string =>
  join(root, "operations", "receipt-files.json");

async function preflightReceiptFiles(
  root: string,
  receipt: InstallReceipt,
  backend: WindowsEffects,
): Promise<void> {
  for (const effect of receipt.files ?? []) {
    assertExternalReceiptPath(root, effect.path);
    await noLinks(effect.path);
    if (effect.kind === "directory") {
      if (!(await exists(effect.path)))
        fail("External directory ownership drift");
      const info = await lstat(effect.path);
      if (!info.isDirectory() || (await readdir(effect.path)).length)
        fail("External directory is not empty or changed; refusing removal");
    } else {
      if (
        !equalValue(
          await backend.read({ kind: "file", path: effect.path }),
          effect.after,
        )
      )
        fail("External file ownership drift; reconcile before removal");
      await effectBytes(root, effect.before);
      await effectBytes(root, effect.after);
    }
  }
}

async function revokeReceiptFile(
  root: string,
  effect: FileEffect,
  backend: WindowsEffects,
): Promise<void> {
  await noLinks(effect.path);
  if (effect.kind === "directory") {
    if (
      !(await lstat(effect.path)).isDirectory() ||
      (await readdir(effect.path)).length
    )
      fail("External directory changed during removal");
    await rmdir(effect.path);
  } else {
    await backend.write(
      { kind: "file", path: effect.path },
      effect.after,
      effect.before,
      await effectBytes(root, effect.before),
    );
  }
}

async function stageReceiptFiles(
  store: Store,
  receipt: InstallReceipt,
): Promise<void> {
  if (!receipt.files?.length) return;
  const path = receiptFileJournal(store.root);
  await noLinks(path);
  if (await exists(path)) fail("Unrecovered external receipt file operation");
  const before = await store.read();
  if (
    JSON.stringify(before.receipts?.[receipt.packageId]?.files) !==
    JSON.stringify(receipt.files)
  )
    fail("External file receipt changed before staging");
  const entry = { before, packageId: receipt.packageId, files: receipt.files };
  if (Buffer.byteLength(JSON.stringify(entry)) > 16 * 1024 * 1024)
    fail("Receipt file journal is too large");
  await atomicJson(path, entry);
}

/** Complete a committed revocation, or restore an uncommitted one, without executing package code. */
export async function recoverReceiptFiles(
  root: string,
  state: State,
  backend = new WindowsEffects(),
): Promise<void> {
  const path = receiptFileJournal(root);
  await noLinks(path);
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
    fail("Invalid receipt file journal type/size");
  const value: unknown = await json(path);
  if (!object(value) || !hash(value.packageId) || !Array.isArray(value.files))
    fail("Invalid receipt file journal");
  validateState(value.before);
  const before = value.before;
  const owner = before.installs[value.packageId];
  const receipt = before.receipts?.[value.packageId];
  if (!owner || !receipt) fail("Receipt file recovery owner is missing");
  validateReceipt(receipt, owner.id, owner);
  if (
    !receipt.files?.length ||
    JSON.stringify(receipt.files) !== JSON.stringify(value.files)
  )
    fail("Receipt file journal does not match recorded ownership");
  const committed =
    state.revision === before.revision + 1 &&
    !state.installs[owner.id] &&
    !state.receipts?.[owner.id];
  if (
    !committed &&
    (state.revision !== before.revision ||
      JSON.stringify(state.installs[owner.id]) !== JSON.stringify(owner) ||
      JSON.stringify(state.receipts?.[owner.id]?.files) !==
        JSON.stringify(receipt.files))
  )
    fail("Receipt file recovery state drift; preserve journal");
  const effects = [...receipt.files].sort((a, b) =>
    committed ? b.order - a.order : a.order - b.order,
  );
  const changes: (() => Promise<void>)[] = [];
  // Preflight every target and every replacement blob before touching any resource.
  for (const effect of effects) {
    assertExternalReceiptPath(root, effect.path);
    await noLinks(effect.path);
    if (effect.kind === "directory") {
      const present = await exists(effect.path);
      if (
        present &&
        (!(await lstat(effect.path)).isDirectory() ||
          (await readdir(effect.path)).length)
      )
        fail("External directory drift during recovery; preserve journal");
      if (committed && present) changes.push(() => rmdir(effect.path));
      if (!committed && !present) {
        await noLinks(dirname(effect.path));
        changes.push(async () => {
          await mkdir(effect.path);
        });
      }
    } else {
      const target = { kind: "file" as const, path: effect.path };
      const current = await backend.read(target);
      const desired = committed ? effect.before : effect.after;
      const other = committed ? effect.after : effect.before;
      const bytes = await effectBytes(root, desired);
      if (equalValue(current, desired)) continue;
      if (!equalValue(current, other))
        fail("External file drift during recovery; preserve journal");
      changes.push(() => backend.write(target, current, desired, bytes));
    }
  }
  for (const apply of changes) await apply();
  await rm(path);
}

/** Prepare every receipt resource without external writes or state publication. */
async function planInstallReceiptRemoval(
  store: Store,
  state: State,
  install: Install,
) {
  const receipt = ensureInstallReceipt(state, install);
  validateReceipts(state);
  const backend = store.effectsBackend ?? new WindowsEffects();
  const desktop = receipt.desktop?.length
    ? await planDesktopRemoval(store.root, state, install, backend)
    : undefined;
  if (desktop)
    for (const effect of desktop.operations) {
      await effectBytes(store.root, effect.before);
      await effectBytes(store.root, effect.after);
    }
  await preflightAdminRemoval(store, state, install);
  await preflightUnregisterServices(store, state, install);
  const lastVersion = !Object.values(state.installs).some(
    (entry) => entry.key === install.key && entry.id !== install.id,
  );
  const profiles: {
    path: string;
    before: Buffer | null;
    after: Buffer;
    next: ProfileIntegration | null;
    order: number;
  }[] = [];
  if (lastVersion)
    for (const profile of Object.values(state.profiles ?? {})) {
      if (!profile.approvals[install.key]) continue;
      const owned = receipt.shell?.find(
        (entry) => profileKey(entry.path) === profileKey(profile.path),
      );
      if (!owned || owned.block !== profile.block)
        fail("Shell receipt ownership changed before removal");
      const before = await profileBytes(profile.path);
      const approvals = { ...profile.approvals };
      delete approvals[install.key];
      const next = Object.keys(approvals).length
        ? { ...profile, approvals }
        : null;
      profiles.push({
        path: profile.path,
        before,
        after: editProfile(store.root, before, profile.block, next?.block),
        next,
        order: owned.order,
      });
    }
  if (state.startMenu?.[install.key]?.id === install.id) {
    const probe = structuredClone(state);
    delete probe.startMenu![install.key];
    await checkStartMenu(
      await startMenuEffects(state, probe, backend),
      backend,
    );
  }
  await preflightReceiptFiles(store.root, receipt, backend);
  return { receipt, backend, desktop, profiles };
}

/** Read-only external preflight for callers establishing an irreversible operation boundary. */
export async function preflightInstallReceiptRemoval(
  store: Store,
  state: State,
  install: Install,
): Promise<void> {
  await planInstallReceiptRemoval(store, structuredClone(state), install);
}

/** Recheck the full preflight under the mutation lock before executing any effects. */
export async function revokeInstallReceipt(
  store: Store,
  state: State,
  install: Install,
): Promise<void> {
  const { receipt, backend, desktop, profiles } =
    await planInstallReceiptRemoval(store, state, install);
  // Only service and admin receipts are checkpointed. Tentative caller selection
  // changes must not be published when an arbitrary removal script fails.
  if (receipt.service?.some((entry) => entry.receipt.status !== "removed")) {
    let failure: unknown;
    try {
      await unregisterServices(store, state, install);
    } catch (error) {
      failure = error;
    }
    const before = await store.read();
    const checkpoint = structuredClone(before);
    checkpoint.services ??= {};
    for (const [id, service] of Object.entries(state.services ?? {}))
      if (service.packageId === install.id)
        checkpoint.services[id] = structuredClone(service);
    const saved = ensureInstallReceipt(checkpoint, install);
    saved.service = structuredClone(
      ensureInstallReceipt(state, install).service,
    );
    await store.commit(before, checkpoint);
    state.revision = checkpoint.revision;
    if (failure !== undefined) throw failure;
  }
  await removeAdminIntegrationLocked(store, state, install);
  await stageReceiptFiles(store, receipt);
  const actions: { order: number; run: () => Promise<void> }[] = [];
  if (desktop)
    actions.push({
      order: receipt.desktop![0]!.order,
      run: async () => {
        await stageDesktopChange(
          store.root,
          state,
          install.key,
          desktop.operations,
          null,
          backend,
        );
        delete state.desktop![install.key];
      },
    });
  for (const profile of profiles)
    actions.push({
      order: profile.order,
      run: async () => {
        await stageProfileChange(
          store.root,
          state,
          profile.path,
          profile.before,
          profile.after,
          profile.next,
        );
        if (profile.next)
          state.profiles![profileKey(profile.path)] = profile.next;
        else delete state.profiles![profileKey(profile.path)];
      },
    });
  for (const effect of receipt.files ?? [])
    actions.push({
      order: effect.order,
      run: () => revokeReceiptFile(store.root, effect, backend),
    });
  for (const action of actions.sort((a, b) => b.order - a.order))
    await action.run();
  delete state.bootstraps?.[install.id];
  delete state.admin?.[install.id];
  for (const [id, service] of Object.entries(state.services ?? {}))
    if (service.packageId === install.id) delete state.services![id];
  delete state.receipts![install.id];
}

type OperationResource = Effect & {
  owner: string;
  order: number;
  directory?: boolean;
};
type OperationEffectChange = { order: number; apply: () => Promise<void> };

export const operationEffectJournal = (root: string): string =>
  join(root, "operations", "receipt-restore.json");

function operationResourceKey(target: EffectTarget): string {
  return target.kind === "file"
    ? "file:" + resolve(target.path).toLowerCase()
    : JSON.stringify([
        "registry",
        target.key.toLowerCase(),
        target.name.toLowerCase(),
      ]);
}

async function operationResources(
  store: Store,
  state: State,
): Promise<Map<string, OperationResource>> {
  const resources = new Map<string, OperationResource>();
  const folders = Object.values(state.receipts ?? {}).some(
    (receipt) => receipt.startMenu?.length,
  )
    ? await (store.effectsBackend ?? new WindowsEffects()).folders()
    : undefined;
  const claim = (entry: OperationResource): void => {
    const key = operationResourceKey(entry.target);
    if (resources.has(key))
      fail("Operation effect snapshots contain duplicate resource ownership");
    resources.set(key, entry);
  };
  for (const receipt of Object.values(state.receipts ?? {})) {
    const install =
      state.installs[receipt.packageId] ??
      fail("Operation effect owner is not installed");
    for (const desktop of receipt.desktop ?? [])
      for (const effect of desktop.effects)
        claim({ ...effect, owner: install.key, order: desktop.order });
    for (const file of receipt.files ?? []) {
      assertExternalReceiptPath(store.root, file.path);
      claim({
        target: { kind: "file", path: file.path },
        before: file.before,
        after: file.after,
        owner: install.key,
        order: file.order,
        ...(file.kind === "directory" ? { directory: true } : {}),
      });
    }
    for (const menu of receipt.startMenu ?? [])
      for (const entry of menu.entries)
        claim({
          target: {
            kind: "file",
            path: join(folders!.startMenu, "Piko Apps", entry.name + ".lnk"),
          },
          before: null,
          after: { hash: entry.hash },
          owner: install.key,
          order: menu.order,
        });
  }
  return resources;
}

function operationPathParts(value: EffectValue): string[] {
  if (value === null) return [];
  if (
    !("type" in value) ||
    (value.type !== "String" && value.type !== "ExpandString") ||
    typeof value.value !== "string"
  )
    fail("Operation PATH resource has an unsupported type");
  return value.value === "" ? [] : value.value.split(";");
}

async function planOperationEffects(
  store: Store,
  current: State,
  target: State,
): Promise<OperationEffectChange[]> {
  const backend = store.effectsBackend ?? new WindowsEffects();
  const old = await operationResources(store, current);
  const next = await operationResources(store, target);
  const changes: OperationEffectChange[] = [];
  for (const key of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(key),
      b = next.get(key);
    if (a && b && (a.owner !== b.owner || !!a.directory !== !!b.directory))
      fail(
        "Operation rollback cannot transfer a foreign resource owner or type",
      );
    const resource = b ?? a!;
    const order = a?.order ?? b!.order;
    if (resource.directory) {
      if (resource.target.kind !== "file")
        fail("Invalid directory effect target");
      const path = resource.target.path;
      await noLinks(path);
      const present = await exists(path);
      if (
        present &&
        (!(await lstat(path)).isDirectory() || (await readdir(path)).length)
      )
        fail("Operation directory resource drift; preserve user data");
      if (!b && present)
        changes.push({
          order,
          apply: async () => {
            await noLinks(path);
            if (
              !(await lstat(path)).isDirectory() ||
              (await readdir(path)).length
            )
              fail("Directory changed during rollback");
            await rmdir(path);
          },
        });
      if (b && !present) {
        await noLinks(dirname(path));
        changes.push({
          order,
          apply: async () => {
            await noLinks(path);
            await mkdir(path);
          },
        });
      }
      continue;
    }
    const actual = await backend.read(resource.target);
    let desired = b ? b.after : a!.before;
    const expected = a ? a.after : b!.before;
    if (a?.pathEntries !== undefined || b?.pathEntries !== undefined) {
      const parts = operationPathParts(actual);
      const normalized = (part: string): string =>
        part.replace(/[\\/]+$/, "").toLowerCase();
      const present = new Set(parts.map(normalized));
      const currentOwned = (a?.pathEntries ?? []).map(normalized);
      const targetOwned = (b?.pathEntries ?? []).map(normalized);
      const currentSide =
        currentOwned.every((part) => present.has(part)) &&
        targetOwned
          .filter((part) => !currentOwned.includes(part))
          .every((part) => !present.has(part));
      const targetSide =
        targetOwned.every((part) => present.has(part)) &&
        currentOwned
          .filter((part) => !targetOwned.includes(part))
          .every((part) => !present.has(part));
      if (!currentSide && !targetSide)
        fail("Owned PATH segments drifted during operation recovery");
      if (targetSide) continue;
      const result = parts.filter(
        (part) => !currentOwned.includes(normalized(part)),
      );
      for (const part of b?.pathEntries ?? [])
        if (!result.some((entry) => normalized(entry) === normalized(part)))
          result.push(part);
      desired =
        result.length === 0 && (b ? b.before : a!.before) === null
          ? null
          : {
              type:
                actual && "type" in actual && actual.type === "String"
                  ? "String"
                  : "ExpandString",
              value: result.join(";"),
            };
    } else if (!equalValue(actual, expected) && !equalValue(actual, desired))
      fail(
        "Operation external resource is neither the current nor target snapshot",
      );
    const bytes = await effectBytes(store.root, desired);
    if (!equalValue(actual, desired))
      changes.push({
        order,
        apply: () => backend.write(resource.target, actual, desired, bytes),
      });
  }
  const profileKeys = new Set([
    ...Object.keys(current.profiles ?? {}),
    ...Object.keys(target.profiles ?? {}),
  ]);
  const markers = profileMarkers(store.root);
  for (const key of profileKeys) {
    const a = current.profiles?.[key],
      b = target.profiles?.[key];
    const path = (b ?? a)!.path;
    if (a && b && a.path !== b.path) fail("Operation Profile identity changed");
    for (const profile of [a, b])
      if (
        profile &&
        (!profile.block.startsWith(markers.start) ||
          !profile.block.endsWith(markers.end))
      )
        fail("Operation Profile ownership markers do not match PIKO_HOME");
    const bytes = await profileBytes(path);
    let after: Buffer;
    try {
      after = editProfile(store.root, bytes, a?.block, b?.block);
    } catch (currentError) {
      // An earlier interrupted pass may already have published this exact target block.
      try {
        if (b) editProfile(store.root, bytes, b.block, b.block);
        else
          editProfile(
            store.root,
            bytes,
            undefined,
            markers.start + "\n" + markers.end,
          );
      } catch {
        throw currentError;
      }
      continue;
    }
    if (bytes !== null && bytes.equals(after)) continue;
    if (bytes === null && after.length === 0) continue;
    const ownerEffects = Object.values(current.receipts ?? {}).flatMap(
      (receipt) => receipt.shell ?? [],
    );
    const order =
      ownerEffects.find((effect) => profileKey(effect.path) === key)?.order ??
      -1;
    changes.push({ order, apply: () => replaceProfile(path, bytes, after) });
  }
  return changes.sort((a, b) => b.order - a.order);
}

async function operationEffectIntent(
  root: string,
): Promise<{ current: State; target: State } | undefined> {
  const path = operationEffectJournal(root);
  await noLinks(path);
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024)
    fail("Invalid operation effect restoration journal");
  const value: unknown = await json(path);
  if (!object(value)) fail("Invalid operation effect restoration snapshots");
  validateState(value.current);
  validateState(value.target);
  return { current: value.current, target: value.target };
}

/** Held-lock helper: restores external effects only. The caller owns service compensation and state publication. */
export async function restoreOperationEffects(
  store: Store,
  current: State,
  target: State,
): Promise<void> {
  validateState(current);
  validateState(target);
  const before = structuredClone(current),
    after = structuredClone(target);
  synchronizeReceipts(before);
  synchronizeReceipts(after);
  validateReceipts(before);
  validateReceipts(after);
  const intent = await operationEffectIntent(store.root);
  if (
    intent &&
    (JSON.stringify(intent.current) !== JSON.stringify(before) ||
      JSON.stringify(intent.target) !== JSON.stringify(after))
  )
    fail("A different external effect restoration is pending");
  // Complete the entire preflight, including all replacement blobs, before the durable intent or first write.
  const changes = await planOperationEffects(store, before, after);
  if (!intent) {
    const entry = { current: before, target: after };
    if (Buffer.byteLength(JSON.stringify(entry)) > 32 * 1024 * 1024)
      fail("Operation effect restoration journal too large");
    await atomicJson(operationEffectJournal(store.root), entry);
  }
  for (const change of changes) await change.apply();
  if (changes.length)
    await (store.effectsBackend ?? new WindowsEffects()).notify();
}

/** Call only after the recovery owner has durably committed the target integration ownership. */
export async function finishOperationEffects(store: Store): Promise<void> {
  const intent = await operationEffectIntent(store.root);
  if (!intent) return;
  const published = await store.read();
  const expected = structuredClone(intent.target);
  synchronizeReceipts(published);
  synchronizeReceipts(expected);
  const projection = (state: State) =>
    JSON.stringify({
      installs: Object.keys(state.installs).sort(),
      desktop: state.desktop ?? {},
      profiles: state.profiles ?? {},
      startMenu: state.startMenu ?? {},
      files: Object.entries(state.receipts ?? {})
        .filter(([, receipt]) => receipt.files?.length)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, receipt]) => [id, receipt.files]),
    });
  if (projection(published) !== projection(expected))
    fail("Target effect ownership is not committed; keep restoration journal");
  if ((await planOperationEffects(store, intent.current, intent.target)).length)
    fail(
      "Target external effects are not fully restored; keep restoration journal",
    );
  await rm(operationEffectJournal(store.root));
}
