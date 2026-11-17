import { chooseVersion, parseSpec } from "../catalog.ts";
import { fail } from "../util.ts";
import type { Install, State } from "../types.ts";
import { nativeRequest } from "../windows-effects.ts";

export function installed(
  state: State,
  spec: string,
): { key: string; installs: Install[]; request?: string } {
  const p = parseSpec(spec),
    matches = Object.values(state.installs).filter(
      (i) => i.name === p.name && (!p.source || i.source.alias === p.source),
    );
  const keys = [...new Set(matches.map((i) => i.key))];
  if (!keys.length) fail("Package is not installed");
  if (keys.length > 1) fail("Ambiguous package; specify <source>/<package>");
  return { key: keys[0]!, installs: matches, request: p.request };
}

export function clearCommands(state: State, key: string): void {
  for (const [command, owner] of Object.entries(state.commands))
    if (owner === key) delete state.commands[command];
  for (const [name, alias] of Object.entries(state.aliases ?? {}))
    if (alias.key === key) delete state.aliases![name];
}

export function selectedInstall(state: State, spec: string): Install {
  const match = installed(state, spec),
    selection = state.defaults[match.key];
  if (!selection)
    fail(
      "Select a default version first; use --no-commands when resolving a conflict",
    );
  const install = state.installs[selection.id]!;
  if (
    match.request &&
    match.request !== selection.request &&
    chooseVersion([install.version], match.request) !== install.version
  )
    fail("Command operations require the selected default version");
  return install;
}

export function exactNpm(state: State, spec: string): Install {
  const match = installed(state, spec);
  const install = match.installs.find((i) => i.version === match.request);
  if (!install || install.kind !== "npm")
    fail("An exact installed npm package version is required");
  return install;
}

export async function elevationHint(
  error: unknown,
): Promise<string | undefined> {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const denied =
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EBUSY" ||
    /access is denied|requires elevation/i.test(message);
  if (!denied) return undefined;
  try {
    if (await nativeRequest({ op: "elevated" }))
      return "access denied even when elevated; a running service or system ACL may be holding the files";
    return "access denied; retry from an Administrator terminal (right-click your terminal → Run as administrator) — Piko never opens a UAC prompt by itself";
  } catch {
    return "access denied; retry from an Administrator terminal";
  }
}
