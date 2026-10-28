export type Bin = { path: string; kind: "native" | "node" };
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
  id: string;
  key: string;
  name: string;
  version: string;
  request: string;
  source: Source;
  dir: string;
  bins: Record<string, Bin>;
  persist: string[];
  verified: boolean;
  checksum: string;
  kind: "portable" | "npm";
  manifestHash: string;
  runtimeVersion?: string;
  enginesNode?: string;
  env?: Record<string, string>;
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
export type PersistentData = { name: string; source: Source; paths: string[] };
export type State = {
  schemaVersion: 1 | 2 | 3 | 4;
  revision: number;
  sources: Record<string, Source>;
  installs: Record<string, Install>;
  defaults: Record<string, Selection>;
  commands: Record<string, string>;
  aliases?: Record<string, CommandAlias>;
  data?: Record<string, PersistentData>;
};
export type Manifest = {
  schemaVersion: 1;
  name: string;
  version: string;
  platforms: Record<
    string,
    {
      url: string;
      sha256?: string;
      format: "file" | "zip";
      file?: string;
      stripPrefix?: string;
      bin: Record<string, string | Bin>;
      env?: Record<string, string>;
      persist?: string[];
    }
  >;
};
export type Index = {
  schemaVersion: 1;
  packages: Record<
    string,
    { latest: string; versions: Record<string, string> }
  >;
};
