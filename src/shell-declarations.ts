import { fail, record } from "./util.ts";
import type { ShellIntegration } from "./types.ts";

export function validateShell(
  value: unknown,
): asserts value is ShellIntegration {
  if (
    !record(value) ||
    !Object.keys(value).length ||
    Object.entries(value).some(
      ([shell, script]) =>
        !["powershell", "bash"].includes(shell) ||
        typeof script !== "string" ||
        !script.trim() ||
        script.includes("\0") ||
        Buffer.byteLength(script) > 65536,
    )
  )
    fail(
      "shell requires PowerShell and/or Bash initializers of at most 64 KiB each",
    );
}
