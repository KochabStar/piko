import { report } from "../progress.ts";
import { makeSource, parseSpec } from "../catalog.ts";
import {
  ensureSourceIndex,
  readSourceIndex,
  refresh,
} from "../source-fetch.ts";
import { component, fail, searchScore } from "../util.ts";
import type { PackagesContext } from "./context.ts";

export type RuntimeSpecOptions = { offline?: boolean };
export type SearchOptions = { refresh?: boolean };
export type SearchResult = { source: string; name: string; latest: string };

export async function runtimeSpec(
  ops: PackagesContext,
  spec: string,
  distribution?: string,
  options: RuntimeSpecOptions = {},
): Promise<string> {
  if (!distribution) return spec;
  distribution = component(distribution);
  const parsed = parseSpec(spec);
  if (parsed.source === "npm")
    fail("Runtime distribution does not apply to npm");
  const state = await ops.store.read(),
    matches: string[] = [];
  for (const original of Object.values(state.sources).filter(
    (s) => !parsed.source || s.alias === parsed.source,
  )) {
    const source = structuredClone(original),
      index = await ensureSourceIndex(ops.root, source, {
        offline: options.offline,
      });
    for (const [name, entry] of Object.entries(index.packages))
      if (
        entry.runtime?.family === parsed.name &&
        entry.runtime.distribution === distribution
      )
        matches.push(
          `${source.alias}/${name}${parsed.request ? "@" + parsed.request : ""}`,
        );
  }
  if (matches.length !== 1)
    fail(
      matches.length
        ? "Ambiguous runtime distribution; specify a source"
        : "Runtime distribution not found in configured sources",
    );
  return matches[0]!;
}

export async function addSource(
  ops: PackagesContext,
  alias: string,
  url: string,
  expectedRevision?: number,
): Promise<void> {
  const source = makeSource(alias, url);
  await ops.store.mutate(async (state) => {
    if (expectedRevision !== undefined && state.revision !== expectedRevision)
      fail("State changed during inventory restore; preview again");
    if (Object.hasOwn(state.sources, source.alias))
      fail("Source already exists; remove it explicitly before replacing it");
    report({ kind: "stage", label: "Refresh source", detail: source.alias });
    await ensureSourceIndex(ops.root, source, { refresh: true });
    state.sources[source.alias] = source;
  });
}

export async function refreshSources(
  ops: PackagesContext,
  alias?: string,
): Promise<void> {
  await ops.store.mutate(
    async (state) => {
      const sources = alias
        ? [state.sources[component(alias)] ?? fail("Unknown source")]
        : Object.values(state.sources);
      for (const s of sources) {
        report({ kind: "stage", label: "Refresh source", detail: s.alias });
        await refresh(ops.root, s);
      }
    },
    { skipUnchanged: true },
  );
}

export async function removeSource(
  ops: PackagesContext,
  alias: string,
  force = false,
): Promise<void> {
  await ops.store.mutate(async (state) => {
    const s = state.sources[component(alias)];
    if (!s) fail("Unknown source");
    if (
      !force &&
      s.type !== "git" &&
      Object.values(state.installs).some(
        (i) => i.source.identity === s.identity,
      )
    )
      fail(
        "Source is referenced by installed packages; use --force to remove only its configuration",
      );
    delete state.sources[s.alias];
  });
}

export async function search(
  ops: PackagesContext,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  if (options.refresh) await refreshSources(ops);
  const matches: {
    result: SearchResult;
    score: number;
  }[] = [];
  const state = await ops.store.read();
  for (const s of Object.values(state.sources)) {
    const index = await readSourceIndex(ops.root, s);
    for (const [name, p] of Object.entries(index.packages)) {
      const score = searchScore(`${s.alias}/${name}`, query);
      if (score !== undefined)
        matches.push({
          result: { source: s.alias, name, latest: p.latest },
          score,
        });
    }
  }
  return matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.result.source}/${a.result.name}`.localeCompare(
          `${b.result.source}/${b.result.name}`,
        ),
    )
    .map((match) => match.result);
}
