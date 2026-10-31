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
  exists,
  fail,
  noLinks,
  noLinksTree,
  removeTree,
  sha256,
} from "./util.ts";
import { downloadArtifact } from "./downloader.ts";
import { report } from "./progress.ts";
import type { State } from "./types.ts";
export async function artifactBytes(
  root: string,
  url: string,
  checksum?: string,
  bypass = false,
  state?: State,
  limit = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 2 * 1024 * 1024 * 1024
  )
    fail("Invalid artifact size limit");
  if (!checksum || bypass) {
    report({
      kind: "stage",
      label: "Download",
      detail: "Checksum bypass explicitly authorized",
    });
    return await downloadArtifact(root, url, state, limit);
  }
  if (!/^[a-f0-9]{64}$/i.test(checksum)) fail("Invalid cache checksum");
  const hash = checksum.toLowerCase(),
    dir = join(root, "cache", "artifacts"),
    file = join(dir, hash);
  await noLinks(file);
  if (await exists(file)) {
    const info = await lstat(file);
    if (!info.isFile()) fail("Invalid cached artifact");
    if (info.size > limit) fail("Cached artifact exceeds size limit");
    report({
      kind: "stage",
      label: "Verify cached artifact",
      detail: "SHA-256",
    });
    const bytes = await readFile(file);
    if (sha256(bytes) !== hash)
      fail("Cached artifact checksum mismatch; inspect cache before retrying");
    return bytes;
  }
  report({
    kind: "stage",
    label: "Download",
    detail: "Connecting to publisher",
  });
  const bytes = await downloadArtifact(root, url, state, limit);
  report({ kind: "stage", label: "Verify download", detail: "SHA-256" });
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
