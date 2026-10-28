import { join } from "node:path";
import { fail, record } from "./util.ts";
import type { State, Install } from "./types.ts";

export function validateEnv(
  value: unknown,
): asserts value is Record<string, string> {
  if (!record(value)) fail("env must be a map of strings");
  const seen = new Set<string>();
  for (const [key, text] of Object.entries(value)) {
    const name = key.toUpperCase();
    if (
      !/^[A-Z_][A-Z0-9_]{0,79}$/i.test(key) ||
      seen.has(name) ||
      /^(PIKO_|NPM_CONFIG_|BUN_|LD_|DYLD_)/.test(name) ||
      [
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "WINDIR",
        "NODE_OPTIONS",
        "NODE_PATH",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "PSMODULEPATH",
      ].includes(name)
    )
      fail(`Protected or invalid environment variable: ${key}`);
    seen.add(name);
    if (
      typeof text !== "string" ||
      /[\x00-\x1f]/.test(text) ||
      text.length > 8192 ||
      /[{}]/.test(text.replace(/\{(root|persist|version)\}/g, ""))
    )
      fail("Unsupported env value or placeholder");
  }
}
export function selectedEnvironment(
  root: string,
  state: State,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const selection of Object.values(state.defaults)) {
    const i: Install = state.installs[selection.id]!;
    if (!i.env) continue;
    validateEnv(i.env);
    for (const [key, text] of Object.entries(i.env)) {
      const value = text.replace(
          /\{(root|persist|version)\}/g,
          (_, token: string) =>
            token === "root"
              ? join(root, i.dir)
              : token === "persist"
                ? join(root, "persist", i.key)
                : i.version,
        ),
        name = key.toUpperCase();
      if (Object.hasOwn(env, name) && env[name] !== value)
        fail(`Selected environment conflict: ${name}`);
      env[name] = value;
    }
  }
  return env;
}
