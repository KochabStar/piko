import { expect, test } from "bun:test";
import { shellEnvironment } from "../src/shell-environment.ts";
import { emptyState } from "../src/store.ts";

test("environment export supports PowerShell, CMD, Bash and JSON without executing code", () => {
  const state = emptyState(),
    root = "D:\\piko tools";
  expect(shellEnvironment(root, state, "powershell", "C:\\tools")).toContain(
    "$env:PIKO_HOME = 'D:\\piko tools'",
  );
  expect(shellEnvironment(root, state, "cmd", "C:\\tools")).toContain(
    '@set "PIKO_HOME=D:\\piko tools"',
  );
  expect(shellEnvironment(root, state, "bash", "C:\\tools")).toContain(
    "export PATH='/d/piko tools/shims':\"$PATH\"",
  );
  expect(
    JSON.parse(shellEnvironment(root, state, "json", "C:\\tools")).PIKO_HOME,
  ).toBe(root);
  expect(() => shellEnvironment(root, state, "cmd", "%UNSAFE%")).toThrow(
    "cannot safely",
  );
  expect(() => shellEnvironment(root, state, "unknown")).toThrow("Choose");
});
