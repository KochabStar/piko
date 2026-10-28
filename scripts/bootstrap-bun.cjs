// Optional bootstrap for developers who have Node/npm but not Bun.
// The platform binary has already been downloaded and integrity-checked by npm.
const { copyFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(
    "This development bootstrap currently supports Windows x64 only",
  );
}
const binary = require.resolve("@oven/bun-windows-x64/bin/bun.exe");
mkdirSync(".tools", { recursive: true });
copyFileSync(binary, join(".tools", "bun.exe"));
copyFileSync(binary, join("node_modules", "bun", "bin", "bun.exe"));
console.log("Bun copied to .tools/bun.exe; no user PATH changes were made.");
