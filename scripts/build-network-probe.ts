import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["scripts/network-probe.ts"],
  minify: true,
  compile: {
    target: "bun-windows-x64",
    outfile: "dist/network-probe.exe",
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
  },
});
if (!result.success)
  throw new AggregateError(result.logs, "Network probe build failed");
console.log("Built dist/network-probe.exe");
