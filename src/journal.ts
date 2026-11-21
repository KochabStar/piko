import { AsyncLocalStorage } from "node:async_hooks";
import { gzipSync, gunzipSync } from "node:zlib";
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  atomicJson,
  exists,
  fail,
  json,
  noLinks,
  relativeFile,
  sha256,
  record,
} from "./util.ts";
import { validateState } from "./store.ts";
import type { Store } from "./store.ts";
import type { State, Source, Manifest } from "./types.ts";

export type OperationKind = "install" | "uninstall" | "update";
export type OperationPhase = {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  at?: string;
  error?: string;
};
export type OperationMove = { from: string; to: string };
export type StateSnapshot = { data: string; hash: string; revision: number };
export type OperationJournal = {
  id: string;
  kind: OperationKind;
  packageId: string;
  startedAt: string;
  pid: number;
  status: "running" | "failed" | "completed";
  phases: OperationPhase[];
  files: string[];
  moves: OperationMove[];
  options: Record<string, unknown>;
  bindings: Record<string, unknown>[];
  before: StateSnapshot;
  states: StateSnapshot[];
  captured?: StateSnapshot;
};
export type OperationOptions = {
  phases?: string[];
  keepOnSuccess?: boolean;
  [key: string]: unknown;
};
type OperationContext = {
  root: string;
  journal: OperationJournal;
  finishing: boolean;
  closed?: boolean;
};
const context = new AsyncLocalStorage<OperationContext>();
const MAX_STATE = 16 * 1024 * 1024;
const MAX_JOURNAL = 64 * 1024 * 1024;
function validateJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    !value ||
    seen.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    fail("Operation intent must contain only acyclic JSON values");
  seen.add(value);
  for (const entry of Object.values(value))
    if (entry !== undefined) validateJson(entry, seen);
  seen.delete(value);
}

function active(store: Store): OperationContext | undefined {
  const value = context.getStore();
  return value?.root === store.root && !value.closed ? value : undefined;
}
export function hasActiveOperation(store: Store): boolean {
  const value = active(store);
  return !!value && !value.finishing;
}
export function isRecoveryOperation(store: Store): boolean {
  return active(store)?.finishing === true;
}
export function operationPath(
  root: string,
  journal: Pick<OperationJournal, "id">,
): string {
  return join(root, "operations", `operation-${journal.id}.json`);
}
function snapshot(state: State): StateSnapshot {
  validateState(state);
  const text = Buffer.from(JSON.stringify(state));
  if (text.length > MAX_STATE)
    fail("Operation state exceeds snapshot safety limit");
  return {
    data: gzipSync(text).toString("base64"),
    hash: sha256(text),
    revision: state.revision,
  };
}
export function decodeOperationState(value: unknown): State {
  if (
    !record(value) ||
    typeof value.data !== "string" ||
    value.data.length > MAX_STATE * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    ) ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    fail("Invalid operation state snapshot");
  let text: Buffer;
  try {
    text = gunzipSync(Buffer.from(value.data, "base64"), {
      maxOutputLength: MAX_STATE,
    });
  } catch {
    fail("Invalid or oversized compressed operation state");
  }
  if (sha256(text) !== value.hash)
    fail("Operation state snapshot hash mismatch");
  const state: unknown = JSON.parse(text.toString("utf8"));
  validateState(state);
  if (state.revision !== value.revision)
    fail("Operation state revision mismatch");
  return state;
}
async function save(value: OperationContext): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(value.journal)) > MAX_JOURNAL)
    fail("Operation journal exceeds safety limit");
  await atomicJson(operationPath(value.root, value.journal), value.journal);
}
function managedPath(root: string, path: string): string {
  const rel = relative(root, resolve(path)).split(sep).join("/");
  relativeFile(rel);
  if (!rel.startsWith("staging/") && !rel.startsWith("apps/"))
    fail("Operation path outside apps/staging boundary");
  if (rel.startsWith("apps/piko/")) fail("Operation cannot own manager state");
  return rel;
}
export async function bindOperation(
  store: Store,
  binding: Record<string, unknown>,
): Promise<void> {
  const value = active(store);
  if (!value) return;
  validateJson(binding);
  const serialized = JSON.stringify(binding);
  if (serialized.length > MAX_STATE)
    fail("Operation binding exceeds safety limit");
  const copy: unknown = JSON.parse(serialized);
  if (!record(copy)) fail("Invalid operation binding");
  if (
    !value.journal.bindings.some((item) => JSON.stringify(item) === serialized)
  )
    value.journal.bindings.push(copy);
  await save(value);
}
export async function bindOperationPackage(
  store: Store,
  binding: {
    id: string;
    source: Source;
    name: string;
    version: string;
    manifestHash: string;
    manifest: Manifest;
  },
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(binding.id) ||
    !binding.name ||
    !binding.version ||
    !/^[a-f0-9]{64}$/.test(binding.manifestHash)
  )
    fail("Invalid bound operation package identity");
  await bindOperation(store, binding);
}
/** Capture tentative ownership before a helper can fail, without claiming publication. */
export async function recordOperationState(
  store: Store,
  state: State,
  after?: State,
): Promise<void> {
  const value = active(store);
  if (!value) return;
  value.journal.captured = snapshot(after ?? state);
  await save(value);
}
/** Persist the candidate BEFORE state publication, closing the publication/checkpoint crash window. */
export async function recordOperationCommit(
  store: Store,
  before: State,
  after: State,
): Promise<void> {
  const value = active(store);
  if (!value) return;
  const current = snapshot(before);
  if (!value.journal.states.some((item) => item.hash === current.hash))
    fail("Operation committed-state binding changed");
  const next = snapshot(after);
  if (!value.journal.states.some((item) => item.hash === next.hash))
    value.journal.states.push(next);
  await save(value);
}
/** Only a handled failed removal can be retried by the same explicit request. */
async function retryFailedUninstall(
  store: Store,
  kind: OperationKind,
  spec: string,
  options: OperationOptions,
): Promise<OperationJournal | undefined> {
  const pending = await pendingOperations(store.root);
  if (pending.length !== 1 || kind !== "uninstall") return;
  const journal = pending[0]!;
  if (
    journal.kind !== kind ||
    journal.packageId !== spec ||
    journal.status !== "failed" ||
    JSON.stringify(journal.options) !== JSON.stringify(options) ||
    journal.phases.some((phase) => phase.status === "running") ||
    !journal.phases.some(
      (phase) => phase.name === "uninstall-admin" && phase.status === "failed",
    ) ||
    journal.moves.length ||
    journal.bindings.length !== 1
  )
    return;
  if (
    journal.phases.some(
      (phase) =>
        /admin|bootstrap|script/i.test(phase.name) &&
        phase.name !== "uninstall-admin",
    )
  )
    return;
  const binding = journal.bindings[0]!;
  if (
    binding.kind !== "uninstall" ||
    typeof binding.packageId !== "string" ||
    binding.force !== options.force
  )
    return;
  const current = await store.readCommitted();
  const bound = current.installs[binding.packageId];
  const original = decodeOperationState(journal.before);
  const currentSnapshot = snapshot(current);
  if (
    !bound ||
    JSON.stringify(bound) !== JSON.stringify(binding.installation) ||
    JSON.stringify(original.installs[bound.id]) !== JSON.stringify(bound) ||
    !journal.states.some((state) => state.hash === currentSnapshot.hash) ||
    journal.captured?.hash !== currentSnapshot.hash
  )
    return;
  const history = current.receipts?.[bound.id]?.admin;
  const approved = original.receipts?.[bound.id]?.admin;
  if (
    history?.install?.status !== "completed" ||
    history.remove?.status !== "failed" ||
    current.admin?.[bound.id]?.action !== "remove" ||
    current.admin[bound.id]?.status !== "failed" ||
    JSON.stringify(history.install) !== JSON.stringify(approved?.install) ||
    JSON.stringify(history.declaration) !==
      JSON.stringify(approved?.declaration) ||
    history.contentHash !== approved?.contentHash
  )
    return;
  const unchanged = (state: State) => {
    const copy = structuredClone(state);
    copy.revision = 0;
    delete copy.admin?.[bound.id];
    if (copy.receipts?.[bound.id]) delete copy.receipts[bound.id]!.admin;
    return JSON.stringify(copy);
  };
  if (
    unchanged(current) !== unchanged(original) ||
    JSON.stringify(current.admin?.[bound.id]) !== JSON.stringify(history.remove)
  )
    return;
  // There must be no trash, staged payload, or other low-level intent to finish.
  if (
    (
      await Promise.all(
        journal.files.map((file) => exists(join(store.root, file))),
      )
    ).some(Boolean) ||
    (await readdir(join(store.root, "operations"))).some(
      (name) => name !== `operation-${journal.id}.json`,
    )
  )
    return;
  // This rechecks the stored approved declaration, installation receipt, digest,
  // These modules depend on the journal/store cycle; defer loading until the
  // validated retry boundary so ordinary journal recovery remains acyclic.
  await (
    await import("./execution.ts")
  ).preflightAdminRemoval(store, current, bound);
  return journal;
}
export async function runOperation<T>(
  store: Store,
  kind: OperationKind,
  spec: string,
  options: OperationOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (active(store)) return await fn();
  return await store.withMutationLock(async () => {
    validateJson(options);
    const retry = await retryFailedUninstall(store, kind, spec, options);
    if (!retry) {
      await autoRecoverDeadJournals(store);
      await assertOrdinaryWrite(store);
    }
    const before = retry?.before ?? snapshot(await store.readCommitted());
    const journal: OperationJournal = retry ?? {
      id: crypto.randomUUID(),
      kind,
      packageId: spec,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      status: "running",
      phases: (options.phases ?? []).map((name) => ({
        name,
        status: "pending",
      })),
      files: [],
      moves: [],
      options: JSON.parse(JSON.stringify(options)),
      bindings: [],
      before,
      states: [before],
    };
    const attempt: OperationPhase | undefined = retry
      ? {
          name: "uninstall-retry",
          status: "running",
          at: new Date().toISOString(),
        }
      : undefined;
    if (attempt) journal.phases.push(attempt);
    journal.pid = process.pid;
    journal.status = "running";
    const value: OperationContext = {
      root: store.root,
      journal,
      finishing: false,
    };
    await save(value);
    return await context.run(value, async () => {
      try {
        const result = await fn();
        if (attempt) attempt.status = "done";
        journal.status = "completed";
        await save(value);
        value.finishing = true;
        await store.recoverRemoval();
        if (!options.keepOnSuccess)
          await rm(operationPath(store.root, journal), { force: true });
        return result;
      } catch (error) {
        if (attempt) {
          attempt.status = "failed";
          attempt.error =
            error instanceof Error ? error.message : String(error);
        }
        journal.status = "failed";
        const current = snapshot(await store.readCommitted());
        const captured = journal.captured
          ? decodeOperationState(journal.captured)
          : undefined;
        const initial = decodeOperationState(before);
        const changedCapture =
          captured &&
          JSON.stringify({
            services: captured.services,
            admin: captured.admin,
            bootstraps: captured.bootstraps,
            desktop: captured.desktop,
            profiles: captured.profiles,
          }) !==
            JSON.stringify({
              services: initial.services,
              admin: initial.admin,
              bootstraps: initial.bootstraps,
              desktop: initial.desktop,
              profiles: initial.profiles,
            });
        const executionBoundary = journal.phases.some(
          (phase) =>
            phase.status !== "pending" &&
            /admin|bootstrap|script/i.test(phase.name),
        );
        const trackedPathsGone = (
          await Promise.all(
            journal.files.map((file) => exists(join(store.root, file))),
          )
        ).every((present) => !present);
        const movesUntouched = (
          await Promise.all(
            journal.moves
              .flatMap((move) => [move.from, move.to])
              .map((file) => exists(join(store.root, file))),
          )
        ).every((present) => !present);
        const effectJournalPending =
          (await exists(
            join(store.root, "operations", "receipt-files.json"),
          )) ||
          (await exists(
            join(store.root, "operations", "receipt-restore.json"),
          ));
        // A failed preflight/download may have registered a stage path before
        // creating it. It is directly retryable when no managed path moved,
        // no state/effect ownership changed, and no irreversible phase began.
        if (
          !executionBoundary &&
          trackedPathsGone &&
          movesUntouched &&
          !effectJournalPending &&
          current.hash === before.hash &&
          !changedCapture
        )
          await rm(operationPath(store.root, journal), { force: true });
        else {
          await save(value);
          if (executionBoundary && kind === "update") {
            // The failed approved execution is durably recorded in state
            // receipts. Close the interrupted update instead of leaving a
            // tombstone that blocks every unrelated package: committed
            // versions stay installed, the previous default stays selected,
            // and a fresh explicit command retries the migration.
            try {
              // recover.ts imports this module; defer the cycle until closure
              // is actually required, like the rollback import below.
              await (
                await import("./ops/recover.ts")
              ).discardFailedOperation(store, journal);
              await rm(operationPath(store.root, journal), { force: true });
            } catch (closure) {
              await save(value);
              throw new AggregateError(
                [error, closure],
                `${error instanceof Error ? error.message : String(error)}; closing the interrupted update blocked: ${closure instanceof Error ? closure.message : String(closure)}; run piko recover`,
              );
            }
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; interrupted update closed: committed versions stay installed and the previous default remains selected; fix the cause and rerun the update`,
            );
          }
          const failedServiceOwnership = Object.values(
            captured?.services ?? {},
          ).some((receipt) => receipt.status === "failed");
          const publishedPayload = (
            await Promise.all(
              journal.files
                .filter((file) => file.startsWith("apps/"))
                .map((file) => exists(join(store.root, file))),
            )
          ).some(Boolean);
          if (
            !executionBoundary &&
            !failedServiceOwnership &&
            (current.hash !== before.hash ||
              publishedPayload ||
              effectJournalPending) &&
            (kind === "install" || kind === "update")
          ) {
            try {
              // Recovery imports the journal and store, so defer this cycle
              // until compensation is actually required.
              await (
                await import("./ops/recover.ts")
              ).rollbackFailedOperation(store, journal);
              await rm(operationPath(store.root, journal), { force: true });
            } catch (compensation) {
              await save(value);
              throw new AggregateError(
                [error, compensation],
                `${error instanceof Error ? error.message : String(error)}; managed rollback blocked: ${compensation instanceof Error ? compensation.message : String(compensation)}; run piko recover`,
              );
            }
          }
        }
        throw error;
      } finally {
        value.closed = true;
      }
    });
  });
}
export async function checkpoint<T>(
  store: Store,
  phase: string,
  fn: () => Promise<T>,
): Promise<T> {
  const value = active(store);
  if (!value) return await fn();
  if (!phase || phase.length > 160) fail("Invalid operation phase");
  const current: OperationPhase = {
    name: phase,
    status: "running",
    at: new Date().toISOString(),
  };
  value.journal.phases.push(current);
  await save(value);
  try {
    const result = await fn();
    current.status = "done";
    await save(value);
    return result;
  } catch (error) {
    current.status = "failed";
    current.error = error instanceof Error ? error.message : String(error);
    await save(value);
    throw error;
  }
}
export async function trackOperationFile(
  store: Store,
  path: string,
): Promise<void> {
  const value = active(store);
  if (!value) return;
  const rel = managedPath(store.root, path);
  if (!value.journal.files.includes(rel)) value.journal.files.push(rel);
  await save(value);
}
export async function trackOperationMove(
  store: Store,
  from: string,
  to: string,
): Promise<void> {
  const value = active(store);
  if (!value) return;
  const move = {
    from: managedPath(store.root, from),
    to: managedPath(store.root, to),
  };
  if (
    !value.journal.moves.some(
      (item) => item.from === move.from && item.to === move.to,
    )
  )
    value.journal.moves.push(move);
  await save(value);
}
export function operationOwnerLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
function validateJournal(value: unknown): asserts value is OperationJournal {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !["install", "uninstall", "update"].includes(value.kind) ||
    typeof value.packageId !== "string" ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !["running", "failed", "completed"].includes(value.status) ||
    !Array.isArray(value.phases) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.moves) ||
    !record(value.options) ||
    !Array.isArray(value.bindings) ||
    !value.bindings.every(record) ||
    !Array.isArray(value.states) ||
    !value.states.length ||
    value.states.length > 1024
  )
    fail("Invalid operation journal");
  decodeOperationState(value.before);
  for (const state of value.states) decodeOperationState(state);
  if (value.captured !== undefined) decodeOperationState(value.captured);
  for (const phase of value.phases)
    if (
      !record(phase) ||
      typeof phase.name !== "string" ||
      phase.name.length > 160 ||
      !["pending", "running", "done", "failed"].includes(phase.status)
    )
      fail("Invalid operation phase");
  for (const path of value.files) {
    if (typeof path !== "string") fail("Invalid operation file");
    relativeFile(path);
    if (
      (!path.startsWith("staging/") && !path.startsWith("apps/")) ||
      path.startsWith("apps/piko/")
    )
      fail("Invalid operation file boundary");
  }
  for (const move of value.moves) {
    if (
      !record(move) ||
      typeof move.from !== "string" ||
      typeof move.to !== "string"
    )
      fail("Invalid operation move");
    for (const path of [move.from, move.to]) {
      relativeFile(path);
      if (
        (!path.startsWith("staging/") && !path.startsWith("apps/")) ||
        path.startsWith("apps/piko/")
      )
        fail("Invalid operation move boundary");
    }
  }
}

/**
 * Before an ordinary write blocks on a dead-owner journal, try to recover it
 * automatically. This keeps `piko update *` / `piko install` usable after a
 * previous run was killed: inert journals (zero side effects) are discarded,
 * resumable ones finish their remaining phases, and only genuinely blocked
 * journals (admin-phase failures the user must inspect) still require an
 * explicit `piko recover`.
 */
async function autoRecoverDeadJournals(store: Store): Promise<void> {
  if (store.recovering) return;
  const pending = await pendingOperations(store.root);
  if (!pending.length) return;
  store.recovering = true;
  try {
    const { recoverOperations } = await import("./ops/recover.ts");
    await recoverOperations(store);
  } catch {
    // Recovery failure leaves the journal in place; assertOrdinaryWrite
    // reports exactly what remains and how to handle it.
  } finally {
    store.recovering = false;
  }
}
export async function pendingOperations(
  root: string,
): Promise<OperationJournal[]> {
  const dir = join(resolve(root), "operations");
  await noLinks(dir);
  if (!(await exists(dir))) return [];
  const result: OperationJournal[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!name.startsWith("operation-") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    await noLinks(path);
    if ((await stat(path)).size > MAX_JOURNAL)
      fail("Operation journal exceeds safety limit");
    const value: unknown = await json(path);
    validateJournal(value);
    if (name !== `operation-${value.id}.json`)
      fail("Operation journal filename binding mismatch");
    result.push(value);
  }
  return result;
}
export async function assertRecoverableOperations(
  root: string,
): Promise<OperationJournal[]> {
  const result = await pendingOperations(root);
  if (result.some((item) => operationOwnerLive(item.pid)))
    fail("An operation owner is still running; refusing recovery");
  return result;
}
export async function assertOrdinaryWrite(store: Store): Promise<void> {
  const own = active(store);
  const pending = (await pendingOperations(store.root)).filter(
    (item) => item.id !== own?.journal.id,
  );
  if (pending.length)
    fail(
      "Interrupted operation pending; run piko recover before writing (live owners are never stolen)",
    );
  if (
    !own &&
    (await exists(join(store.root, "operations", "receipt-restore.json")))
  )
    fail(
      "External effect restoration pending; run piko recover before writing",
    );
}
export async function withRecoveryOperation<T>(
  store: Store,
  journal: OperationJournal,
  fn: () => Promise<T>,
): Promise<T> {
  return await context.run({ root: store.root, journal, finishing: true }, fn);
}
