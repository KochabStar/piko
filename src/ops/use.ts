import {
  carryDesktopIntegration,
  planDesktopUpgrade,
  stageDesktopChange,
} from "../desktop.ts";
import { chooseVersion, parseSpec } from "../catalog.ts";
import { ensureSourceIndex, readSourceIndex } from "../source-fetch.ts";
import { upgradeState } from "../store.ts";
import { checkPersistentFileMappings } from "../persistence.ts";
import { persistentExecutable } from "../execution.ts";
import { assertNoDataProfile } from "../data-profiles.ts";
import { commandName, fail } from "../util.ts";
import { installed, clearCommands } from "./shared.ts";
import { installPackage } from "./install.ts";
import type { Install, State } from "../types.ts";
import type { PackagesContext } from "./context.ts";

export async function select(
  ops: PackagesContext,
  state: State,
  key: string,
  id: string,
  request: string,
  noCommands = false,
): Promise<void> {
  upgradeState(state);
  const install = state.installs[id];
  if (!install || install.key !== key) fail("Missing installed target");
  if (
    Object.values(install.bins).some((b) => b.data) &&
    state.bootstraps?.[id]?.status !== "completed"
  )
    fail(
      "Run and approve this version's bootstrap before selecting generated commands",
    );
  await carryDesktopIntegration(ops.root, state, install, ops.effectsBackend);
  if (
    install.admin?.required &&
    (state.receipts?.[id]?.admin?.install?.status !== "completed" ||
      state.receipts[id]?.admin?.remove !== undefined)
  )
    fail(
      state.defaults[key] && state.defaults[key]?.id !== id
        ? `Required system integration must migrate before switching; Administrator terminal: piko system ${install.source.alias}/${install.name}@${install.version} --upgrade --approve-admin`
        : `Required system integration is not ready; Administrator terminal: piko system ${install.source.alias}/${install.name}@${install.version} --approve-admin`,
    );
  if (
    Object.values(state.admin ?? {}).some(
      (r) =>
        state.installs[r.id]?.key === key &&
        state.receipts?.[r.id]?.admin?.install !== undefined &&
        state.receipts[r.id]?.admin?.remove?.status !== "completed" &&
        r.id !== id,
    )
  )
    fail("Remove system integration before switching versions");
  const prior = state.defaults[key];
  const enabled = noCommands
    ? []
    : (prior?.commands ?? Object.keys(install.bins));
  for (const alias of Object.values(state.aliases!)) {
    if (alias.key === key && !install.bins[alias.command])
      fail(
        `New version does not provide aliased command ${alias.command}; remove the alias first`,
      );
  }
  for (const command of enabled) {
    if (!install.bins[command])
      fail(
        `New version does not provide enabled command ${command}; release it first`,
      );
    const owner = state.commands[command];
    if ((owner && owner !== key) || state.aliases![command])
      fail(
        `Command conflict: ${command} is owned by another package or alias; no default was changed`,
      );
  }
  for (const [command, owner] of Object.entries(state.commands))
    if (owner === key) delete state.commands[command];
  state.defaults[key] = { id, request, commands: enabled };
  for (const command of enabled) state.commands[command] = key;
}

export async function usePackage(
  ops: PackagesContext,
  spec: string,
  options: {
    noCommands?: boolean;
    expectedRevision?: number;
    installLatest?: boolean;
    retainRequest?: boolean;
  } = {},
): Promise<void> {
  let installedLatest: Install | undefined;
  if (options.installLatest && parseSpec(spec).request === "latest") {
    if (options.expectedRevision !== undefined)
      fail(
        "Automatic latest installation cannot change an approved dependency plan",
      );
    const parsed = parseSpec(spec),
      state = await ops.store.read();
    let installSpec = spec;
    if (
      parsed.source !== "npm" &&
      Object.values(state.installs).some(
        (i) =>
          i.name === parsed.name &&
          (!parsed.source || i.source.alias === parsed.source),
      )
    ) {
      const match = installed(state, spec),
        original = match.installs[0]!;
      if (original.kind === "npm") installSpec = `npm:${parsed.name}@latest`;
      else {
        const source = Object.values(state.sources).find(
          (s) => s.identity === original.source.identity,
        );
        if (!source)
          fail(
            "Restore the original source before installing its latest version",
          );
        installSpec = `${source.alias}/${parsed.name}@latest`;
      }
    }
    installedLatest = await installPackage(ops, installSpec, {
      skipUnchanged: true,
      refreshSource: true,
    });
  }
  await ops.store.mutate(async (state) => {
    if (
      options.expectedRevision !== undefined &&
      state.revision !== options.expectedRevision
    )
      fail("State changed during dependency installation; preview again");
    const match = installed(state, spec);
    if (installedLatest && match.key !== installedLatest.key)
      fail("Package source changed while installing latest; retry selection");
    if (!match.request && match.installs.length !== 1)
      fail("Multiple versions are installed; specify a version");
    const request = match.request ?? match.installs[0]!.version;
    let aliases: Record<string, string> | undefined;
    if (
      request !== "latest" &&
      !match.installs.some((i) => i.version === request) &&
      !/^\d+(?:\.\d+)?$/.test(request)
    ) {
      const original = match.installs[0]!.source;
      const source = Object.values(state.sources).find(
        (s) => s.identity === original.identity,
      );
      if (!source)
        fail("Restore the original source before resolving a version alias");
      aliases = (await ensureSourceIndex(ops.root, source)).packages[
        match.installs[0]!.name
      ]?.aliases;
    }
    let latest: string | undefined;
    if (request === "latest" && !installedLatest) {
      const original = match.installs[0]!.source;
      const source = Object.values(state.sources).find(
        (entry) => entry.identity === original.identity,
      );
      if (source?.type === "http")
        latest = (await readSourceIndex(ops.root, source)).packages[
          match.installs[0]!.name
        ]?.latest;
    }
    const version =
      installedLatest?.version ??
      chooseVersion(
        match.installs.map((i) => i.version),
        request,
        latest,
        aliases,
      );
    const target =
      match.installs.find((i) => i.version === version) ??
      fail("Latest installation is no longer available; retry selection");
    await checkPersistentFileMappings(ops.root, target);
    for (const bin of Object.values(target.bins))
      if (bin.data)
        await persistentExecutable(ops.root, state, target, bin.path);
    await select(
      ops,
      state,
      match.key,
      target.id,
      options.retainRequest
        ? (state.defaults[match.key]?.request ?? request)
        : request,
      options.noCommands,
    );
  });
}

export async function unuse(ops: PackagesContext, spec: string): Promise<void> {
  await ops.store.mutate(async (state) => {
    const { key } = installed(state, spec);
    await assertNoDataProfile(ops.root, key);
    if (
      state.desktop?.[key] ||
      Object.values(state.admin ?? {}).some(
        (r) =>
          state.installs[r.id]?.key === key &&
          state.receipts?.[r.id]?.admin?.install !== undefined &&
          state.receipts[r.id]?.admin?.remove?.status !== "completed",
      )
    )
      fail("Revoke desktop/system integration before unuse");
    delete state.defaults[key];
    clearCommands(state, key);
  });
}

export async function upgradeDesktop(
  ops: PackagesContext,
  spec: string,
  binding: string,
): Promise<void> {
  await ops.store.mutate(
    async (state) => {
      const plan = await planDesktopUpgrade(
        ops.root,
        state,
        spec,
        ops.effectsBackend,
      );
      if (!binding || binding !== plan.binding)
        fail("Desktop upgrade changed; preview again and pass --yes --binding");
      await stageDesktopChange(
        ops.root,
        state,
        plan.install.key,
        plan.operations,
        plan.receipt,
        ops.effectsBackend,
      );
      state.desktop![plan.install.key] = plan.receipt!;
      await select(
        ops,
        state,
        plan.install.key,
        plan.install.id,
        plan.install.version,
      );
    },
    { effectsBackend: ops.effectsBackend },
  );
}

export async function restoreSelection(
  ops: PackagesContext,
  spec: string,
  version: string,
  request: string,
  commands: string[],
  expectedRevision: number,
): Promise<void> {
  await ops.store.mutate(async (state) => {
    if (state.revision !== expectedRevision)
      fail("State changed during inventory restore; preview again");
    const match = installed(state, spec),
      target = match.installs.find((i) => i.version === version);
    if (!target) fail("Inventory selected version is not installed");
    for (const bin of Object.values(target.bins))
      if (bin.data)
        await persistentExecutable(ops.root, state, target, bin.path);
    if (
      state.defaults[match.key] &&
      state.defaults[match.key]!.id !== target.id
    )
      fail(
        "Inventory would replace an existing default; resolve explicitly first",
      );
    state.defaults[match.key] = {
      id: target.id,
      request,
      commands: commands.map(commandName),
    };
    await select(ops, state, match.key, target.id, request);
  });
}
