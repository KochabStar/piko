import { commandName, fail } from "../util.ts";
import { upgradeState } from "../store.ts";
import { selectedInstall } from "./shared.ts";
import type { PackagesContext } from "./context.ts";

export async function claimCommand(
  ops: PackagesContext,
  name: string,
  spec: string,
): Promise<void> {
  name = commandName(name);
  await ops.store.mutate(async (state) => {
    upgradeState(state);
    if (state.aliases![name])
      fail("This name is an alias; remove it explicitly before claiming it");
    const install = selectedInstall(state, spec);
    if (!install.bins[name]) fail(`Package does not provide ${name}`);
    const previous = state.commands[name];
    if (previous && previous !== install.key) {
      const selection = state.defaults[previous]!;
      selection.commands = (
        selection.commands ??
        Object.entries(state.commands)
          .filter(([, key]) => key === previous)
          .map(([n]) => n)
      ).filter((n) => n !== name);
    }
    const selection = state.defaults[install.key]!;
    selection.commands = [
      ...new Set([...(selection.commands ?? Object.keys(install.bins)), name]),
    ];
    state.commands[name] = install.key;
  });
}

export async function aliasCommand(
  ops: PackagesContext,
  name: string,
  spec: string,
  provided: string,
  expectedRevision?: number,
): Promise<void> {
  name = commandName(name);
  provided = commandName(provided);
  await ops.store.mutate(async (state) => {
    if (expectedRevision !== undefined && state.revision !== expectedRevision)
      fail("State changed during inventory restore; preview again");
    upgradeState(state);
    if (state.commands[name] || state.aliases![name])
      fail("Command or alias name already exists; remove it explicitly first");
    const install = selectedInstall(state, spec);
    if (!install.bins[provided])
      fail(
        `Package does not provide ${provided}; aliases cannot target aliases`,
      );
    state.aliases![name] = { key: install.key, command: provided };
  });
}

export async function removeAlias(
  ops: PackagesContext,
  name: string,
): Promise<void> {
  name = commandName(name);
  await ops.store.mutate(async (state) => {
    upgradeState(state);
    if (!state.aliases![name]) fail("Not a command alias");
    delete state.aliases![name];
  });
}

export async function releaseCommand(
  ops: PackagesContext,
  name: string,
): Promise<void> {
  name = commandName(name);
  await ops.store.mutate(async (state) => {
    upgradeState(state);
    const key = state.commands[name];
    if (!key) fail("Not an owned command; use unalias for an alias");
    const selection = state.defaults[key]!;
    selection.commands = (
      selection.commands ?? Object.keys(state.installs[selection.id]!.bins)
    ).filter((n) => n !== name);
    delete state.commands[name];
  });
}
