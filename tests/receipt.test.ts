import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { WindowsEffects } from "../src/windows-effects.ts";
import { saveEffectBytes } from "../src/desktop.ts";
import {
  ensureInstallReceipt,
  finishOperationEffects,
  operationEffectJournal,
  preflightInstallReceiptRemoval,
  receiptFileJournal,
  recoverReceiptFiles,
  restoreOperationEffects,
  synchronizeReceipts,
  validateReceipts,
} from "../src/receipt.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";
import type {
  EffectTarget,
  EffectValue,
  FileEffect,
  Install,
  State,
} from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-receipt-tests-"));
const payload = Buffer.from("receipt fixture executable; never run");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/file") return new Response(payload);
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          receipt: {
            latest: "2.0.0",
            versions: { "1.0.0": "1.json", "2.0.0": "2.json" },
          },
        },
      });
    return Response.json({
      schemaVersion: 1,
      name: "receipt",
      version: path === "/2.json" ? "2.0.0" : "1.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          format: "file",
          file: "tool.exe",
          sha256: sha256(payload),
          bin: {},
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

class FileBackend extends WindowsEffects {
  writes: string[] = [];
  failOnce = "";
  override async write(
    target: EffectTarget,
    before: EffectValue,
    after: EffectValue,
    bytes?: Uint8Array,
  ) {
    if (target.kind === "file") {
      if (target.path === this.failOnce) {
        this.failOnce = "";
        throw new Error("injected receipt write failure");
      }
      this.writes.push(target.path);
    }
    await super.write(target, before, after, bytes);
  }
}

async function fixture() {
  const directory = await mkdtemp(join(work, "case-"));
  const root = join(directory, "home");
  const backend = new FileBackend(join(directory, "external"));
  const p = new Packages(root, backend);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const install = await p.install("main/receipt@1.0.0");
  return { p, backend, directory, install };
}

async function enrollFiles(
  p: Packages,
  install: Install,
  directory: string,
  count = 3,
): Promise<FileEffect[]> {
  const effects: FileEffect[] = [];
  for (let index = 0; index < count; index++) {
    const path = join(directory, `external-${index}.txt`);
    const bytes = Buffer.from(`managed-${index}`);
    await writeFile(path, bytes);
    effects.push({
      packageId: install.id,
      order: index + 10,
      path,
      kind: "file",
      before: null,
      after: await saveEffectBytes(p.root, bytes),
    });
  }
  await p.store.mutate(async (state) => {
    ensureInstallReceipt(state, install).files = effects;
  });
  return effects;
}

async function recordFileJournal(
  p: Packages,
  install: Install,
): Promise<State> {
  const before = await p.store.read();
  await atomicJson(receiptFileJournal(p.root), {
    before,
    packageId: install.id,
    files: before.receipts![install.id]!.files,
  });
  return before;
}

test("uninstall reverses file effects by durable order and does not renumber on unrelated commits", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  await p.store.mutate(async () => {});
  expect(
    (await p.store.read()).receipts![install.id]!.files!.map(
      (entry) => entry.order,
    ),
  ).toEqual([10, 11, 12]);
  await p.uninstall("main/receipt@1.0.0");
  expect(backend.writes).toEqual(
    [...effects].reverse().map((entry) => entry.path),
  );
  expect(await Promise.all(effects.map((entry) => exists(entry.path)))).toEqual(
    [false, false, false],
  );
  expect(await exists(receiptFileJournal(p.root))).toBe(false);
  expect((await p.store.read()).receipts?.[install.id]).toBeUndefined();
});

test("all external files are preflighted before the first revocation and user drift is preserved", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  await writeFile(effects[1]!.path, "user-edited");
  const before = await p.store.read();
  await expect(p.uninstall("main/receipt@1.0.0")).rejects.toThrow(
    "ownership drift",
  );
  expect(backend.writes).toEqual([]);
  expect(await p.store.read()).toEqual(before);
  expect(await readFile(effects[0]!.path, "utf8")).toBe("managed-0");
  expect(await readFile(effects[1]!.path, "utf8")).toBe("user-edited");
  expect(await exists(join(p.root, install.dir, "tool.exe"))).toBe(true);
});

test("a failed external write rolls back earlier effects, keeps installation files, and can retry", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  backend.failOnce = effects[1]!.path;
  await expect(p.uninstall("main/receipt@1.0.0")).rejects.toThrow(
    "injected receipt write failure",
  );
  expect(await Promise.all(effects.map((entry) => exists(entry.path)))).toEqual(
    [true, true, true],
  );
  expect(await exists(join(p.root, install.dir, "tool.exe"))).toBe(true);
  expect((await p.store.read()).installs[install.id]).toBeDefined();
  expect(await exists(receiptFileJournal(p.root))).toBe(false);
  await p.uninstall("main/receipt@1.0.0");
  expect((await p.store.read()).installs[install.id]).toBeUndefined();
});

test("receipt file journal recovers interrupted writes on either side of state publication", async () => {
  for (const committed of [false, true]) {
    const { p, backend, directory, install } = await fixture();
    const effects = await enrollFiles(p, install, directory, 2);
    const before = await recordFileJournal(p, install);
    await rm(effects[1]!.path);
    const chosen = structuredClone(before);
    if (committed) {
      chosen.revision++;
      delete chosen.installs[install.id];
      delete chosen.receipts![install.id];
    }
    await recoverReceiptFiles(p.root, chosen, backend);
    expect(
      await Promise.all(effects.map((entry) => exists(entry.path))),
    ).toEqual(committed ? [false, false] : [true, true]);
    expect(await exists(receiptFileJournal(p.root))).toBe(false);
  }
});

test("receipt file recovery preflights all resources before writing and retains a journal on drift", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory, 2);
  const before = await recordFileJournal(p, install);
  await rm(effects[0]!.path);
  await writeFile(effects[1]!.path, "foreign user data");
  await expect(recoverReceiptFiles(p.root, before, backend)).rejects.toThrow(
    "drift",
  );
  expect(backend.writes).toEqual([]);
  expect(await exists(effects[0]!.path)).toBe(false);
  expect(await readFile(effects[1]!.path, "utf8")).toBe("foreign user data");
  expect(await exists(receiptFileJournal(p.root))).toBe(true);
});

test("empty owned directories are removed nonrecursively and user-populated directories are rejected", async () => {
  const { p, directory, install } = await fixture();
  const path = join(directory, "external-empty");
  await mkdir(path);
  await p.store.mutate(async (state) => {
    ensureInstallReceipt(state, install).files = [
      {
        order: 10,
        packageId: install.id,
        kind: "directory",
        path,
        before: null,
        after: null,
      },
    ];
  });
  await writeFile(join(path, "user-data"), "keep");
  await expect(p.uninstall("main/receipt@1.0.0")).rejects.toThrow("not empty");
  expect(await readFile(join(path, "user-data"), "utf8")).toBe("keep");
  await rm(join(path, "user-data"));
  await p.uninstall("main/receipt@1.0.0");
  expect(await exists(path)).toBe(false);
});

test("legacy admin actions migrate into separate histories and retain stable effect orders", async () => {
  const { p, install } = await fixture();
  const state = await p.store.read();
  const installed = {
    id: install.id,
    action: "install" as const,
    binding: "a".repeat(64),
    at: new Date().toISOString(),
    status: "completed" as const,
  };
  state.admin = { [install.id]: installed };
  synchronizeReceipts(state);
  const order = state.receipts![install.id]!.admin!.order;
  state.admin[install.id] = {
    ...installed,
    action: "remove",
    status: "failed",
    error: "retry me",
  };
  synchronizeReceipts(state);
  expect(state.receipts![install.id]!.admin!.install).toEqual(installed);
  expect(state.receipts![install.id]!.admin!.remove).toMatchObject({
    action: "remove",
    status: "failed",
  });
  expect(state.receipts![install.id]!.admin!.order).toBe(order);
  validateReceipts(state);
});

test("receipt validation rejects wrong-version ownership, missing snapshots and duplicate global effect orders", async () => {
  const { p, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory, 2);
  const state = await p.store.read();
  const wrongOwner = structuredClone(state);
  wrongOwner.receipts![install.id]!.files![0]!.packageId = "b".repeat(64);
  expect(() => validateReceipts(wrongOwner)).toThrow("ownership");
  const duplicateOrder = structuredClone(state);
  duplicateOrder.receipts![install.id]!.files![1]!.order = effects[0]!.order;
  expect(() => validateReceipts(duplicateOrder)).toThrow("order");
  const missingSnapshot = structuredClone(state);
  Reflect.deleteProperty(
    missingSnapshot.receipts![install.id]!.files![0]!,
    "after",
  );
  expect(() => validateReceipts(missingSnapshot)).toThrow("snapshots");
});

test("cross-commit file restoration is durable and idempotent after a partial failure", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  const current = await p.store.read();
  const target = structuredClone(current);
  delete target.receipts![install.id]!.files;
  backend.failOnce = effects[1]!.path;
  await expect(
    restoreOperationEffects(p.store, current, target),
  ).rejects.toThrow("injected receipt write failure");
  expect(await exists(operationEffectJournal(p.root))).toBe(true);
  expect(await exists(effects[2]!.path)).toBe(false);
  expect(await exists(effects[0]!.path)).toBe(true);
  await restoreOperationEffects(p.store, current, target);
  await restoreOperationEffects(p.store, current, target);
  expect(await Promise.all(effects.map((entry) => exists(entry.path)))).toEqual(
    [false, false, false],
  );
  await expect(finishOperationEffects(p.store)).rejects.toThrow(
    "not committed",
  );
  target.revision = current.revision + 1;
  await atomicJson(p.store.statePath, target);
  await finishOperationEffects(p.store);
  expect(await exists(operationEffectJournal(p.root))).toBe(false);
});

test("cross-commit restoration preflights every current or target resource before any write", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  const current = await p.store.read();
  const target = structuredClone(current);
  delete target.receipts![install.id]!.files;
  await writeFile(effects[0]!.path, "unrelated user edit");
  await expect(
    restoreOperationEffects(p.store, current, target),
  ).rejects.toThrow("neither the current nor target");
  expect(backend.writes).toEqual([]);
  expect(await exists(effects[2]!.path)).toBe(true);
  expect(await exists(operationEffectJournal(p.root))).toBe(false);
});

test("standalone uninstall receipt preflight is read-only and detects drift before an irreversible checkpoint", async () => {
  const { p, backend, directory, install } = await fixture();
  const effects = await enrollFiles(p, install, directory);
  const state = await p.store.read();
  const original = structuredClone(state);
  await preflightInstallReceiptRemoval(p.store, state, install);
  expect(state).toEqual(original);
  expect(await p.store.read()).toEqual(original);
  expect(backend.writes).toEqual([]);
  expect(await exists(receiptFileJournal(p.root))).toBe(false);
  expect(await Promise.all(effects.map((entry) => exists(entry.path)))).toEqual(
    [true, true, true],
  );
  await writeFile(effects[1]!.path, "user edit before checkpoint");
  await expect(
    preflightInstallReceiptRemoval(p.store, state, install),
  ).rejects.toThrow("ownership drift");
  expect(state).toEqual(original);
  expect(await p.store.read()).toEqual(original);
  expect(backend.writes).toEqual([]);
  expect(await exists(receiptFileJournal(p.root))).toBe(false);
});
