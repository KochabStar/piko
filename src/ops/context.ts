import type { Store } from "../store.ts";
import type { WindowsEffects } from "../windows-effects.ts";
import type { Index, Manifest, Source } from "../types.ts";
import type { NpmContext } from "../npm.ts";
import type { ResolutionSession } from "../package-resolution.ts";
import type { Install } from "../types.ts";

export type PackagesContext = {
  root: string;
  store: Store;
  effectsBackend?: WindowsEffects;
};
export type SourceSnapshot = { source: Source; index: Index };
export type SourceIndexes = Map<string, Promise<SourceSnapshot>>;
export type InstallOptions = {
  skipChecksum?: boolean;
  expectedRevision?: number;
  expectedManifestHash?: string;
  npmLock?: unknown;
  sourceIndexes?: SourceIndexes;
  resolution?: ResolutionSession;
  updateFrom?: Install;
  approveAdmin?: boolean;
  context?: NpmContext;
  skipUnchanged?: boolean;
  offline?: boolean;
  refreshSource?: boolean;
  withService?: boolean;
  deferService?: boolean;
  bound?: { source: Source; name: string; version: string; manifest: Manifest };
};
export type UseOptions = {
  noCommands?: boolean;
  expectedRevision?: number;
  installLatest?: boolean;
  retainRequest?: boolean;
};
export type UpdateOptions = { approveAdmin?: boolean; withService?: boolean };
