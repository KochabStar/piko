import { join } from "node:path";
import { report } from "../progress.ts";
import { parseSpec } from "../catalog.ts";
import { ensureSourceIndex } from "../source-fetch.ts";
import {
  resolvePackageManifest,
  resolutionSession,
} from "../package-resolution.ts";
import { compareVersions } from "../upstream.ts";
import { dependencyStatus, type DependencyCheck } from "../dependencies.ts";
import { selectedEnvironment } from "../environment.ts";
import { npmContext, resolveNpm } from "../npm.ts";
import { commandName, fail, publicEndpoint } from "../util.ts";
import { installed } from "./shared.ts";
import type {
  CatalogPackage,
  Index,
  Install,
  Selection,
  Source,
} from "../types.ts";
import type { PackagesContext } from "./context.ts";

export type AvailablePackage = {
  source: Source;
  versions: string[];
  latest: string;
  version?: string;
  dependencies?: DependencyCheck[];
  aliases?: Record<string, string>;
  runtime?: CatalogPackage["runtime"];
};
export type PackageInfo = {
  package: string;
  ambiguous: boolean;
  available: AvailablePackage[];
  installed: (Install & {
    default: boolean;
    selection: Selection | undefined;
    path: string;
  })[];
};
export type OutdatedResult = {
  package: string;
  current: string;
  request: string;
  source: string;
  candidate: string | null;
  latest?: string;
  status: string;
  reason?: string;
};

export async function info(
  ops: PackagesContext,
  spec: string,
): Promise<PackageInfo> {
  report({ kind: "stage", label: "Load package information", detail: spec });
  const parsed = parseSpec(spec),
    state = await ops.store.read();
  const installed = Object.values(state.installs).filter(
    (i) =>
      i.name === parsed.name &&
      (!parsed.source || i.source.alias === parsed.source),
  );
  const available: AvailablePackage[] = [];
  const resolution = resolutionSession();
  await ops.store.mutate(async (current) => {
    if (parsed.source === "npm") {
      const context = await npmContext(ops.root, current, parsed.name);
      const versions: unknown = JSON.parse(
        await context.run(
          [
            "view",
            parsed.name,
            "versions",
            "--json",
            "--registry=" + context.registry,
          ],
          join(ops.root, "apps", "piko"),
        ),
      );
      const list = typeof versions === "string" ? [versions] : versions;
      if (!Array.isArray(list) || !list.every((v) => typeof v === "string"))
        fail("Invalid npm metadata");
      const resolved = await resolveNpm(
        context,
        parsed.name,
        "latest",
        join(ops.root, "apps", "piko"),
      );
      available.push({
        source: resolved.source,
        versions: list,
        latest: resolved.version,
      });
    } else
      for (const source of Object.values(current.sources).filter(
        (s) => !parsed.source || s.alias === parsed.source,
      )) {
        report({
          kind: "stage",
          label: "Refresh source",
          detail: source.alias,
        });
        const index = await ensureSourceIndex(ops.root, source),
          entry = index.packages[parsed.name];
        if (entry) {
          const manifest = await resolvePackageManifest(
            ops.root,
            current,
            source,
            parsed.name,
            entry,
            parsed.request ?? "latest",
            { preview: true, session: resolution },
          );
          const version = manifest.version;
          available.push({
            source,
            versions: Object.keys(entry.versions),
            latest:
              parsed.request && parsed.request !== "latest"
                ? (
                    await resolvePackageManifest(
                      ops.root,
                      current,
                      source,
                      parsed.name,
                      entry,
                      "latest",
                      { preview: true, session: resolution },
                    )
                  ).version
                : version,
            aliases: entry.aliases,
            runtime: entry.runtime,
            version,
            dependencies: await dependencyStatus(
              ops.root,
              current,
              source,
              manifest.platforms["windows-x64"]!.depends,
            ),
          });
        }
      }
  });
  if (!available.length && !installed.length) fail("Package not found");
  return {
    package: spec,
    ambiguous:
      new Set([
        ...available.map((a) => a.source.identity),
        ...installed.map((i) => i.source.identity),
      ]).size > 1,
    available,
    installed: installed.map((i) => ({
      ...i,
      default: state.defaults[i.key]?.id === i.id,
      selection: state.defaults[i.key],
      path: join(ops.root, i.dir),
    })),
  };
}

export async function outdated(
  ops: PackagesContext,
  spec?: string,
): Promise<OutdatedResult[]> {
  report({ kind: "stage", label: "Check available updates" });
  const state = await ops.store.read();
  const filter = spec ? installed(state, spec) : undefined;
  const selected = Object.entries(state.defaults).filter(
    ([key]) => !filter || key === filter.key,
  );
  const results: OutdatedResult[] = [];
  const indexes = new Map<string, { source: Source; index: Index }>();
  const resolution = resolutionSession();
  for (const [key, selection] of selected.sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const i = state.installs[selection.id]!;
    report({
      kind: "item",
      package: `${i.source.alias}/${i.name}`,
      index: results.length + 1,
      total: selected.length,
    });
    report({
      kind: "stage",
      label: "Resolve update candidate",
      detail: i.version,
    });
    const row: (typeof results)[number] = {
      package:
        i.kind === "npm" ? `npm:${i.name}` : `${i.source.alias}/${i.name}`,
      current: i.version,
      request: selection.request,
      source: publicEndpoint(i.source.url),
      candidate: null,
      status: "failed",
    };
    if (i.selfUpdate) {
      row.status = "self-update";
      row.reason = "Package updates itself; piko update delegates to it";
      results.push(row);
      continue;
    }
    row.candidate = null;
    row.status = "failed";
    try {
      if (i.kind === "npm") {
        const context = await npmContext(ops.root, state, i.name);
        if (context.registry !== i.source.url)
          fail("npm registry changed; restore the original registry");
        row.candidate = (
          await resolveNpm(
            context,
            i.name,
            selection.request,
            join(ops.root, "apps/piko"),
          )
        ).version;
        row.latest = (
          await resolveNpm(
            context,
            i.name,
            "latest",
            join(ops.root, "apps/piko"),
          )
        ).version;
      } else {
        const original = Object.values(state.sources).find(
          (s) => s.identity === i.source.identity,
        );
        if (!original)
          fail("Original source is not configured; restore it before updating");
        let cached = indexes.get(original.identity);
        if (!cached) {
          const source = structuredClone(original);
          cached = {
            source,
            index: await ensureSourceIndex(ops.root, source, { refresh: true }),
          };
          indexes.set(source.identity, cached);
        }
        const { source, index } = cached;
        const entry = index.packages[i.name];
        if (!entry) fail("Package is no longer listed by its original source");
        const manifest = await resolvePackageManifest(
          ops.root,
          state,
          source,
          i.name,
          entry,
          selection.request,
          { preview: true, session: resolution },
        );
        row.candidate = manifest.version;
        row.latest =
          selection.request === "latest"
            ? manifest.version
            : (
                await resolvePackageManifest(
                  ops.root,
                  state,
                  source,
                  i.name,
                  entry,
                  "latest",
                  { preview: true, session: resolution },
                )
              ).version;
        const platform = manifest.platforms["windows-x64"]!;
        if (
          row.candidate !== i.version &&
          (state.admin?.[i.id]?.action === "install" ||
            (state.desktop?.[key] &&
              JSON.stringify(state.desktop[key]!.declaration) !==
                JSON.stringify(platform.desktop)))
        )
          fail(
            "Revoke pinned desktop/system integration before updating this version; preview/reapply afterwards",
          );
        if (row.candidate !== i.version && platform.bootstrap)
          fail(
            "New bootstrap version needs explicit install and execution approval before selection",
          );
        const unmet = (
          await dependencyStatus(
            ops.root,
            state,
            source,
            platform.depends,
            false,
          )
        ).filter((d) => !d.satisfied);
        if (unmet.length)
          fail(
            "Unmet dependencies: " +
              unmet
                .map((d) => `${d.package}: ${d.issues.join("; ")}`)
                .join("; "),
          );
        const provided = Object.keys(platform.bin).map(commandName);
        if (new Set(provided).size !== provided.length)
          fail("Candidate has case-colliding commands");
        const enabled = selection.commands ?? Object.keys(i.bins);
        if (
          [
            ...enabled,
            ...Object.values(state.aliases ?? {})
              .filter((a) => a.key === key)
              .map((a) => a.command),
          ].some((c) => !provided.includes(c))
        )
          fail("Candidate removes an enabled or aliased command");
        const probe = structuredClone(state);
        probe.installs[i.id] = {
          ...i,
          version: row.candidate,
          env: platform.env,
        };
        selectedEnvironment(ops.root, probe);
      }
      row.status =
        row.candidate === i.version
          ? selection.request === i.version
            ? "pinned"
            : "current"
          : compareVersions(row.candidate, i.version) < 0
            ? "downgrade"
            : "outdated";
      if (row.status === "pinned")
        row.reason = "Exact version request; update keeps this version";
      if (row.status === "downgrade")
        row.reason =
          "Source/request now resolves to an older version; nothing was changed";
    } catch (error) {
      row.status = "blocked";
      row.reason = error instanceof Error ? error.message : String(error);
    }
    results.push(row);
  }
  if (filter && !selected.length)
    fail("Package has no default version to check");
  return results;
}
