import {
  chooseVersion,
  loadManifest,
  makeSource,
  parseSpec,
  refresh,
  distributionDownloads,
} from "./catalog.ts";
import { dependencyStatus } from "./dependencies.ts";
import { chooseLayout, installDirectory } from "./layout.ts";
import { npmSnapshotPath } from "./scripts.ts";
import { validateNpmLock } from "./npm-lock.ts";
import { join } from "node:path";
import { json, noLinks } from "./util.ts";
import { selectedEnvironment } from "./environment.ts";
import { installId, packageKey } from "./store.ts";
import {
  commandName,
  fail,
  networkUrl,
  record,
  versionKey,
  sha256,
} from "./util.ts";
import type { Packages } from "./packages.ts";
import type { Bin, CatalogPackage, Manifest, Source, State } from "./types.ts";

export type Inventory = {
  schemaVersion: 1;
  sources: { alias: string; url: string; type: "http" | "git"; ref?: string }[];
  packages: {
    source: string;
    name: string;
    versions: string[];
    selection?: { version: string; request: string; commands: string[] };
  }[];
  aliases: { name: string; package: string; command: string }[];
  npmRegistry?: string;
  npmRegistries?: Record<string, string>;
  npmLocks?: Record<string, unknown>;
  integrations?: {
    package: string;
    shell: "powershell" | "bash" | "desktop" | "bootstrap" | "system";
  }[];
};
function safeUrl(value: string): string {
  const u = new URL(value);
  if (
    u.password ||
    (u.username && !(u.protocol === "ssh:" && u.username === "git")) ||
    u.search ||
    u.hash
  )
    fail(
      "Inventory refuses URLs containing credentials, queries or fragments; configure a credential-free endpoint first",
    );
  return value;
}
function fields(value: unknown, allowed: string[]) {
  if (!record(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    fail("Invalid or unsupported inventory fields");
}
function packageSpec(p: Inventory["packages"][number]): string {
  return p.source === "npm" ? `npm:${p.name}` : `${p.source}/${p.name}`;
}
export function validateInventory(value: unknown): Inventory {
  fields(value, [
    "schemaVersion",
    "sources",
    "packages",
    "aliases",
    "npmRegistry",
    "npmRegistries",
    "npmLocks",
    "integrations",
  ]);
  const v = value as Inventory;
  if (
    v.schemaVersion !== 1 ||
    !Array.isArray(v.sources) ||
    !Array.isArray(v.packages) ||
    !Array.isArray(v.aliases) ||
    v.sources.length > 100 ||
    v.packages.length > 1000 ||
    v.aliases.length > 1000
  )
    fail("Invalid inventory header or size");
  const sources = new Set<string>();
  for (const s of v.sources) {
    fields(s, ["alias", "url", "type", "ref"]);
    if (
      typeof s.alias !== "string" ||
      typeof s.url !== "string" ||
      !["http", "git"].includes(s.type) ||
      (s.ref !== undefined && typeof s.ref !== "string")
    )
      fail("Invalid inventory source");
    const canonical = makeSource(s.alias, safeUrl(s.url), s.type, s.ref);
    if (
      s.alias !== canonical.alias ||
      s.url !== canonical.url ||
      sources.has(s.alias)
    )
      fail("Duplicate or noncanonical inventory source");
    sources.add(s.alias);
  }
  if (v.npmRegistry !== undefined) {
    if (
      typeof v.npmRegistry !== "string" ||
      networkUrl(safeUrl(v.npmRegistry)).href !== v.npmRegistry
    )
      fail("Invalid inventory npm registry");
  }
  const specs = new Map<string, Inventory["packages"][number]>();
  let count = 0;
  for (const p of v.packages) {
    fields(p, ["source", "name", "versions", "selection"]);
    if (
      typeof p.source !== "string" ||
      typeof p.name !== "string" ||
      !Array.isArray(p.versions) ||
      !p.versions.length
    )
      fail("Invalid inventory package");
    if (
      p.source === "npm"
        ? !(v.npmRegistries?.[p.name] ?? v.npmRegistry)
        : !sources.has(p.source)
    )
      fail("Inventory package references a missing source/registry");
    const spec = packageSpec(p),
      parsed = parseSpec(spec);
    if (parsed.name !== p.name || parsed.source !== p.source || specs.has(spec))
      fail("Duplicate or noncanonical inventory package");
    specs.set(spec, p);
    const versions = new Set<string>();
    for (const version of p.versions) {
      if (typeof version !== "string" || ++count > 10000)
        fail("Invalid inventory version count");
      versionKey(version);
      if (
        parseSpec(`${spec}@${version}`).request !== version ||
        versions.has(version)
      )
        fail("Duplicate or unrepresentable inventory version");
      versions.add(version);
    }
    if (p.selection !== undefined) {
      fields(p.selection, ["version", "request", "commands"]);
      const s = p.selection;
      if (
        !versions.has(s.version) ||
        typeof s.request !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(s.request) ||
        !Array.isArray(s.commands) ||
        s.commands.length > 1000
      )
        fail("Invalid inventory selection");
      const names = new Set<string>();
      for (const name of s.commands) {
        if (
          typeof name !== "string" ||
          commandName(name) !== name ||
          names.has(name)
        )
          fail("Invalid inventory command set");
        names.add(name);
      }
    }
  }
  if (v.npmRegistries !== undefined) {
    if (!record(v.npmRegistries) || Object.keys(v.npmRegistries).length > 1000)
      fail("Invalid npm registries");
    for (const [name, url] of Object.entries(v.npmRegistries)) {
      if (
        !specs.has("npm:" + name) ||
        typeof url !== "string" ||
        networkUrl(safeUrl(url)).href !== url
      )
        fail("Invalid npm package registry");
    }
  }
  if (v.npmLocks !== undefined) {
    if (!record(v.npmLocks) || Object.keys(v.npmLocks).length > 10000)
      fail("Invalid npm locks");
    for (const [spec, lock] of Object.entries(v.npmLocks)) {
      const parsed = parseSpec(spec);
      if (
        parsed.source !== "npm" ||
        !parsed.request ||
        !specs.get("npm:" + parsed.name)?.versions.includes(parsed.request)
      )
        fail("Unreferenced npm lock");
      validateNpmLock(lock, parsed.name, parsed.request);
    }
  }
  const aliases = new Set<string>();
  for (const a of v.aliases) {
    fields(a, ["name", "package", "command"]);
    if (
      typeof a.name !== "string" ||
      commandName(a.name) !== a.name ||
      aliases.has(a.name) ||
      typeof a.command !== "string" ||
      commandName(a.command) !== a.command ||
      typeof a.package !== "string" ||
      !specs.get(a.package)?.selection
    )
      fail("Invalid inventory alias target");
    aliases.add(a.name);
  }
  if (v.integrations !== undefined) {
    if (!Array.isArray(v.integrations) || v.integrations.length > 1000)
      fail("Invalid integration intents");
    const seen = new Set<string>();
    for (const intent of v.integrations) {
      fields(intent, ["package", "shell"]);
      if (
        typeof intent.package !== "string" ||
        !specs.has(intent.package) ||
        !["powershell", "bash", "desktop", "bootstrap", "system"].includes(
          intent.shell,
        ) ||
        seen.has(intent.package + ":" + intent.shell)
      )
        fail("Invalid integration intent target");
      seen.add(intent.package + ":" + intent.shell);
    }
  }
  return structuredClone(v);
}

export function exportInventory(state: State): Inventory {
  const sources = new Map<string, Inventory["sources"][number]>();
  const addSource = (s: Source) => {
    if (s.type === "npm") return;
    const item = {
      alias: s.alias,
      url: safeUrl(s.url),
      type: s.type,
      ...(s.ref ? { ref: s.ref } : {}),
    };
    const prior = sources.get(s.alias);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item))
      fail(
        "Source alias was reused for different provenance; resolve before exporting",
      );
    sources.set(s.alias, item);
  };
  Object.values(state.sources).forEach(addSource);
  const packages = new Map<string, Inventory["packages"][number]>(),
    keys = new Map<string, string>();
  let npmRegistry: string | undefined;
  const npmRegistries: Record<string, string> = {};
  for (const i of Object.values(state.installs)) {
    if (!i.verified)
      fail(
        "Inventory cannot silently restore unverified installations; reinstall them with checksums first",
      );
    addSource(i.source);
    if (i.kind === "npm") {
      if (npmRegistries[i.name] && npmRegistries[i.name] !== i.source.url)
        fail(
          "Same npm package has multiple source identities; reconcile before export",
        );
      npmRegistries[i.name] = safeUrl(i.source.url);
      npmRegistry ??= safeUrl(i.source.url);
    }
    const spec =
      i.kind === "npm" ? `npm:${i.name}` : `${i.source.alias}/${i.name}`;
    const entry = packages.get(i.key) ?? {
      source: i.source.alias,
      name: i.name,
      versions: [],
    };
    entry.versions.push(i.version);
    if (state.defaults[i.key]?.id === i.id)
      entry.selection = {
        version: i.version,
        request: state.defaults[i.key]!.request,
        commands: Object.entries(state.commands)
          .filter(([, owner]) => owner === i.key)
          .map(([name]) => name)
          .sort(),
      };
    packages.set(i.key, entry);
    keys.set(i.key, spec);
  }
  const profileIntents = [
    ...new Map(
      Object.values(state.profiles ?? {}).flatMap((p) =>
        Object.keys(p.approvals)
          .filter((key) => keys.has(key))
          .map((key) => {
            const intent = {
              package: keys.get(key)!,
              shell: p.shell ?? ("powershell" as const),
            };
            return [intent.package + ":" + intent.shell, intent] as const;
          }),
      ),
    ).values(),
  ];
  return validateInventory({
    schemaVersion: 1,
    sources: [...sources.values()].sort((a, b) =>
      a.alias.localeCompare(b.alias),
    ),
    packages: [...packages.values()]
      .map((p) => ({ ...p, versions: p.versions.sort() }))
      .sort((a, b) => packageSpec(a).localeCompare(packageSpec(b))),
    aliases: Object.entries(state.aliases ?? {})
      .map(([name, a]) => ({
        name,
        package: keys.get(a.key)!,
        command: a.command,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...(npmRegistry ? { npmRegistry, npmRegistries } : {}),
    ...(state.profiles ? { integrations: profileIntents } : {}),
    ...(state.desktop || state.bootstraps || state.admin
      ? {
          integrations: [
            ...profileIntents,
            ...Object.keys(state.desktop ?? {})
              .filter((key) => keys.has(key))
              .map((key) => ({
                package: keys.get(key)!,
                shell: "desktop" as const,
              })),
            ...[
              ...new Set(
                Object.entries(state.bootstraps ?? {})
                  .filter(([, r]) => r.status === "completed")
                  .map(([id]) => state.installs[id]!.key),
              ),
            ]
              .filter((key) => keys.has(key))
              .map((key) => ({
                package: keys.get(key)!,
                shell: "bootstrap" as const,
              })),
            ...[
              ...new Set(
                Object.values(state.admin ?? {})
                  .filter((r) => r.action === "install")
                  .map((r) => state.installs[r.id]!.key),
              ),
            ]
              .filter((key) => keys.has(key))
              .map((key) => ({
                package: keys.get(key)!,
                shell: "system" as const,
              })),
          ],
        }
      : {}),
  });
}

type Metadata = {
  source: Source;
  entry: CatalogPackage;
  manifests: Map<string, Manifest>;
};
export async function planInventory(packages: Packages, value: unknown) {
  const inventory = validateInventory(value),
    state = await packages.store.read();
  const conflicts: string[] = [],
    steps: {
      action: string;
      package?: string;
      version?: string;
      source?: string;
      request?: string;
    }[] = [];
  const sourceMap = new Map<string, Source>(),
    metadata = new Map<string, Metadata>();
  const bySpec = new Map(inventory.packages.map((p) => [packageSpec(p), p]));
  const keyFor = (p: Inventory["packages"][number]) =>
    p.source === "npm"
      ? Object.values(state.installs).find(
          (i) =>
            i.kind === "npm" &&
            i.name === p.name &&
            i.source.url ===
              (inventory.npmRegistries?.[p.name] ?? inventory.npmRegistry),
        )?.key
      : sourceMap.has(p.source)
        ? packageKey(sourceMap.get(p.source)!, p.name)
        : undefined;
  for (const s of inventory.sources) {
    const source = makeSource(s.alias, s.url, s.type, s.ref);
    sourceMap.set(s.alias, source);
    const existing = state.sources[s.alias];
    if (existing && existing.identity !== source.identity)
      conflicts.push(`Source ${s.alias} conflicts with its existing identity`);
    if (!existing) steps.push({ action: "add-source", source: s.alias });
    try {
      const index = await refresh(packages.root, source);
      for (const p of inventory.packages.filter((p) => p.source === s.alias)) {
        const entry = index.packages[p.name];
        if (!entry) {
          conflicts.push(`${packageSpec(p)} is absent from its source`);
          continue;
        }
        const manifests = new Map<string, Manifest>();
        for (const version of p.versions) {
          if (!Object.hasOwn(entry.versions, version)) {
            conflicts.push(
              `${packageSpec(p)}@${version} is absent from its source`,
            );
            continue;
          }
          const manifest = await loadManifest(
            packages.root,
            source,
            entry.versions[version]!,
            p.name,
            version,
          );
          if (
            distributionDownloads(manifest.platforms["windows-x64"]!).some(
              (d) => !d.sha256,
            )
          )
            conflicts.push(
              `${packageSpec(p)}@${version} lacks required checksums`,
            );
          manifests.set(version, manifest);
        }
        metadata.set(packageSpec(p), { source, entry, manifests });
      }
    } catch {
      conflicts.push(
        `Source ${s.alias} cannot be read or contains invalid manifests`,
      );
    }
  }
  const scoped = JSON.parse(process.env.PIKO_NPM_SCOPED_REGISTRIES ?? "{}");
  if (!record(scoped)) fail("Invalid PIKO_NPM_SCOPED_REGISTRIES");
  for (const p of inventory.packages.filter((p) => p.source === "npm")) {
    const expected = inventory.npmRegistries?.[p.name] ?? inventory.npmRegistry;
    const configured =
      (p.name.startsWith("@") && scoped[p.name.split("/")[0]!]) ||
      process.env.PIKO_NPM_REGISTRY ||
      "https://registry.npmjs.org/";
    if (networkUrl(configured).href !== expected)
      conflicts.push(
        "Set PIKO_NPM_REGISTRY / PIKO_NPM_SCOPED_REGISTRIES to the exported registry for " +
          p.name,
      );
  }
  const owners = new Map<string, string>();
  const probe = structuredClone(state);
  for (const p of inventory.packages) {
    const spec = packageSpec(p),
      key = keyFor(p);
    if (
      key &&
      state.defaults[key] &&
      p.selection &&
      state.installs[state.defaults[key]!.id]!.version !== p.selection.version
    )
      conflicts.push(
        `${spec} would replace an existing default; unuse it explicitly first`,
      );
    for (const version of p.versions) {
      const declaration = metadata.get(spec)?.manifests.get(version)?.platforms[
        "windows-x64"
      ];
      if (
        declaration?.bootstrap &&
        p.selection?.version === version &&
        declaration.bootstrap.outputs.some((path) =>
          Object.values(declaration.bin).some(
            (bin) => typeof bin !== "string" && bin.data && bin.path === path,
          ),
        )
      )
        conflicts.push(
          `${spec} needs explicit bootstrap approval before restoring its selected generated commands; install/bootstrap/select separately`,
        );
      steps.push({ action: "install", package: spec, version });
    }
    if (!p.selection) continue;
    steps.push({
      action: "select",
      package: spec,
      version: p.selection.version,
      request: p.selection.request,
    });
    for (const command of p.selection.commands) {
      if (owners.has(command) && owners.get(command) !== spec)
        conflicts.push(`Inventory command conflict: ${command}`);
      owners.set(command, spec);
      if (
        (state.commands[command] && state.commands[command] !== key) ||
        state.aliases?.[command]
      )
        conflicts.push(`Existing command/alias conflict: ${command}`);
    }
    const m = metadata.get(spec)?.manifests.get(p.selection.version);
    if (m && key) {
      const platform = m.platforms["windows-x64"]!,
        bins: Record<string, Bin> = {};
      for (const [name, b] of Object.entries(platform.bin)) {
        const command = commandName(name);
        if (Object.hasOwn(bins, command))
          conflicts.push(`${spec} has case-colliding commands`);
        bins[command] = typeof b === "string" ? { path: b, kind: "native" } : b;
      }
      if (p.selection.commands.some((c) => !bins[c]))
        conflicts.push(`${spec} no longer provides an exported command`);
      const id = installId(key, p.selection.version);
      const layout = chooseLayout(probe, sourceMap.get(p.source)!, p.name);
      probe.installs[id] = {
        ...(layout ? { layout } : {}),
        id,
        key,
        name: p.name,
        version: p.selection.version,
        request: p.selection.request,
        source: sourceMap.get(p.source)!,
        dir: installDirectory(
          sourceMap.get(p.source)!,
          p.name,
          p.selection.version,
          key,
          layout,
        ),
        bins,
        env: platform.env,
        persist: [],
        verified: true,
        checksum: "preview",
        manifestHash: "preview",
        kind: "portable",
      };
      probe.defaults[key] = {
        id,
        request: p.selection.request,
        commands: p.selection.commands,
      };
    }
  }
  try {
    selectedEnvironment(packages.root, probe);
  } catch {
    conflicts.push("Selected package environments conflict");
  }
  for (const a of inventory.aliases) {
    const p = bySpec.get(a.package)!,
      key = keyFor(p),
      existing = state.aliases?.[a.name];
    if (
      owners.has(a.name) ||
      state.commands[a.name] ||
      (existing && (existing.key !== key || existing.command !== a.command))
    )
      conflicts.push(`Alias conflict: ${a.name}`);
    const manifest = metadata
      .get(a.package)
      ?.manifests.get(p.selection!.version);
    if (manifest && !manifest.platforms["windows-x64"]!.bin[a.command])
      conflicts.push(`Missing alias target: ${a.name}`);
    steps.push({ action: "alias", package: a.package });
  }
  const edges = new Map(
    inventory.packages.map((p) => [packageSpec(p), new Set<string>()]),
  );
  const node = inventory.packages.find(
    (p) =>
      p.name === "node" &&
      p.source !== "npm" &&
      p.selection?.commands.includes("node"),
  );
  for (const p of inventory.packages) {
    const spec = packageSpec(p);
    if (p.source === "npm") {
      if (node) edges.get(spec)!.add(packageSpec(node));
      else if (!state.commands.node)
        conflicts.push(
          `${spec} requires an explicitly selected managed Node in the inventory or existing environment`,
        );
      continue;
    }
    const meta = metadata.get(spec);
    if (!meta) continue;
    for (const m of meta.manifests.values()) {
      for (const dependency of m.platforms["windows-x64"]!.depends ?? []) {
        const d = parseSpec(dependency.package),
          targetSpec = `${d.source ?? p.source}/${d.name}`,
          target = bySpec.get(targetSpec);
        if (target) {
          if (!target.selection) {
            conflicts.push(
              `${spec} requires a selected inventory dependency: ${targetSpec}`,
            );
            continue;
          }
          const selected = target.selection;
          try {
            if (d.request && d.request !== "latest")
              chooseVersion(
                [selected.version],
                d.request,
                undefined,
                metadata.get(targetSpec)?.entry.aliases,
              );
          } catch {
            conflicts.push(
              `${targetSpec} default does not satisfy ${dependency.package}`,
            );
          }
          for (const command of dependency.commands ?? [])
            if (
              !selected.commands.includes(command) &&
              !inventory.aliases.some(
                (a) => a.name === command && a.package === targetSpec,
              )
            )
              conflicts.push(
                `${targetSpec} does not enable dependency command ${command}`,
              );
          edges.get(spec)!.add(targetSpec);
        } else {
          const unmet = await dependencyStatus(
            packages.root,
            state,
            meta.source,
            [dependency],
          );
          if (unmet.some((d) => !d.satisfied))
            conflicts.push(
              `${spec} requires ${targetSpec}; add its installed/default selection to the inventory`,
            );
        }
      }
    }
  }
  const order: string[] = [],
    pending = new Set(edges.keys());
  while (pending.size) {
    const ready = [...pending]
      .filter((spec) => [...edges.get(spec)!].every((d) => order.includes(d)))
      .sort();
    if (!ready.length) {
      conflicts.push("Inventory dependency cycle");
      break;
    }
    for (const spec of ready) {
      order.push(spec);
      pending.delete(spec);
    }
  }
  for (const intent of inventory.integrations ?? [])
    steps.push({
      action:
        intent.shell === "powershell"
          ? "shell-integration-needs-new-approval"
          : intent.shell + "-integration-needs-new-approval",
      package: intent.package,
    });
  const manifestHashes = [...metadata].flatMap(([spec, meta]) =>
    [...meta.manifests].map(([v, m]) => [spec, v, sha256(JSON.stringify(m))]),
  );
  return {
    inventory,
    revision: state.revision,
    conflicts: [...new Set(conflicts)],
    steps,
    order,
    binding: sha256(
      JSON.stringify([inventory, state.revision, manifestHashes, order]),
    ),
    manifests: Object.fromEntries(
      manifestHashes.map(([spec, version, hash]) => [
        `${spec}@${version}`,
        hash!,
      ]),
    ),
    warning:
      "Restore is sequential, not a whole-machine transaction. It does not restore credentials, data or script approvals. Successful earlier steps remain after failure; rerun a preview to resume.",
  };
}

export async function exportLockedInventory(packages: Packages) {
  const state = await packages.store.read();
  const inventory = exportInventory(state);
  const npmLocks: Record<string, unknown> = {};
  for (const install of Object.values(state.installs).filter(
    (i) => i.kind === "npm",
  )) {
    if (!install.npmBuild)
      fail("Reinstall legacy npm CLI before locked export");
    const path = join(
      npmSnapshotPath(packages.root, install.npmBuild.inputHash),
      "package-lock.json",
    );
    await noLinks(path);
    const lock = await json(path);
    validateNpmLock(lock, install.name, install.version);
    if (sha256(JSON.stringify(lock)) !== install.checksum)
      fail("npm lock differs from installation receipt");
    npmLocks["npm:" + install.name + "@" + install.version] = lock;
  }
  return validateInventory({ ...inventory, npmLocks });
}

export async function importInventory(
  packages: Packages,
  value: unknown,
  options: { confirmed?: boolean; binding?: string } = {},
) {
  const plan = await planInventory(packages, value);
  if (!options.confirmed)
    fail("Inventory restore requires explicit --yes after reviewing --dry-run");
  if (options.binding && options.binding !== plan.binding)
    fail("Inventory or environment changed; preview again");
  if (plan.conflicts.length)
    fail("Inventory restore blocked: " + plan.conflicts.join("; "));
  let revision = plan.revision;
  const completed: {
    action: string;
    package?: string;
    source?: string;
    version?: string;
  }[] = [];
  for (const s of plan.inventory.sources) {
    if (!(await packages.store.read()).sources[s.alias]) {
      await packages.addSource(s.alias, s.url, s.type, s.ref, revision++);
      completed.push({ action: "source-added", source: s.alias });
    }
  }
  for (const spec of plan.order) {
    const p = plan.inventory.packages.find((p) => packageSpec(p) === spec)!;
    for (const version of p.versions) {
      await packages.install(
        `${spec}@${version}`,
        false,
        revision++,
        plan.manifests[`${spec}@${version}`],
        plan.inventory.npmLocks?.[`${spec}@${version}`],
      );
      completed.push({ action: "installed", package: spec, version });
    }
    if (p.selection) {
      await packages.restoreSelection(
        spec,
        p.selection.version,
        p.selection.request,
        p.selection.commands,
        revision++,
      );
      completed.push({
        action: "selected",
        package: spec,
        version: p.selection.version,
      });
      for (const a of plan.inventory.aliases.filter(
        (a) => a.package === spec,
      )) {
        const existing = (await packages.store.read()).aliases?.[a.name];
        if (!existing) {
          await packages.aliasCommand(a.name, spec, a.command, revision++);
          completed.push({ action: "aliased", package: spec });
        }
      }
    }
  }
  if ((await packages.store.read()).revision !== revision)
    fail("State changed during restore; preview before continuing");
  return {
    completed,
    pendingIntegrations: plan.inventory.integrations ?? [],
    warning: plan.warning,
  };
}
