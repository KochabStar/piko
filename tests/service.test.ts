import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateServiceReceipt,
  validateServices,
} from "../src/service-declarations.ts";
import {
  controlService,
  preflightUnregisterServices,
  quoteServiceArgument,
  registerServices,
  restoreOperationServices,
  serviceRows,
  unregisterServices,
} from "../src/service.ts";
import type { ServiceBackend, ServiceSnapshot } from "../src/service.ts";
import { Store } from "../src/store.ts";
import type {
  Install,
  ServiceDeclaration,
  ServiceReceiptConfig,
  State,
} from "../src/types.ts";
import { sha256 } from "../src/util.ts";

const declaration = {
  name: "PikoFixture",
  displayName: "Piko Fixture",
  binPath: "fixture.exe",
  startType: "demand",
};

test("service declarations reject case collisions, unsafe paths, cycles, and disabled auto-start", () => {
  expect(() =>
    validateServices([declaration, { ...declaration, name: "pikofixture2" }]),
  ).not.toThrow();
  expect(() =>
    validateServices([declaration, { ...declaration, name: "pikofixture" }]),
  ).toThrow(/case-insensitive|Case-colliding|Duplicate/);
  expect(() =>
    validateServices([{ ...declaration, binPath: "..\\outside.exe" }]),
  ).toThrow();
  expect(() =>
    validateServices([
      { ...declaration, startType: "disabled", startAfterInstall: true },
    ]),
  ).toThrow(/disabled/i);
  expect(() =>
    validateServices([
      { ...declaration, name: "one", depends: ["two"] },
      { ...declaration, name: "two", depends: ["one"] },
    ]),
  ).toThrow(/cyclic/i);
});

test("service command arguments use Windows quoting and do not concatenate shell syntax", () => {
  const quoted = quoteServiceArgument("C:\\Program Files\\Piko\\fixture.exe");
  expect(quoted.startsWith('"C:')).toBe(true);
  expect(quoted.endsWith('fixture.exe"')).toBe(true);
  const quote = String.fromCharCode(34),
    slash = String.fromCharCode(92);
  expect(quoteServiceArgument('a; & "quoted"')).toBe(
    `${quote}a; & ${slash}${quote}quoted${slash}${quote}${quote}`,
  );
});

test("service receipts require an owned complete SCM configuration", () => {
  const packageId = "a".repeat(64);
  const receipt = {
    id: `${packageId}/pikofixture`,
    name: "PikoFixture",
    displayName: "Piko Fixture",
    installedAt: new Date().toISOString(),
    installedVersion: "1.0.0",
    packageId,
    status: "registered",
    owned: true,
    config: {
      binaryPath: quoteServiceArgument(join(tmpdir(), "Piko", "fixture.exe")),
      startType: 3,
      serviceType: 16,
      errorControl: 1,
      account: "LocalSystem",
      displayName: "Piko Fixture",
      description: "",
      depends: [],
    },
  };
  expect(() => validateServiceReceipt(receipt)).not.toThrow();
  expect(() => validateServiceReceipt({ ...receipt, owned: false })).toThrow(
    /Registered service receipt lacks ownership/,
  );
  expect(() =>
    validateServiceReceipt({
      ...receipt,
      config: { ...receipt.config, binaryPath: "fixture.exe" },
    }),
  ).toThrow(/absolute executable/);
});

const work = await mkdtemp(join(tmpdir(), "piko-service-tests-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
);

class IsolatedServices implements ServiceBackend {
  entries = new Map<string, ServiceSnapshot>();
  writes: string[] = [];
  admin = true;
  fail = "";
  marked = false;
  pending = false;
  timeoutMs = 1;
  pollMs = 0;
  async isAdmin() {
    return this.admin;
  }
  async query(name: string) {
    const entry = this.entries.get(name.toLowerCase());
    if (entry && !this.pending && (entry.state === 2 || entry.state === 3))
      entry.state = entry.state === 2 ? 4 : 1;
    return structuredClone(entry);
  }
  async create(name: string, config: ServiceReceiptConfig) {
    this.writes.push(`create:${name}`);
    if (this.fail === "create") throw Error("injected create failure");
    if (this.entries.has(name.toLowerCase()))
      throw Error("service already exists");
    this.entries.set(name.toLowerCase(), {
      config: structuredClone(config),
      state: 1,
    });
  }
  async describe(name: string, description: string) {
    this.writes.push(`describe:${name}`);
    if (this.fail === "describe") throw Error("injected describe failure");
    this.entries.get(name.toLowerCase())!.config.description = description;
  }
  async start(name: string) {
    this.writes.push(`start:${name}`);
    if (this.fail === "start") throw Error("injected start failure");
    this.entries.get(name.toLowerCase())!.state = this.pending ? 2 : 4;
  }
  async stop(name: string) {
    this.writes.push(`stop:${name}`);
    if (this.fail === "stop") throw Error("injected stop failure");
    this.entries.get(name.toLowerCase())!.state = this.pending ? 3 : 1;
  }
  async delete(name: string) {
    this.writes.push(`delete:${name}`);
    if (this.fail === "delete") throw Error("injected delete failure");
    if (!this.marked) this.entries.delete(name.toLowerCase());
  }
}

// Tests exercise service transactions, not Store's unrelated registry/shim effects.
class ServiceStore extends Store {
  mutations = 0;
  commits = 0;
  constructor(
    root: string,
    public state: State,
  ) {
    super(root);
  }
  override async read(): Promise<State> {
    return structuredClone(this.state);
  }
  override async mutate<T>(fn: (state: State) => Promise<T>): Promise<T> {
    this.mutations++;
    const state = structuredClone(this.state),
      result = await fn(state);
    this.state = state;
    this.commits++;
    return result;
  }
}
async function fixture(patch: Partial<ServiceDeclaration> = {}) {
  const root = join(work, crypto.randomUUID());
  const source = {
    alias: "main",
    type: "http" as const,
    url: "https://example.invalid/index.json",
    identity: sha256("main"),
  };
  const install: Install = {
    id: sha256(root),
    key: "fixture--" + source.identity.slice(0, 16),
    name: "fixture",
    version: "1.0.0",
    request: "1.0.0",
    source,
    dir: "apps/fixture/1.0.0",
    bins: { fixture: { path: "fixture.exe", kind: "native" } },
    persist: [],
    verified: true,
    checksum: "a".repeat(64),
    kind: "portable",
    manifestHash: "b".repeat(64),
    services: [
      {
        name: "PikoFixture",
        displayName: "Piko Fixture",
        binPath: "fixture.exe",
        startType: "demand",
        ...patch,
      },
    ],
  };
  await mkdir(join(root, install.dir), { recursive: true });
  await writeFile(join(root, install.dir, "fixture.exe"), "never executed");
  await writeFile(
    join(root, install.dir, ".piko-install.json"),
    JSON.stringify(install),
  );
  const state: State = {
    schemaVersion: 9,
    revision: 0,
    installs: { [install.id]: install },
    sources: { main: source },
    defaults: {},
    commands: {},
  };
  const store = new ServiceStore(root, state),
    backend = new IsolatedServices();
  return {
    store,
    state,
    install,
    backend,
    id: `${install.id}/pikofixture`,
    spec: "main/fixture@1.0.0",
  };
}

test("isolated SCM lifecycle registers, starts, restarts stop-before-start, stops and revokes from receipt", async () => {
  const { store, state, install, backend, id, spec } = await fixture({
    description: "Fixture description",
    args: ["--service", 'a; & "quoted"'],
  });
  await registerServices(store, state, install, backend);
  expect(state.services?.[id]?.owned).toBe(true);
  expect(state.receipts?.[install.id]?.service?.[0]?.receipt).toEqual(
    state.services?.[id],
  );
  expect(backend.entries.get("pikofixture")?.config.binaryPath).toContain(
    '"--service"',
  );
  backend.writes.length = 0;
  await registerServices(store, state, install, backend);
  expect(backend.writes).toEqual([]);
  await controlService(store, spec, "start", backend);
  backend.writes.length = 0;
  const restarted = await controlService(store, spec, "restart", backend);
  expect(backend.writes).toEqual(["stop:PikoFixture", "start:PikoFixture"]);
  expect(restarted[0]?.state).toBe(4);
  await controlService(store, spec, "stop", backend);
  // Revocation must use the saved declaration even if the current manifest is gone.
  delete install.services;
  await unregisterServices(store, store.state, install, backend);
  expect(backend.entries.size).toBe(0);
  expect(store.state.services?.[id]?.status).toBe("removed");
  expect(store.state.services?.[id]?.owned).toBe(false);
});

test("non-admin registration and foreign same-name services cannot write or acquire ownership", async () => {
  const { store, state, install, backend } = await fixture();
  backend.admin = false;
  await expect(
    registerServices(store, state, install, backend),
  ).rejects.toThrow(/Administrator terminal/);
  expect(backend.writes).toEqual([]);
  backend.admin = true;
  await registerServices(store, state, install, backend);
  delete state.services;
  delete state.receipts;
  backend.writes.length = 0;
  const before = structuredClone(state);
  await expect(
    registerServices(store, state, install, backend),
  ).rejects.toThrow(/foreign/);
  expect(state).toEqual(before);
  expect(backend.writes).toEqual([]);
});

test("SCM config drift blocks queries of ownership, preflight and writes without receipt changes", async () => {
  const { store, state, install, backend, spec } = await fixture();
  await registerServices(store, state, install, backend);
  backend.entries.get("pikofixture")!.config.account = "OtherAccount";
  const before = structuredClone(state);
  backend.writes.length = 0;
  await expect(
    preflightUnregisterServices(store, state, install, backend),
  ).rejects.toThrow(/drifted/);
  await expect(
    unregisterServices(store, state, install, backend),
  ).rejects.toThrow(/drifted/);
  await expect(controlService(store, spec, "stop", backend)).rejects.toThrow(
    /drifted/,
  );
  expect(store.state).toEqual(before);
  expect(store.commits).toBe(0);
  expect(backend.writes).toEqual([]);
  const rows = await serviceRows(store, spec, backend);
  expect(rows[0]?.owned).toBe(false);
  expect(rows[0]?.error).toMatch(/drifted/);
});

for (const failure of ["describe", "start"] as const)
  test(`partial ${failure} failure compensates a created service and can retry`, async () => {
    const { store, state, install, backend, id } = await fixture({
      description: "Fixture",
      startAfterInstall: true,
    });
    backend.fail = failure;
    await expect(
      registerServices(store, state, install, backend),
    ).rejects.toThrow(`injected ${failure} failure`);
    expect(backend.entries.size).toBe(0);
    expect(state.services?.[id]?.status).toBe("failed");
    expect(state.services?.[id]?.owned).toBe(false);
    expect(state.services?.[id]?.error).toContain(failure);
    backend.fail = "";
    await registerServices(store, state, install, backend);
    expect(state.services?.[id]?.status).toBe("registered");
    expect(backend.entries.get("pikofixture")?.state).toBe(4);
  });

test("failed compensation retains owned config and retry never adopts an unrelated service", async () => {
  const { store, state, install, backend, id } = await fixture({
    startAfterInstall: true,
  });
  backend.pending = true;
  await expect(
    registerServices(store, state, install, backend),
  ).rejects.toThrow(/compensation failed/);
  expect(state.services?.[id]?.owned).toBe(true);
  expect(state.services?.[id]?.status).toBe("failed");
  expect(state.services?.[id]?.config).toBeDefined();
  backend.pending = false;
  await registerServices(store, state, install, backend);
  expect(state.services?.[id]?.status).toBe("registered");
});

test("marked-for-deletion and stop timeouts retain failure ownership until safe retry", async () => {
  const { store, state, install, backend, id } = await fixture({
    startAfterInstall: true,
  });
  await registerServices(store, state, install, backend);
  backend.pending = true;
  backend.writes.length = 0;
  await expect(
    unregisterServices(store, state, install, backend),
  ).rejects.toThrow(/timed out/);
  expect(backend.writes).toEqual(["stop:PikoFixture"]);
  expect(state.services?.[id]?.owned).toBe(true);
  backend.pending = false;
  backend.marked = true;
  await expect(
    unregisterServices(store, state, install, backend),
  ).rejects.toThrow(/marked for deletion/);
  expect(state.services?.[id]?.status).toBe("failed");
  expect(state.services?.[id]?.owned).toBe(true);
  backend.marked = false;
  await unregisterServices(store, state, install, backend);
  expect(state.services?.[id]?.status).toBe("removed");
});

test("control failures commit failure receipt and status is readonly with a missing managed row", async () => {
  const { store, state, install, backend, id, spec } = await fixture();
  await registerServices(store, state, install, backend);
  backend.fail = "start";
  await expect(controlService(store, spec, "start", backend)).rejects.toThrow(
    /injected start/,
  );
  expect(store.commits).toBe(1);
  expect(store.state.services?.[id]?.status).toBe("failed");
  expect(store.state.services?.[id]?.owned).toBe(true);
  backend.entries.clear();
  backend.admin = false;
  const mutations = store.mutations,
    writes = [...backend.writes];
  const rows = await controlService(store, spec, "status", backend);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("missing");
  expect(rows[0]?.packageId).toBe(install.id);
  expect(store.mutations).toBe(mutations);
  expect(backend.writes).toEqual(writes);
});

test("cross-source and unselected multi-version service references require explicit identity", async () => {
  const { store, state, install, backend } = await fixture();
  const other = structuredClone(install);
  other.id = "c".repeat(64);
  other.key = "other-key";
  other.source = { ...other.source, alias: "other", identity: "d".repeat(64) };
  state.installs[other.id] = other;
  state.defaults[install.key] = { id: install.id, request: install.version };
  await expect(serviceRows(store, "fixture", backend)).rejects.toThrow(
    /ambiguous/,
  );
  expect(
    (await serviceRows(store, "main/fixture@1.0.0", backend))[0]?.source,
  ).toBe("main");
  delete state.installs[other.id];
  delete state.defaults[install.key];
  const newer = { ...install, id: "e".repeat(64), version: "2.0.0" };
  state.installs[newer.id] = newer;
  await expect(serviceRows(store, "main/fixture", backend)).rejects.toThrow(
    /ambiguous/,
  );
  expect(backend.writes).toEqual([]);
});

test("disabled services and explicit stop policy cannot be bypassed by control or removal", async () => {
  const { store, state, install, backend, spec } = await fixture({
    startType: "disabled",
    stopBeforeUninstall: false,
  });
  await registerServices(store, state, install, backend);
  backend.writes.length = 0;
  await expect(controlService(store, spec, "start", backend)).rejects.toThrow(
    /Disabled/,
  );
  backend.entries.get("pikofixture")!.state = 4;
  await expect(
    unregisterServices(store, state, install, backend),
  ).rejects.toThrow(/already be stopped/);
  expect(backend.writes).toEqual([]);
});

test("service rollback restores the previous version from its exact receipt and is idempotent", async () => {
  const { store, state, install, backend, id } = await fixture({
    description: "Previous generation",
    startAfterInstall: true,
  });
  await registerServices(store, state, install, backend);
  const target = structuredClone(state);
  await unregisterServices(store, state, install, backend);
  const newer: Install = {
    ...structuredClone(install),
    id: sha256("new generation"),
    version: "2.0.0",
    dir: "apps/fixture/2.0.0",
  };
  state.installs[newer.id] = newer;
  await mkdir(join(store.root, newer.dir), { recursive: true });
  await writeFile(join(store.root, newer.dir, "fixture.exe"), "never executed");
  await writeFile(
    join(store.root, newer.dir, ".piko-install.json"),
    JSON.stringify(newer),
  );
  await registerServices(store, state, newer, backend);
  const oldConfig = target.services![id]!.config;
  backend.writes.length = 0;
  await restoreOperationServices(store, state, target, backend);
  expect(backend.entries.get("pikofixture")?.config).toEqual(oldConfig);
  expect(backend.entries.get("pikofixture")?.state).toBe(4);
  expect(state.services?.[id]?.owned).toBe(true);
  expect(state.services?.[`${newer.id}/pikofixture`]?.status).toBe("removed");
  backend.writes.length = 0;
  await restoreOperationServices(store, state, target, backend);
  expect(backend.writes).toEqual([]);
});

test("service rollback preflights all foreign resources before deleting any service", async () => {
  const { store, state, install, backend } = await fixture();
  install.services!.push({ ...install.services![0]!, name: "PikoSecond" });
  await writeFile(
    join(store.root, install.dir, ".piko-install.json"),
    JSON.stringify(install),
  );
  const target = structuredClone(state);
  await registerServices(store, state, install, backend);
  backend.entries.get("pikosecond")!.config.account = "ForeignAccount";
  const before = structuredClone(state);
  backend.writes.length = 0;
  await expect(
    restoreOperationServices(store, state, target, backend),
  ).rejects.toThrow(/foreign|drifted/);
  expect(backend.writes).toEqual([]);
  expect(state).toEqual(before);
});

test("rollback does not adopt a service whose only receipt explicitly lacks ownership", async () => {
  const { store, state, install, backend, id } = await fixture();
  const target = structuredClone(state);
  await registerServices(store, state, install, backend);
  state.services![id]!.status = "failed";
  state.services![id]!.owned = false;
  state.receipts![install.id]!.service![0]!.receipt = structuredClone(
    state.services![id]!,
  );
  backend.writes.length = 0;
  await expect(
    restoreOperationServices(store, state, target, backend),
  ).rejects.toThrow(/foreign/);
  expect(backend.writes).toEqual([]);
});

test("rollback description failure preserves exact ownership for retry and leaves target immutable", async () => {
  const { store, state, install, backend, id } = await fixture({
    description: "Saved description",
    startAfterInstall: true,
  });
  await registerServices(store, state, install, backend);
  const target = structuredClone(state),
    original = structuredClone(target);
  await unregisterServices(store, state, install, backend);
  backend.fail = "describe";
  await expect(
    restoreOperationServices(store, state, target, backend),
  ).rejects.toThrow(/injected describe/);
  expect(state.services?.[id]?.status).toBe("failed");
  expect(state.services?.[id]?.owned).toBe(true);
  expect(state.services?.[id]?.config?.description).toBe("");
  expect(target).toEqual(original);
  backend.fail = "";
  await restoreOperationServices(store, state, target, backend);
  expect(backend.entries.get("pikofixture")?.config).toEqual(
    target.services?.[id]?.config,
  );
  expect(backend.entries.get("pikofixture")?.state).toBe(4);
  expect(state.services?.[id]?.status).toBe("registered");
});

test("rollback reconciles an already-restored SCM service without deleting the restored generation", async () => {
  const { store, state, install, backend, id } = await fixture();
  await registerServices(store, state, install, backend);
  const target = structuredClone(state),
    restored = structuredClone(backend.entries.get("pikofixture")!);
  await unregisterServices(store, state, install, backend);
  const newer: Install = {
    ...structuredClone(install),
    id: sha256("stale capture generation"),
    version: "2.0.0",
    dir: "apps/fixture/2.0.0",
  };
  state.installs[newer.id] = newer;
  await mkdir(join(store.root, newer.dir), { recursive: true });
  await writeFile(join(store.root, newer.dir, "fixture.exe"), "never executed");
  await writeFile(
    join(store.root, newer.dir, ".piko-install.json"),
    JSON.stringify(newer),
  );
  await registerServices(store, state, newer, backend);
  // SCM restoration landed, but the last ownership capture still names the newer generation.
  backend.entries.set("pikofixture", restored);
  backend.writes.length = 0;
  await restoreOperationServices(store, state, target, backend);
  expect(backend.writes).toEqual([]);
  expect(state.services?.[id]?.owned).toBe(true);
  expect(state.services?.[`${newer.id}/pikofixture`]?.owned).toBe(false);
  await restoreOperationServices(store, state, target, backend);
  expect(backend.writes).toEqual([]);
});

test("create-to-receipt crash window never adopts identical SCM configuration", async () => {
  const { store, state, install, backend, id } = await fixture();
  await registerServices(store, state, install, backend);
  const target = structuredClone(state);
  // SCM CreateService landed, but durable capture contains only the create intent.
  state.services![id]!.status = "failed";
  state.services![id]!.owned = false;
  state.services![id]!.error = "CreateService outcome was not durably recorded";
  state.receipts![install.id]!.service![0]!.receipt = structuredClone(
    state.services![id]!,
  );
  const before = structuredClone(state);
  backend.writes.length = 0;
  await expect(
    registerServices(store, state, install, backend),
  ).rejects.toThrow(/foreign|drifted/);
  await expect(
    restoreOperationServices(store, state, target, backend),
  ).rejects.toThrow(/ambiguous create ownership/);
  // Identical captures must not bypass the guard as an already-completed rollback.
  await expect(
    restoreOperationServices(store, state, structuredClone(state), backend),
  ).rejects.toThrow(/ambiguous create ownership/);
  expect(state).toEqual(before);
  expect(backend.writes).toEqual([]);
  expect(backend.entries.get("pikofixture")?.config).toEqual(
    target.services?.[id]?.config,
  );
});
