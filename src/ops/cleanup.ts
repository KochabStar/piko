import semver from "semver";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { persistentFolder } from "../layout.ts";
import { upgradeState } from "../store.ts";
import { parseSpec } from "../catalog.ts";
import { installationUsers } from "../installation-users.ts";
import {
  checkPersistentFileMappings,
  checkPersistentLinkMappings,
  noLinksData,
} from "../persistence.ts";
import {
  atomicJson,
  exists,
  fail,
  inside,
  json,
  noLinks,
  sha256,
} from "../util.ts";
import { elevationHint, installed } from "./shared.ts";
import { uninstallPackage } from "./uninstall.ts";
import type { Install, State } from "../types.ts";
import type { PackagesContext } from "./context.ts";
import { assertNoDataProfile } from "../data-profiles.ts";

export type CleanupDataOptions = {
  dryRun?: boolean;
  confirmed?: boolean;
  expectedPaths?: string[];
};
export type CleanupDataResult = { paths: string[]; deleted: boolean };
export type VersionCleanupEntry = {
  installation: Install;
  package: string;
  version: string;
  path: string;
  reason?: string;
  action: string;
};
export type VersionCleanupPlan = {
  keep: number;
  entries: VersionCleanupEntry[];
  binding: string;
};
export type CleanupVersionsOptions = { confirmed?: boolean; binding?: string };
export type CleanupVersionResult = {
  package: string;
  version: string;
  status: string;
  error?: string;
};

export async function cleanupData(
  ops: PackagesContext,
  spec: string,
  options: CleanupDataOptions = {},
): Promise<CleanupDataResult> {
  const plan = (state: State) => {
    upgradeState(state);
    const parsed = parseSpec(spec);
    if (parsed.request) fail("Data cleanup targets a package, not a version");
    const matches = Object.entries(state.data!).filter(
      ([, data]) =>
        data.name === parsed.name &&
        (!parsed.source || data.source.alias === parsed.source),
    );
    if (matches.length > 1)
      fail("Ambiguous persistent package; specify <source>/<package>");
    if (!matches.length) {
      if (
        Object.values(state.installs).some(
          (i) =>
            i.name === parsed.name &&
            (!parsed.source || i.source.alias === parsed.source),
        )
      )
        fail("Package still has installed versions");
      fail(
        "No recorded persistent data for this package; legacy untracked directories must be inspected manually",
      );
    }
    const [key, data] = matches[0]!;
    if (Object.values(state.installs).some((i) => i.key === key))
      fail("Package still has installed versions referencing its data");
    return {
      key,
      data,
      paths: data.paths.map((path) =>
        inside(
          join(ops.root, "persist", persistentFolder(data, key)),
          join(ops.root, "persist", persistentFolder(data, key), path),
        ),
      ),
    };
  };
  if (options.dryRun) {
    const { paths, key } = plan(await ops.store.read());
    await assertNoDataProfile(ops.root, key);
    for (const path of paths) await noLinksData(path);
    return { paths, deleted: false };
  }
  return await ops.store.mutate(async (state) => {
    const { key, data, paths } = plan(state);
    await assertNoDataProfile(ops.root, key);
    if (!options.confirmed)
      fail(
        "Explicit data deletion confirmation required; use --dry-run then --yes",
      );
    if (
      options.expectedPaths &&
      JSON.stringify(options.expectedPaths) !== JSON.stringify(paths)
    )
      fail("Cleanup targets changed after confirmation; preview again");
    for (const path of paths) await noLinksData(path);
    const operation = "data-cleanup-" + crypto.randomUUID(),
      stage = join(ops.root, "staging", operation);
    await noLinks(stage);
    await mkdir(stage, { recursive: true });
    await atomicJson(join(stage, ".piko-cleanup.json"), { key, data });
    await atomicJson(ops.store.dataRemovalPath, { key, data, operation });
    for (let n = 0; n < paths.length; n++)
      if (await exists(paths[n]!))
        await rename(paths[n]!, join(stage, String(n)));
    delete state.data![key];
    return { paths, deleted: true };
  });
}

export async function versionCleanupPlan(
  ops: PackagesContext,
  spec?: string,
  keep = 1,
): Promise<VersionCleanupPlan> {
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > 10000)
    fail("--keep must be an integer from 0 to 10000");
  const state = await ops.store.read();
  if (spec && parseSpec(spec).request)
    fail("Version cleanup targets a package, not a version");
  const installs = spec
    ? installed(state, spec).installs
    : Object.values(state.installs);
  const entries: VersionCleanupEntry[] = [];
  for (const key of [...new Set(installs.map((i) => i.key))].sort()) {
    const group = installs
      .filter((i) => i.key === key)
      .sort((a, b) =>
        semver.valid(a.version) && semver.valid(b.version)
          ? semver.rcompare(a.version, b.version)
          : b.version.localeCompare(a.version, undefined, { numeric: true }),
      );
    let retained = 0;
    for (const i of group) {
      let action =
          state.defaults[key]?.id === i.id
            ? "protect-default"
            : retained++ < keep
              ? "keep"
              : "remove",
        reason: string | undefined;
      const path = join(ops.root, i.dir);
      if (action === "remove") {
        // One drifted or unverifiable installation must not block cleanup
        // of every other package: defer it with the reason instead of
        // failing the whole plan. Removal never proceeds past these checks.
        try {
          await noLinks(path);
          await noLinks(join(path, ".piko-install.json"));
          if (
            JSON.stringify(await json(join(path, ".piko-install.json"))) !==
            JSON.stringify(i)
          )
            fail("Installation receipt drift; inspect before version cleanup");
          await checkPersistentFileMappings(ops.root, i);
          // Directory drift is reconciled by uninstall during execution;
          // planning only reports shapes that still refuse.
          await checkPersistentLinkMappings(ops.root, i, {
            reconcile: false,
          });
          const users = await installationUsers(
            ops.root,
            i,
            ops.effectsBackend,
          );
          if (users.length) {
            action = "defer-in-use";
            reason =
              users.map((p) => `${p.name} (${p.pid})`).join(", ") +
              (i.admin
                ? "; system-integrated files are loaded — revoke with piko system <package> --remove --approve-admin in an Administrator terminal, or retry after sign-out/restart"
                : "");
          }
        } catch (error) {
          action = "defer-drift";
          reason = error instanceof Error ? error.message : String(error);
          const hint = await elevationHint(error);
          if (hint) reason += ` (${hint})`;
        }
      }
      entries.push({
        installation: i,
        package:
          i.kind === "npm" ? `npm:${i.name}` : `${i.source.alias}/${i.name}`,
        version: i.version,
        path,
        action,
        ...(reason === undefined ? {} : { reason }),
      });
    }
  }
  return { keep, entries, binding: sha256(JSON.stringify(entries)) };
}

export async function cleanupVersions(
  ops: PackagesContext,
  spec?: string,
  keep = 1,
  options: CleanupVersionsOptions = {},
): Promise<CleanupVersionResult[]> {
  const plan = await versionCleanupPlan(ops, spec, keep);
  if (!options.confirmed)
    fail("Version cleanup requires explicit confirmation after --dry-run");
  if (options.binding && options.binding !== plan.binding)
    fail("Version cleanup plan changed; preview again");
  const results: CleanupVersionResult[] = [];
  for (const item of plan.entries.filter((e) => e.action === "defer-in-use"))
    results.push({
      package: item.package,
      version: item.version,
      status: "deferred-in-use",
    });
  for (const item of plan.entries.filter((e) => e.action === "defer-drift"))
    results.push({
      package: item.package,
      version: item.version,
      status: "deferred-drift",
      error: item.reason,
    });
  for (const item of plan.entries.filter((e) => e.action === "remove")) {
    try {
      await uninstallPackage(
        ops,
        `${item.package}@${item.version}`,
        false,
        item.installation,
      );
      results.push({
        package: item.package,
        version: item.version,
        status: "removed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error),
        hint = await elevationHint(error);
      results.push({
        package: item.package,
        version: item.version,
        status: "failed",
        error: hint ? `${message} (${hint})` : message,
      });
    }
  }
  return results;
}
