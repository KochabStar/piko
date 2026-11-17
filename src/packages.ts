import { Store } from "./store.ts";
import type { WindowsEffects } from "./windows-effects.ts";
import type { Install } from "./types.ts";
import type {
  InstallOptions,
  UpdateOptions,
  UseOptions,
} from "./ops/context.ts";
import { installPackage } from "./ops/install.ts";
import { updateAll, updatePackage } from "./ops/update.ts";
import type { UpdateResult } from "./ops/update.ts";
import {
  restoreSelection,
  unuse,
  upgradeDesktop,
  usePackage,
} from "./ops/use.ts";
import { uninstallPackage } from "./ops/uninstall.ts";
import {
  addSource,
  refreshSources,
  removeSource,
  runtimeSpec,
  search,
} from "./ops/sources.ts";
import type {
  RuntimeSpecOptions,
  SearchOptions,
  SearchResult,
} from "./ops/sources.ts";
import { info, outdated } from "./ops/query.ts";
import type { PackageInfo, OutdatedResult } from "./ops/query.ts";
import {
  aliasCommand,
  claimCommand,
  releaseCommand,
  removeAlias,
} from "./ops/commands.ts";
import {
  approveScripts,
  inspectScripts,
  rebuildScripts,
  revokeScripts,
  scriptInventory,
} from "./ops/npm-scripts.ts";
import type { ScriptPlan } from "./ops/npm-scripts.ts";
import {
  cleanupData,
  cleanupVersions,
  versionCleanupPlan,
} from "./ops/cleanup.ts";
import type {
  CleanupDataOptions,
  CleanupDataResult,
  CleanupVersionsOptions,
  CleanupVersionResult,
  VersionCleanupPlan,
} from "./ops/cleanup.ts";

export type InstallRequestOptions = Pick<
  InstallOptions,
  "offline" | "withService"
>;

export class Packages {
  readonly store: Store;

  constructor(
    readonly root: string,
    readonly effectsBackend?: WindowsEffects,
  ) {
    this.store = new Store(root, effectsBackend);
  }

  runtimeSpec(
    spec: string,
    distribution?: string,
    options: RuntimeSpecOptions = {},
  ): Promise<string> {
    return runtimeSpec(this, spec, distribution, options);
  }

  addSource(
    alias: string,
    url: string,
    expectedRevision?: number,
  ): Promise<void> {
    return addSource(this, alias, url, expectedRevision);
  }

  refreshSources(alias?: string): Promise<void> {
    return refreshSources(this, alias);
  }

  removeSource(alias: string, force = false): Promise<void> {
    return removeSource(this, alias, force);
  }

  search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    return search(this, query, options);
  }

  info(spec: string): Promise<PackageInfo> {
    return info(this, spec);
  }

  outdated(spec?: string): Promise<OutdatedResult[]> {
    return outdated(this, spec);
  }

  updateAll(
    dryRun = false,
    options: UpdateOptions = {},
  ): Promise<UpdateResult[]> {
    return updateAll(this, dryRun, options);
  }

  install(
    spec: string,
    skipChecksum = false,
    expectedRevision?: number,
    expectedManifestHash?: string,
    npmLock?: unknown,
    options: InstallRequestOptions = {},
  ): Promise<Install> {
    return installPackage(this, spec, {
      skipChecksum,
      expectedRevision,
      expectedManifestHash,
      npmLock,
      ...options,
    });
  }

  use(spec: string, options: UseOptions = {}): Promise<void> {
    return usePackage(this, spec, options);
  }

  unuse(spec: string): Promise<void> {
    return unuse(this, spec);
  }

  upgradeDesktop(spec: string, binding: string): Promise<void> {
    return upgradeDesktop(this, spec, binding);
  }

  restoreSelection(
    spec: string,
    version: string,
    request: string,
    commands: string[],
    expectedRevision: number,
  ): Promise<void> {
    return restoreSelection(
      this,
      spec,
      version,
      request,
      commands,
      expectedRevision,
    );
  }

  claimCommand(name: string, spec: string): Promise<void> {
    return claimCommand(this, name, spec);
  }

  aliasCommand(
    name: string,
    spec: string,
    provided: string,
    expectedRevision?: number,
  ): Promise<void> {
    return aliasCommand(this, name, spec, provided, expectedRevision);
  }

  removeAlias(name: string): Promise<void> {
    return removeAlias(this, name);
  }

  releaseCommand(name: string): Promise<void> {
    return releaseCommand(this, name);
  }

  scriptInventory(spec: string): Promise<NonNullable<Install["scripts"]>> {
    return scriptInventory(this, spec);
  }

  inspectScripts(spec: string): Promise<ScriptPlan> {
    return inspectScripts(this, spec);
  }

  approveScripts(spec: string, path: string, binding: string): Promise<void> {
    return approveScripts(this, spec, path, binding);
  }

  revokeScripts(spec: string, path: string): Promise<void> {
    return revokeScripts(this, spec, path);
  }

  rebuildScripts(spec: string): Promise<void> {
    return rebuildScripts(this, spec);
  }

  cleanupData(
    spec: string,
    options: CleanupDataOptions = {},
  ): Promise<CleanupDataResult> {
    return cleanupData(this, spec, options);
  }

  versionCleanupPlan(spec?: string, keep = 1): Promise<VersionCleanupPlan> {
    return versionCleanupPlan(this, spec, keep);
  }

  cleanupVersions(
    spec?: string,
    keep = 1,
    options: CleanupVersionsOptions = {},
  ): Promise<CleanupVersionResult[]> {
    return cleanupVersions(this, spec, keep, options);
  }

  update(spec: string, options: UpdateOptions = {}): Promise<Install> {
    return updatePackage(this, spec, new Map(), options);
  }

  uninstall(spec: string, force = false, expected?: Install): Promise<void> {
    return uninstallPackage(this, spec, force, expected);
  }
}
