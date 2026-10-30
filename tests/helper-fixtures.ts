import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fullSevenZipRelease, lessMsiRelease } from "../src/installer-tools.ts";
import { innoRelease, sevenZipRelease } from "../src/helpers.ts";
import { extractZip } from "../src/artifacts.ts";
import { download, exists, sha256 } from "../src/util.ts";

export const aria2Release = {
  url: "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip",
  sha256: "67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288",
};
// Official binaries are cached locally, not committed. First run needs HTTPS access.
export async function fixtureAsset(asset: { url: string; sha256: string }) {
  const shared = join(import.meta.dir, "../.tools/helper-fixtures");
  await mkdir(shared, { recursive: true });
  const file = join(shared, asset.sha256);
  if (!(await exists(file))) {
    const bytes = await download(asset.url);
    if (sha256(bytes) !== asset.sha256)
      throw new Error("Official helper fixture checksum mismatch");
    await writeFile(file, bytes);
  }
  const bytes = await readFile(file);
  if (sha256(bytes) !== asset.sha256)
    throw new Error("Cached helper fixture checksum mismatch");
  return { file, bytes };
}
export async function seedSevenZip(root: string) {
  const cache = join(root, "cache/artifacts");
  await mkdir(cache, { recursive: true });
  for (const asset of [sevenZipRelease.bootstrap, sevenZipRelease.archive])
    await writeFile(
      join(cache, asset.sha256),
      (await fixtureAsset(asset)).bytes,
    );
}
export async function seedInno(root: string) {
  const cache = join(root, "cache/artifacts");
  await mkdir(cache, { recursive: true });
  await writeFile(
    join(cache, innoRelease.sha256),
    (await fixtureAsset(innoRelease)).bytes,
  );
}
export async function aria2Fixture(root: string) {
  const { file } = await fixtureAsset(aria2Release);
  await extractZip(file, root, "aria2-1.37.0-win-64bit-build1");
  return join(root, "aria2c.exe");
}

export async function seedInstallerTools(root: string) {
  await seedSevenZip(root);
  const cache = join(root, "cache/artifacts");
  for (const release of [fullSevenZipRelease, lessMsiRelease])
    await writeFile(
      join(cache, release.sha256),
      (await fixtureAsset(release)).bytes,
    );
}
