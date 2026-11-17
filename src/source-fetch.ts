import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicJson,
  component,
  download,
  exists,
  fail,
  failTransient,
  json,
  noLinks,
  publicEndpoint,
  withRetries,
} from "./util.ts";
import { normalizeIndex } from "./catalog.ts";
import type { Index, Source } from "./types.ts";

const STALE_MS = 24 * 60 * 60 * 1000;

function sourceDirectory(root: string, source: Source): string {
  return join(root, "sources", component(source.alias));
}

function latestPath(root: string, source: Source): string {
  return join(sourceDirectory(root, source), "latest.json");
}

function legacyPath(root: string, source: Source): string {
  if (!/^[a-f0-9]{64}$/.test(source.identity))
    fail("Invalid source cache identity");
  return join(root, "sources", source.identity, "index.json");
}

function indexUrl(source: Source): string {
  const url = new URL(source.url);
  return url.pathname.endsWith("/index.json")
    ? url.href
    : new URL("index.json", url).href;
}

function cacheFresh(source: Source): boolean {
  if (!source.fetchedAt) return false;
  const at = Date.parse(source.fetchedAt);
  const age = Date.now() - at;
  return Number.isFinite(age) && age >= 0 && age <= STALE_MS;
}

export async function readSourceIndex(
  root: string,
  source: Source,
): Promise<Index> {
  const current = latestPath(root, source);
  await noLinks(current);
  if (await exists(current)) return normalizeIndex(await json(current));
  // Read-only compatibility for pre-latest layouts. Do not migrate or delete
  // from this function: search and shell startup must remain lock-free.
  const legacy = legacyPath(root, source);
  await noLinks(legacy);
  if (await exists(legacy)) return normalizeIndex(await json(legacy));
  fail(
    `Source ${source.alias} has no cached index; run piko source refresh ${source.alias}`,
  );
}

export async function refresh(root: string, source: Source): Promise<Index> {
  if (source.type !== "http")
    fail(
      `Source ${source.alias} uses unsupported ${source.type} provenance; configure a trusted HTTP URL explicitly without rewriting its identity`,
    );
  const value: unknown = await withRetries(async () => {
    const url = indexUrl(source);
    const bytes = await download(url, 8 * 1024 * 1024);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      failTransient(`Source index is not valid JSON: ${publicEndpoint(url)}`);
    }
  });
  const index = normalizeIndex(value);
  // Validate completely before touching the previously successful cache.
  const latest = latestPath(root, source);
  await noLinks(latest);
  await atomicJson(latest, index);
  await migrateSourceCache(root, source);
  source.fetchedAt = new Date().toISOString();
  return index;
}

export async function ensureSourceIndex(
  root: string,
  source: Source,
  options: { offline?: boolean; refresh?: boolean } = {},
): Promise<Index> {
  if (options.offline && options.refresh)
    fail("Source index cannot be both offline and refreshed");
  if (options.refresh) return refresh(root, source);
  if (options.offline) return readSourceIndex(root, source);
  if (cacheFresh(source)) {
    const current = latestPath(root, source);
    await noLinks(current);
    if (await exists(current)) return readSourceIndex(root, source);
  }
  return refresh(root, source);
}

/** Migrate only the validated legacy index; preserve unknown files and links. */
export async function migrateSourceCache(
  root: string,
  source: Source,
): Promise<boolean> {
  if (source.type !== "http")
    fail(
      `Cannot migrate non-HTTP source ${source.alias}; configure a trusted HTTP URL explicitly`,
    );
  const legacy = legacyPath(root, source);
  await noLinks(legacy);
  if (!(await exists(legacy))) return false;
  if (!(await lstat(legacy)).isFile()) return false;
  let index: Index;
  try {
    index = normalizeIndex(await json(legacy));
  } catch (error: any) {
    // Invalid or unrelated content is not confirmed to be an old cache.
    if (error?.code) throw error;
    return false;
  }
  const latest = latestPath(root, source);
  await noLinks(latest);
  if (await exists(latest)) normalizeIndex(await json(latest));
  else await atomicJson(latest, index);
  await unlink(legacy);
  const dir = join(root, "sources", source.identity);
  try {
    if (!(await readdir(dir)).length) await rmdir(dir);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
}

export async function removeSourceCache(
  root: string,
  source: Source,
): Promise<void> {
  for (const path of [latestPath(root, source), legacyPath(root, source)]) {
    await noLinks(path);
    if (await exists(path)) await unlink(path);
  }
  for (const dir of [
    sourceDirectory(root, source),
    join(root, "sources", source.identity),
  ]) {
    try {
      if (!(await readdir(dir)).length) await rmdir(dir);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export function sourceCacheIsStale(source: Source): boolean {
  return !cacheFresh(source);
}
