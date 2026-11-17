import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertRecoverableOperations,
  decodeOperationState,
  operationPath,
  pendingOperations,
  withRecoveryOperation,
  type OperationJournal,
} from "../journal.ts";
import {
  exists,
  fail,
  json,
  noLinks,
  noLinksTree,
  record,
  removeTree,
} from "../util.ts";
import { validateState, upgradeState, type Store } from "../store.ts";
import { persistentFolder } from "../layout.ts";
import { recoverDesktop } from "../desktop.ts";
import { recoverProfile } from "../profiles.ts";
import {
  finishOperationEffects,
  operationEffectJournal,
  recoverReceiptFiles,
  restoreOperationEffects,
  synchronizeReceipts,
} from "../receipt.ts";
import { restoreOperationServices } from "../service.ts";
import type { Install, State } from "../types.ts";
import { resumeOperationPlan } from "./replay.ts";

export type RecoveryRow = {
  id: string;
  kind: string;
  packageId: string;
  status: "resumed" | "rolled-back" | "blocked";
  error?: string;
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertBoundState(journal: OperationJournal, current: State): void {
  if (!journal.states.some((item) => same(decodeOperationState(item), current)))
    fail("Operation state drift; no recovery files were touched");
}

function assertNoArbitraryExecution(journal: OperationJournal): void {
  const before = decodeOperationState(journal.before);
  const states = [
    ...journal.states.map(decodeOperationState),
    ...(journal.captured ? [decodeOperationState(journal.captured)] : []),
  ];
  if (
    journal.phases.some(
      (phase) =>
        phase.status !== "pending" &&
        /admin|bootstrap|script/i.test(phase.name),
    ) ||
    states.some(
      (state) =>
        !same(state.admin ?? {}, before.admin ?? {}) ||
        !same(state.bootstraps ?? {}, before.bootstraps ?? {}),
    )
  )
    fail(
      "Arbitrary approved execution requires explicit inspection/retry; durable action history is preserved",
    );
}

async function knownInstalls(
  store: Store,
  journal: OperationJournal,
): Promise<Map<string, Install>> {
  const installs = new Map<string, Install>();
  for (const state of [
    decodeOperationState(journal.before),
    ...journal.states.map(decodeOperationState),
    ...(journal.captured ? [decodeOperationState(journal.captured)] : []),
  ])
    for (const install of Object.values(state.installs))
      installs.set(install.dir.replaceAll("\\", "/"), install);
  if (await exists(store.installPath)) {
    await noLinks(store.installPath);
    const value: unknown = await json(store.installPath);
    if (!record(value) || !record(value.installation))
      fail("Invalid legacy installation intent");
    const initial = decodeOperationState(journal.before);
    const idValue: unknown = value.installation.id;
    if (typeof idValue !== "string")
      fail("Invalid legacy installation identity");
    const probe: unknown = {
      ...initial,
      installs: { ...initial.installs, [idValue]: value.installation },
    };
    validateState(probe);
    const checked =
      probe.installs[idValue] ?? fail("Validated installation is missing");
    installs.set(checked.dir.replaceAll("\\", "/"), checked);
  }
  return installs;
}

async function verifyDirectory(path: string, install: Install): Promise<void> {
  await noLinks(path);
  await noLinks(join(path, ".piko-install.json"));
  if (!same(await json(join(path, ".piko-install.json")), install))
    fail(
      "Recovery installation receipt changed; preserve files for inspection",
    );
}

async function detachPersistentLinks(
  store: Store,
  path: string,
  install: Install,
  relative = "",
): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const child = join(path, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      const destination = resolve(
        store.root,
        "persist",
        persistentFolder(install, install.key),
        name,
      );
      if (
        !install.persist.includes(name) ||
        resolve(await readlink(child)).toLowerCase() !==
          destination.toLowerCase()
      )
        fail("Unknown link in operation-owned installation");
      await unlink(child);
    } else if (info.isDirectory())
      await detachPersistentLinks(store, child, install, name);
  }
}

async function restoreRemovedDirectories(
  store: Store,
  journal: OperationJournal,
  installs: Map<string, Install>,
): Promise<void> {
  const moves = journal.moves.filter(
    (move) => move.from.startsWith("apps/") && move.to.startsWith("staging/"),
  );
  // Preflight every rename before touching any of the reversible data.
  for (const move of moves) {
    const install =
      installs.get(move.from) ??
      fail("Removal move has no bound installation owner");
    const from = join(store.root, move.from),
      trash = join(store.root, move.to);
    await noLinks(from);
    await noLinks(trash);
    if (await exists(trash)) {
      if (await exists(from))
        fail("Both removal source and trash exist; preserve journal");
      await verifyDirectory(trash, install);
    } else if (await exists(from)) await verifyDirectory(from, install);
    else
      fail("Reversible removal data is missing; refusing snapshot overwrite");
  }
  for (const move of [...moves].reverse()) {
    const from = join(store.root, move.from),
      trash = join(store.root, move.to);
    if (await exists(trash)) {
      await mkdir(dirname(from), { recursive: true });
      await rename(trash, from);
    }
  }
}

async function cleanupNewFiles(
  store: Store,
  journal: OperationJournal,
  installs: Map<string, Install>,
): Promise<void> {
  const before = decodeOperationState(journal.before);
  const targets = new Set(
    journal.moves
      .filter(
        (move) =>
          move.from.startsWith("staging/") && move.to.startsWith("apps/"),
      )
      .map((move) => move.to),
  );
  for (const file of journal.files)
    if (file.startsWith("apps/")) targets.add(file);
  for (const path of targets) {
    const install =
      installs.get(path) ?? fail("New installation target has no bound owner");
    if (before.installs[install.id])
      fail("Operation cannot delete a pre-existing installation");
    const full = join(store.root, path);
    if (await exists(full)) {
      await verifyDirectory(full, install);
      await detachPersistentLinks(store, full, install);
      await noLinksTree(full);
      await removeTree(full);
    }
  }
  for (const path of [...journal.files].reverse()) {
    if (!path.startsWith("staging/")) continue;
    const full = join(store.root, path);
    await noLinks(full);
    if (await exists(full)) {
      await noLinksTree(full);
      await removeTree(full);
    }
  }
}

async function reconcileLegacyEffects(store: Store): Promise<void> {
  await store.recover();
  const state = await store.readCommitted();
  await recoverProfile(store.root, state);
  await recoverDesktop(store.root, state, store.effectsBackend);
  await recoverReceiptFiles(store.root, state, store.effectsBackend);
}

async function rollbackOperation(
  store: Store,
  journal: OperationJournal,
): Promise<void> {
  assertNoArbitraryExecution(journal);
  const committed = await store.readCommitted();
  assertBoundState(journal, committed);
  const target = decodeOperationState(journal.before);
  upgradeState(target);
  synchronizeReceipts(target);
  const installs = await knownInstalls(store, journal);
  await restoreRemovedDirectories(store, journal, installs);
  await reconcileLegacyEffects(store);
  const ownership = journal.captured
    ? decodeOperationState(journal.captured)
    : structuredClone(committed);
  upgradeState(ownership);
  synchronizeReceipts(ownership);
  // A rollback must not orphan or destroy persistent data created while the
  // operation was running. Retain its explicit data ownership independently
  // of the rolled-back executable generation.
  target.data ??= {};
  for (const [key, data] of Object.entries(ownership.data ?? {}))
    if (!target.data[key]) target.data[key] = structuredClone(data);
  // External compensation retains its original pair across a failed service
  // compensation, even though service ownership captures advance independently.
  const effectPath = operationEffectJournal(store.root);
  if (await exists(effectPath)) {
    const intent: unknown = await json(effectPath);
    if (!record(intent)) fail("Invalid effect restoration intent");
    validateState(intent.current);
    validateState(intent.target);
    await restoreOperationEffects(store, intent.current, intent.target);
  } else await restoreOperationEffects(store, ownership, target);
  await restoreOperationServices(store, ownership, target);
  const latest = await store.readCommitted();
  // Commit restores selection/current/shims via their existing guarded journal;
  // it never overwrites the state file directly or publishes a stale revision.
  if (!same({ ...latest, revision: 0 }, { ...target, revision: 0 }))
    await store.commit(latest, target);
  await finishOperationEffects(store);
  await cleanupNewFiles(store, journal, installs);
  // Legacy install/remove intents refer to exactly the bound owners preflighted
  // above. They are obsolete only after compensation and target publication.
  await rm(store.installPath, { force: true });
  await store.recoverRemoval();
}

/** Compensate a handled failure while its original writer lease is still held. */
export async function rollbackFailedOperation(
  store: Store,
  journal: OperationJournal,
): Promise<void> {
  await store.withMutationLock(async () => {
    await withRecoveryOperation(store, journal, async () => {
      await rollbackOperation(store, journal);
    });
  });
}

async function resumeOperation(
  store: Store,
  journal: OperationJournal,
): Promise<void> {
  assertBoundState(journal, await store.readCommitted());
  assertNoArbitraryExecution(journal);
  const installs = await knownInstalls(store, journal);
  const current = await store.readCommitted();
  const uncommittedRemovals = journal.moves.filter(
    (move) =>
      move.from.startsWith("apps/") &&
      move.to.startsWith("staging/") &&
      [...installs.values()].some(
        (install) =>
          install.dir.replaceAll("\\", "/") === move.from &&
          !!current.installs[install.id],
      ),
  );
  if (uncommittedRemovals.length)
    await restoreRemovedDirectories(
      store,
      { ...journal, moves: uncommittedRemovals },
      installs,
    );
  await reconcileLegacyEffects(store);
  await store.recoverInstallation();
  await store.recoverRebuild();
  await store.recoverDataRemoval();
  if (journal.status !== "completed") await resumeOperationPlan(store, journal);
  await store.recoverRemoval();
}

export async function recoverOperations(
  store: Store,
  options: { mode?: "resume" | "rollback"; rollback?: boolean } = {},
): Promise<RecoveryRow[]> {
  const mode =
    options.mode ?? (options.rollback === true ? "rollback" : "resume");
  return await store.withMutationLock(async () => {
    const journals = await assertRecoverableOperations(store.root);
    if (!journals.length) {
      // Legacy selection/install/removal journals are reconciled by the normal
      // mutation recovery pipeline while this lease remains held. Invalid
      // legacy journals propagate their validation error instead of appearing
      // as an empty recovery result.
      await store.mutate(async () => undefined, { skipUnchanged: true });
      return [];
    }
    const rows: RecoveryRow[] = [];
    for (const journal of journals) {
      try {
        await withRecoveryOperation(store, journal, async () => {
          if (mode === "resume") await resumeOperation(store, journal);
          else await rollbackOperation(store, journal);
        });
        await rm(operationPath(store.root, journal), { force: true });
        rows.push({
          id: journal.id,
          kind: journal.kind,
          packageId: journal.packageId,
          status: mode === "resume" ? "resumed" : "rolled-back",
        });
      } catch (error) {
        rows.push({
          id: journal.id,
          kind: journal.kind,
          packageId: journal.packageId,
          status: "blocked",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rows;
  });
}

export async function inspectOperations(
  root: string,
): Promise<OperationJournal[]> {
  return await pendingOperations(root);
}
