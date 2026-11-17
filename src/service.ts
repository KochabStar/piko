import { lstat } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { capture, fail, inside, noLinks, record } from "./util.ts";
import { verifyInstall } from "./desktop.ts";
import { parseSpec } from "./catalog.ts";
import { recordOperationState } from "./journal.ts";
import {
  serviceNameKey,
  validateServices,
  validateServiceReceipt,
} from "./service-declarations.ts";
import type {
  Install,
  ServiceDeclaration,
  ServiceEffect,
  ServiceReceipt,
  ServiceReceiptConfig,
  State,
} from "./types.ts";
import type { Store } from "./store.ts";

export type ServiceSnapshot = { config: ServiceReceiptConfig; state: number };
export interface ServiceBackend {
  isAdmin(): Promise<boolean>;
  query(name: string): Promise<ServiceSnapshot | undefined>;
  // Atomic creation only. Description is deliberately a separate, receipted step.
  create(name: string, config: ServiceReceiptConfig): Promise<void>;
  describe(name: string, description: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  delete(name: string): Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}
export type ServiceRow = {
  packageId: string;
  package: string;
  source: string;
  version: string;
  name: string;
  displayName: string;
  state?: number;
  status: string;
  receiptStatus?: ServiceReceipt["status"];
  owned: boolean;
  error?: string;
};
const statuses: Record<number, string> = {
  1: "stopped",
  2: "start-pending",
  3: "stop-pending",
  4: "running",
  5: "continue-pending",
  6: "pause-pending",
  7: "paused",
};
const receiptId = (install: Install, name: string) =>
  `${install.id}/${serviceNameKey(name)}`;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function quoteServiceArgument(value: string): string {
  let result = '"',
    slashes = 0;
  for (const character of value) {
    if (character === "\\") slashes++;
    else {
      result +=
        "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
      slashes = 0;
    }
  }
  return result + "\\".repeat(slashes * 2) + '"';
}
function expectedConfig(
  root: string,
  install: Install,
  declaration: ServiceDeclaration,
): ServiceReceiptConfig {
  const directory = inside(root, resolve(root, install.dir));
  const executable = inside(directory, resolve(directory, declaration.binPath));
  const binaryPath = [executable, ...(declaration.args ?? [])]
    .map(quoteServiceArgument)
    .join(" ");
  if (binaryPath.length > 32766)
    fail("Service command line exceeds Windows limit");
  return {
    binaryPath,
    startType: { auto: 2, demand: 3, disabled: 4 }[declaration.startType],
    serviceType: 16,
    errorControl: 1,
    account: "LocalSystem",
    displayName: declaration.displayName,
    description: declaration.description ?? "",
    depends: [...(declaration.depends ?? [])].map(serviceNameKey).sort(),
  };
}
function sameConfig(
  left: ServiceReceiptConfig,
  right: ServiceReceiptConfig,
): boolean {
  return (
    left.binaryPath === right.binaryPath &&
    left.startType === right.startType &&
    left.serviceType === right.serviceType &&
    left.errorControl === right.errorControl &&
    left.account.toLowerCase() === right.account.toLowerCase() &&
    left.displayName === right.displayName &&
    left.description === right.description &&
    JSON.stringify(left.depends.map(serviceNameKey).sort()) ===
      JSON.stringify(right.depends.map(serviceNameKey).sort())
  );
}
function assertOwned(snapshot: ServiceSnapshot, receipt: ServiceReceipt): void {
  validateServiceReceipt(receipt);
  if (
    !receipt.owned ||
    receipt.status === "removed" ||
    !receipt.config ||
    !sameConfig(snapshot.config, receipt.config)
  )
    fail(`Refusing foreign or configuration-drifted service: ${receipt.name}`);
}
function ordered(declarations: ServiceDeclaration[]): ServiceDeclaration[] {
  validateServices(declarations);
  const byName = new Map(
    declarations.map((declaration) => [
      serviceNameKey(declaration.name),
      declaration,
    ]),
  );
  const result: ServiceDeclaration[] = [],
    visited = new Set<string>();
  function visit(declaration: ServiceDeclaration) {
    const key = serviceNameKey(declaration.name);
    if (visited.has(key)) return;
    visited.add(key);
    for (const dependency of declaration.depends ?? []) {
      const local = byName.get(serviceNameKey(dependency));
      if (local) visit(local);
    }
    result.push(declaration);
  }
  for (const declaration of declarations) visit(declaration);
  return result;
}
function saveReceipt(
  state: State,
  install: Install,
  declaration: ServiceDeclaration,
  receipt: ServiceReceipt,
): void {
  (state.services ??= {})[receipt.id] = receipt;
  const parent = ((state.receipts ??= {})[install.id] ??= {
    packageId: install.id,
    version: install.version,
    installedAt: receipt.installedAt,
  });
  const effects = (parent.service ??= []);
  const existing = effects.find((effect) => effect.receipt.id === receipt.id);
  if (existing) {
    existing.receipt = receipt;
    existing.declaration = structuredClone(declaration);
  } else {
    const prior = [
      ...(parent.desktop ?? []),
      ...(parent.shell ?? []),
      ...(parent.startMenu ?? []),
      ...effects,
      ...(parent.bootstrap ?? []),
      ...(parent.files ?? []),
    ];
    const order =
      Math.max(
        -1,
        ...prior.map((effect) => effect.order),
        parent.admin?.order ?? -1,
      ) + 1;
    effects.push({ order, declaration: structuredClone(declaration), receipt });
  }
}
function ownedEffects(state: State, install: Install): ServiceEffect[] {
  const effects = state.receipts?.[install.id]?.service ?? [];
  for (const effect of effects) {
    validateServices([effect.declaration]);
    validateServiceReceipt(effect.receipt);
    if (
      effect.receipt.packageId !== install.id ||
      effect.receipt.id !== receiptId(install, effect.declaration.name)
    )
      fail("Service receipt identity differs from installation");
    const current = state.services?.[effect.receipt.id];
    if (current && JSON.stringify(current) !== JSON.stringify(effect.receipt))
      fail("Service ownership receipts disagree");
  }
  return [...effects].sort((a, b) => b.order - a.order);
}
async function requireAdmin(backend: ServiceBackend): Promise<void> {
  if (!(await backend.isAdmin()))
    fail(
      "Open an Administrator terminal manually to manage services; Piko never requests UAC",
    );
}
async function transition(
  backend: ServiceBackend,
  receipt: ServiceReceipt,
  target: 1 | 4,
): Promise<void> {
  let snapshot = await backend.query(receipt.name);
  if (!snapshot) fail(`Service is missing: ${receipt.name}`);
  assertOwned(snapshot, receipt);
  if (snapshot.state === target) return;
  if (target === 4 && snapshot.config.startType === 4)
    fail("Disabled services cannot be started");
  if (snapshot.state !== (target === 1 ? 3 : 2)) {
    if (target === 1) await backend.stop(receipt.name);
    else await backend.start(receipt.name);
  }
  const deadline = Date.now() + (backend.timeoutMs ?? 30000);
  for (;;) {
    snapshot = await backend.query(receipt.name);
    if (!snapshot)
      fail(`Service disappeared during state transition: ${receipt.name}`);
    assertOwned(snapshot, receipt);
    if (snapshot.state === target) return;
    if (target === 4 && snapshot.state === 1)
      fail(`Service failed to start: ${receipt.name}`);
    if (Date.now() >= deadline)
      fail(
        `Service transition timed out: ${receipt.name} (state ${snapshot.state})`,
      );
    await Bun.sleep(backend.pollMs ?? 200);
  }
}
async function removeOwned(
  backend: ServiceBackend,
  receipt: ServiceReceipt,
  stop: boolean,
): Promise<void> {
  let snapshot = await backend.query(receipt.name);
  if (!snapshot) {
    receipt.status = "removed";
    receipt.owned = false;
    delete receipt.error;
    return;
  }
  assertOwned(snapshot, receipt);
  if (snapshot.state !== 1) {
    if (!stop) fail(`Service must be stopped before deletion: ${receipt.name}`);
    await transition(backend, receipt, 1);
  }
  snapshot = await backend.query(receipt.name);
  if (snapshot) {
    assertOwned(snapshot, receipt);
    await backend.delete(receipt.name);
  }
  const deadline = Date.now() + (backend.timeoutMs ?? 30000);
  while (await backend.query(receipt.name)) {
    if (Date.now() >= deadline)
      fail(`Service is still present or marked for deletion: ${receipt.name}`);
    await Bun.sleep(backend.pollMs ?? 200);
  }
  receipt.status = "removed";
  receipt.owned = false;
  delete receipt.error;
}

// Constant source only; every service name/config enters via JSON, never source interpolation.
const queryScript = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIKO_SERVICE_REQUEST)) | ConvertFrom-Json
if ($p.op -eq 'admin') {
 [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress
 exit
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PikoScm {
 [StructLayout(LayoutKind.Sequential)] struct Config { public uint type,start,error; public IntPtr binary,group; public uint tag; public IntPtr dependencies,account,display; }
 [StructLayout(LayoutKind.Sequential)] struct Status { public uint type,state,controls,win32Exit,specificExit,checkpoint,waitHint,pid,flags; }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,EntryPoint="QueryServiceConfigW",SetLastError=true)] static extern bool QueryConfig(IntPtr service,IntPtr buffer,uint size,out uint needed);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,EntryPoint="QueryServiceConfig2W",SetLastError=true)] static extern bool QueryConfig2(IntPtr service,uint level,IntPtr buffer,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int level,out Status status,int size,out int needed);
 [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
 static string Text(IntPtr value) { return value==IntPtr.Zero ? "" : Marshal.PtrToStringUni(value); }
 public static object Query(string name) {
  IntPtr manager=OpenSCManager(null,null,1); if(manager==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   IntPtr service=OpenService(manager,name,5);
   if(service==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==1060) return null; throw new Win32Exception(error); }
   try {
    uint needed; QueryConfig(service,IntPtr.Zero,0,out needed);
    if(needed==0 || needed>1048576) throw new InvalidOperationException("Invalid SCM configuration size");
    IntPtr buffer=Marshal.AllocHGlobal((int)needed);
    try {
     if(!QueryConfig(service,buffer,needed,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
     Config config=(Config)Marshal.PtrToStructure(buffer,typeof(Config));
     List<string> depends=new List<string>(); IntPtr cursor=config.dependencies;
     while(cursor!=IntPtr.Zero) { string dependency=Text(cursor); if(dependency.Length==0) break; depends.Add(dependency); cursor=IntPtr.Add(cursor,(dependency.Length+1)*2); }
     Status status; int statusSize; if(!QueryServiceStatusEx(service,0,out status,Marshal.SizeOf(typeof(Status)),out statusSize)) throw new Win32Exception(Marshal.GetLastWin32Error());
     uint descriptionSize; QueryConfig2(service,1,IntPtr.Zero,0,out descriptionSize);
     if(descriptionSize==0 || descriptionSize>1048576) throw new InvalidOperationException("Invalid SCM description size");
     IntPtr description=Marshal.AllocHGlobal((int)descriptionSize);
     try {
      if(!QueryConfig2(service,1,description,descriptionSize,out descriptionSize)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new { state=status.state, config=new { binaryPath=Text(config.binary),startType=config.start,serviceType=config.type,errorControl=config.error,account=Text(config.account),displayName=Text(config.display),description=Text(Marshal.ReadIntPtr(description)),depends=depends.ToArray() } };
     } finally { Marshal.FreeHGlobal(description); }
    } finally { Marshal.FreeHGlobal(buffer); }
   } finally { CloseServiceHandle(service); }
  } finally { CloseServiceHandle(manager); }
 }
}
'@
try { $result = [PikoScm]::Query([string]$p.name); if ($null -eq $result) { [Console]::Out.WriteLine('null') } else { ConvertTo-Json -InputObject $result -Compress -Depth 5 } }
catch { $e=$_.Exception; while($e.InnerException){$e=$e.InnerException}; if($e -is [ComponentModel.Win32Exception]) { [Console]::Error.WriteLine('SCM error '+$e.NativeErrorCode); exit $e.NativeErrorCode }; throw }
`;
export class WindowsServiceBackend implements ServiceBackend {
  private systemExecutable(name: string): string {
    if (process.platform !== "win32")
      fail("Windows SCM is only available on Windows");
    const root = process.env.SystemRoot ?? "C:\\Windows";
    if (!/^[A-Za-z]:[\\/]/.test(root))
      fail("SystemRoot must be an absolute local Windows directory");
    return win32.join(root, "System32", name);
  }
  private async request(request: {
    op: "admin" | "query";
    name?: string;
  }): Promise<unknown> {
    const executable = this.systemExecutable(
      "WindowsPowerShell/v1.0/powershell.exe",
    );
    const output = await capture(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(queryScript, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          PIKO_SERVICE_REQUEST: Buffer.from(JSON.stringify(request)).toString(
            "base64",
          ),
        },
      },
    );
    return JSON.parse(output);
  }
  async isAdmin(): Promise<boolean> {
    return (await this.request({ op: "admin" })) === true;
  }
  async query(name: string): Promise<ServiceSnapshot | undefined> {
    const value = await this.request({ op: "query", name });
    if (value === null) return undefined;
    if (
      !record(value) ||
      !record(value.config) ||
      !Number.isInteger(value.state) ||
      typeof value.state !== "number" ||
      value.state < 1 ||
      value.state > 7
    )
      fail("Invalid SCM status response");
    const config = value.config;
    for (const key of ["binaryPath", "account", "displayName", "description"])
      if (typeof config[key] !== "string")
        fail("Invalid SCM configuration response");
    for (const key of ["startType", "serviceType", "errorControl"])
      if (typeof config[key] !== "number" || !Number.isInteger(config[key]))
        fail("Invalid SCM numeric configuration");
    if (
      !Array.isArray(config.depends) ||
      config.depends.some((dependency) => typeof dependency !== "string")
    )
      fail("Invalid SCM dependencies response");
    return {
      state: value.state,
      config: {
        binaryPath: config.binaryPath as string,
        account: config.account as string,
        displayName: config.displayName as string,
        description: config.description as string,
        startType: config.startType as number,
        serviceType: config.serviceType as number,
        errorControl: config.errorControl as number,
        depends: config.depends as string[],
      },
    };
  }
  async create(name: string, config: ServiceReceiptConfig): Promise<void> {
    const args = [
      "create",
      name,
      "type=",
      "own",
      "start=",
      config.startType === 2
        ? "auto"
        : config.startType === 4
          ? "disabled"
          : "demand",
      "error=",
      "normal",
      "binPath=",
      config.binaryPath,
      "obj=",
      "LocalSystem",
      "DisplayName=",
      config.displayName,
    ];
    if (config.depends.length) args.push("depend=", config.depends.join("/"));
    await capture(this.systemExecutable("sc.exe"), args);
  }
  async describe(name: string, description: string): Promise<void> {
    await capture(this.systemExecutable("sc.exe"), [
      "description",
      name,
      description,
    ]);
  }
  async start(name: string): Promise<void> {
    await capture(this.systemExecutable("sc.exe"), ["start", name]);
  }
  async stop(name: string): Promise<void> {
    await capture(this.systemExecutable("sc.exe"), ["stop", name]);
  }
  async delete(name: string): Promise<void> {
    await capture(this.systemExecutable("sc.exe"), ["delete", name]);
  }
}

export async function registerServices(
  store: Store,
  state: State,
  install: Install,
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<void> {
  const declarations = ordered(install.services ?? []);
  if (!declarations.length) return;
  await requireAdmin(backend);
  await verifyInstall(store.root, install);
  const plans: {
    declaration: ServiceDeclaration;
    config: ServiceReceiptConfig;
    prior?: ServiceReceipt;
    snapshot?: ServiceSnapshot;
  }[] = [];
  for (const declaration of declarations) {
    const directory = inside(store.root, resolve(store.root, install.dir));
    const executable = inside(
      directory,
      resolve(directory, declaration.binPath),
    );
    await noLinks(executable);
    if (!(await lstat(executable)).isFile())
      fail("Service executable is not a regular package file");
    const config = expectedConfig(store.root, install, declaration);
    for (const owner of Object.values(state.services ?? {}))
      if (
        serviceNameKey(owner.name) === serviceNameKey(declaration.name) &&
        owner.packageId !== install.id &&
        owner.owned &&
        owner.status !== "removed"
      )
        fail(
          `Service name is owned by another installation: ${declaration.name}`,
        );
    const prior = state.services?.[receiptId(install, declaration.name)],
      snapshot = await backend.query(declaration.name);
    if (snapshot) {
      if (!prior)
        fail(`Refusing an existing foreign service: ${declaration.name}`);
      assertOwned(snapshot, prior);
      const partial = {
        ...config,
        description: prior.config?.description ?? "",
      };
      if (
        !sameConfig(snapshot.config, partial) ||
        !["", config.description].includes(snapshot.config.description)
      )
        fail("Service configuration differs from the installation receipt");
    }
    plans.push({ declaration, config, prior, snapshot });
  }
  const created: {
    declaration: ServiceDeclaration;
    receipt: ServiceReceipt;
  }[] = [];
  let active:
    { declaration: ServiceDeclaration; receipt: ServiceReceipt } | undefined;
  try {
    for (const plan of plans) {
      const { declaration, config } = plan;
      const receipt: ServiceReceipt =
        plan.snapshot && plan.prior
          ? structuredClone(plan.prior)
          : {
              id: receiptId(install, declaration.name),
              name: declaration.name,
              displayName: declaration.displayName,
              installedAt: new Date().toISOString(),
              installedVersion: install.version,
              packageId: install.id,
              status: "failed",
              config: { ...config, description: "" },
              owned: false,
            };
      active = { declaration, receipt };
      saveReceipt(state, install, declaration, receipt);
      await recordOperationState(store, state);
      if (!plan.snapshot) {
        await backend.create(declaration.name, receipt.config!);
        receipt.owned = true;
        created.push(active);
        await recordOperationState(store, state);
      }
      const current = await backend.query(declaration.name);
      if (!current) fail("Service disappeared after registration");
      assertOwned(current, receipt);
      if (receipt.config!.description !== config.description) {
        await backend.describe(declaration.name, config.description);
        receipt.config = config;
        await recordOperationState(store, state);
      }
      const configured = await backend.query(declaration.name);
      if (!configured || !sameConfig(configured.config, config))
        fail("SCM did not retain the requested service configuration");
      receipt.status = "registered";
      delete receipt.error;
      if (declaration.startAfterInstall) await transition(backend, receipt, 4);
      await recordOperationState(store, state);
    }
  } catch (error) {
    if (active) {
      active.receipt.status = "failed";
      active.receipt.error = errorText(error);
    }
    const failures: string[] = [];
    for (const entry of created.reverse()) {
      try {
        await removeOwned(backend, entry.receipt, true);
        entry.receipt.status = "failed";
        entry.receipt.error = errorText(error);
      } catch (compensation) {
        entry.receipt.status = "failed";
        entry.receipt.error = `${errorText(error)}; compensation: ${errorText(compensation)}`;
        failures.push(errorText(compensation));
      }
      saveReceipt(state, install, entry.declaration, entry.receipt);
    }
    await recordOperationState(store, state);
    if (failures.length)
      fail(
        `${errorText(error)}; service compensation failed: ${failures.join("; ")}`,
      );
    throw error;
  }
}
export async function preflightUnregisterServices(
  _store: Store,
  state: State,
  install: Install,
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<void> {
  const effects = ownedEffects(state, install).filter(
    (effect) => effect.receipt.status !== "removed",
  );
  if (!effects.length) return;
  await requireAdmin(backend);
  for (const { declaration, receipt } of effects) {
    const snapshot = await backend.query(receipt.name);
    if (!snapshot) continue;
    assertOwned(snapshot, receipt);
    if (declaration.stopBeforeUninstall === false && snapshot.state !== 1)
      fail(`Service must already be stopped: ${receipt.name}`);
  }
}
export async function unregisterServices(
  store: Store,
  state: State,
  install: Install,
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<void> {
  await preflightUnregisterServices(store, state, install, backend);
  for (const { declaration, receipt } of ownedEffects(state, install)) {
    if (receipt.status === "removed") continue;
    try {
      await removeOwned(
        backend,
        receipt,
        declaration.stopBeforeUninstall !== false,
      );
      saveReceipt(state, install, declaration, receipt);
      await recordOperationState(store, state);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorText(error);
      saveReceipt(state, install, declaration, receipt);
      await recordOperationState(store, state);
      throw error;
    }
  }
}
function matchingInstall(state: State, spec: string): Install {
  const parsed = parseSpec(spec);
  const matches = Object.values(state.installs).filter(
    (install) =>
      install.name === parsed.name &&
      (!parsed.source || install.source.alias === parsed.source),
  );
  if (new Set(matches.map((install) => install.key)).size !== 1)
    fail(
      "Unknown or ambiguous service package; specify source/package@version",
    );
  if (parsed.request) {
    const exact = matches.filter(
      (install) => install.version === parsed.request,
    );
    if (exact.length !== 1)
      fail(
        "Unknown or ambiguous installed service version; specify an exact version",
      );
    return exact[0]!;
  }
  if (matches.length === 1) return matches[0]!;
  const selected = matches.filter(
    (install) => state.defaults[install.key]?.id === install.id,
  );
  if (selected.length !== 1)
    fail("Service version is ambiguous; specify source/package@version");
  return selected[0]!;
}
async function rowsFor(
  state: State,
  installs: Install[],
  backend: ServiceBackend,
): Promise<ServiceRow[]> {
  const rows: ServiceRow[] = [];
  for (const install of installs) {
    const effects = ownedEffects(state, install);
    const names = new Map(
      (install.services ?? []).map((declaration) => [
        serviceNameKey(declaration.name),
        declaration,
      ]),
    );
    for (const effect of effects)
      names.set(serviceNameKey(effect.declaration.name), effect.declaration);
    for (const declaration of names.values()) {
      const receipt =
        state.services?.[receiptId(install, declaration.name)] ??
        effects.find(
          (effect) =>
            serviceNameKey(effect.declaration.name) ===
            serviceNameKey(declaration.name),
        )?.receipt;
      const row: ServiceRow = {
        packageId: install.id,
        package: install.name,
        source: install.source.alias,
        version: install.version,
        name: declaration.name,
        displayName: declaration.displayName,
        status: "missing",
        receiptStatus: receipt?.status,
        owned: false,
        ...(receipt?.error ? { error: receipt.error } : {}),
      };
      try {
        const snapshot = await backend.query(declaration.name);
        if (snapshot) {
          row.state = snapshot.state;
          row.status = statuses[snapshot.state] ?? "unknown";
          if (receipt) {
            try {
              assertOwned(snapshot, receipt);
              row.owned = true;
            } catch (error) {
              row.error = errorText(error);
            }
          } else row.error = "Existing service has no Piko ownership receipt";
        }
      } catch (error) {
        row.status = "error";
        row.error = errorText(error);
      }
      rows.push(row);
    }
  }
  return rows;
}
export async function serviceRows(
  store: Store,
  spec?: string,
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<ServiceRow[]> {
  const state = await store.read();
  return await rowsFor(
    state,
    spec ? [matchingInstall(state, spec)] : Object.values(state.installs),
    backend,
  );
}
export async function controlService(
  store: Store,
  spec: string,
  action: "start" | "stop" | "restart" | "status",
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<ServiceRow[]> {
  if (action === "status") return await serviceRows(store, spec, backend);
  if (!["start", "stop", "restart"].includes(action))
    fail("Invalid service action");
  const result = await store.mutate(
    async (state) => {
      const install = matchingInstall(state, spec),
        effects = ownedEffects(state, install).filter(
          (effect) => effect.receipt.status !== "removed",
        );
      if (!effects.length) fail("Package has no registered Piko services");
      await requireAdmin(backend);
      if (action !== "stop") await verifyInstall(store.root, install);
      if (action !== "stop") {
        for (const { declaration, receipt } of effects) {
          const directory = inside(
            store.root,
            resolve(store.root, install.dir),
          );
          const executable = inside(
            directory,
            resolve(directory, declaration.binPath),
          );
          await noLinks(executable);
          if (
            !(await lstat(executable)).isFile() ||
            !receipt.config ||
            !sameConfig(
              receipt.config,
              expectedConfig(store.root, install, declaration),
            )
          )
            fail(
              "Service executable or saved configuration differs from the verified installation",
            );
        }
      }
      for (const { receipt } of effects) {
        const snapshot = await backend.query(receipt.name);
        if (!snapshot) fail(`Service is missing: ${receipt.name}`);
        assertOwned(snapshot, receipt);
        if (action !== "stop" && snapshot.config.startType === 4)
          fail("Disabled services cannot be started");
      }
      const phases: { effects: ServiceEffect[]; target: 1 | 4 }[] =
        action === "restart"
          ? [
              { effects, target: 1 },
              { effects: [...effects].reverse(), target: 4 },
            ]
          : [
              {
                effects: action === "start" ? [...effects].reverse() : effects,
                target: action === "stop" ? 1 : 4,
              },
            ];
      let failure: string | undefined;
      for (const phase of phases) {
        for (const { declaration, receipt } of phase.effects) {
          try {
            await transition(backend, receipt, phase.target);
            receipt.status = "registered";
            delete receipt.error;
          } catch (error) {
            receipt.status = "failed";
            receipt.error = errorText(error);
            failure = receipt.error;
          }
          saveReceipt(state, install, declaration, receipt);
          if (failure) break;
        }
        if (failure) break;
      }
      return { rows: await rowsFor(state, [install], backend), failure };
    },
    { skipUnchanged: true },
  );
  if (result.failure) fail(result.failure);
  return result.rows;
}

type RecoveryService = {
  install: Install;
  declaration: ServiceDeclaration;
  receipt: ServiceReceipt;
  order: number;
};
function recoveryServices(state: State): Map<string, RecoveryService[]> {
  const names = new Map<string, RecoveryService[]>(),
    ids = new Set<string>();
  for (const install of Object.values(state.installs)) {
    for (const effect of ownedEffects(state, install)) {
      const key = serviceNameKey(effect.receipt.name),
        entries = names.get(key) ?? [];
      if (ids.has(effect.receipt.id))
        fail("Duplicate service recovery receipt");
      ids.add(effect.receipt.id);
      entries.push({
        install,
        declaration: effect.declaration,
        receipt: effect.receipt,
        order: effect.order,
      });
      names.set(key, entries);
    }
  }
  for (const receipt of Object.values(state.services ?? {})) {
    validateServiceReceipt(receipt);
    if (!ids.has(receipt.id))
      fail("Service recovery requires a complete install ownership receipt");
  }
  for (const entries of names.values())
    if (
      entries.filter(
        (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
      ).length > 1
    )
      fail("Conflicting owners in service recovery state");
  return names;
}

/** Restore only journal-proven SCM effects; the caller restores package files first. */
export async function restoreOperationServices(
  store: Store,
  current: State,
  target: State,
  backend: ServiceBackend = new WindowsServiceBackend(),
): Promise<void> {
  const currentNames = recoveryServices(current),
    targetNames = recoveryServices(target);
  const names = new Set([...currentNames.keys(), ...targetNames.keys()]);
  type Plan = {
    key: string;
    from?: RecoveryService;
    to?: RecoveryService;
    snapshot?: ServiceSnapshot;
    owner?: RecoveryService;
    remove: boolean;
  };
  const touched: {
    key: string;
    before: RecoveryService[];
    after: RecoveryService[];
  }[] = [];
  for (const key of names) {
    const before = currentNames.get(key) ?? [],
      after = targetNames.get(key) ?? [];
    const signature = (entries: RecoveryService[]) =>
      JSON.stringify(
        entries
          .map((entry) => ({
            receipt: entry.receipt,
            declaration: entry.declaration,
          }))
          .sort((a, b) => a.receipt.id.localeCompare(b.receipt.id)),
      );
    const ambiguousCreate = before.some(
      (entry) =>
        entry.receipt.status === "failed" && entry.receipt.owned !== true,
    );
    if (signature(before) !== signature(after) || ambiguousCreate)
      touched.push({ key, before, after });
  }
  if (!touched.length) return;
  await requireAdmin(backend);
  const plans: Plan[] = [];
  // Complete preflight first: a later foreign name must prevent earlier writes too.
  for (const { key, before, after } of touched) {
    const from = before.find(
      (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
    );
    const to = after.find(
      (entry) => entry.receipt.owned && entry.receipt.status !== "removed",
    );
    const snapshot = await backend.query(
      (from ?? to ?? before[0] ?? after[0])!.receipt.name,
    );
    // A saved create intent is not proof that CreateService succeeded. Even an
    // identical target config cannot close the create-to-ownership crash window.
    if (
      snapshot &&
      before.some(
        (entry) =>
          entry.receipt.status === "failed" && entry.receipt.owned !== true,
      )
    )
      fail(
        `Refusing foreign service with ambiguous create ownership; retain the blocked operation journal: ${key}`,
      );
    const owner = snapshot
      ? [from, to].find(
          (entry) =>
            entry?.receipt.config &&
            sameConfig(snapshot.config, entry.receipt.config),
        )
      : undefined;
    if (snapshot && !owner)
      fail(
        `Refusing foreign or configuration-drifted service during rollback: ${key}`,
      );
    if (snapshot && owner) assertOwned(snapshot, owner.receipt);
    if (to) {
      await verifyInstall(store.root, to.install);
      const directory = inside(store.root, resolve(store.root, to.install.dir));
      const executable = inside(
        directory,
        resolve(directory, to.declaration.binPath),
      );
      await noLinks(executable);
      if (!(await lstat(executable)).isFile() || !to.receipt.config)
        fail("Recovery service executable is unavailable");
      const expected = expectedConfig(store.root, to.install, to.declaration);
      const partial = {
        ...expected,
        description: to.receipt.config.description,
      };
      if (
        !sameConfig(to.receipt.config, partial) ||
        !["", expected.description].includes(to.receipt.config.description)
      )
        fail(
          "Recovery service configuration differs from its verified installation",
        );
      if (to.declaration.startAfterInstall && to.receipt.config.startType === 4)
        fail("Recovery cannot start a disabled service");
    }
    const remove =
      !!snapshot &&
      (!to?.receipt.config || !sameConfig(snapshot.config, to.receipt.config));
    if (
      remove &&
      owner?.declaration.stopBeforeUninstall === false &&
      snapshot?.state !== 1
    )
      fail(`Service must already be stopped before rollback: ${key}`);
    plans.push({ key, from, to, snapshot, owner, remove });
  }
  const persist = async (entry: RecoveryService, receipt: ServiceReceipt) => {
    if (!current.installs[entry.install.id])
      current.installs[entry.install.id] = structuredClone(entry.install);
    saveReceipt(current, entry.install, entry.declaration, receipt);
    await recordOperationState(store, current);
  };
  // Remove the new generation before restoring the old generation with the same name.
  for (const plan of [...plans].sort(
    (a, b) => (b.owner?.order ?? -1) - (a.owner?.order ?? -1),
  )) {
    if (!plan.remove && plan.snapshot) {
      if (plan.from && plan.to && plan.from.receipt.id !== plan.to.receipt.id) {
        const stale = {
          ...structuredClone(plan.from.receipt),
          status: "removed" as const,
          owned: false,
        };
        delete stale.error;
        await persist(plan.from, stale);
      }
      continue;
    }
    const entry = plan.owner ?? plan.from;
    if (!entry) continue;
    const receipt = structuredClone(entry.receipt);
    try {
      if (plan.remove)
        await removeOwned(
          backend,
          receipt,
          entry.declaration.stopBeforeUninstall !== false,
        );
      else {
        receipt.status = "removed";
        receipt.owned = false;
        delete receipt.error;
      }
      await persist(entry, receipt);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorText(error);
      await persist(entry, receipt);
      throw error;
    }
  }
  const desired = plans.filter(
    (plan): plan is Plan & { to: RecoveryService } => !!plan.to,
  );
  const byName = new Map(desired.map((plan) => [plan.key, plan]));
  const sequence: typeof desired = [],
    visited = new Set<string>();
  function visit(plan: (typeof desired)[number]) {
    if (visited.has(plan.key)) return;
    visited.add(plan.key);
    for (const dependency of plan.to.declaration.depends ?? []) {
      const local = byName.get(serviceNameKey(dependency));
      if (local) visit(local);
    }
    sequence.push(plan);
  }
  for (const plan of desired) visit(plan);
  for (const { to } of sequence) {
    const receipt = structuredClone(to.receipt),
      config = receipt.config!;
    try {
      const snapshot = await backend.query(receipt.name);
      if (snapshot) {
        assertOwned(snapshot, receipt);
        await persist(to, receipt);
      } else {
        receipt.status = "failed";
        receipt.owned = false;
        receipt.config = { ...config, description: "" };
        await persist(to, receipt);
        await backend.create(receipt.name, receipt.config);
        receipt.owned = true;
        await persist(to, receipt);
        const created = await backend.query(receipt.name);
        if (!created) fail("Recovery service disappeared after registration");
        assertOwned(created, receipt);
        if (config.description) {
          await backend.describe(receipt.name, config.description);
          receipt.config = config;
          await persist(to, receipt);
        }
      }
      const configured = await backend.query(receipt.name);
      if (!configured || !sameConfig(configured.config, config))
        fail("Recovery SCM configuration did not match its target receipt");
      if (to.declaration.startAfterInstall)
        await transition(backend, receipt, 4);
      receipt.status = to.receipt.status;
      if (to.receipt.error === undefined) delete receipt.error;
      else receipt.error = to.receipt.error;
      await persist(to, receipt);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = errorText(error);
      await persist(to, receipt);
      throw error;
    }
  }
}
