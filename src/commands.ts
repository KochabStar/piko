import { commandName, fail } from "./util.ts";
import type { Bin, Install, State } from "./types.ts";

export function commandNames(state: State): string[] {
  return [
    ...new Set([
      ...Object.keys(state.commands),
      ...Object.keys(state.aliases ?? {}),
    ]),
  ];
}
export function resolveCommand(
  state: State,
  name: string,
): { install: Install; bin: Bin; provided: string } {
  name = commandName(name);
  const alias = state.aliases?.[name],
    key = alias?.key ?? state.commands[name];
  const selection = key && state.defaults[key],
    install = selection && state.installs[selection.id];
  if (!install)
    fail(`No default provider for ${name}; choose one with piko use`);
  const provided = alias?.command ?? name,
    bin = install.bins[provided];
  if (!bin)
    fail(
      `Selected package no longer provides ${provided}; remove its alias or select a compatible version`,
    );
  return { install, bin, provided };
}
