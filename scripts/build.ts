import { buildSandboxRegistry } from "./sandbox-registry.ts";
import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  minify: true,
  compile: {
    target: "bun-windows-x64",
    outfile: "dist/piko.exe",
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
  },
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");
await buildSandboxRegistry("dist/sandbox-registry");
console.log("Built dist/piko.exe and Sandbox registry fixtures");
