import { report } from "../progress.ts";
import { npmContext } from "../npm.ts";
import { WindowsEffects } from "../windows-effects.ts";
import { fail } from "../util.ts";
import { refresh } from "../source-fetch.ts";
import {
  resolutionSession,
  type ResolutionSession,
} from "../package-resolution.ts";
import {
  bindOperation,
  checkpoint,
  recordOperationState,
  runOperation,
} from "../journal.ts";
import {
  preflightUnregisterServices,
  registerServices,
  unregisterServices,
} from "../service.ts";
import {
  inspectSystemUpgrade,
  applySystemUpgrade,
} from "../integration-upgrade.ts";
import { installPackage } from "./install.ts";
import { installed } from "./shared.ts";
import { select } from "./use.ts";
import { outdated } from "./query.ts";
import type { Install } from "../types.ts";
import type {
  PackagesContext,
  SourceIndexes,
  UpdateOptions,
} from "./context.ts";

export type UpdateResult = {
  package: string;
  request: string;
  status: string;
  version?: string;
  current?: string;
  candidate?: string | null;
  latest?: string;
  source?: string;
  reason?: string;
  error?: string;
};

async function refreshUpdateSources(
  ops: PackagesContext,
  indexes: SourceIndexes,
): Promise<void> {
  if (indexes.size) return;
  await ops.store.mutate(
    async (state) => {
      for (const source of Object.values(state.sources)) {
        report({
          kind: "stage",
          label: "Refresh source",
          detail: source.alias,
        });
        const index = await refresh(ops.root, source);
        indexes.set(
          source.identity,
          Promise.resolve({ source: structuredClone(source), index }),
        );
      }
    },
    { skipUnchanged: true },
  );
}

export async function updatePackage(
  ops: PackagesContext,
  spec: string,
  indexes: SourceIndexes = new Map(),
  options: UpdateOptions = {},
  resolution: ResolutionSession = resolutionSession(),
): Promise<Install> {
  await refreshUpdateSources(ops, indexes);
  return await runOperation(ops.store, "update", spec, options, async () => {
    report({ kind: "stage", label: "Check selected version", detail: spec });
    const state = await ops.store.read();
    const match = installed(state, spec);
    const selection = state.defaults[match.key];
    if (!selection) fail("Package has no default version to update");
    const previous = state.installs[selection.id]!;
    if (
      previous.kind !== "npm" &&
      !Object.values(state.sources).some(
        (source) => source.identity === previous.source.identity,
      )
    )
      fail("Original source is not configured; restore it before updating");
    await bindOperation(ops.store, {
      kind: "update",
      packageId: previous.key,
      previous: previous.id,
      spec,
      request: selection.request,
    });
    if (selection.request === previous.version) return previous;
    const existingServices = (
      state.receipts?.[previous.id]?.service ?? []
    ).some(
      (effect) => effect.receipt.owned && effect.receipt.status !== "removed",
    );
    if (existingServices && !options.withService)
      fail(
        "Service migration requires an Administrator terminal: piko update " +
          spec +
          " --with-service",
      );
    let target: Install;
    if (previous.kind === "npm") {
      const context = await npmContext(ops.root, state, previous.name);
      if (context.registry !== previous.source.url)
        fail(
          "npm registry changed; refusing to change the installed package source",
        );
      target = await installPackage(
        ops,
        "npm:" + previous.name + "@" + selection.request,
        { context, skipUnchanged: true },
      );
    } else {
      const source = Object.values(state.sources).find(
        (entry) => entry.identity === previous.source.identity,
      );
      if (!source)
        fail("Original source is not configured; restore it before updating");
      target = await installPackage(
        ops,
        source.alias + "/" + previous.name + "@" + selection.request,
        {
          sourceIndexes: indexes,
          resolution,
          updateFrom: previous,
          approveAdmin: options.approveAdmin,
          skipUnchanged: true,
          withService: options.withService,
          deferService: existingServices,
        },
      );
    }
    await bindOperation(ops.store, {
      kind: "update",
      packageId: previous.key,
      previous: previous.id,
      target: target.id,
      spec,
      request: selection.request,
    });
    if (target.id === previous.id) return target;
    const currentState = await ops.store.read();
    const admin = currentState.receipts?.[target.id]?.admin;
    if (
      target.admin?.required &&
      (admin?.install?.status !== "completed" || admin.remove !== undefined)
    ) {
      const exact =
        target.source.alias + "/" + target.name + "@" + target.version;
      if (!options.approveAdmin)
        fail(
          "Required system integration must migrate first; Administrator terminal: piko system " +
            exact +
            " --upgrade --approve-admin (or rerun update with --approve-admin)",
        );
      if (!(await (ops.effectsBackend ?? new WindowsEffects()).elevated()))
        fail(
          "Open an Administrator terminal and rerun update --approve-admin. Piko never requests UAC.",
        );
      const plan = await inspectSystemUpgrade(ops, exact);
      await checkpoint(ops.store, target.id + "/admin-upgrade", () =>
        applySystemUpgrade(ops, exact, plan.binding),
      );
      return (await ops.store.read()).installs[target.id]!;
    }
    await checkpoint(ops.store, target.id + "/selection", () =>
      ops.store.mutate(async (current) => {
        const selected = current.defaults[match.key];
        if (
          !selected ||
          selected.id !== selection.id ||
          selected.request !== selection.request
        )
          fail(
            "Default selection changed while updating; retry the bound update",
          );
        if (existingServices) {
          await preflightUnregisterServices(ops.store, current, previous);
          await checkpoint(
            ops.store,
            target.id + "/service-migrate",
            async () => {
              try {
                await unregisterServices(ops.store, current, previous);
                if (target.services?.length)
                  await registerServices(ops.store, current, target);
              } catch (error) {
                try {
                  if (target.services?.length)
                    await unregisterServices(ops.store, current, target);
                  await registerServices(ops.store, current, previous);
                } catch (compensation) {
                  await recordOperationState(ops.store, current);
                  fail(
                    String(error) +
                      "; restoring old service failed: " +
                      String(compensation),
                  );
                }
                await recordOperationState(ops.store, current);
                throw error;
              }
            },
          );
        }
        await select(ops, current, match.key, target.id, selection.request);
      }),
    );
    return target;
  });
}

export async function updateAll(
  ops: PackagesContext,
  dryRun = false,
  options: UpdateOptions = {},
): Promise<UpdateResult[]> {
  if (dryRun)
    return (await outdated(ops)).map((row) => ({
      ...row,
      version: row.current,
    }));
  const state = await ops.store.read();
  const indexes: SourceIndexes = new Map();
  const resolution = resolutionSession();
  const entries = Object.entries(state.defaults).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  try {
    await refreshUpdateSources(ops, indexes);
  } catch (error) {
    return entries.map(([, selection]) => {
      const install = state.installs[selection.id]!;
      return {
        package:
          install.kind === "npm"
            ? "npm:" + install.name
            : install.source.alias + "/" + install.name,
        request: selection.request,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    });
  }
  const results: UpdateResult[] = [];
  for (const [, selection] of entries) {
    const before = state.installs[selection.id]!;
    const spec =
      before.kind === "npm"
        ? "npm:" + before.name
        : before.source.alias + "/" + before.name;
    report({
      kind: "item",
      package: spec,
      index: results.length + 1,
      total: entries.length,
    });
    try {
      const updated = await updatePackage(
        ops,
        spec,
        indexes,
        options,
        resolution,
      );
      results.push({
        package: spec,
        request: selection.request,
        status: updated.id === before.id ? "unchanged" : "updated",
        version: updated.version,
      });
    } catch (error) {
      results.push({
        package: spec,
        request: selection.request,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
