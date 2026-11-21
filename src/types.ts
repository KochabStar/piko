export type Bin = {
  path: string;
  kind: "native" | "node" | "powershell";
  data?: boolean;
};
export type DesktopDeclaration = {
  environment?: Record<string, string>;
  path?: string[];
  shortcuts?: { name: string; path: string; args?: string[] }[];
  fonts?: string[];
  associations?: {
    extension: string;
    label: string;
    path: string;
    args?: string[];
  }[];
  menus?: {
    id: string;
    label: string;
    target: "file" | "directory" | "background";
    path: string;
    args?: string[];
  }[];
};
export type ExecDeclaration = {
  path: string;
  args: string[];
  env?: Record<string, string>;
  kind?: "native" | "powershell" | "javascript";
};
export type BootstrapDeclaration = ExecDeclaration & { outputs: string[] };
export type ServiceDeclaration = {
  name: string;
  displayName: string;
  description?: string;
  binPath: string;
  args?: string[];
  startType: "auto" | "demand" | "disabled";
  depends?: string[];
  startAfterInstall?: boolean;
  stopBeforeUninstall?: boolean;
};
export type ServiceReceiptConfig = {
  binaryPath: string;
  startType: number;
  serviceType: number;
  errorControl: number;
  account: string;
  displayName: string;
  description: string;
  depends: string[];
};
export type ServiceReceipt = {
  id: string;
  name: string;
  displayName: string;
  installedAt: string;
  installedVersion: string;
  packageId: string;
  status: "registered" | "failed" | "removed";
  config?: ServiceReceiptConfig;
  owned?: boolean;
  error?: string;
};
export type ServiceEffect = {
  order: number;
  declaration: ServiceDeclaration;
  receipt: ServiceReceipt;
};
export type ShellEffect = {
  order: number;
  packageId: string;
  path: string;
  block: string;
};
export type FileEffect = {
  order: number;
  packageId: string;
  path: string;
  kind: "file" | "directory";
  before: EffectValue;
  after: EffectValue;
};
export type AdminEffect = {
  install?: AdminReceipt;
  remove?: AdminReceipt;
  declaration?: AdminDeclaration;
  contentHash?: string;
};
export type InstallReceipt = {
  packageId: string;
  installedAt: string;
  version: string;
  desktop?: (DesktopReceipt & { order: number })[];
  shell?: ShellEffect[];
  startMenu?: (StartMenuReceipt & { order: number })[];
  service?: ServiceEffect[];
  admin?: AdminEffect & { order?: number };
  bootstrap?: (BootstrapReceipt & { order: number })[];
  files?: FileEffect[];
};
export type AdminDeclaration = {
  required?: boolean;
  install: ExecDeclaration;
  remove: ExecDeclaration;
};
export type EffectTarget =
  | { kind: "registry"; key: string; name: string }
  | { kind: "file"; path: string; font?: boolean };
export type EffectValue =
  | null
  | { hash: string }
  | {
      type: "String" | "ExpandString" | "DWord" | "MultiString";
      value: string | number | string[];
    };
export type Effect = {
  target: EffectTarget;
  before: EffectValue;
  after: EffectValue;
  pathEntries?: string[];
};
export type DesktopReceipt = {
  id: string;
  declaration: DesktopDeclaration;
  effects: Effect[];
  binding: string;
};
export type BootstrapReceipt = {
  binding: string;
  at: string;
  status: "running" | "failed" | "completed";
  error?: string;
};
export type AdminReceipt = BootstrapReceipt & {
  id: string;
  action: "install" | "remove";
};
export type ShellIntegration = { powershell?: string; bash?: string };
export type ProfileIntegration = {
  shell?: "powershell" | "bash";
  path: string;
  block: string;
  approvals: Record<string, { binding: string }>;
};
export type PersistentFile = { mode: "hardlink" | "seed"; initial: string };
export type PersistDeclaration =
  string | ({ path: string; kind: "file" } & PersistentFile);
export type ConfigTemplate = { text: string };
/** Historical provenance is retained verbatim for installed receipt verification.
 * New configured sources are HTTP-only (npm is an internal provider); git/ref/
 * commit remain readable solely to list/remove/uninstall legacy installations.
 */
export type Source = {
  alias: string;
  url: string;
  type: "http" | "git" | "npm";
  ref?: string;
  commit?: string;
  identity: string;
  fetchedAt?: string;
};
export type ScriptApproval = { binding: string; approvedAt: string };
export type NpmBuild = {
  inputHash: string;
  currentHash: string;
  approvals: Record<string, ScriptApproval>;
  lastRun?: { at: string; node: string; npm: string; paths: string[] };
};
export type Install = {
  layout?: import("./layout.ts").PackageLayout;
  id: string;
  key: string;
  name: string;
  version: string;
  request: string;
  source: Source;
  dir: string;
  bins: Record<string, Bin>;
  persist: string[];
  persistFiles?: Record<string, PersistentFile>;
  verified: boolean;
  checksum: string;
  kind: "portable" | "npm";
  manifestHash: string;
  runtimeVersion?: string;
  enginesNode?: string;
  npmCompatibility?: import("./npm-runtime.ts").NpmCompatibility;
  env?: Record<string, string>;
  shell?: ShellIntegration;
  desktop?: DesktopDeclaration;
  bootstrap?: BootstrapDeclaration;
  admin?: AdminDeclaration;
  services?: ServiceDeclaration[];
  depends?: Dependency[];
  npmBuild?: NpmBuild;
  scripts?: {
    path: string;
    name: string;
    version: string;
    integrity?: string;
    resolved?: string;
    events: Record<string, string>;
  }[];
};
export type Selection = { id: string; request: string; commands?: string[] };
export type CommandAlias = { key: string; command: string };
export type PersistentData = {
  layout?: import("./layout.ts").PackageLayout;
  name: string;
  source: Source;
  paths: string[];
  files?: Record<string, PersistentFile>;
};
export type StartMenuReceipt = {
  id: string;
  entries: { name: string; hash: string }[];
};
export type State = {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  revision: number;
  sources: Record<string, Source>;
  installs: Record<string, Install>;
  defaults: Record<string, Selection>;
  commands: Record<string, string>;
  aliases?: Record<string, CommandAlias>;
  receipts?: Record<string, InstallReceipt>;
  services?: Record<string, ServiceReceipt>;
  data?: Record<string, PersistentData>;
  profiles?: Record<string, ProfileIntegration>;
  startMenu?: Record<string, StartMenuReceipt>;
  desktop?: Record<string, DesktopReceipt>;
  bootstraps?: Record<string, BootstrapReceipt>;
  admin?: Record<string, AdminReceipt>;
};
export type Dependency = {
  package: string;
  commands?: string[];
};
export type ArchiveFormat =
  | "zip"
  | "7z"
  | "tar"
  | "tar.gz"
  | "tar.xz"
  | "inno"
  | "msi"
  | "burn"
  | "nsis"
  | "pe";
export type NestedArchive = {
  path: string;
  format: "zip" | "7z" | "7z#";
  stripPrefix?: string;
};
export type Download = {
  url: string;
  cabinets?: Record<string, { url: string; sha256: string; maxBytes?: number }>;
  // WiX Burn bundles chain several packages; only this manifest-declared
  // payload id is extracted, and it must be an MSI.
  payload?: string;
  sha256?: string;
  format: "file" | ArchiveFormat;
  files?: Record<string, string>;
  nested?: NestedArchive[];
  maxBytes?: number;
  file?: string;
  stripPrefix?: string;
  into?: string;
  // Only a later combined download may overlay: its extraction replaces
  // file paths already written by earlier downloads instead of failing.
  overlay?: boolean;
};
export type Distribution = {
  bin: Record<string, string | Bin>;
  depends?: Dependency[];
  env?: Record<string, string>;
  persist?: PersistDeclaration[];
  configTemplates?: Record<string, ConfigTemplate>;
  configFiles?: Record<string, string>;
  shell?: ShellIntegration;
  desktop?: DesktopDeclaration;
  bootstrap?: BootstrapDeclaration;
  admin?: AdminDeclaration;
  services?: ServiceDeclaration[];
  maxExpandedBytes?: number;
} & (
  | (Download & { downloads?: never })
  | {
      downloads: Download[];
      files?: never;
      nested?: never;
      maxBytes?: never;
      url?: never;
      sha256?: never;
      format?: never;
      file?: never;
      stripPrefix?: never;
      into?: never;
    }
);
export type Manifest = {
  schemaVersion: 1;
  name: string;
  version: string;
  platforms: Record<string, Distribution>;
};
export type CatalogPackage = {
  latest: string;
  versions: Record<string, string>;
  aliases?: Record<string, string>;
  runtime?: { family: string; distribution: string };
};
export type Index = {
  schemaVersion: 1;
  packages: Record<string, CatalogPackage>;
};
