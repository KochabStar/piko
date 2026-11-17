import { mkdir, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { report } from "../progress.ts";
import { enrollStartMenu } from "../start-menu.ts";
import { WindowsEffects } from "../windows-effects.ts";
import {
  persistence,
  renderTemplate,
  checkPackagePersistentFiles,
} from "../persistence.ts";
import { artifactBytes } from "../cache.ts";
import { chooseLayout, installDirectory, persistentFolder } from "../layout.ts";
import { packageKey, installId, upgradeState } from "../store.ts";
import {
  normalizeManifest,
  parseSpec,
  distributionDownloads,
} from "../catalog.ts";
import { ensureSourceIndex } from "../source-fetch.ts";
import { resolvePackageManifest } from "../package-resolution.ts";
import { compareVersions } from "../upstream.ts";
import { preflightUnregisterServices } from "../service.ts";
import { ensureInstallerTool } from "../installer-tools.ts";
import { ensureInnoUnpacker, ensureSevenZip } from "../helpers.ts";
import { dependencyStatus } from "../dependencies.ts";
import { selectedEnvironment } from "../environment.ts";
import {
  extractArchive,
  extractionState,
  writeArtifactFile,
} from "../artifacts.ts";
import {
  commandName,
  exists,
  fail,
  noLinks,
  removeTree,
  sha256,
  atomicJson,
  inside,
} from "../util.ts";
import { saveNpmSnapshot } from "../scripts.ts";
import { npmContext, resolveNpm, prepareNpm } from "../npm.ts";
import { npmCompatibility } from "../npm-runtime.ts";
import { selectedNode } from "../windows.ts";
import { ensureInstallReceipt } from "../receipt.ts";
import { registerServices } from "../service.ts";
import {
  bindOperation,
  runOperation,
  checkpoint,
  trackOperationFile,
} from "../journal.ts";
import type {
  Bin,
  CatalogPackage,
  Index,
  Install,
  Manifest,
  Source,
  State,
} from "../types.ts";
import type { PackagesContext, InstallOptions } from "./context.ts";

export async function installPackage(
  ops: PackagesContext,
  spec: string,
  options: InstallOptions = {},
): Promise<Install> {
  const {
    skipChecksum = false,
    expectedRevision,
    expectedManifestHash,
    npmLock,
    sourceIndexes,
    context: providedContext,
    skipUnchanged = false,
    offline = false,
    refreshSource = false,
    withService = false,
    deferService = false,
  } = options;
  const install = async (state: State) => {
    if (expectedRevision !== undefined && state.revision !== expectedRevision)
      fail("State changed during inventory restore; preview again");
    report({ kind: "stage", label: "Resolve package", detail: spec });
    const parsed = parseSpec(spec),
      request = parsed.request ?? "latest";
    if (parsed.source === "npm") {
      if (offline)
        fail(
          "Offline npm installation requires a complete verified graph; use a previously installed version",
        );
      if (skipChecksum) fail("--skip-checksum does not bypass npm integrity");
      const selected = selectedNode(ops.root, state);
      const context =
        providedContext?.node === selected.exe &&
        providedContext.npm === selected.npm
          ? providedContext
          : await npmContext(ops.root, state, parsed.name);
      if (context === providedContext) {
        await noLinks(context.node);
        await noLinks(context.npm);
      }
      const resolved = await resolveNpm(
        context,
        parsed.name,
        request,
        join(ops.root, "apps", "piko"),
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
        stage = join(ops.root, "staging", operation, "app"),
        dir = installDirectory(
          resolved.source,
          parsed.name,
          resolved.version,
          key,
          layout,
        ),
        destination = join(ops.root, dir);
      await bindOperation(ops.store, {
        kind: "install",
        spec: `npm:${parsed.name}@${resolved.version}`,
        packageId: id,
        name: parsed.name,
        version: resolved.version,
        source: resolved.source,
        npmLock,
      });
      await noLinks(stage);
      await trackOperationFile(ops.store, join(ops.root, "staging", operation));
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
        const inputHash = await saveNpmSnapshot(ops.root, stage);
        upgradeState(state);

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
        await trackOperationFile(ops.store, destination);
        await checkpoint(ops.store, `${installation.id}/link`, () =>
          ops.store.publishInstall(installation, stage, operation),
        );
        state.installs[id] = installation;
        ensureInstallReceipt(state, installation).installedAt =
          new Date().toISOString();
        if (prepared.scripts.length)
          console.error(
            `WARNING: ${prepared.scripts.length} package(s) have skipped lifecycle scripts. Review with piko scripts list npm:${parsed.name}@${resolved.version}. Script execution requires explicit content-bound approval and rebuild.`,
          );
        return installation;
      } finally {
        if (!(await exists(ops.store.installPath)))
          await removeTree(join(ops.root, "staging", operation));
      }
    }
    let source: Source, version: string, manifest: Manifest;
    if (options.bound) {
      const bound = options.bound;
      if (
        bound.name !== parsed.name ||
        bound.version !== request ||
        bound.source.alias !== parsed.source
      )
        fail("Recovery package identity changed");
      source =
        state.sources[bound.source.alias] ??
        fail("Restore the original source before recovery");
      if (source.identity !== bound.source.identity)
        fail("Recovery source identity changed");
      version = bound.version;
      manifest = normalizeManifest(bound.manifest, bound.name, bound.version);
    } else {
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
        let index: Index;
        if (sourceIndexes) {
          let snapshot = sourceIndexes.get(source.identity);
          if (!snapshot) {
            const original = structuredClone(source);
            snapshot = ensureSourceIndex(ops.root, original, {
              offline,
              refresh: refreshSource,
            }).then((index) => ({
              source: original,
              index,
            }));
            sourceIndexes.set(source.identity, snapshot);
          }
          const resolved = await snapshot;
          source.fetchedAt = resolved.source.fetchedAt;
          index = resolved.index;
        } else
          index = await ensureSourceIndex(ops.root, source, {
            offline,
            refresh: refreshSource,
          });
        const entry = index.packages[parsed.name];
        if (entry) candidates.push({ source, entry });
      }
      if (!candidates.length) fail("Package not found in configured sources");
      if (candidates.length > 1)
        fail("Ambiguous package; specify <source>/<package>");
      const candidate = candidates[0]!;
      source = candidate.source;
      manifest = await resolvePackageManifest(
        ops.root,
        state,
        source,
        parsed.name,
        candidate.entry,
        request,
        {
          offline,
          session: options.resolution,
          currentVersion: options.updateFrom?.version,
          preflight: async (proposed) => {
            const platform = proposed.platforms["windows-x64"]!;
            const previous = options.updateFrom;
            if (previous && proposed.version !== previous.version) {
              if (
                (state.admin?.[previous.id]?.action === "install" &&
                  !platform.admin?.required) ||
                (state.desktop?.[previous.key] &&
                  JSON.stringify(state.desktop[previous.key]!.declaration) !==
                    JSON.stringify(platform.desktop))
              )
                fail(
                  "Revoke pinned desktop/system integration before updating this version; preview/reapply afterwards",
                );
              if (platform.bootstrap)
                fail(
                  "New bootstrap version needs explicit install and execution approval before selection",
                );
              const provided = Object.keys(platform.bin).map(commandName);
              if (new Set(provided).size !== provided.length)
                fail("Candidate has case-colliding commands");
              const enabled =
                state.defaults[previous.key]?.commands ??
                Object.keys(previous.bins);
              if (
                [
                  ...enabled,
                  ...Object.values(state.aliases ?? {})
                    .filter((a) => a.key === previous.key)
                    .map((a) => a.command),
                ].some((command) => !provided.includes(command))
              )
                fail("Candidate removes an enabled or aliased command");
              const probe = structuredClone(state);
              probe.installs[previous.id] = {
                ...previous,
                version: proposed.version,
                env: platform.env,
              };
              selectedEnvironment(ops.root, probe);
              const unmet = (
                await dependencyStatus(
                  ops.root,
                  state,
                  source,
                  platform.depends,
                  false,
                )
              ).filter((dependency) => !dependency.satisfied);
              if (unmet.length)
                fail(
                  "Unmet dependencies: " +
                    unmet
                      .map(
                        (dependency) =>
                          dependency.package +
                          ": " +
                          dependency.issues.join("; "),
                      )
                      .join("; "),
                );
            }
            if (platform.services?.length || deferService) {
              if (!withService)
                fail(
                  "Declared services require an Administrator terminal and --with-service",
                );
              if (
                !(await (ops.effectsBackend ?? new WindowsEffects()).elevated())
              )
                fail("Open an Administrator terminal; Piko never requests UAC");
              if (previous && deferService)
                await preflightUnregisterServices(ops.store, state, previous);
            }
            if (
              previous &&
              platform.admin?.required &&
              proposed.version !== previous.version
            ) {
              if (!options.approveAdmin)
                fail(
                  "Required system integration must migrate first; rerun update --approve-admin in an Administrator terminal",
                );
              if (
                !(await (ops.effectsBackend ?? new WindowsEffects()).elevated())
              )
                fail(
                  "Open an Administrator terminal and rerun update --approve-admin",
                );
            }
          },
        },
      );
      version = manifest.version;
      if (
        options.updateFrom &&
        version !== options.updateFrom.version &&
        compareVersions(version, options.updateFrom.version) < 0
      )
        fail("Source/request resolves to an older version; refusing downgrade");
    }
    report({
      kind: "stage",
      label: "Check dependencies and installed receipt",
    });
    const dependencyChecks = await dependencyStatus(
      ops.root,
      state,
      source,
      manifest.platforms["windows-x64"]!.depends,
      !offline,
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
    await bindOperation(ops.store, {
      kind: "install",
      packageId: id,
      spec: `${source.alias}/${parsed.name}@${version}`,
      source,
      name: parsed.name,
      version,
      manifestHash,
      manifest,
    });
    const prior = state.installs[id];
    if (prior) {
      await checkPackagePersistentFiles(ops.root, state, key);
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
      ensureInstallReceipt(state, prior);
      if (prior.services?.length && !deferService) {
        const ready = prior.services.every(
          (declaration) =>
            state.services?.[prior.id + "/" + declaration.name.toLowerCase()]
              ?.status === "registered",
        );
        if (!ready && !withService)
          fail(
            "Declared services require an Administrator terminal: piko install " +
              spec +
              " --with-service",
          );
        if (withService)
          await checkpoint(ops.store, prior.id + "/service", () =>
            registerServices(ops.store, state, prior),
          );
      }
      await enrollStartMenu(ops.root, state, prior, ops.effectsBackend);
      return prior;
    }
    const platform = manifest.platforms["windows-x64"]!;
    if (platform.services?.length) {
      if (!withService)
        fail(
          "Declared services require an Administrator terminal: piko install " +
            spec +
            " --with-service",
        );
      if (skipChecksum)
        fail("Service registration requires verified package content");
      if (!(await (ops.effectsBackend ?? new WindowsEffects()).elevated()))
        fail(
          "Open an Administrator terminal and rerun install --with-service; Piko never requests UAC",
        );
    }
    const downloads = distributionDownloads(platform);
    if (downloads.some((d) => !d.sha256) && !skipChecksum)
      fail(
        "Checksum is required; use --skip-checksum only for an explicit single-install exception",
      );
    const bins: Record<string, Bin> = {};
    for (const [name, value] of Object.entries(platform.bin)) {
      const normalized = commandName(name);
      if (Object.hasOwn(bins, normalized)) fail("Case-colliding command names");
      bins[normalized] =
        typeof value === "string" ? { path: value, kind: "native" } : value;
    }
    const { paths: persist, files: persistFiles } = persistence(
      platform.persist,
    );
    await checkPackagePersistentFiles(ops.root, state, key);
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
          fail("Executable entries cannot be stored in persistent directories");
    }
    const layout = chooseLayout(state, source, parsed.name);
    const dir = installDirectory(source, parsed.name, version, key, layout),
      destination = join(ops.root, dir);
    const operation = crypto.randomUUID(),
      stageRoot = join(ops.root, "staging", operation),
      stage = join(stageRoot, "app");
    await noLinks(stageRoot);
    await trackOperationFile(ops.store, stageRoot);
    await mkdir(stage, { recursive: true });
    try {
      report({ kind: "stage", label: "Prepare extraction tools" });
      let sevenZip: string | undefined,
        inno: string | undefined,
        lessMsi: string | undefined;
      if (
        downloads.some(
          (d) =>
            d.format === "msi" ||
            d.format === "burn" ||
            d.format === "nsis" ||
            d.format === "pe",
        )
      )
        sevenZip = await ensureInstallerTool(
          ops.root,
          state,
          "full7zip",
          offline,
        );
      if (downloads.some((d) => d.format === "msi" || d.format === "burn"))
        lessMsi = await ensureInstallerTool(
          ops.root,
          state,
          "lessmsi",
          offline,
        );
      if (
        !sevenZip &&
        downloads.some(
          (d) =>
            ["7z", "tar", "tar.gz", "tar.xz"].includes(d.format) ||
            d.nested?.some((s) => s.format === "7z"),
        )
      )
        sevenZip = await ensureSevenZip(ops.root, state, offline);
      if (downloads.some((d) => d.format === "inno"))
        inno = await ensureInnoUnpacker(ops.root, state, offline);
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
        const bytes = await checkpoint(ops.store, `${id}/download-${n}`, () =>
            artifactBytes(
              ops.root,
              download.url,
              download.sha256,
              skipChecksum,
              state,
              download.maxBytes,
              offline,
            ),
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
            const cabBytes = await checkpoint(
              ops.store,
              `${id}/cabinet-${n}-${cabinetName}`,
              () =>
                artifactBytes(
                  ops.root,
                  cabinet.url,
                  cabinet.sha256,
                  false,
                  state,
                  cabinet.maxBytes,
                  offline,
                ),
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
          const format = download.format;
          await checkpoint(ops.store, `${id}/extract-${n}`, () =>
            extractArchive(
              archive,
              format,
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
                payload: download.payload,
              },
            ),
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
      for (const [path, content] of Object.entries(platform.configFiles ?? {}))
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
                ops.root,
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
        ...(platform.services?.length ? { services: platform.services } : {}),
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
      await trackOperationFile(ops.store, destination);
      await checkpoint(ops.store, `${installation.id}/link`, () =>
        ops.store.publishInstall(installation, stage, operation),
      );
      state.installs[id] = installation;
      ensureInstallReceipt(state, installation).installedAt =
        new Date().toISOString();
      upgradeState(state);
      if (installation.services?.length && !deferService)
        await checkpoint(ops.store, installation.id + "/service", () =>
          registerServices(ops.store, state, installation),
        );
      return installation;
    } finally {
      if (!(await exists(ops.store.installPath))) await removeTree(stageRoot);
    }
  };
  return runOperation(
    ops.store,
    "install",
    spec,
    {
      skipChecksum,
      expectedRevision,
      expectedManifestHash,
      npmLock,
      offline,
      withService,
    },
    () =>
      checkpoint(ops.store, "install/state", () =>
        ops.store.mutate(install, { skipUnchanged }),
      ),
  );
}
