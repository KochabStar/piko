import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  chooseVersion,
  normalizeIndex,
  parseSpec,
  refresh,
} from "./catalog.ts";
import { resolveCommand } from "./commands.ts";
import { packageKey } from "./store.ts";
import { fail, json, noLinks } from "./util.ts";
import type { Dependency, Source, State } from "./types.ts";

// Shell startup uses validated local metadata: never fetch on opening a terminal.
export async function dependencyAliases(
  root: string,
  source: Source,
  name: string,
  refreshSource = true,
): Promise<Record<string, string> | undefined> {
  if (refreshSource)
    return (await refresh(root, structuredClone(source))).packages[name]
      ?.aliases;
  const path = join(root, "sources", source.identity, "index.json");
  await noLinks(path);
  return normalizeIndex(await json(path)).packages[name]?.aliases;
}

// Preflight only: dependencies never install, select or claim commands implicitly.
export async function dependencyStatus(
  root: string,
  state: State,
  source: Source,
  dependencies: Dependency[] = [],
  refreshSource = true,
) {
  const results = [];
  for (const dependency of dependencies) {
    const parsed = parseSpec(dependency.package),
      provider = parsed.source ? state.sources[parsed.source] : source,
      request = parsed.request ?? "latest",
      spec = `${parsed.source ?? source.alias}/${parsed.name}@${request}`,
      commands = dependency.commands ?? [],
      issues: string[] = [],
      advice: string[] = [];
    const key = provider && packageKey(provider, parsed.name),
      installed = Object.values(state.installs).filter((i) => i.key === key),
      selection = key && state.defaults[key],
      selected = selection && state.installs[selection.id];
    let aliases: Record<string, string> | undefined;
    if (
      provider &&
      request !== "latest" &&
      !/^\d+(?:\.\d+)?$/.test(request) &&
      !installed.some((i) => i.version === request)
    ) {
      try {
        aliases = await dependencyAliases(
          root,
          provider,
          parsed.name,
          refreshSource,
        );
        if (!aliases || !Object.hasOwn(aliases, request))
          issues.push("Dependency version alias is not declared by its source");
      } catch {
        issues.push(
          "Dependency version alias could not be refreshed from its source",
        );
      }
    }
    if (!provider) {
      issues.push(`Dependency source ${parsed.source} is not configured`);
      advice.push(
        `Restore the trusted source ${parsed.source} before retrying`,
      );
    } else if (!selected) {
      issues.push(
        installed.length
          ? "Installed but no default selected"
          : "Not installed",
      );
      if (
        !installed.length ||
        (request !== "latest" &&
          !installed.some((i) => {
            try {
              chooseVersion([i.version], request, undefined, aliases);
              return true;
            } catch {
              return false;
            }
          }))
      )
        advice.push(`piko install ${spec}`);
      advice.push(`piko use ${spec}`);
    } else {
      // "latest" means any explicitly selected version here, not upstream latest.
      try {
        if (request !== "latest")
          chooseVersion([selected.version], request, undefined, aliases);
      } catch {
        issues.push(
          `Selected version ${selected.version} does not match ${request}`,
        );
        advice.push(`piko install ${spec}`, `piko use ${spec}`);
      }
      for (const command of commands) {
        try {
          const resolved = resolveCommand(state, command);
          if (resolved.install.id !== selected.id)
            throw new Error(`Command ${command} is owned by another package`);
          if (resolved.bin.data) {
            await (
              await import("./execution.ts")
            ).persistentExecutable(root, state, selected, resolved.bin.path);
            continue;
          }
          const file = join(root, selected.dir, resolved.bin.path);
          await noLinks(file);
          if (!(await lstat(file)).isFile())
            throw new Error(
              `Dependency command ${command} is not a regular file`,
            );
        } catch (error) {
          issues.push(
            `${command}: ${error instanceof Error ? error.message : String(error)}`,
          );
          advice.push(
            `Check command ownership with piko command list; explicitly claim or alias ${command} for ${parsed.source ?? source.alias}/${parsed.name}`,
          );
        }
      }
      try {
        const directory = join(root, selected.dir);
        await noLinks(directory);
        if (!(await lstat(directory)).isDirectory())
          throw new Error("Dependency installation is not a directory");
      } catch (error) {
        issues.push(
          `Dependency files unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        advice.push(
          "Inspect the managed installation and reinstall explicitly if needed",
        );
      }
    }
    results.push({
      package: spec,
      commands,
      installedVersions: installed.map((i) => i.version),
      selectedVersion: selected ? selected.version : null,
      satisfied: issues.length === 0,
      issues,
      advice,
    });
  }
  return results;
}

// Protect active consumers, not retained old versions. Cover command transfers,
// alias removal and forced default uninstall at the shared mutation boundary.
export async function protectDependencies(
  root: string,
  before: State,
  after: State,
) {
  if (
    JSON.stringify([before.defaults, before.commands, before.aliases]) ===
    JSON.stringify([after.defaults, after.commands, after.aliases])
  )
    return;
  for (const selection of Object.values(after.defaults)) {
    const consumer = after.installs[selection.id]!;
    if (
      consumer.kind === "npm" &&
      Object.values(consumer.bins).some((bin) => bin.kind === "node")
    ) {
      const nodeIdentity = (state: State) => {
        const key = state.commands.node;
        return key && state.defaults[key]?.id;
      };
      if (
        before.defaults[consumer.key]?.id !== consumer.id ||
        nodeIdentity(before) !== nodeIdentity(after)
      ) {
        const node = (await import("./windows.ts")).selectedNode(root, after);
        (await import("./npm-runtime.ts")).checkNpmEngines(
          consumer,
          node.version,
        );
      }
    }
    if (!consumer.depends?.length) continue;
    const previous = before.defaults[consumer.key];
    const environment = (state: State) =>
      consumer.depends!.map((dependency) => {
        const parsed = parseSpec(dependency.package);
        const source = parsed.source
          ? state.sources[parsed.source]
          : consumer.source;
        const selection =
          source && state.defaults[packageKey(source, parsed.name)];
        return [
          selection,
          selection && state.installs[selection.id],
          (dependency.commands ?? []).map((command) => {
            try {
              const resolved = resolveCommand(state, command);
              return [resolved.install.id, resolved.bin];
            } catch {
              return null;
            }
          }),
        ];
      });
    if (
      previous?.id === consumer.id &&
      JSON.stringify(environment(before)) === JSON.stringify(environment(after))
    )
      continue;
    const checks = await dependencyStatus(
      root,
      after,
      consumer.source,
      consumer.depends,
      false,
    );
    const broken = checks.filter((check) => !check.satisfied);
    if (broken.length)
      fail(
        "Dependency protection: " +
          consumer.source.alias +
          "/" +
          consumer.name +
          " requires " +
          broken.map((d) => d.package + ": " + d.issues.join("; ")).join("; ") +
          ". Unuse the consumer first or select compatible providers.",
      );
  }
}

export async function checkRuntimeDependencies(
  root: string,
  state: State,
  install: import("./types.ts").Install,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(install.id)) return;
  if (seen.size >= 1000) fail("Dependency graph exceeds 1000 packages");
  seen.add(install.id);
  const checks = await dependencyStatus(
    root,
    state,
    install.source,
    install.depends,
    false,
  );
  const broken = checks.filter((d) => !d.satisfied);
  if (broken.length)
    fail(
      "Runtime dependencies unavailable: " +
        broken.map((d) => d.package + ": " + d.issues.join("; ")).join("; "),
    );
  for (const dependency of install.depends ?? []) {
    const parsed = parseSpec(dependency.package);
    const source = parsed.source
      ? state.sources[parsed.source]
      : install.source;
    const selection = source && state.defaults[packageKey(source, parsed.name)];
    if (selection)
      await checkRuntimeDependencies(
        root,
        state,
        state.installs[selection.id]!,
        seen,
      );
  }
}
