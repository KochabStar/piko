import { networkUrl, record, relativeFile, fail } from "./util.ts";

export function validateNpmLock(
  lock: unknown,
  name: string,
  version: string,
): asserts lock is { lockfileVersion: number; packages: Record<string, any> } {
  if (
    !record(lock) ||
    lock.lockfileVersion !== 3 ||
    !record(lock.packages) ||
    Object.keys(lock.packages).length > 100000
  )
    fail("Expected npm lockfileVersion 3 with a bounded package graph");
  if (
    lock.packages[""]?.dependencies?.[name] !== version ||
    Object.keys(lock.packages[""]?.dependencies ?? {}).length !== 1 ||
    lock.packages["node_modules/" + name]?.version !== version
  )
    fail("npm lock does not match the requested CLI/version");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    relativeFile(path);
    if (
      !path.startsWith("node_modules/") ||
      !record(entry) ||
      entry.link ||
      typeof entry.resolved !== "string" ||
      typeof entry.integrity !== "string" ||
      !/^sha(256|384|512)-/.test(entry.integrity)
    )
      fail("Unverifiable locked npm dependency");
    const url = networkUrl(entry.resolved);
    if (url.username || url.password || url.search || url.hash)
      fail("npm lock export/import refuses credentials, queries or fragments");
  }
}
