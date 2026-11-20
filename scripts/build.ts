import { buildSandboxRegistry } from "./sandbox-registry.ts";
import { mkdir } from "node:fs/promises";
// The launcher is the committed src/generated/shim.ts payload: builds must be
// deterministic across machines, or a runner-toolchain recompile silently
// drops other known launchers from the embedded compatibility set (the
// 0.4.29/0.4.30 CI builds refused every locally written shim). Regenerating
// after a shim.c change is the explicit `bun run build:shim` step.
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
