import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const destination = fileURLToPath(
  new URL("../../piko-source/scripts/lib/", import.meta.url),
);
const result = await Bun.build({
  entrypoints: [source + "upstream.ts", source + "manifest-template.ts"],
  outdir: destination,
  target: "node",
  format: "esm",
  naming: "[name].mjs",
});
if (!result.success)
  throw new AggregateError(result.logs, "Source runtime build failed");
for (const output of result.outputs) console.log(output.path);
