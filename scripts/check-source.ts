import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeManifest } from "../src/catalog.ts";
import { component, noLinks, record, relativeFile } from "../src/util.ts";
export async function checkSource(folder: string) {
  const root = resolve(folder);
  await noLinks(root);
  const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  if (index.schemaVersion !== 1 || !record(index.packages))
    throw new Error("Invalid source index");
  const checked = [];
  for (const [name, entry] of Object.entries(index.packages)) {
    component(name);
    if (
      !record(entry) ||
      !record(entry.versions) ||
      typeof entry.latest !== "string" ||
      !Object.hasOwn(entry.versions, entry.latest)
    )
      throw new Error("Invalid catalog entry");
    for (const [version, path] of Object.entries(entry.versions)) {
      relativeFile(path);
      const file = join(root, path as string);
      await noLinks(file);
      const manifest = normalizeManifest(
        JSON.parse(await readFile(file, "utf8")),
        name,
        version,
      );
      if (!manifest.platforms["windows-x64"]?.sha256)
        throw new Error("Catalog releases require checksums");
      checked.push({ name, version, path });
    }
  }
  return { root, checked };
}
if (import.meta.main)
  console.log(
    JSON.stringify(
      await checkSource(process.argv[2] ?? "examples/source"),
      null,
      2,
    ),
  );
