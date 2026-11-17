import semver from "semver";
import { chooseVersion, parseSpec } from "./catalog.ts";
import {
  resolvePackageManifest,
  resolutionSession,
} from "./package-resolution.ts";
import { ensureSourceIndex } from "./source-fetch.ts";
import { dependencyStatus } from "./dependencies.ts";
import { installId, packageKey } from "./store.ts";
import { fail, sha256 } from "./util.ts";
import { bindOperation, runOperation } from "./journal.ts";
import { installPackage } from "./ops/install.ts";
import type { Packages } from "./packages.ts";
import type { Index, Manifest, Source } from "./types.ts";

// Explicit, bounded graph planning. Existing defaults are fixed constraints;
// this command never silently changes an existing provider or claims commands.
export type DependencyInstallOptions = {
  offline?: boolean;
  withService?: boolean;
};
export async function planDependencies(
  packages: Packages,
  spec: string,
  options: DependencyInstallOptions = {},
) {
  const state = await packages.store.read(),
    root = parseSpec(spec);
  if (root.source === "npm")
    fail("Use ordinary npm install after explicitly selecting managed Node");
  const indexes = new Map<string, Index>();
  const resolution = resolutionSession();
  const indexFor = async (source: Source) => {
    if (!indexes.has(source.identity))
      indexes.set(
        source.identity,
        await ensureSourceIndex(packages.root, source, {
          offline: options.offline,
        }),
      );
    return indexes.get(source.identity)!;
  };
  const sources = Object.values(state.sources).filter(
    (s) => !root.source || s.alias === root.source,
  );
  const candidates: Source[] = [];
  for (const source of sources)
    if ((await indexFor(source)).packages[root.name]) candidates.push(source);
  if (candidates.length !== 1)
    fail("Unknown or ambiguous dependency root; specify source/package");
  type Node = {
    source: Source;
    name: string;
    requests: Set<string>;
    commands: Set<string>;
    version: string;
    hash: string;
    manifest: Manifest;
    dependencies: string[];
    select: boolean;
  };
  const nodes = new Map<string, Node>();
  const choices = new Map<string, string>();
  const replan = Symbol("replan dependency choices");
  const visiting = new Set<string>();
  const claims = new Map<string, string>();
  const order: string[] = [];
  const visit = async (
    source: Source,
    name: string,
    request: string,
    commands: string[],
    isRoot = false,
  ): Promise<string> => {
    const key = packageKey(source, name),
      entry = (await indexFor(source)).packages[name];
    if (!entry) fail("Dependency not listed: " + source.alias + "/" + name);
    if (visiting.has(key))
      fail("Dependency cycle: " + [...visiting, key].join(" -> "));
    const prior = nodes.get(key);
    const requests = new Set([...(prior?.requests ?? []), request]);
    const accepts = (version: string) =>
      [...requests].every((r) => {
        try {
          return (
            r === "latest" ||
            chooseVersion([version], r, undefined, entry.aliases) === version
          );
        } catch {
          return false;
        }
      });
    const selected = !isRoot && state.defaults[key];
    const selectedVersion = selected && state.installs[selected.id]!.version;
    const resolved = selectedVersion
      ? undefined
      : await resolvePackageManifest(
          packages.root,
          state,
          source,
          name,
          entry,
          request,
          { offline: options.offline, session: resolution },
        );
    const available = [
      ...new Set([
        ...Object.keys(entry.versions),
        ...(resolved ? [resolved.version] : []),
      ]),
    ].filter(accepts);
    const preferred = choices.get(key);
    const version =
      selectedVersion ||
      (preferred && accepts(preferred)
        ? preferred
        : resolved && accepts(resolved.version)
          ? resolved.version
          : available
              .filter((v) => semver.valid(v) && !semver.prerelease(v))
              .sort(semver.rcompare)[0] ||
            (available.length === 1 ? available[0] : undefined));
    if (!version || !accepts(version))
      fail(
        "Dependency constraints conflict for " +
          source.alias +
          "/" +
          name +
          ": " +
          [...requests].join(", ") +
          ". Existing defaults must be changed explicitly.",
      );
    if (prior && prior.version !== version) {
      choices.set(key, version);
      throw replan; // Rebuild edges so discarded versions leave no stale requirements.
    }
    const manifest =
      resolved?.version === version
        ? resolved
        : await resolvePackageManifest(
            packages.root,
            state,
            source,
            name,
            entry,
            version,
            { offline: options.offline, session: resolution },
          );
    const distribution = manifest.platforms["windows-x64"]!;
    if (!isRoot && !selected) {
      if (
        Object.values(distribution.bin).some(
          (bin) => typeof bin !== "string" && bin.data,
        )
      )
        fail(
          "Dependency needs explicit bootstrap before selection: " +
            source.alias +
            "/" +
            name,
        );
      for (const command of Object.keys(distribution.bin)) {
        const owner = claims.get(command) ?? state.commands[command];
        if (state.aliases?.[command] || (owner && owner !== key))
          fail("Dependency command conflict: " + command);
        claims.set(command, key);
      }
    }
    const requiredCommands = new Set([...(prior?.commands ?? []), ...commands]);
    for (const command of requiredCommands) {
      const owner = state.commands[command] ?? state.aliases?.[command]?.key;
      if (owner && owner !== key)
        fail("Dependency command conflict: " + command);
      if (!distribution.bin[command] && !state.aliases?.[command])
        fail("Dependency does not provide " + command);
    }
    if (selected) {
      const checks = await dependencyStatus(
        packages.root,
        state,
        source,
        [
          {
            package: source.alias + "/" + name + "@" + version,
            commands: [...requiredCommands],
          },
        ],
        !options.offline,
      );
      if (checks.some((c) => !c.satisfied))
        fail(
          "Existing dependency default needs explicit reconciliation: " +
            checks.flatMap((c) => c.issues).join("; "),
        );
    }
    if (nodes.size >= 1000 || visiting.size >= 100)
      fail("Dependency graph size/depth limit exceeded");
    const node: Node = {
      source,
      name,
      requests,
      commands: requiredCommands,
      version,
      hash: sha256(JSON.stringify(manifest)),
      manifest,
      dependencies: [],
      select: !isRoot && !selected,
    };
    nodes.set(key, node);
    visiting.add(key);
    for (const dependency of distribution.depends ?? []) {
      const parsed = parseSpec(dependency.package);
      const provider = parsed.source ? state.sources[parsed.source] : source;
      if (!provider) fail("Dependency source missing: " + parsed.source);
      node.dependencies.push(
        await visit(
          provider,
          parsed.name,
          parsed.request ?? "latest",
          dependency.commands ?? [],
        ),
      );
    }
    visiting.delete(key);
    if (!order.includes(key)) order.push(key);
    return key;
  };
  const attempted = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const signature = JSON.stringify([...choices].sort());
    if (attempt >= 100 || attempted.has(signature))
      fail(
        "Dependency choices cannot converge; pin compatible versions explicitly",
      );
    attempted.add(signature);
    nodes.clear();
    claims.clear();
    visiting.clear();
    order.length = 0;
    try {
      await visit(
        candidates[0]!,
        root.name,
        root.request ?? "latest",
        [],
        true,
      );
      break;
    } catch (error) {
      if (error !== replan) throw error;
    }
  }
  const steps = order.map((key) => {
    const n = nodes.get(key)!;
    return {
      package: n.source.alias + "/" + n.name,
      version: n.version,
      manifestHash: n.hash,
      source: {
        alias: n.source.alias,
        url: n.source.url,
        type: n.source.type,
        identity: n.source.identity,
      },
      name: n.name,
      manifest: n.manifest,
      installed: !!state.installs[installId(key, n.version)],
      select: n.select,
      request: [...n.requests][0]!,
      commands: [...n.commands].sort(),
    };
  });
  return {
    revision: state.revision,
    steps,
    binding: sha256(
      JSON.stringify([
        state.revision,
        spec,
        steps,
        !!options.offline,
        !!options.withService,
      ]),
    ),
    warning:
      "Only explicit --with-deps --yes with an unchanged --binding installs/selects dependencies. Root installation does not select a default. Completed steps remain after failure; preview again to retry.",
  };
}

export async function installWithDependencies(
  packages: Packages,
  spec: string,
  binding: string,
  options: DependencyInstallOptions = {},
) {
  return await runOperation(
    packages.store,
    "install",
    spec,
    { ...options, dependencies: true },
    async () => {
      const plan = await planDependencies(packages, spec, options);
      if (!binding || binding !== plan.binding)
        fail(
          "Dependency plan changed; preview --with-deps --dry-run and pass its --binding",
        );
      await bindOperation(packages.store, {
        kind: "dependencies",
        spec,
        steps: plan.steps,
        options,
      });
      let revision = plan.revision;
      for (const step of plan.steps) {
        await installPackage(packages, step.package + "@" + step.version, {
          ...options,
          expectedRevision: revision,
          expectedManifestHash: step.manifestHash,
          bound: {
            source: step.source,
            name: step.name,
            version: step.version,
            manifest: step.manifest,
          },
        });
        revision = (await packages.store.read()).revision;
        if (step.select) {
          await packages.use(step.package + "@" + step.version, {
            expectedRevision: revision,
          });
          revision = (await packages.store.read()).revision;
        }
      }
      return {
        status: "completed",
        steps: plan.steps,
        defaultUnchangedForRoot: true,
      };
    },
  );
}
