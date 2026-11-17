import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Store,
  emptyState,
  installId,
  packageKey,
  sourceIdentity,
  validateState,
} from "../src/store.ts";
import { atomicJson, sha256 } from "../src/util.ts";
import type { Install, Source } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-schema-nine-"));
afterAll(async () => {
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
  test(`schema ${schemaVersion} lazily migrates to nine without rewriting historical install evidence`, async () => {
    const root = join(work, String(schemaVersion));
    const store = new Store(root);
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
      manifestHash: sha256("manifest"),
      kind: "portable",
    };
    const state = emptyState();
    state.schemaVersion = schemaVersion;
    if (schemaVersion === 1) {
      delete state.aliases;
      delete state.data;
    }
    delete state.receipts;
    delete state.services;
    state.installs[install.id] = install;
    state.sources.main = source;
    validateState(state);
    await mkdir(join(root, install.dir), { recursive: true });
    const receiptPath = join(root, install.dir, ".piko-install.json");
    await atomicJson(receiptPath, install);
    await atomicJson(store.statePath, state);
    const original = await readFile(receiptPath, "utf8");
    expect((await store.readCommitted()).schemaVersion).toBe(schemaVersion);
    expect(
      JSON.parse(await readFile(store.statePath, "utf8")).schemaVersion,
    ).toBe(schemaVersion);
    await store.mutate(async () => undefined);
    const migrated = await store.readCommitted();
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.receipts?.[install.id]?.packageId).toBe(install.id);
    expect(migrated.installs[install.id]).toEqual(install);
    expect(await readFile(receiptPath, "utf8")).toBe(original);
  });
}

test("historical Git provenance remains Git while a configured HTTP source drops obsolete ref metadata", async () => {
  const store = new Store(join(work, "historical-git"));
  const git: Source = {
    alias: "legacy",
    type: "git",
    url: "https://example.invalid/repo.git",
    ref: "stable",
    commit: "a".repeat(40),
    identity: sourceIdentity(
      "git",
      "https://example.invalid/repo.git",
      "stable",
    ),
  };
  const http: Source = {
    alias: "main",
    type: "http",
    url: "https://example.invalid/index.json",
    ref: "obsolete",
    identity: sourceIdentity(
      "http",
      "https://example.invalid/index.json",
      "obsolete",
    ),
  };
  const state = emptyState();
  state.schemaVersion = 8;
  state.sources.legacy = git;
  state.sources.main = http;
  await atomicJson(store.statePath, state);
  await store.mutate(async () => undefined);
  const migrated = await store.readCommitted();
  expect(migrated.sources.legacy).toEqual(git);
  expect(migrated.sources.main?.type).toBe("http");
  expect(migrated.sources.main?.ref).toBeUndefined();
  expect(migrated.sources.main?.identity).toBe(
    sourceIdentity("http", http.url),
  );
});
