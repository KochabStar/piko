import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import {
  download,
  exists,
  fail,
  noLinks,
  noLinksTree,
  removeTree,
  sha256,
} from "./util.ts";
import type { State } from "./types.ts";
export async function artifactBytes(
  root: string,
  url: string,
  checksum?: string,
  bypass = false,
): Promise<Uint8Array> {
  if (!checksum || bypass) return await download(url);
  if (!/^[a-f0-9]{64}$/i.test(checksum)) fail("Invalid cache checksum");
  const hash = checksum.toLowerCase(),
    dir = join(root, "cache", "artifacts"),
    file = join(dir, hash);
  await noLinks(file);
  if (await exists(file)) {
    if (!(await lstat(file)).isFile()) fail("Invalid cached artifact");
    const bytes = await readFile(file);
    if (sha256(bytes) !== hash)
      fail("Cached artifact checksum mismatch; inspect cache before retrying");
    return bytes;
  }
  const bytes = await download(url);
  if (sha256(bytes) !== hash)
    fail("SHA-256 mismatch; installation was not committed");
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, hash + "." + crypto.randomUUID() + ".tmp");
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    if (await exists(temporary))
      await (await import("node:fs/promises")).unlink(temporary);
  }
  return bytes;
}
export async function cachePlan(root: string, state: State) {
  const used = new Set(
      Object.values(state.installs).flatMap((i) =>
        i.npmBuild ? [i.npmBuild.inputHash] : [],
      ),
    ),
    entries: { path: string; kind: string; removable: boolean }[] = [];
  for (const kind of ["artifacts", "npm-input"]) {
    const dir = join(root, "cache", kind);
    await noLinks(dir);
    if (!(await exists(dir))) continue;
    for (const name of await readdir(dir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const path = join(dir, name);
      await noLinks(path);
      entries.push({
        path,
        kind,
        removable: kind !== "npm-input" || !used.has(name),
      });
    }
  }
  return entries;
}
export async function cleanCache(
  root: string,
  state: State,
  confirmed = false,
) {
  const entries = await cachePlan(root, state);
  if (confirmed)
    for (const e of entries.filter((e) => e.removable)) {
      if ((await lstat(e.path)).isDirectory()) await noLinksTree(e.path);
      await removeTree(e.path);
    }
  return entries;
}
