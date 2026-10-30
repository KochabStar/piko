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
  kind?: "native" | "powershell";
};
export type BootstrapDeclaration = ExecDeclaration & { outputs: string[] };
export type AdminDeclaration = {
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
export type Source = {
  alias: string;
  url: string;
  type: "http" | "git" | "npm";
  ref?: string;
  commit?: string;
  identity: string;
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
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  revision: number;
  sources: Record<string, Source>;
  installs: Record<string, Install>;
  defaults: Record<string, Selection>;
  commands: Record<string, string>;
  aliases?: Record<string, CommandAlias>;
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
  "zip" | "7z" | "tar" | "tar.gz" | "tar.xz" | "inno" | "msi" | "nsis" | "pe";
export type NestedArchive = {
  path: string;
  format: "zip" | "7z";
  stripPrefix?: string;
};
export type Download = {
  url: string;
  cabinets?: Record<string, { url: string; sha256: string; maxBytes?: number }>;
  sha256?: string;
  format: "file" | ArchiveFormat;
  files?: Record<string, string>;
  nested?: NestedArchive[];
  maxBytes?: number;
  file?: string;
  stripPrefix?: string;
  into?: string;
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
