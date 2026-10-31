import { report } from "./progress.ts";
import { installationUsers } from "./installation-users.ts";
import { enrollStartMenu } from "./start-menu.ts";
import {
  carryDesktopIntegration,
  planDesktopUpgrade,
  stageDesktopChange,
} from "./desktop.ts";
import type { WindowsEffects } from "./windows-effects.ts";
import { editProfile, profileBytes, stageProfileChange } from "./profiles.ts";
import {
  persistence,
  renderTemplate,
  checkPackagePersistentFiles,
  checkPersistentFileMappings,
  noLinksData,
} from "./persistence.ts";
import { selectedEnvironment } from "./environment.ts";
import semver from "semver";
import {
  cp,
  mkdir,
  writeFile,
  rename,
  lstat,
  readlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { artifactBytes } from "./cache.ts";
import { chooseLayout, installDirectory, persistentFolder } from "./layout.ts";
import { Store, packageKey, installId, upgradeState } from "./store.ts";
import {
  makeSource,
  refresh,
  loadManifest,
  parseSpec,
  chooseVersion,
  normalizeIndex,
  distributionDownloads,
} from "./catalog.ts";
import { ensureInstallerTool } from "./installer-tools.ts";
import { ensureInnoUnpacker, ensureSevenZip } from "./helpers.ts";
import { dependencyStatus } from "./dependencies.ts";
import {
  extractArchive,
  extractionState,
  writeArtifactFile,
} from "./artifacts.ts";
import {
  capture,
  commandName,
  component,
  exists,
  fail,
  noLinks,
  removeTree,
  sha256,
  atomicJson,
  inside,
  json,
  publicEndpoint,
} from "./util.ts";
import {
  saveNpmSnapshot,
  scriptPlan,
  npmSnapshotPath,
  npmTreeHash,
  rebuildNpm,
} from "./scripts.ts";
import { npmContext, resolveNpm, prepareNpm } from "./npm.ts";
import { npmCompatibility } from "./npm-runtime.ts";
import { selectedNode } from "./windows.ts";
import type { Bin, CatalogPackage, Install, Source, State } from "./types.ts";

type SourceIndexes = Map<
  string,
  Promise<{ source: Source; index: Awaited<ReturnType<typeof refresh>> }>
>;

export class Packages {
  readonly store: Store;
  constructor(
    readonly root: string,
    readonly effectsBackend?: WindowsEffects,
  ) {
    this.store = new Store(root, effectsBackend);
  }
  async runtimeSpec(spec: string, distribution?: string): Promise<string> {
    if (!distribution) return spec;
    distribution = component(distribution);
    const parsed = parseSpec(spec);
    if (parsed.source === "npm")
      fail("Runtime distribution does not apply to npm");
    const state = await this.store.read(),
      matches: string[] = [];
    for (const original of Object.values(state.sources).filter(
      (s) => !parsed.source || s.alias === parsed.source,
    )) {
      const source = structuredClone(original),
        index = await refresh(this.root, source);
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
  async addSource(
    alias: string,
    url: string,
    type: "http" | "git" = "http",
    ref?: string,
    expectedRevision?: number,
  ): Promise<void> {
    const source = makeSource(alias, url, type, ref);
    await this.store.mutate(async (state) => {
      if (expectedRevision !== undefined && state.revision !== expectedRevision)
        fail("State changed during inventory restore; preview again");
      if (Object.hasOwn(state.sources, source.alias))
        fail("Source already exists; remove it explicitly before replacing it");
      report({ kind: "stage", label: "Refresh source", detail: source.alias });
      await refresh(this.root, source);
      state.sources[source.alias] = source;
    });
  }
  async refreshSources(alias?: string): Promise<void> {
    await this.store.mutate(
      async (state) => {
        const sources = alias
          ? [state.sources[component(alias)] ?? fail("Unknown source")]
          : Object.values(state.sources);
        for (const s of sources) {
          report({ kind: "stage", label: "Refresh source", detail: s.alias });
          await refresh(this.root, s);
        }
      },
      { skipUnchanged: true },
    );
  }
  async removeSource(alias: string, force = false): Promise<void> {
    await this.store.mutate(async (state) => {
      const s = state.sources[component(alias)];
      if (!s) fail("Unknown source");
      if (
        !force &&
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
  async search(
    query: string,
    options: { refresh?: boolean } = {},
  ): Promise<{ source: string; name: string; latest: string }[]> {
    if (options.refresh) await this.refreshSources();
    const results: { source: string; name: string; latest: string }[] = [];
    const state = await this.store.read();
    for (const s of Object.values(state.sources)) {
      const path = join(this.root, "sources", s.identity, "index.json");
      await noLinks(path);
      if (!(await exists(path)))
        fail(
          `Source ${s.alias} has no cached index; run piko source refresh ${s.alias}`,
        );
      const index = normalizeIndex(await json(path));
      for (const [name, p] of Object.entries(index.packages))
        if (`${s.alias}/${name}`.toLowerCase().includes(query.toLowerCase()))
          results.push({ source: s.alias, name, latest: p.latest });
    }
    return results.sort((a, b) =>
      `${a.source}/${a.name}`.localeCompare(`${b.source}/${b.name}`),
    );
  }
  private installed(
    state: State,
    spec: string,
  ): { key: string; installs: Install[]; request?: string } {
    const p = parseSpec(spec),
      matches = Object.values(state.installs).filter(
        (i) => i.name === p.name && (!p.source || i.source.alias === p.source),
      );
    const keys = [...new Set(matches.map((i) => i.key))];
    if (!keys.length) fail("Package is not installed");
    if (keys.length > 1) fail("Ambiguous package; specify <source>/<package>");
    return { key: keys[0]!, installs: matches, request: p.request };
  }
  private async select(
    state: State,
    key: string,
    id: string,
    request: string,
    noCommands = false,
  ): Promise<void> {
    upgradeState(state);
    const install = state.installs[id];
    if (!install || install.key !== key) fail("Missing installed target");
    if (
      Object.values(install.bins).some((b) => b.data) &&
      state.bootstraps?.[id]?.status !== "completed"
    )
      fail(
        "Run and approve this version's bootstrap before selecting generated commands",
      );
    await carryDesktopIntegration(
      this.root,
      state,
      install,
      this.effectsBackend,
    );
    if (
      Object.values(state.admin ?? {}).some(
        (r) =>
          state.installs[r.id]?.key === key &&
          r.action === "install" &&
          r.id !== id,
      )
    )
      fail("Remove system integration before switching versions");
    const prior = state.defaults[key];
    const enabled = noCommands
      ? []
      : (prior?.commands ?? Object.keys(install.bins));
    for (const alias of Object.values(state.aliases!)) {
      if (alias.key === key && !install.bins[alias.command])
        fail(
          `New version does not provide aliased command ${alias.command}; remove the alias first`,
        );
    }
    for (const command of enabled) {
      if (!install.bins[command])
        fail(
          `New version does not provide enabled command ${command}; release it first`,
        );
      const owner = state.commands[command];
      if ((owner && owner !== key) || state.aliases![command])
        fail(
          `Command conflict: ${command} is owned by another package or alias; no default was changed`,
        );
    }
    for (const [command, owner] of Object.entries(state.commands))
      if (owner === key) delete state.commands[command];
    state.defaults[key] = { id, request, commands: enabled };
    for (const command of enabled) state.commands[command] = key;
  }
  async upgradeDesktop(spec: string, binding: string): Promise<void> {
    await this.store.mutate(
      async (state) => {
        const plan = await planDesktopUpgrade(
          this.root,
          state,
          spec,
          this.effectsBackend,
        );
        if (!binding || binding !== plan.binding)
          fail(
            "Desktop upgrade changed; preview again and pass --yes --binding",
          );
        await stageDesktopChange(
          this.root,
          state,
          plan.install.key,
          plan.operations,
          plan.receipt,
          this.effectsBackend,
        );
        state.desktop![plan.install.key] = plan.receipt!;
        await this.select(
          state,
          plan.install.key,
          plan.install.id,
          plan.install.version,
        );
      },
      { effectsBackend: this.effectsBackend },
    );
  }
  async use(
    spec: string,
    options: { noCommands?: boolean; expectedRevision?: number } = {},
  ): Promise<void> {
    await this.store.mutate(async (state) => {
      if (
        options.expectedRevision !== undefined &&
        state.revision !== options.expectedRevision
      )
        fail("State changed during dependency installation; preview again");
      const match = this.installed(state, spec);
      if (!match.request && match.installs.length !== 1)
        fail("Multiple versions are installed; specify a version");
      const request = match.request ?? match.installs[0]!.version;
      let aliases: Record<string, string> | undefined;
      if (
        request !== "latest" &&
        !match.installs.some((i) => i.version === request) &&
        !/^\d+(?:\.\d+)?$/.test(request)
      ) {
        const original = match.installs[0]!.source;
        const source = Object.values(state.sources).find(
          (s) => s.identity === original.identity,
        );
        if (!source)
          fail("Restore the original source before resolving a version alias");
        aliases = (await refresh(this.root, source)).packages[
          match.installs[0]!.name
        ]?.aliases;
      }
      let latest: string | undefined;
      if (request === "latest") {
        const source = match.installs[0]!.source;
        const indexFile = join(
          this.root,
          "sources",
          source.identity,
          "index.json",
        );
        // Use the validated cached source designation, not semver coercion:
        // vendors also publish four-part versions and build identifiers.
        // Selection stays offline and never installs a missing newer version.
        if (await exists(indexFile)) {
          await noLinks(indexFile);
          latest = normalizeIndex(await json(indexFile)).packages[
            match.installs[0]!.name
          ]?.latest;
        }
      }
      const version = chooseVersion(
        match.installs.map((i) => i.version),
        request,
        latest,
        aliases,
      );
      await checkPersistentFileMappings(
        this.root,
        state.installs[match.installs.find((i) => i.version === version)!.id]!,
      );
      for (const bin of Object.values(
        match.installs.find((i) => i.version === version)!.bins,
      ))
        if (bin.data)
          await (
            await import("./execution.ts")
          ).persistentExecutable(
            this.root,
            state,
            match.installs.find((i) => i.version === version)!,
            bin.path,
          );
      await this.select(
        state,
        match.key,
        match.installs.find((i) => i.version === version)!.id,
        request,
        options.noCommands,
      );
    });
  }
  private clearCommands(state: State, key: string): void {
    for (const [command, owner] of Object.entries(state.commands))
      if (owner === key) delete state.commands[command];
    for (const [name, alias] of Object.entries(state.aliases ?? {}))
      if (alias.key === key) delete state.aliases![name];
  }
  private selectedInstall(state: State, spec: string): Install {
    const match = this.installed(state, spec),
      selection = state.defaults[match.key];
    if (!selection)
      fail(
        "Select a default version first; use --no-commands when resolving a conflict",
      );
    const install = state.installs[selection.id]!;
    if (
      match.request &&
      match.request !== selection.request &&
      chooseVersion([install.version], match.request) !== install.version
    )
      fail("Command operations require the selected default version");
    return install;
  }
  async claimCommand(name: string, spec: string): Promise<void> {
    name = commandName(name);
    await this.store.mutate(async (state) => {
      upgradeState(state);
      if (state.aliases![name])
        fail("This name is an alias; remove it explicitly before claiming it");
      const install = this.selectedInstall(state, spec);
      if (!install.bins[name]) fail(`Package does not provide ${name}`);
      const previous = state.commands[name];
      if (previous && previous !== install.key) {
        const selection = state.defaults[previous]!;
        selection.commands = (
          selection.commands ??
          Object.entries(state.commands)
            .filter(([, key]) => key === previous)
            .map(([n]) => n)
        ).filter((n) => n !== name);
      }
      const selection = state.defaults[install.key]!;
      selection.commands = [
        ...new Set([
          ...(selection.commands ?? Object.keys(install.bins)),
          name,
        ]),
      ];
      state.commands[name] = install.key;
    });
  }
  async aliasCommand(
    name: string,
    spec: string,
    provided: string,
    expectedRevision?: number,
  ): Promise<void> {
    name = commandName(name);
    provided = commandName(provided);
    await this.store.mutate(async (state) => {
      if (expectedRevision !== undefined && state.revision !== expectedRevision)
        fail("State changed during inventory restore; preview again");
      upgradeState(state);
      if (state.commands[name] || state.aliases![name])
        fail(
          "Command or alias name already exists; remove it explicitly first",
        );
      const install = this.selectedInstall(state, spec);
      if (!install.bins[provided])
        fail(
          `Package does not provide ${provided}; aliases cannot target aliases`,
        );
      state.aliases![name] = { key: install.key, command: provided };
    });
  }
  async removeAlias(name: string): Promise<void> {
    name = commandName(name);
    await this.store.mutate(async (state) => {
      upgradeState(state);
      if (!state.aliases![name]) fail("Not a command alias");
      delete state.aliases![name];
    });
  }
  async releaseCommand(name: string): Promise<void> {
    name = commandName(name);
    await this.store.mutate(async (state) => {
      upgradeState(state);
      const key = state.commands[name];
      if (!key) fail("Not an owned command; use unalias for an alias");
      const selection = state.defaults[key]!;
      selection.commands = (
        selection.commands ?? Object.keys(state.installs[selection.id]!.bins)
      ).filter((n) => n !== name);
      delete state.commands[name];
    });
  }
  async unuse(spec: string): Promise<void> {
    await this.store.mutate(async (state) => {
      const { key } = this.installed(state, spec);
      await (
        await import("./data-profiles.ts")
      ).assertNoDataProfile(this.root, key);
      if (
        state.desktop?.[key] ||
        Object.values(state.admin ?? {}).some(
          (r) => state.installs[r.id]?.key === key && r.action === "install",
        )
      )
        fail("Revoke desktop/system integration before unuse");
      delete state.defaults[key];
      this.clearCommands(state, key);
    });
  }
  async install(
    spec: string,
    skipChecksum = false,
    expectedRevision?: number,
    expectedManifestHash?: string,
    npmLock?: unknown,
  ): Promise<Install> {
    return this.installPackage(spec, {
      skipChecksum,
      expectedRevision,
      expectedManifestHash,
      npmLock,
    });
  }
  private async installPackage(
    spec: string,
    {
      skipChecksum = false,
      expectedRevision,
      expectedManifestHash,
      npmLock,
      sourceIndexes,
      context: providedContext,
      skipUnchanged = false,
    }: {
      skipChecksum?: boolean;
      expectedRevision?: number;
      expectedManifestHash?: string;
      npmLock?: unknown;
      sourceIndexes?: SourceIndexes;
      context?: Awaited<ReturnType<typeof npmContext>>;
      skipUnchanged?: boolean;
    } = {},
  ): Promise<Install> {
    const install = async (state: State) => {
      if (expectedRevision !== undefined && state.revision !== expectedRevision)
        fail("State changed during inventory restore; preview again");
      report({ kind: "stage", label: "Resolve package", detail: spec });
      const parsed = parseSpec(spec),
        request = parsed.request ?? "latest";
      if (parsed.source === "npm") {
        if (skipChecksum) fail("--skip-checksum does not bypass npm integrity");
        const selected = selectedNode(this.root, state);
        const context =
          providedContext?.node === selected.exe &&
          providedContext.npm === selected.npm
            ? providedContext
            : await npmContext(this.root, state, parsed.name);
        if (context === providedContext) {
          await noLinks(context.node);
          await noLinks(context.npm);
        }
        const resolved = await resolveNpm(
          context,
          parsed.name,
          request,
          join(this.root, "apps", "piko"),
        );
        const key = packageKey(resolved.source, parsed.name),
          id = installId(key, resolved.version),
          prior = state.installs[id];
        if (prior) {
          if (
            npmLock !== undefined &&
            prior.checksum !== sha256(JSON.stringify(npmLock))
          )
            fail(
              "Existing npm installation has a different locked graph; uninstall/reconcile explicitly",
            );
          return prior;
        }
        const layout = chooseLayout(state, resolved.source, parsed.name);
        const operation = crypto.randomUUID(),
          stage = join(this.root, "staging", operation, "app"),
          dir = installDirectory(
            resolved.source,
            parsed.name,
            resolved.version,
            key,
            layout,
          ),
          destination = join(this.root, dir);
        await noLinks(stage);
        await mkdir(stage, { recursive: true });
        try {
          report({
            kind: "stage",
            label: "Install npm dependencies",
            detail: "Integrity enforced; lifecycle scripts disabled",
          });
          const prepared = await prepareNpm(
            context,
            stage,
            parsed.name,
            resolved.version,
            npmLock,
          );
          report({ kind: "stage", label: "Verify npm graph and snapshot" });
          const inputHash = await saveNpmSnapshot(this.root, stage);
          upgradeState(state);
          state.schemaVersion = Math.max(
            state.schemaVersion,
            3,
          ) as State["schemaVersion"];
          const installation: Install = {
            ...(layout ? { layout } : {}),
            npmBuild: { inputHash, currentHash: inputHash, approvals: {} },
            id,
            key,
            name: parsed.name,
            version: resolved.version,
            request,
            source: resolved.source,
            dir,
            bins: prepared.bins,
            npmCompatibility: await npmCompatibility(stage, context.node),
            persist: [],
            verified: true,
            checksum: prepared.checksum,
            manifestHash: prepared.checksum,
            kind: "npm",
            runtimeVersion: prepared.runtimeVersion,
            enginesNode: prepared.enginesNode,
            scripts: prepared.scripts,
          };
          await atomicJson(join(stage, ".piko-install.json"), installation);
          await noLinks(destination);
          if (await exists(destination))
            fail(
              "Untracked npm installation directory exists; inspect before retrying",
            );
          report({
            kind: "stage",
            label: "Commit installation",
            detail: `${parsed.name}@${resolved.version}`,
          });
          await this.store.publishInstall(installation, stage, operation);
          state.installs[id] = installation;
          if (prepared.scripts.length)
            console.error(
              `WARNING: ${prepared.scripts.length} package(s) have skipped lifecycle scripts. Review with piko scripts list npm:${parsed.name}@${resolved.version}. Script execution requires explicit content-bound approval and rebuild.`,
            );
          return installation;
        } finally {
          if (!(await exists(this.store.installPath)))
            await removeTree(join(this.root, "staging", operation));
        }
      }
      const candidates: { source: Source; entry: CatalogPackage }[] = [];
      const sources = parsed.source
        ? [state.sources[parsed.source] ?? fail("Unknown source")]
        : Object.values(state.sources);
      for (const source of sources) {
        report({
          kind: "stage",
          label: "Refresh source",
          detail: source.alias,
        });
        let index: Awaited<ReturnType<typeof refresh>>;
        if (sourceIndexes) {
          let snapshot = sourceIndexes.get(source.identity);
          if (!snapshot) {
            const original = structuredClone(source);
            snapshot = refresh(this.root, original).then((index) => ({
              source: original,
              index,
            }));
            sourceIndexes.set(source.identity, snapshot);
          }
          const resolved = await snapshot;
          if (resolved.source.commit !== undefined)
            source.commit = resolved.source.commit;
          index = resolved.index;
        } else index = await refresh(this.root, source);
        const entry = index.packages[parsed.name];
        if (entry) candidates.push({ source, entry });
      }
      if (!candidates.length) fail("Package not found in configured sources");
      if (candidates.length > 1)
        fail("Ambiguous package; specify <source>/<package>");
      const candidate = candidates[0]!,
        source = candidate.source;
      const version = chooseVersion(
        Object.keys(candidate.entry.versions),
        request,
        candidate.entry.latest,
        candidate.entry.aliases,
      );
      report({
        kind: "stage",
        label: "Load manifest",
        detail: `${source.alias}/${parsed.name}@${version}`,
      });
      const manifest = await loadManifest(
        this.root,
        source,
        candidate.entry.versions[version]!,
        parsed.name,
        version,
      );
      report({
        kind: "stage",
        label: "Check dependencies and installed receipt",
      });
      const dependencyChecks = await dependencyStatus(
        this.root,
        state,
        source,
        manifest.platforms["windows-x64"]!.depends,
      );
      const unmet = dependencyChecks.filter((d) => !d.satisfied);
      if (unmet.length)
        fail(
          "Unmet dependencies (no dependency or default was changed):\n" +
            unmet
              .map(
                (d) =>
                  `${d.package}: ${d.issues.join("; ")}\n  ${d.advice.join("\n  ")}`,
              )
              .join("\n"),
        );
      const manifestHash = sha256(JSON.stringify(manifest)),
        key = packageKey(source, parsed.name),
        id = installId(key, version);
      if (expectedManifestHash && manifestHash !== expectedManifestHash)
        fail("Manifest changed since inventory preview; preview again");
      const prior = state.installs[id];
      if (prior) {
        await checkPackagePersistentFiles(this.root, state, key);
        if (prior.manifestHash !== manifestHash)
          fail(
            "Installed version has different manifest content; refusing to overwrite",
          );
        if (!prior.verified && !skipChecksum)
          fail(
            "Existing installation was not verified; explicit reinstall is required",
          );
        report({
          kind: "stage",
          label: "Already installed",
          detail: `${prior.name}@${prior.version}; no download needed`,
        });
        await enrollStartMenu(this.root, state, prior, this.effectsBackend);
        return prior;
      }
      const platform = manifest.platforms["windows-x64"]!;
      const downloads = distributionDownloads(platform);
      if (downloads.some((d) => !d.sha256) && !skipChecksum)
        fail(
          "Checksum is required; use --skip-checksum only for an explicit single-install exception",
        );
      const bins: Record<string, Bin> = {};
      for (const [name, value] of Object.entries(platform.bin)) {
        const normalized = commandName(name);
        if (Object.hasOwn(bins, normalized))
          fail("Case-colliding command names");
        bins[normalized] =
          typeof value === "string" ? { path: value, kind: "native" } : value;
      }
      const { paths: persist, files: persistFiles } = persistence(
        platform.persist,
      );
      await checkPackagePersistentFiles(this.root, state, key);
      for (const previous of Object.values(state.installs).filter(
        (i) => i.key === key,
      ))
        for (const path of persist) {
          const priorPath = previous.persist.find(
            (p) => p.toLowerCase() === path.toLowerCase(),
          );
          if (
            priorPath &&
            (priorPath !== path ||
              previous.persistFiles?.[priorPath]?.mode !==
                persistFiles[path]?.mode)
          )
            fail(
              "Persistent path spelling/type/mode changed; explicit migration required",
            );
        }
      for (const path of persist) {
        const data = state.data?.[key];
        const priorPath = data?.paths.find(
          (p) => p.toLowerCase() === path.toLowerCase(),
        );
        if (
          priorPath &&
          (priorPath !== path ||
            data?.files?.[priorPath]?.mode !== persistFiles[path]?.mode)
        )
          fail(
            "Recorded persistent data type/mode changed; explicit migration required",
          );
      }
      const registered =
        state.data?.[key]?.paths ??
        Object.values(state.installs)
          .filter((i) => i.key === key)
          .flatMap((i) => i.persist);
      for (const path of persist) {
        const normalized = path.toLowerCase();
        if (
          registered.some(
            (prior) =>
              prior.toLowerCase() !== normalized &&
              (prior.toLowerCase().startsWith(normalized + "/") ||
                normalized.startsWith(prior.toLowerCase() + "/")),
          )
        )
          fail("Persistent path overlaps a previously recorded directory");
      }
      for (let n = 0; n < persist.length; n++) {
        const a = persist[n]!.toLowerCase();
        if (a === ".piko-install.json")
          fail("Persistence conflicts with installation metadata");
        for (let m = 0; m < n; m++) {
          const b = persist[m]!.toLowerCase();
          if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
            fail("Overlapping persistent directories");
        }
        for (const bin of Object.values(bins))
          if (
            !bin.data &&
            (bin.path.toLowerCase() === a ||
              bin.path.toLowerCase().startsWith(a + "/"))
          )
            fail(
              "Executable entries cannot be stored in persistent directories",
            );
      }
      const operation = crypto.randomUUID(),
        stageRoot = join(this.root, "staging", operation),
        stage = join(stageRoot, "app");
      await noLinks(stageRoot);
      await mkdir(stage, { recursive: true });
      const layout = chooseLayout(state, source, parsed.name);
      const dir = installDirectory(source, parsed.name, version, key, layout),
        destination = join(this.root, dir);
      try {
        report({ kind: "stage", label: "Prepare extraction tools" });
        let sevenZip: string | undefined,
          inno: string | undefined,
          lessMsi: string | undefined;
        if (
          downloads.some(
            (d) =>
              d.format === "msi" || d.format === "nsis" || d.format === "pe",
          )
        )
          sevenZip = await ensureInstallerTool(this.root, state, "full7zip");
        if (downloads.some((d) => d.format === "msi"))
          lessMsi = await ensureInstallerTool(this.root, state, "lessmsi");
        if (
          !sevenZip &&
          downloads.some(
            (d) =>
              ["7z", "tar", "tar.gz", "tar.xz"].includes(d.format) ||
              d.nested?.some((s) => s.format === "7z"),
          )
        )
          sevenZip = await ensureSevenZip(this.root, state);
        if (downloads.some((d) => d.format === "inno"))
          inno = await ensureInnoUnpacker(this.root, state);
        const extraction = extractionState(platform.maxExpandedBytes),
          checksums: string[] = [];
        let verified = true;
        if (skipChecksum)
          console.error(
            `WARNING: checksum bypass authorized for ${source.alias}/${parsed.name}@${version} only`,
          );
        for (const [n, download] of downloads.entries()) {
          report({
            kind: "stage",
            label: `Artifact ${n + 1}/${downloads.length}`,
            detail: `${parsed.name}@${version}`,
          });
          const bytes = await artifactBytes(
              this.root,
              download.url,
              download.sha256,
              skipChecksum,
              state,
              download.maxBytes,
            ),
            checksum = sha256(bytes);
          report({
            kind: "stage",
            label: "Verify artifact",
            detail: `SHA-256; artifact ${n + 1}/${downloads.length}`,
          });
          checksums.push(checksum);
          const matches =
            !!download.sha256 && checksum === download.sha256.toLowerCase();
          verified &&= matches;
          if (!matches && !skipChecksum)
            fail("SHA-256 mismatch; installation was not committed");
          if (download.format === "file") {
            report({ kind: "stage", label: "Stage executable" });
            await writeArtifactFile(
              stage,
              [download.into, download.file!].filter(Boolean).join("/"),
              bytes,
              extraction,
            );
          } else {
            const archive = join(stageRoot, `download-${n}.${download.format}`);
            await writeFile(archive, bytes, { flag: "wx" });
            const cabinets: Record<string, string> = {};
            for (const [cabinetName, cabinet] of Object.entries(
              download.cabinets ?? {},
            )) {
              const cabBytes = await artifactBytes(
                this.root,
                cabinet.url,
                cabinet.sha256,
                false,
                state,
                cabinet.maxBytes,
              );
              checksums.push(sha256(cabBytes));
              const path = join(
                stageRoot,
                "cabinet-" + crypto.randomUUID() + ".cab",
              );
              await writeFile(path, cabBytes, { flag: "wx" });
              cabinets[cabinetName] = path;
            }
            report({
              kind: "stage",
              label: "Extract archive",
              detail: `${download.format}; artifact ${n + 1}/${downloads.length}`,
            });
            await extractArchive(
              archive,
              download.format,
              stage,
              download.stripPrefix,
              extraction,
              download.into,
              sevenZip,
              inno,
              {
                files: download.files,
                nested: download.nested,
                lessMsi,
                cabinets,
              },
            );
          }
        }
        report({
          kind: "stage",
          label: "Validate files and prepare data mappings",
        });
        const checksum =
          checksums.length === 1
            ? checksums[0]!
            : sha256(JSON.stringify(checksums));
        for (const [path, content] of Object.entries(
          platform.configFiles ?? {},
        ))
          await writeArtifactFile(
            stage,
            path,
            Buffer.from(content, "utf8"),
            extraction,
          );
        for (const [path, template] of Object.entries(
          platform.configTemplates ?? {},
        ))
          await writeArtifactFile(
            stage,
            path,
            Buffer.from(
              renderTemplate(
                template.text,
                destination,
                join(
                  this.root,
                  "persist",
                  persistentFolder({ name: parsed.name, source, layout }, key),
                ),
              ),
              "utf8",
            ),
            extraction,
          );
        for (const bin of Object.values(bins)) {
          if (bin.data) continue;
          const target = inside(stage, join(stage, bin.path));
          await noLinks(target);
          if (!(await lstat(target)).isFile())
            fail("Executable entry is not a regular file");
        }
        await noLinks(destination);
        if (await exists(destination))
          fail(
            "Untracked installation directory already exists; inspect it before retrying",
          );
        const installation: Install = {
          ...(layout ? { layout } : {}),
          id,
          key,
          name: parsed.name,
          version,
          request,
          source,
          dir,
          bins,
          persist,
          ...(Object.keys(persistFiles).length ? { persistFiles } : {}),
          verified,
          checksum,
          kind: "portable",
          ...(platform.desktop ? { desktop: platform.desktop } : {}),
          ...(platform.bootstrap ? { bootstrap: platform.bootstrap } : {}),
          ...(platform.admin ? { admin: platform.admin } : {}),
          ...(platform.env ? { env: platform.env } : {}),
          ...(platform.shell ? { shell: platform.shell } : {}),
          // Keep legacy receipts unchanged; new installs retain declared dependencies.
          ...(platform.shell || platform.depends?.length
            ? { depends: platform.depends ?? [] }
            : {}),
          manifestHash,
        };
        await atomicJson(join(stage, ".piko-install.json"), installation);
        report({
          kind: "stage",
          label: "Commit installation",
          detail: `${parsed.name}@${version}`,
        });
        await this.store.publishInstall(installation, stage, operation);
        state.installs[id] = installation;
        if (
          platform.env ||
          platform.shell ||
          Object.keys(persistFiles).length ||
          Object.values(bins).some((b) => b.kind === "powershell")
        ) {
          upgradeState(state);
          state.schemaVersion =
            platform.shell ||
            Object.keys(persistFiles).length ||
            Object.values(bins).some((b) => b.kind === "powershell")
              ? 5
              : (Math.max(state.schemaVersion, 4) as State["schemaVersion"]);
        }
        if (persist.length) upgradeState(state);
        return installation;
      } finally {
        if (!(await exists(this.store.installPath)))
          await removeTree(stageRoot);
      }
    };
    return this.store.mutate(install, { skipUnchanged });
  }
  async update(spec: string): Promise<Install> {
    return this.updatePackage(spec, new Map());
  }
  private async updatePackage(
    spec: string,
    sourceIndexes: SourceIndexes,
  ): Promise<Install> {
    report({ kind: "stage", label: "Check selected version", detail: spec });
    const state = await this.store.read(),
      match = this.installed(state, spec),
      selection = state.defaults[match.key];
    if (!selection) fail("Package has no default version to update");
    const previous = state.installs[selection.id]!;
    if (previous.kind === "npm") {
      const context = await npmContext(this.root, state, previous.name);
      if (context.registry !== previous.source.url)
        fail(
          "npm registry changed; refusing to change the installed package source",
        );
      if (selection.request === previous.version) {
        report({
          kind: "stage",
          label: "Keep pinned version",
          detail: `${previous.name}@${previous.version}`,
        });
        return previous;
      }
      const installed = await this.installPackage(
        `npm:${previous.name}@${selection.request}`,
        { context, skipUnchanged: true },
      );
      if (installed.id === previous.id) return installed;
      report({
        kind: "stage",
        label: "Switch selected version",
        detail: `${previous.version} -> ${installed.version}`,
      });
      await this.store.mutate(async (current) => {
        const selected = current.defaults[match.key];
        if (
          !selected ||
          selected.id !== selection.id ||
          selected.request !== selection.request
        )
          fail(
            "Default changed during update; new npm version is installed but not selected",
          );
        await this.select(current, match.key, installed.id, selection.request);
      });
      return installed;
    }
    const active = Object.values(state.sources).find(
      (s) => s.identity === previous.source.identity,
    );
    if (!active)
      fail("Original source is not configured; restore it before updating");
    if (selection.request === previous.version) {
      report({
        kind: "stage",
        label: "Keep pinned version",
        detail: `${previous.name}@${previous.version}`,
      });
      return previous;
    }
    const installed = await this.installPackage(
      `${active.alias}/${previous.name}@${selection.request}`,
      { sourceIndexes, skipUnchanged: true },
    );
    if (installed.id === previous.id) return installed;
    report({
      kind: "stage",
      label: "Switch selected version",
      detail: `${previous.version} -> ${installed.version}`,
    });
    await this.store.mutate(async (current) => {
      const selected = current.defaults[match.key];
      if (
        !selected ||
        selected.id !== selection.id ||
        selected.request !== selection.request
      )
        fail(
          "Default selection changed while updating; new version remains installed but was not selected",
        );
      await this.select(current, match.key, installed.id, selection.request);
    });
    return installed;
  }
  async info(spec: string) {
    report({ kind: "stage", label: "Load package information", detail: spec });
    const parsed = parseSpec(spec),
      state = await this.store.read();
    const installed = Object.values(state.installs).filter(
      (i) =>
        i.name === parsed.name &&
        (!parsed.source || i.source.alias === parsed.source),
    );
    const available: {
      source: Source;
      versions: string[];
      latest: string;
      version?: string;
      dependencies?: Awaited<ReturnType<typeof dependencyStatus>>;
      aliases?: Record<string, string>;
      runtime?: CatalogPackage["runtime"];
    }[] = [];
    await this.store.mutate(async (current) => {
      if (parsed.source === "npm") {
        const context = await npmContext(this.root, current, parsed.name);
        const versions = JSON.parse(
          await context.run(
            [
              "view",
              parsed.name,
              "versions",
              "--json",
              "--registry=" + context.registry,
            ],
            join(this.root, "apps", "piko"),
          ),
        );
        const list = typeof versions === "string" ? [versions] : versions;
        if (!Array.isArray(list) || !list.every((v) => typeof v === "string"))
          fail("Invalid npm metadata");
        const resolved = await resolveNpm(
          context,
          parsed.name,
          "latest",
          join(this.root, "apps", "piko"),
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
          const index = await refresh(this.root, source),
            entry = index.packages[parsed.name];
          if (entry) {
            const version = chooseVersion(
              Object.keys(entry.versions),
              parsed.request ?? "latest",
              entry.latest,
              entry.aliases,
            );
            const manifest = await loadManifest(
              this.root,
              source,
              entry.versions[version]!,
              parsed.name,
              version,
            );
            available.push({
              source,
              versions: Object.keys(entry.versions),
              latest: entry.latest,
              aliases: entry.aliases,
              runtime: entry.runtime,
              version,
              dependencies: await dependencyStatus(
                this.root,
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
        path: join(this.root, i.dir),
      })),
    };
  }
  async outdated(spec?: string) {
    report({ kind: "stage", label: "Check available updates" });
    const state = await this.store.read();
    const filter = spec ? this.installed(state, spec) : undefined;
    const selected = Object.entries(state.defaults).filter(
      ([key]) => !filter || key === filter.key,
    );
    const results: {
      package: string;
      current: string;
      request: string;
      source: string;
      candidate: string | null;
      latest?: string;
      status: string;
      reason?: string;
    }[] = [];
    const indexes = new Map<
      string,
      { source: Source; index: Awaited<ReturnType<typeof refresh>> }
    >();
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
      try {
        if (i.kind === "npm") {
          const context = await npmContext(this.root, state, i.name);
          if (context.registry !== i.source.url)
            fail("npm registry changed; restore the original registry");
          row.candidate = (
            await resolveNpm(
              context,
              i.name,
              selection.request,
              join(this.root, "apps/piko"),
            )
          ).version;
          row.latest = (
            await resolveNpm(
              context,
              i.name,
              "latest",
              join(this.root, "apps/piko"),
            )
          ).version;
        } else {
          const original = Object.values(state.sources).find(
            (s) => s.identity === i.source.identity,
          );
          if (!original)
            fail(
              "Original source is not configured; restore it before updating",
            );
          let cached = indexes.get(original.identity);
          if (!cached) {
            const source = structuredClone(original);
            cached = { source, index: await refresh(this.root, source) };
            indexes.set(source.identity, cached);
          }
          const { source, index } = cached;
          const entry = index.packages[i.name];
          if (!entry)
            fail("Package is no longer listed by its original source");
          row.latest = entry.latest;
          row.candidate = chooseVersion(
            Object.keys(entry.versions),
            selection.request,
            entry.latest,
            entry.aliases,
          );
          const manifest = await loadManifest(
            this.root,
            source,
            entry.versions[row.candidate]!,
            i.name,
            row.candidate,
          );
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
          if (distributionDownloads(platform).some((d) => !d.sha256))
            fail("Candidate lacks required SHA-256");
          const unmet = (
            await dependencyStatus(this.root, state, source, platform.depends)
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
          selectedEnvironment(this.root, probe);
        }
        row.status =
          row.candidate === i.version
            ? selection.request === i.version
              ? "pinned"
              : "current"
            : semver.valid(row.candidate) &&
                semver.valid(i.version) &&
                semver.lt(row.candidate, i.version)
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
  async updateAll(dryRun = false) {
    if (dryRun)
      return (await this.outdated()).map((r) => ({ ...r, version: r.current }));
    const state = await this.store.read(),
      results: {
        package: string;
        request: string;
        status: string;
        version?: string;
        error?: string;
      }[] = [];
    // One fresh source snapshot per batch, never a persistent/stale fallback.
    const sourceIndexes: SourceIndexes = new Map();
    let index = 0;
    for (const key of Object.keys(state.defaults).sort()) {
      const selection = state.defaults[key]!,
        i = state.installs[selection.id]!,
        spec =
          i.kind === "npm" ? `npm:${i.name}` : `${i.source.alias}/${i.name}`;
      report({
        kind: "item",
        package: spec,
        index: ++index,
        total: Object.keys(state.defaults).length,
      });
      try {
        const updated = await this.updatePackage(spec, sourceIndexes);
        report({
          kind: "result",
          label: `${spec}@${updated.version}: ${updated.id === i.id ? "unchanged" : "updated"}`,
        });
        results.push({
          package: spec,
          request: selection.request,
          status: updated.id === i.id ? "unchanged" : "updated",
          version: updated.version,
        });
      } catch (error) {
        report({ kind: "result", label: `${spec}: failed`, failed: true });
        results.push({
          package: spec,
          request: selection.request,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
  async scriptInventory(
    spec: string,
  ): Promise<NonNullable<Install["scripts"]>> {
    const state = await this.store.read(),
      match = this.installed(state, spec);
    const installation = match.request
      ? match.installs.find((i) => i.version === match.request)
      : match.installs.length === 1
        ? match.installs[0]
        : undefined;
    if (!installation || installation.kind !== "npm")
      fail("Select an exact installed npm package version");
    return installation.scripts ?? [];
  }
  private exactNpm(state: State, spec: string): Install {
    const match = this.installed(state, spec);
    const install = match.installs.find((i) => i.version === match.request);
    if (!install || install.kind !== "npm")
      fail("An exact installed npm package version is required");
    return install;
  }
  async inspectScripts(spec: string) {
    return await scriptPlan(
      this.root,
      this.exactNpm(await this.store.read(), spec),
    );
  }
  async approveScripts(
    spec: string,
    path: string,
    binding: string,
  ): Promise<void> {
    await this.store.mutate(async (state) => {
      const install = this.exactNpm(state, spec),
        plan = await scriptPlan(this.root, install);
      const script = plan.scripts.find((s) => s.path === path);
      if (!script || script.binding !== binding)
        fail(
          "Script approval contents changed; inspect again and confirm the exact binding",
        );

      if (plan.graph.filter((g) => g.resolved === script.resolved).length !== 1)
        fail(
          "Duplicate resolved package cannot be approved at path granularity",
        );
      install.npmBuild!.approvals[path] = {
        binding,
        approvedAt: new Date().toISOString(),
      };
    });
  }
  async revokeScripts(spec: string, path: string): Promise<void> {
    await this.store.mutate(async (state) => {
      const install = this.exactNpm(state, spec);
      if (!install.npmBuild?.approvals[path])
        fail("No script approval exists at this exact path");
      delete install.npmBuild.approvals[path];
    });
  }
  async rebuildScripts(spec: string): Promise<void> {
    await this.store.mutate(async (state) => {
      const before = this.exactNpm(state, spec),
        plan = await scriptPlan(this.root, before),
        context = await npmContext(this.root, state, before.name);
      if (context.registry !== before.source.url)
        fail(
          "npm registry changed; refusing to rebuild against a different source",
        );
      const operation = "npm-rebuild-" + crypto.randomUUID(),
        control = join(this.root, "staging", operation),
        stage = join(control, "app"),
        live = join(this.root, before.dir),
        backup = join(control, "old");
      await noLinks(control);
      await mkdir(control, { recursive: true });
      let journaled = false;
      try {
        await cp(npmSnapshotPath(this.root, plan.inputHash), stage, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        if ((await npmTreeHash(stage)) !== plan.inputHash)
          fail("npm snapshot changed while preparing rebuild");
        await rebuildNpm(
          context,
          stage,
          control,
          plan,
          before.npmBuild!.approvals,
        );
        const after = structuredClone(before);
        after.npmBuild!.currentHash = await npmTreeHash(stage);
        after.npmBuild!.lastRun = {
          at: new Date().toISOString(),
          node: await capture(context.node, ["--version"], {
            env: context.env,
          }),
          npm: context.version,
          paths: plan.scripts.filter((s) => s.approved).map((s) => s.path),
        };
        if (
          (await npmTreeHash(npmSnapshotPath(this.root, plan.inputHash))) !==
          plan.inputHash
        )
          fail("npm snapshot changed during rebuild; refusing replacement");
        after.runtimeVersion = after.npmBuild!.lastRun.node;
        after.npmCompatibility = await npmCompatibility(stage, context.node);
        for (const bin of Object.values(after.bins)) {
          const path = join(stage, bin.path);
          await noLinks(path);
          if (!(await lstat(path)).isFile())
            fail("Rebuild removed a CLI executable");
        }
        await atomicJson(join(stage, ".piko-install.json"), after);
        if ((await npmTreeHash(live)) !== before.npmBuild!.currentHash)
          fail(
            "Original npm installation changed during rebuild; refusing replacement",
          );
        await atomicJson(this.store.rebuildPath, { operation, before, after });
        journaled = true;
        await rename(live, backup);
        await rename(stage, live);
        state.installs[after.id] = after;
      } finally {
        if (!journaled) await removeTree(control);
      }
    });
  }
  async cleanupData(
    spec: string,
    options: {
      dryRun?: boolean;
      confirmed?: boolean;
      expectedPaths?: string[];
    } = {},
  ): Promise<{ paths: string[]; deleted: boolean }> {
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
            join(this.root, "persist", persistentFolder(data, key)),
            join(this.root, "persist", persistentFolder(data, key), path),
          ),
        ),
      };
    };
    if (options.dryRun) {
      const { paths, key } = plan(await this.store.read());
      await (
        await import("./data-profiles.ts")
      ).assertNoDataProfile(this.root, key);
      for (const path of paths) await noLinksData(path);
      return { paths, deleted: false };
    }
    return await this.store.mutate(async (state) => {
      const { key, data, paths } = plan(state);
      await (
        await import("./data-profiles.ts")
      ).assertNoDataProfile(this.root, key);
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
        stage = join(this.root, "staging", operation);
      await noLinks(stage);
      await mkdir(stage, { recursive: true });
      await atomicJson(join(stage, ".piko-cleanup.json"), { key, data });
      await atomicJson(this.store.dataRemovalPath, { key, data, operation });
      for (let n = 0; n < paths.length; n++)
        if (await exists(paths[n]!))
          await rename(paths[n]!, join(stage, String(n)));
      delete state.data![key];
      return { paths, deleted: true };
    });
  }
  async restoreSelection(
    spec: string,
    version: string,
    request: string,
    commands: string[],
    expectedRevision: number,
  ): Promise<void> {
    await this.store.mutate(async (state) => {
      if (state.revision !== expectedRevision)
        fail("State changed during inventory restore; preview again");
      const match = this.installed(state, spec),
        target = match.installs.find((i) => i.version === version);
      if (!target) fail("Inventory selected version is not installed");
      for (const bin of Object.values(target.bins))
        if (bin.data)
          await (
            await import("./execution.ts")
          ).persistentExecutable(this.root, state, target, bin.path);
      if (
        state.defaults[match.key] &&
        state.defaults[match.key]!.id !== target.id
      )
        fail(
          "Inventory would replace an existing default; resolve explicitly first",
        );
      state.defaults[match.key] = {
        id: target.id,
        request,
        commands: commands.map(commandName),
      };
      await this.select(state, match.key, target.id, request);
    });
  }
  async versionCleanupPlan(spec?: string, keep = 1) {
    if (!Number.isSafeInteger(keep) || keep < 0 || keep > 10000)
      fail("--keep must be an integer from 0 to 10000");
    const state = await this.store.read();
    if (spec && parseSpec(spec).request)
      fail("Version cleanup targets a package, not a version");
    const installs = spec
      ? this.installed(state, spec).installs
      : Object.values(state.installs);
    const entries: {
      installation: Install;
      package: string;
      version: string;
      path: string;
      action: string;
    }[] = [];
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
              : "remove";
        const path = join(this.root, i.dir);
        if (
          action === "remove" &&
          (await installationUsers(this.root, i, this.effectsBackend)).length
        )
          action = "defer-in-use";
        if (action === "remove") {
          await noLinks(path);
          await noLinks(join(path, ".piko-install.json"));
          if (
            JSON.stringify(await json(join(path, ".piko-install.json"))) !==
            JSON.stringify(i)
          )
            fail("Installation receipt drift; inspect before version cleanup");
        }
        entries.push({
          installation: i,
          package:
            i.kind === "npm" ? `npm:${i.name}` : `${i.source.alias}/${i.name}`,
          version: i.version,
          path,
          action,
        });
      }
    }
    return { keep, entries, binding: sha256(JSON.stringify(entries)) };
  }
  async cleanupVersions(
    spec?: string,
    keep = 1,
    options: { confirmed?: boolean; binding?: string } = {},
  ) {
    const plan = await this.versionCleanupPlan(spec, keep);
    if (!options.confirmed)
      fail("Version cleanup requires explicit confirmation after --dry-run");
    if (options.binding && options.binding !== plan.binding)
      fail("Version cleanup plan changed; preview again");
    const results: {
      package: string;
      version: string;
      status: string;
      error?: string;
    }[] = [];
    for (const item of plan.entries.filter((e) => e.action === "defer-in-use"))
      results.push({
        package: item.package,
        version: item.version,
        status: "deferred-in-use",
      });
    for (const item of plan.entries.filter((e) => e.action === "remove")) {
      try {
        await this.uninstall(
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
        results.push({
          package: item.package,
          version: item.version,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }
  async uninstall(
    spec: string,
    force = false,
    expected?: Install,
  ): Promise<void> {
    await this.store.mutate(async (state) => {
      upgradeState(state);
      const match = this.installed(state, spec);
      if (!match.request) fail("Uninstall requires an exact installed version");
      const installation = match.installs.find(
        (i) => i.version === match.request,
      );
      if (!installation) fail("Exact installed version not found");
      await (
        await import("./data-profiles.ts")
      ).assertNoDataProfile(this.root, installation.key);
      if (state.bootstraps?.[installation.id]?.status === "running")
        fail(
          "Bootstrap may be interrupted or running; explicitly retry/inspect it before uninstall",
        );
      if (
        state.desktop?.[installation.key]?.id === installation.id ||
        state.admin?.[installation.id]?.action === "install"
      )
        fail(
          "Revoke desktop/system integration before uninstalling this version",
        );
      if (expected && JSON.stringify(expected) !== JSON.stringify(installation))
        fail("Installation changed since cleanup preview");
      if (state.defaults[match.key]?.id === installation.id) {
        if (!force)
          fail(
            "Cannot uninstall the default version; switch or unuse it first, or explicitly use --force",
          );
        delete state.defaults[match.key];
        this.clearCommands(state, match.key);
      }
      const from = join(this.root, installation.dir),
        trash = `uninstall-${crypto.randomUUID()}`,
        to = join(this.root, "staging", trash);
      await noLinks(from);
      if (expected) {
        await noLinks(join(from, ".piko-install.json"));
        if (
          JSON.stringify(await json(join(from, ".piko-install.json"))) !==
          JSON.stringify(expected)
        )
          fail("Installation receipt changed since cleanup preview");
      }
      await noLinks(dirname(to));
      const users = await installationUsers(
        this.root,
        installation,
        this.effectsBackend,
      );
      if (users.length)
        fail(
          "Installation is in use by loaded DLLs/processes; keep this version and retry cleanup after sign-out/restart: " +
            users.map((p) => `${p.name} (${p.pid})`).join(", "),
        );
      await mkdir(dirname(to), { recursive: true });
      // Only unlink declared mappings after verifying their exact managed target.
      await checkPersistentFileMappings(this.root, installation);
      for (const path of installation.persist) {
        if (installation.persistFiles?.[path]) continue;
        const link = join(from, path),
          expected = resolve(
            join(
              this.root,
              "persist",
              persistentFolder(installation, installation.key),
              path,
            ),
          );
        if (!(await exists(link))) continue;
        if (
          !(await lstat(link)).isSymbolicLink() ||
          resolve(await readlink(link)).toLowerCase() !== expected.toLowerCase()
        )
          fail("Persistent mapping drift; refusing removal");
      }
      if (
        !Object.values(state.installs).some(
          (i) => i.key === installation.key && i.id !== installation.id,
        )
      ) {
        for (const [profileId, profile] of Object.entries(
          state.profiles ?? {},
        )) {
          if (!profile.approvals[installation.key]) continue;
          const next = structuredClone(profile);
          delete next.approvals[installation.key];
          const desired = Object.keys(next.approvals).length ? next : null,
            bytes = await profileBytes(profile.path),
            after = editProfile(
              this.root,
              bytes,
              profile.block,
              desired?.block,
            );
          await stageProfileChange(
            this.root,
            state,
            profile.path,
            bytes,
            after,
            desired,
          );
          if (desired) state.profiles![profileId] = desired;
          else delete state.profiles![profileId];
        }
      }
      await atomicJson(this.store.removalPath, { installation, trash });
      await rename(from, to);
      delete state.bootstraps?.[installation.id];
      delete state.admin?.[installation.id];
      delete state.installs[installation.id];
    });
  }
}
