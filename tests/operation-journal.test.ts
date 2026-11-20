import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Store,
  emptyState,
  installId,
  packageKey,
  sourceIdentity,
} from "../src/store.ts";
import {
  decodeOperationState,
  operationPath,
  pendingOperations,
  recordOperationState,
  runOperation,
  trackOperationFile,
  checkpoint,
  trackOperationMove,
} from "../src/journal.ts";
import { inspectOperations, recoverOperations } from "../src/ops/recover.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";
import { synchronizeReceipts } from "../src/receipt.ts";
import type { Install, Source } from "../src/types.ts";
import { Packages } from "../src/packages.ts";
import { inspectExecution, runExecution } from "../src/execution.ts";
import { WindowsEffects } from "../src/windows-effects.ts";

class IsolatedEffects extends WindowsEffects {
  override async elevated() {
    return true;
  }
  override async shortcut(target: string, args: string): Promise<Uint8Array> {
    return Buffer.from(JSON.stringify([target, args]));
  }
}

const work = await mkdtemp(join(tmpdir(), "piko-operation-journal-"));
afterAll(async () => {
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

async function isolated(name: string): Promise<Store> {
  const store = new Store(join(work, name));
  await mkdir(store.root, { recursive: true });
  return store;
}

async function orphan(store: Store): Promise<void> {
  const journals = await pendingOperations(store.root);
  for (const journal of journals) {
    // Deliberately impossible PID, local to this isolated journal (never kill a process).
    journal.pid = 2147483647;
    await atomicJson(operationPath(store.root, journal), journal);
  }
}

test("validation and download rejection without side effects remains directly retryable", async () => {
  const store = await isolated("retry");
  for (const created of [false, true]) {
    const stage = join(store.root, "staging", "rejected");
    await expect(
      runOperation(store, "install", "main/tool", {}, async () => {
        await trackOperationFile(store, stage);
        if (created) await mkdir(stage, { recursive: true });
        try {
          throw new Error("download rejected");
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      }),
    ).rejects.toThrow("download rejected");
    expect(await inspectOperations(store.root)).toEqual([]);
  }
  await store.mutate(async () => undefined);
  expect((await store.readCommitted()).schemaVersion).toBe(9);
});

test("nested operations share one journal and reject unrelated writers during the full lease", async () => {
  const store = await isolated("lease");
  const { promise: ready, resolve: entered } = Promise.withResolvers<void>();
  const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
  const running = runOperation(store, "update", "main/tool", {}, async () => {
    await runOperation(store, "install", "main/tool@2", {}, async () => {
      expect(await pendingOperations(store.root)).toHaveLength(1);
      entered();
      await barrier;
    });
  });
  await ready;
  try {
    await expect(
      new Store(store.root).mutate(async () => undefined),
    ).rejects.toThrow(/still running|pending/);
  } finally {
    release();
  }
  await running;
  expect(await pendingOperations(store.root)).toEqual([]);
});

test("extract process kill preserves a validated journal and rollback removes only its owned stage", async () => {
  const store = await isolated("extract-kill");
  const journalUrl = new URL("../src/journal.ts", import.meta.url).href;
  const storeUrl = new URL("../src/store.ts", import.meta.url).href;
  const source = `
    import { Store } from ${JSON.stringify(storeUrl)};
    import { checkpoint, runOperation, trackOperationFile } from ${JSON.stringify(journalUrl)};
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const store = new Store(${JSON.stringify(store.root)});
    await runOperation(store, 'install', 'main/tool@1', {}, async () => {
      const stage = join(store.root, 'staging', 'extract-owned');
      await trackOperationFile(store, stage);
      await checkpoint(store, 'extract', async () => {
        await mkdir(stage, { recursive: true });
        await writeFile(join(stage, 'partial.bin'), 'partial extract');
        console.log('extract-ready');
        await Bun.stdin.stream().getReader().read();
      });
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("extract-ready");
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
  const [journal] = await inspectOperations(store.root);
  expect(journal).toBeDefined();
  expect(decodeOperationState(journal!.before)).toEqual(emptyState());
  expect((await recoverOperations(store))[0]?.status).toBe("blocked");
  expect(
    await exists(join(store.root, "staging", "extract-owned", "partial.bin")),
  ).toBe(true);
  expect(
    (await recoverOperations(store, { mode: "rollback" }))[0]?.status,
  ).toBe("rolled-back");
  expect(await exists(join(store.root, "staging", "extract-owned"))).toBe(
    false,
  );
});

test("state binding drift blocks rollback before deleting staging", async () => {
  const store = await isolated("state-drift");
  const stage = join(store.root, "staging", "owned");
  await expect(
    runOperation(store, "update", "main/tool", {}, async () => {
      await trackOperationFile(store, stage);
      await mkdir(stage, { recursive: true });
      throw new Error("interrupted");
    }),
  ).rejects.toThrow("interrupted");
  await orphan(store);
  const drift = emptyState();
  drift.revision = 3;
  await atomicJson(store.statePath, drift);
  const rows = await recoverOperations(store, { mode: "rollback" });
  expect(rows[0]?.status).toBe("blocked");
  expect(rows[0]?.error).toContain("state drift");
  expect(await exists(stage)).toBe(true);
});

test("tampered journal paths and compressed snapshots are rejected without effects", async () => {
  const store = await isolated("tampered");
  const stage = join(store.root, "staging", "owned");
  await expect(
    runOperation(store, "install", "main/tool", {}, async () => {
      await trackOperationFile(store, stage);
      await mkdir(stage, { recursive: true });
      throw new Error("interrupted");
    }),
  ).rejects.toThrow();
  const [journal] = await pendingOperations(store.root);
  journal!.files = ["../outside"];
  await atomicJson(operationPath(store.root, journal!), journal);
  await expect(inspectOperations(store.root)).rejects.toThrow(/relative path/);
  journal!.files = ["staging/owned"];
  journal!.before.hash = "0".repeat(64);
  await atomicJson(operationPath(store.root, journal!), journal);
  await expect(inspectOperations(store.root)).rejects.toThrow(/hash mismatch/);
});

test("failed tentative service ownership survives without falsely publishing state", async () => {
  const store = await isolated("failed-service");
  const source: Source = {
    alias: "main",
    type: "http",
    url: "https://example.invalid/index.json",
    identity: sourceIdentity("http", "https://example.invalid/index.json"),
  };
  const key = packageKey(source, "tool");
  const install: Install = {
    id: installId(key, "1.0.0"),
    key,
    name: "tool",
    version: "1.0.0",
    request: "1.0.0",
    source,
    dir: join("apps", key, "1.0.0"),
    bins: {},
    persist: [],
    verified: true,
    checksum: sha256("artifact"),
    kind: "portable",
    manifestHash: sha256("manifest"),
    services: [
      {
        name: "PikoTestTool",
        displayName: "Piko Test Tool",
        binPath: "tool.exe",
        startType: "demand",
      },
    ],
  };
  const before = emptyState();
  before.installs[install.id] = install;
  synchronizeReceipts(before);
  await atomicJson(store.statePath, before);
  await expect(
    runOperation(store, "install", "main/tool@1.0.0", {}, async () =>
      store.mutate(async (tentative) => {
        const id = `${install.id}/pikotesttool`;
        tentative.services![id] = {
          id,
          name: "PikoTestTool",
          displayName: "Piko Test Tool",
          installedAt: new Date(0).toISOString(),
          installedVersion: install.version,
          packageId: install.id,
          status: "failed",
          owned: true,
          error: "SCM compensation failed",
          config: {
            binaryPath: '"' + join(store.root, install.dir, "tool.exe") + '"',
            startType: 3,
            serviceType: 16,
            errorControl: 1,
            account: "LocalSystem",
            displayName: "Piko Test Tool",
            description: "",
            depends: [],
          },
        };
        synchronizeReceipts(tentative);
        await recordOperationState(store, tentative);
        // A helper's durable ownership must survive callback cleanup on failure.
        delete tentative.services![id];
        delete tentative.receipts![install.id]!.service;
        throw new Error("SCM compensation failed");
      }),
    ),
  ).rejects.toThrow("SCM compensation failed");
  const [journal] = await pendingOperations(store.root);
  const captured = decodeOperationState(journal!.captured);
  expect(Object.values(captured.services!)[0]?.owned).toBe(true);
  expect(await store.readCommitted()).toEqual(before);
  await expect(store.mutate(async () => undefined)).rejects.toThrow(
    "piko recover",
  );
  const text = await readFile(operationPath(store.root, journal!), "utf8");
  expect(text).toContain("captured");
});

async function installFixture(store: Store, version: string): Promise<Install> {
  const source: Source = {
    alias: "main",
    type: "http",
    url: "https://example.invalid/index.json",
    identity: sourceIdentity("http", "https://example.invalid/index.json"),
  };
  const key = packageKey(source, "recoverytool");
  const install: Install = {
    id: installId(key, version),
    key,
    name: "recoverytool",
    version,
    request: version,
    source,
    dir: join("apps", key, version),
    bins: {},
    persist: [],
    verified: true,
    checksum: sha256(version),
    manifestHash: sha256("manifest-" + version),
    kind: "portable",
  };
  await mkdir(join(store.root, install.dir), { recursive: true });
  await writeFile(join(store.root, install.dir, "payload.txt"), version);
  await atomicJson(
    join(store.root, install.dir, ".piko-install.json"),
    install,
  );
  return install;
}

for (const published of [false, true]) {
  test(`interrupted removal rollback restores retained trash on ${published ? "after" : "before"} publication side`, async () => {
    const store = await isolated(`removal-${published}`);
    const install = await installFixture(store, "1.0.0");
    const state = emptyState();
    state.installs[install.id] = install;
    synchronizeReceipts(state);
    await atomicJson(store.statePath, state);
    const trashName = `uninstall-${crypto.randomUUID()}`;
    const trash = join(store.root, "staging", trashName);
    await expect(
      runOperation(
        store,
        "uninstall",
        "main/recoverytool@1.0.0",
        {},
        async () => {
          await store.mutate(async (next) => {
            await trackOperationMove(
              store,
              join(store.root, install.dir),
              trash,
            );
            await mkdir(join(store.root, "staging"), { recursive: true });
            await atomicJson(store.removalPath, {
              installation: install,
              trash: trashName,
            });
            await rename(join(store.root, install.dir), trash);
            delete next.installs[install.id];
            delete next.receipts![install.id];
            if (!published)
              throw new Error("interrupted before state publication");
          });
          throw new Error("interrupted after state publication");
        },
      ),
    ).rejects.toThrow("interrupted");
    expect(await exists(join(trash, "payload.txt"))).toBe(true);
    await orphan(store);
    const rows = await recoverOperations(store, { mode: "rollback" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("rolled-back");
    expect((await store.readCommitted()).installs[install.id]).toEqual(install);
    expect(
      await readFile(join(store.root, install.dir, "payload.txt"), "utf8"),
    ).toBe("1.0.0");
    expect(await exists(trash)).toBe(false);
    expect(await exists(store.removalPath)).toBe(false);
  });
}

test("handled update failure restores old selection and removes newly owned generation", async () => {
  const store = await isolated("update-rollback");
  const old = await installFixture(store, "1.0.0");
  const before = emptyState();
  before.installs[old.id] = old;
  before.defaults[old.key] = { id: old.id, request: "latest", commands: [] };
  synchronizeReceipts(before);
  await store.commit(emptyState(), before);
  let next!: Install;
  const trashName = `uninstall-${crypto.randomUUID()}`;
  const trash = join(store.root, "staging", trashName);
  await expect(
    runOperation(store, "update", "main/recoverytool", {}, async () => {
      await store.mutate(async (state) => {
        const stage = join(store.root, "staging", "update-stage");
        await trackOperationFile(store, stage);
        next = await installFixture(store, "2.0.0");
        await trackOperationMove(
          store,
          join(stage, "app"),
          join(store.root, next.dir),
        );
        await trackOperationMove(store, join(store.root, old.dir), trash);
        await mkdir(join(store.root, "staging"), { recursive: true });
        await atomicJson(store.removalPath, {
          installation: old,
          trash: trashName,
        });
        await rename(join(store.root, old.dir), trash);
        state.installs[next.id] = next;
        delete state.installs[old.id];
        delete state.receipts![old.id];
        state.defaults[old.key] = {
          id: next.id,
          request: "latest",
          commands: [],
        };
      });
      throw new Error("interrupted update");
    }),
  ).rejects.toThrow("interrupted update");
  expect(await pendingOperations(store.root)).toEqual([]);
  const restored = await store.readCommitted();
  expect(restored.defaults[old.key]?.id).toBe(old.id);
  expect(restored.installs[old.id]).toEqual(old);
  expect(restored.installs[next.id]).toBeUndefined();
  expect(await exists(join(store.root, next.dir))).toBe(false);
  expect(await readFile(join(store.root, old.dir, "payload.txt"), "utf8")).toBe(
    "1.0.0",
  );
});

test("removing a launcher owner commits only the projected ownership state", async () => {
  const root = join(work, "launcher-removal");
  const backend = new IsolatedEffects(join(root, "external"));
  const p = new Packages(root, backend);
  const install = await installFixture(p.store, "1.0.0");
  await writeFile(
    join(root, install.dir, "payload.exe"),
    "launcher fixture; never executed",
  );
  install.desktop = {
    shortcuts: [{ name: "Journal Tool", path: "payload.exe" }],
  };
  await atomicJson(join(root, install.dir, ".piko-install.json"), install);
  await p.store.mutate(async (state) => {
    state.installs[install.id] = install;
  });
  const before = await p.store.readCommitted();
  expect(before.startMenu?.[install.key]?.id).toBe(install.id);
  const launcher = join(
    (await backend.folders()).startMenu,
    "Piko Apps",
    "Journal Tool.lnk",
  );
  expect(await exists(launcher)).toBe(true);
  // A callback can fail while its state is deliberately between projections.
  await expect(
    runOperation(p.store, "uninstall", "main/recoverytool", {}, async () => {
      await p.store.mutate(async (state) => {
        delete state.installs[install.id];
        delete state.receipts![install.id];
        throw new Error("original removal failure");
      });
    }),
  ).rejects.toThrow("original removal failure");
  expect(await p.store.readCommitted()).toEqual(before);
  expect(await pendingOperations(root)).toEqual([]);
  await p.uninstall("main/recoverytool");
  const after = await p.store.readCommitted();
  expect(after.schemaVersion).toBe(9);
  expect(after.installs[install.id]).toBeUndefined();
  expect(after.startMenu?.[install.key]).toBeUndefined();
  expect(after.receipts?.[install.id]).toBeUndefined();
  expect(await exists(launcher)).toBe(false);
  expect(await pendingOperations(root)).toEqual([]);
});

async function failedAdminRemoval(name: string) {
  const root = join(work, name);
  const p = new Packages(root, new IsolatedEffects(join(root, "external")));
  const install = await installFixture(p.store, "1.0.0");
  install.admin = {
    install: { kind: "javascript", path: "system.js", args: ["install"] },
    remove: { kind: "javascript", path: "system.js", args: ["remove"] },
  };
  const script = `
    import { appendFile, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export default async function ({ args, root }) {
      if (args[0] !== 'remove') return;
      await appendFile(join(root, 'attempts'), 'remove\\n');
      if ((await readFile(join(root, 'remove-input'), 'utf8')) === 'fail')
        throw new Error('declared remove failed');
    }
  `;
  await writeFile(join(root, install.dir, "system.js"), script);
  await atomicJson(join(root, install.dir, ".piko-install.json"), install);
  await p.store.mutate(async (state) => {
    state.installs[install.id] = install;
  });
  const spec = "main/recoverytool";
  const preview = await inspectExecution(p.store, spec, true);
  await runExecution(p.store, spec, {
    admin: true,
    confirmed: true,
    binding: preview.binding,
  });
  const approved = structuredClone(
    (await p.store.readCommitted()).receipts![install.id]!.admin!.install,
  );
  await writeFile(join(root, "remove-input"), "fail");
  await expect(p.uninstall(spec)).rejects.toThrow("declared remove failed");
  const [journal] = await pendingOperations(root);
  expect(journal!.status).toBe("failed");
  expect(
    (await p.store.readCommitted()).receipts![install.id]!.admin!.remove
      ?.status,
  ).toBe("failed");
  return { p, install, spec, approved, journal: journal! };
}

test("only the exact explicit uninstall retries handled admin failure and preserves journal history", async () => {
  const { p, install, spec, approved, journal } =
    await failedAdminRemoval("admin-retry");
  await expect(p.store.mutate(async () => undefined)).rejects.toThrow(
    "pending",
  );
  await expect(p.uninstall(spec, true)).rejects.toThrow("pending");
  await expect(p.uninstall(spec + "@1.0.0")).rejects.toThrow("pending");
  await expect(p.uninstall(spec)).rejects.toThrow("declared remove failed");
  const [retried] = await pendingOperations(p.root);
  expect(retried!.id).toBe(journal.id);
  expect(retried!.before).toEqual(journal.before);
  expect(retried!.phases.slice(0, journal.phases.length)).toEqual(
    journal.phases,
  );
  expect(
    retried!.phases.some(
      (phase) => phase.name === "uninstall-retry" && phase.status === "failed",
    ),
  ).toBe(true);
  expect(
    (await p.store.readCommitted()).receipts![install.id]!.admin!.install,
  ).toEqual(approved);
  await writeFile(join(p.root, "remove-input"), "ok");
  await p.uninstall(spec);
  expect((await p.store.readCommitted()).installs[install.id]).toBeUndefined();
  expect(await readFile(join(p.root, "attempts"), "utf8")).toBe(
    "remove\nremove\nremove\n",
  );
  expect(await pendingOperations(p.root)).toEqual([]);
});

for (const interruption of ["journal", "phase"] as const) {
  test(`explicit uninstall never adopts a running ${interruption}`, async () => {
    const { p, spec, journal } = await failedAdminRemoval(
      "admin-running-" + interruption,
    );
    if (interruption === "journal") journal.status = "running";
    else journal.phases.push({ name: "uninstall-admin", status: "running" });
    journal.pid = 2147483647;
    await atomicJson(operationPath(p.root, journal), journal);
    await writeFile(join(p.root, "remove-input"), "ok");
    await expect(p.uninstall(spec)).rejects.toThrow("pending");
    expect(await readFile(join(p.root, "attempts"), "utf8")).toBe("remove\n");
    expect((await pendingOperations(p.root))[0]).toEqual(journal);
  });
}
test("discard abandons the failed admin journal and frees unrelated writes", async () => {
  const { p, install, spec } = await failedAdminRemoval("admin-discard");
  await orphan(p.store);
  const rows = await recoverOperations(p.store, { mode: "discard" });
  expect(rows.map((row) => row.status)).toEqual(["discarded"]);
  expect(await pendingOperations(p.root)).toEqual([]);
  const state = await p.store.readCommitted();
  expect(state.receipts![install.id]!.admin!.install?.status).toBe("completed");
  expect(state.receipts![install.id]!.admin!.remove?.status).toBe("failed");
  // Unrelated global writes are usable again.
  await p.store.mutate(async () => undefined);
  // The package flow retries through a fresh explicit command.
  await writeFile(join(p.root, "remove-input"), "ok");
  await p.uninstall(spec);
  expect((await p.store.readCommitted()).installs[install.id]).toBeUndefined();
});

test("discard refuses an interrupted journal and keeps it pending", async () => {
  const { p, journal } = await failedAdminRemoval("admin-discard-running");
  journal.status = "running";
  await atomicJson(operationPath(p.root, journal), journal);
  await orphan(p.store);
  const rows = await recoverOperations(p.store, { mode: "discard" });
  expect(rows[0]?.status).toBe("blocked");
  expect(rows[0]?.error ?? "").toContain("Only failed operations");
  expect(await pendingOperations(p.root)).toHaveLength(1);
});

test("a failed admin migration inside an update closes the journal itself", async () => {
  const store = await isolated("update-admin-close");
  await expect(
    runOperation(
      store,
      "update",
      "main/tool",
      { phases: ["pkg/admin-upgrade"] },
      async () => {
        await checkpoint(store, "pkg/admin-upgrade", async () => {
          throw new Error("admin migration failed");
        });
      },
    ),
  ).rejects.toThrow(
    "interrupted update closed: committed versions stay installed",
  );
  expect(await inspectOperations(store.root)).toEqual([]);
  await store.mutate(async () => undefined);
});

test("retry still rejects modified approved code without adopting the failed journal", async () => {
  const { p, install, spec, journal } =
    await failedAdminRemoval("admin-digest");
  await writeFile(
    join(p.root, install.dir, "system.js"),
    "export default async function () {}\n",
  );
  await expect(p.uninstall(spec)).rejects.toThrow("content changed");
  expect((await pendingOperations(p.root))[0]).toEqual(journal);
  expect(await readFile(join(p.root, "attempts"), "utf8")).toBe("remove\n");
});

test("explicit recovery reconciles legacy selection intent without a generic journal", async () => {
  const store = await isolated("legacy-selection");
  const before = emptyState();
  const after = structuredClone(before);
  after.revision++;
  await atomicJson(store.statePath, before);
  await atomicJson(store.journalPath, { before, after, startMenu: [] });
  expect(await pendingOperations(store.root)).toEqual([]);
  await recoverOperations(store);
  expect(await exists(store.journalPath)).toBe(false);
  expect(await store.readCommitted()).toEqual(before);
});

test("invalid legacy intent is not reported as empty successful recovery", async () => {
  const store = await isolated("legacy-invalid");
  await atomicJson(store.journalPath, { before: null, after: null });
  await expect(recoverOperations(store)).rejects.toThrow();
  expect(await exists(store.journalPath)).toBe(true);
});
