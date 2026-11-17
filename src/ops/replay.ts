import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeManifest, parseSpec } from "../catalog.ts";
import {
  checkpoint,
  decodeOperationState,
  isRecoveryOperation,
  recordOperationState,
  type OperationJournal,
} from "../journal.ts";
import {
  emptyState,
  installId,
  packageKey,
  sourceIdentity,
  validateState,
  type Store,
} from "../store.ts";
import {
  checkPersistentFileMappings,
  checkPersistentLinkMappings,
} from "../persistence.ts";
import { validateReceipts } from "../receipt.ts";
import { npmTreeHash } from "../scripts.ts";
import {
  preflightUnregisterServices,
  registerServices,
  unregisterServices,
} from "../service.ts";
import {
  commandName,
  exists,
  fail,
  json,
  noLinks,
  record,
  sha256,
} from "../util.ts";
import { installPackage } from "./install.ts";
import { usePackage } from "./use.ts";
import { uninstallPackage } from "./uninstall.ts";
import type { Install, Manifest, Source, State } from "../types.ts";
import type { PackagesContext } from "./context.ts";

type BoundInstall = {
  id: string;
  key: string;
  spec: string;
  source: Source;
  name: string;
  version: string;
  manifestHash?: string;
  manifest?: Manifest;
  npmLock?: unknown;
};
type BoundUpdate = {
  key: string;
  previous: string;
  target: string;
  spec: string;
  request: string;
};
type BoundRemoval = { spec: string; installation: Install; force: boolean };
type DependencyStep = {
  candidate: BoundInstall;
  select: boolean;
  request: string;
  commands: string[];
};

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) fail(`Invalid saved ${label}`);
  return value;
}
function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`Invalid saved ${label}`);
  return result;
}
function exactSpec(source: Source, name: string, version: string): string {
  return source.type === "npm"
    ? `npm:${name}@${version}`
    : `${source.alias}/${name}@${version}`;
}
function validateSource(
  value: unknown,
  state: State,
  requireConfigured = true,
): Source {
  if (!record(value) || !["http", "git", "npm"].includes(String(value.type)))
    fail("Invalid saved source");
  const source = value as Source;
  text(source.alias, "source alias");
  text(source.url, "source URL");
  if (source.ref !== undefined && typeof source.ref !== "string")
    fail("Invalid saved source ref");
  if (source.identity !== sourceIdentity(source.type, source.url, source.ref))
    fail("Saved source identity mismatch");
  if (source.type !== "npm") {
    const probe = emptyState();
    probe.sources[source.alias] = source;
    validateState(probe);
    if (requireConfigured) {
      const configured = state.sources[source.alias];
      if (
        !configured ||
        configured.identity !== source.identity ||
        configured.type !== source.type ||
        configured.url !== source.url ||
        configured.ref !== source.ref
      )
        fail("Restore the original configured source identity before resuming");
    }
  } else if (source.alias !== "npm") fail("Invalid saved npm source alias");
  return {
    alias: source.alias,
    url: source.url,
    type: source.type,
    identity: source.identity,
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    ...(source.commit === undefined ? {} : { commit: source.commit }),
  };
}
function validateCandidate(
  value: Record<string, unknown>,
  state: State,
): BoundInstall {
  const source = validateSource(value.source, state);
  const name = text(value.name, "package name"),
    version = text(value.version, "exact version");
  const spec = exactSpec(source, name, version),
    parsed = parseSpec(spec);
  if (
    parsed.name !== name ||
    parsed.request !== version ||
    parsed.source !== source.alias
  )
    fail("Saved package spec identity mismatch");
  const key = packageKey(source, name),
    id = installId(key, version);
  if (
    (value.packageId ?? value.id) !== id ||
    (value.spec !== undefined && value.spec !== spec)
  )
    fail("Saved installation identity mismatch");
  if (source.type === "npm") {
    if (value.manifest !== undefined || value.manifestHash !== undefined)
      fail("Unexpected portable manifest in npm binding");
    return { id, key, spec, source, name, version, npmLock: value.npmLock };
  }
  const manifest = normalizeManifest(value.manifest, name, version);
  const manifestHash = digest(value.manifestHash, "manifest hash");
  if (sha256(JSON.stringify(manifest)) !== manifestHash)
    fail("Saved manifest SHA-256 mismatch");
  return { id, key, spec, source, name, version, manifestHash, manifest };
}
function validateRemoval(
  value: Record<string, unknown>,
  state: State,
): BoundRemoval {
  if (!record(value.installation) || typeof value.force !== "boolean")
    fail("Invalid saved uninstall intent");
  const install = value.installation as Install;
  const probe = emptyState();
  probe.installs[install.id] = install;
  validateState(probe);
  validateSource(install.source, state, false);
  const spec = exactSpec(install.source, install.name, install.version);
  if (value.packageId !== install.id || value.spec !== spec)
    fail("Saved uninstall identity mismatch");
  return { spec, installation: install, force: value.force };
}
async function verifyLocal(
  store: Store,
  state: State,
  install: Install,
  bound?: BoundInstall,
): Promise<void> {
  if (
    bound &&
    (install.id !== bound.id ||
      install.key !== bound.key ||
      install.name !== bound.name ||
      install.version !== bound.version ||
      install.source.identity !== bound.source.identity ||
      (bound.manifestHash !== undefined &&
        install.manifestHash !== bound.manifestHash))
  )
    fail("Installed payload does not match the saved installation intent");
  const root = join(store.root, install.dir),
    receipt = join(root, ".piko-install.json");
  await noLinks(root);
  await noLinks(receipt);
  if (!same(await json(receipt), install))
    fail("Local installation receipt drift; preserve payload and journal");
  validateReceipts(state);
  const owned = state.receipts?.[install.id];
  if (
    !owned ||
    owned.packageId !== install.id ||
    owned.version !== install.version
  )
    fail("Local installation has no matching durable ownership receipt");
  await checkPersistentFileMappings(store.root, install);
  await checkPersistentLinkMappings(store.root, install, { reconcile: false });
  for (const bin of Object.values(install.bins)) {
    if (bin.data) continue;
    const path = join(root, bin.path);
    await noLinks(path);
    if (!(await lstat(path)).isFile())
      fail("Installed command payload is missing or changed");
  }
  if (install.kind === "npm") {
    if (
      !install.npmBuild ||
      (await npmTreeHash(root)) !== install.npmBuild.currentHash
    )
      fail("Installed npm graph drift; preserve payload and journal");
    if (
      bound?.npmLock !== undefined &&
      sha256(JSON.stringify(bound.npmLock)) !== install.checksum
    )
      fail("Installed npm graph differs from the saved lock");
  }
}
function assertSelectionSafe(state: State, candidate: BoundInstall): void {
  const install = state.installs[candidate.id];
  const platform = candidate.manifest?.platforms["windows-x64"];
  if (
    (install?.admin?.required || platform?.admin?.required) &&
    (state.admin?.[candidate.id]?.action !== "install" ||
      state.admin[candidate.id]?.status !== "completed")
  )
    fail(
      "Recovery cannot run an unapproved admin installation; inspect and explicitly reconcile system integration",
    );
  const bins = install?.bins ?? platform?.bin ?? {};
  if (
    Object.values(bins).some((bin) => typeof bin !== "string" && bin.data) &&
    state.bootstraps?.[candidate.id]?.status !== "completed"
  )
    fail(
      "Recovery cannot run bootstrap code to create commands; inspect and explicitly approve it",
    );
  if (
    Object.values(state.receipts ?? {}).some(
      (receipt) =>
        receipt.packageId !== candidate.id &&
        state.installs[receipt.packageId]?.key === candidate.key &&
        receipt.admin?.install &&
        receipt.admin.remove?.status !== "completed",
    )
  )
    fail("Recovery cannot automatically migrate arbitrary system integration");
}
async function ensureCandidate(
  ops: PackagesContext,
  candidate: BoundInstall,
  withService: boolean,
  deferService = false,
): Promise<Install> {
  const state = await ops.store.readCommitted();
  const prior = state.installs[candidate.id];
  if (prior) await verifyLocal(ops.store, state, prior, candidate);
  if (!candidate.manifest || !candidate.manifestHash) {
    if (prior) return prior;
    fail(
      "Exact npm graph is not installed; locked npm recovery preparation is required. No lifecycle code was run; preserve journal and staging",
    );
  }
  return await installPackage(ops, candidate.spec, {
    offline: true,
    expectedManifestHash: candidate.manifestHash,
    bound: {
      source: candidate.source,
      name: candidate.name,
      version: candidate.version,
      manifest: candidate.manifest,
    },
    withService,
    deferService,
  });
}

/** Replay only validated, durable intent. Caller owns the lease and reconciles known low-level journals. */
export async function resumeOperationPlan(
  store: Store,
  journal: OperationJournal,
): Promise<void> {
  if (!isRecoveryOperation(store))
    fail("Bound replay requires the existing recovery operation lease");
  const state = await store.readCommitted(),
    before = decodeOperationState(journal.before);
  validateState(state);
  if (
    !journal.states.some((snapshot) =>
      same(decodeOperationState(snapshot), state),
    )
  )
    fail("Operation state drift before bound replay");
  const snapshots = [
    before,
    ...journal.states.map(decodeOperationState),
    ...(journal.captured ? [decodeOperationState(journal.captured)] : []),
  ];
  const executionPhases = journal.phases.filter((phase) =>
    /admin|bootstrap|script/i.test(phase.name),
  );
  if (
    executionPhases.some(
      (phase) => phase.status !== "pending" && phase.status !== "done",
    ) ||
    (snapshots.some(
      (snapshot) =>
        !same(snapshot.admin ?? {}, before.admin ?? {}) ||
        !same(snapshot.bootstraps ?? {}, before.bootstraps ?? {}),
    ) &&
      !executionPhases.some((phase) => phase.status === "done"))
  )
    fail(
      "Arbitrary approved execution has an uncertain boundary; inspect/retry explicitly and preserve journal",
    );
  if (!journal.bindings.length)
    fail("Operation has no exact saved binding intent; preserve journal");
  const candidates = new Map<string, BoundInstall>();
  const updateIntents = new Map<
    string,
    { previous: string; request: string; spec: string }
  >();
  const updates: BoundUpdate[] = [],
    removals: BoundRemoval[] = [];
  let dependency: Record<string, unknown> | undefined;
  const addCandidate = (value: Record<string, unknown>): BoundInstall => {
    const candidate = validateCandidate(value, state),
      prior = candidates.get(candidate.id);
    if (prior && !same(prior, candidate))
      fail("Conflicting saved installation/version/manifest intents");
    candidates.set(candidate.id, candidate);
    return candidate;
  };
  // Validate every record before any replay, even records unrelated to the first unfinished step.
  for (const binding of journal.bindings) {
    if (!record(binding)) fail("Malformed saved operation binding");
    if (
      binding.kind === "install" ||
      (binding.kind === undefined && binding.id !== undefined)
    )
      addCandidate(binding);
    else if (binding.kind === "uninstall")
      removals.push(validateRemoval(binding, state));
    else if (binding.kind === "update") {
      const key = text(binding.packageId, "update key"),
        previous = digest(binding.previous, "previous installation");
      const spec = text(binding.spec, "update spec"),
        request = text(binding.request, "selection request");
      const old = before.installs[previous];
      if (
        !old ||
        old.key !== key ||
        before.defaults[key]?.id !== old.id ||
        before.defaults[key]?.request !== request
      )
        fail("Saved update intent disagrees with the original selection");
      const parsed = parseSpec(spec);
      if (
        parsed.name !== old.name ||
        (parsed.source && parsed.source !== old.source.alias)
      )
        fail("Saved update spec mismatch");
      const intent = { previous, request, spec },
        prior = updateIntents.get(key);
      if (prior && (prior.previous !== previous || prior.request !== request))
        fail("Conflicting saved update selection intents");
      updateIntents.set(key, intent);
      if (binding.target !== undefined) {
        const update = {
          key,
          previous,
          target: digest(binding.target, "update target"),
          spec,
          request,
        };
        if (
          updates.some(
            (entry) => entry.key === key && entry.target !== update.target,
          )
        )
          fail("Conflicting saved update targets");
        if (!updates.some((entry) => entry.key === key)) updates.push(update);
      }
    } else if (binding.kind === "dependencies") {
      if (dependency && !same(dependency, binding))
        fail("Conflicting saved dependency plans");
      if (
        typeof binding.spec !== "string" ||
        !Array.isArray(binding.steps) ||
        !binding.steps.length ||
        binding.steps.length > 1000 ||
        !record(binding.options)
      )
        fail("Malformed saved dependency plan");
      dependency = binding;
    } else
      fail("Unsupported or malformed saved operation intent; preserve journal");
  }
  const steps: DependencyStep[] = [];
  if (dependency) {
    for (const value of dependency.steps as unknown[]) {
      if (
        !record(value) ||
        typeof value.select !== "boolean" ||
        !Array.isArray(value.commands) ||
        !value.commands.every((command) => typeof command === "string") ||
        new Set(value.commands).size !== value.commands.length
      )
        fail("Malformed saved dependency step");
      const packageSpec = text(value.package, "dependency package"),
        version = text(value.version, "dependency version");
      const parsed = parseSpec(`${packageSpec}@${version}`);
      const source =
        state.sources[parsed.source ?? ""] ??
        fail("Saved dependency source is no longer configured");
      const id = installId(packageKey(source, parsed.name), version);
      let candidate = candidates.get(id);
      if (value.manifest !== undefined)
        candidate = addCandidate({
          ...value,
          kind: "install",
          packageId: id,
          source: value.source ?? source,
          name: value.name ?? parsed.name,
          spec: `${packageSpec}@${version}`,
        });
      if (
        !candidate ||
        candidate.manifestHash !==
          digest(value.manifestHash, "dependency manifest hash")
      )
        fail(
          "Saved dependency step has no exact validated manifest; preserve journal instead of replanning",
        );
      if (steps.some((step) => step.candidate.key === candidate.key))
        fail("Duplicate dependency provider in saved plan");
      const commands = value.commands as string[];
      for (const command of commands) commandName(command);
      steps.push({
        candidate,
        select: value.select,
        request: text(value.request, "dependency request"),
        commands,
      });
    }
    const root = parseSpec(text(dependency.spec, "dependency root"));
    const roots = steps.filter(
      (step) =>
        step.candidate.name === root.name &&
        (!root.source || step.candidate.source.alias === root.source),
    );
    if (roots.length !== 1 || roots[0]!.select)
      fail("Saved dependency plan must keep the root unselected");
    if (
      !same(
        state.defaults[roots[0]!.candidate.key],
        before.defaults[roots[0]!.candidate.key],
      )
    )
      fail("Dependency root selection changed");
    const claims = new Map<string, string>();
    for (const [index, step] of steps.entries()) {
      const { candidate } = step;
      const original = before.defaults[candidate.key],
        current = state.defaults[candidate.key];
      if (
        step.select
          ? !!original || (!!current && current.id !== candidate.id)
          : !same(original, current)
      )
        fail("Saved dependency provider constraint changed");
      if (step.select) assertSelectionSafe(state, candidate);
      const bins = candidate.manifest!.platforms["windows-x64"]!.bin;
      for (const command of step.select
        ? [...Object.keys(bins), ...step.commands]
        : step.commands) {
        const owner =
          state.commands[command] ??
          state.aliases?.[command]?.key ??
          claims.get(command);
        if (owner && owner !== candidate.key)
          fail("Saved dependency command/provider conflict");
        if (!bins[command] && !state.aliases?.[command])
          fail("Saved dependency command is no longer provided");
        if (step.select && state.aliases?.[command])
          fail("Saved dependency command conflicts with an alias");
        claims.set(command, candidate.key);
      }
      for (const requirement of candidate.manifest!.platforms["windows-x64"]!
        .depends ?? []) {
        const parsed = parseSpec(requirement.package);
        const provider = parsed.source
          ? state.sources[parsed.source]
          : candidate.source;
        if (!provider) fail("Saved dependency provider is missing");
        const key = packageKey(provider, parsed.name),
          position = steps.findIndex((entry) => entry.candidate.key === key);
        if (position < 0 || position >= index)
          fail("Saved dependency steps are not a complete topological plan");
      }
    }
  }
  for (const [key, intent] of updateIntents)
    if (!updates.some((update) => update.key === key)) {
      const matches = [...candidates.values()].filter(
        (candidate) => candidate.key === key,
      );
      if (matches.length !== 1)
        fail(
          "Update target intent is absent and no unique exact bound candidate exists",
        );
      updates.push({ key, ...intent, target: matches[0]!.id });
    }
  // A crash before recording selection may use only the unique candidate bound to the original selected key.
  if (journal.kind === "update" && !dependency) {
    const parsed = parseSpec(journal.packageId);
    const originals = Object.values(before.installs).filter(
      (install) =>
        before.defaults[install.key]?.id === install.id &&
        install.name === parsed.name &&
        (!parsed.source || parsed.source === install.source.alias),
    );
    for (const old of originals)
      if (!updates.some((update) => update.key === old.key)) {
        const matches = [...candidates.values()].filter(
          (candidate) => candidate.key === old.key,
        );
        if (matches.length !== 1)
          fail(
            "Update selection intent is absent and no unique exact bound target exists",
          );
        updates.push({
          key: old.key,
          previous: old.id,
          target: matches[0]!.id,
          spec: journal.packageId,
          request: before.defaults[old.key]!.request,
        });
      }
    if (!updates.length) fail("No validated saved update selection intent");
  }
  for (const update of updates) {
    const target =
      candidates.get(update.target) ??
      fail("Saved update target has no exact bound installation");
    if (target.key !== update.key)
      fail("Saved update target package identity mismatch");
    const current = state.defaults[update.key],
      original = before.defaults[update.key]!;
    if (
      !current ||
      current.request !== update.request ||
      (current.id !== update.previous && current.id !== update.target) ||
      (current.id === update.previous && !same(current, original))
    )
      fail("Update original selection/request compare-and-swap failed");
    assertSelectionSafe(state, target);
    const oldServices = (
      before.receipts?.[update.previous]?.service ?? []
    ).some(
      (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
    );
    if (oldServices && journal.options.withService !== true)
      fail("Saved update did not approve service migration");
  }
  for (const removal of removals) {
    const current = state.installs[removal.installation.id];
    if (current && !same(current, removal.installation))
      fail("Saved uninstall installation changed");
    const admin = state.receipts?.[removal.installation.id]?.admin;
    if (admin?.install && admin.remove?.status !== "completed")
      fail("Recovery never automatically replays arbitrary admin removal");
  }
  for (const candidate of candidates.values()) {
    const installed = state.installs[candidate.id];
    if (installed) await verifyLocal(store, state, installed, candidate);
    else if (!candidate.manifest)
      fail(
        "Exact npm graph is absent after partial preparation; preserve staging and journal for explicit locked replay. Lifecycle scripts will not run",
      );
  }
  const ops: PackagesContext = {
    root: store.root,
    store,
    effectsBackend: store.effectsBackend,
  };
  if (dependency) {
    const withService =
      (dependency.options as Record<string, unknown>).withService === true;
    for (const step of steps) {
      await ensureCandidate(ops, step.candidate, withService);
      const current = await store.readCommitted();
      if (
        step.select &&
        current.defaults[step.candidate.key]?.id !== step.candidate.id
      )
        await usePackage(ops, step.candidate.spec, {
          expectedRevision: current.revision,
        });
    }
    return;
  }
  if (journal.kind === "uninstall") {
    if (removals.length !== 1 || candidates.size || updates.length)
      fail("Malformed standalone uninstall plan");
    const removal = removals[0]!;
    if (state.installs[removal.installation.id])
      await uninstallPackage(
        ops,
        removal.spec,
        removal.force,
        removal.installation,
      );
    else {
      if (
        !snapshots.some((snapshot) =>
          same(
            snapshot.installs[removal.installation.id],
            removal.installation,
          ),
        )
      )
        fail("Removed installation has no validated saved owner");
      if (await exists(join(store.root, removal.installation.dir)))
        fail(
          "Removed installation still has an untracked live payload; preserve files",
        );
      if (
        !journal.moves.some(
          (move) =>
            move.from === removal.installation.dir.replaceAll("\\", "/"),
        )
      )
        fail("Completed uninstall has no tracked removal move");
    }
    return;
  }
  if (!candidates.size)
    fail("Operation has no exact installation intent to replay");
  for (const candidate of candidates.values()) {
    const update = updates.find((entry) => entry.target === candidate.id);
    const oldServices =
      update &&
      state.defaults[update.key]?.id !== update.target &&
      (before.receipts?.[update.previous]?.service ?? []).some(
        (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
      );
    await ensureCandidate(
      ops,
      candidate,
      journal.options.withService === true,
      !!oldServices,
    );
  }
  for (const update of updates) {
    let current = await store.readCommitted();
    if (current.defaults[update.key]?.id === update.target) continue;
    if (!same(current.defaults[update.key], before.defaults[update.key]))
      fail("Update selection compare-and-swap failed during replay");
    const previous = before.installs[update.previous]!;
    const migrateServices = (
      before.receipts?.[previous.id]?.service ?? []
    ).some(
      (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
    );
    if (migrateServices) {
      await checkpoint(store, `${update.target}/service-migrate`, () =>
        store.mutate(async (mutable) => {
          if (!same(mutable.defaults[update.key], before.defaults[update.key]))
            fail("Service migration selection compare-and-swap failed");
          const target =
            mutable.installs[update.target] ??
            fail("Bound service target is missing");
          await preflightUnregisterServices(store, mutable, previous);
          try {
            await unregisterServices(store, mutable, previous);
            if (target.services?.length)
              await registerServices(store, mutable, target);
          } catch (error) {
            try {
              if (target.services?.length)
                await unregisterServices(store, mutable, target);
              await registerServices(store, mutable, previous);
            } catch (compensation) {
              await recordOperationState(store, mutable);
              fail(
                String(error) +
                  "; restoring old service failed: " +
                  String(compensation),
              );
            }
            await recordOperationState(store, mutable);
            throw error;
          }
        }),
      );
      current = await store.readCommitted();
    }
    await usePackage(ops, candidates.get(update.target)!.spec, {
      expectedRevision: current.revision,
      retainRequest: true,
    });
  }
  for (const removal of removals) {
    if ((await store.readCommitted()).installs[removal.installation.id])
      await uninstallPackage(
        ops,
        removal.spec,
        removal.force,
        removal.installation,
      );
  }
}
