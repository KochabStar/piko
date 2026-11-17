import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-cli-service-recovery-"));
const exe = join(import.meta.dir, "../dist/piko.exe");

afterAll(async () => {
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

async function cli(root: string, args: string[], expected = 0) {
  const child = Bun.spawn([exe, ...args], {
    env: { ...process.env, PIKO_HOME: root },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(expected);
  if (expected === 0) expect(err).toBe("");
  return { out, err };
}

async function fixture(name: string) {
  const root = join(work, name);
  const bytes = await readFile(
    join(process.env.SystemRoot!, "System32/cmd.exe"),
  );
  const service = `PikoCliFixture_${process.pid}_${Date.now()}`;
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      requests++;
      const path = new URL(request.url).pathname;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: {
            tool: { latest: "1.0.0", versions: { "1.0.0": "tool.json" } },
          },
        });
      if (path === "/tool.json")
        return Response.json({
          schemaVersion: 1,
          name: "tool",
          version: "1.0.0",
          platforms: {
            "windows-x64": {
              url: `http://127.0.0.1:${server.port}/file`,
              sha256: sha256(bytes),
              format: "file",
              file: "tool.exe",
              bin: { tool: "tool.exe" },
            },
          },
        });
      if (path === "/file") return new Response(bytes);
      return new Response("not found", { status: 404 });
    },
  });
  return { root, service, server, requests: () => requests };
}

test("CLI service list and recovery inspection are readonly even with a mutation lock", async () => {
  const root = join(work, "empty");
  const store = new Store(root);
  await store.mutate(async () => {});
  const state = await readFile(store.statePath);
  const lock = join(root, "mutation.lock");
  await mkdir(lock);
  try {
    expect(
      JSON.parse((await cli(root, ["service", "list", "--json"])).out),
    ).toEqual([]);
    expect((await cli(root, ["service", "list"])).out).toContain(
      "No managed services.",
    );
    expect(
      JSON.parse((await cli(root, ["recover", "--dry-run", "--json"])).out),
    ).toEqual([]);
    expect((await cli(root, ["recover", "--dry-run"])).out).toContain(
      "No pending operations.",
    );
    const doctor = JSON.parse((await cli(root, ["doctor", "--json"])).out);
    expect(doctor.receipts).toEqual({});
    expect(doctor.services).toEqual([]);
    expect(doctor.pendingOperations).toEqual([]);
    expect(await exists(lock)).toBe(true);
    expect(await readFile(store.statePath)).toEqual(state);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
  expect(
    JSON.parse((await cli(root, ["recover", "--continue", "--json"])).out),
  ).toEqual([]);
  expect(
    JSON.parse((await cli(root, ["recover", "--rollback", "--json"])).out),
  ).toEqual([]);
});

test("CLI service status preserves missing declarations without registering or controlling services", async () => {
  const f = await fixture("missing-service");
  try {
    await cli(f.root, [
      "source",
      "add",
      "main",
      `http://127.0.0.1:${f.server.port}/`,
    ]);
    await cli(f.root, ["install", "main/tool@1.0.0", "--json"]);
    const store = new Store(f.root);
    // Seed a previously installed declaration whose SCM registration is missing;
    // readonly status must never attempt registration or request elevation.
    await store.mutate(async (state) => {
      const install = Object.values(state.installs)[0]!;
      install.services = [
        {
          name: f.service,
          displayName: "Piko CLI fixture",
          binPath: "tool.exe",
          startType: "demand",
        },
      ];
      await atomicJson(
        join(f.root, install.dir, ".piko-install.json"),
        install,
      );
    });
    const state = await readFile(store.statePath);
    const count = f.requests();
    const lock = join(f.root, "mutation.lock");
    await mkdir(lock);
    try {
      for (const args of [
        ["service", "list"],
        ["service", "main/tool", "status"],
        ["status", "main/tool"],
      ]) {
        const rows = JSON.parse((await cli(f.root, [...args, "--json"])).out);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "main",
          package: "tool",
          version: "1.0.0",
          name: f.service,
          status: "missing",
          owned: false,
        });
      }
      const table = (await cli(f.root, ["status", "main/tool"])).out;
      expect(table).toContain(f.service);
      expect(table).toContain("missing");
      expect(f.requests()).toBe(count);
      expect(await readFile(store.statePath)).toEqual(state);
      expect(await exists(lock)).toBe(true);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  } finally {
    f.server.stop(true);
  }
});

test("CLI offline installation and dependency/distribution resolution never request network", async () => {
  const f = await fixture("offline");
  try {
    await cli(f.root, [
      "source",
      "add",
      "main",
      `http://127.0.0.1:${f.server.port}/`,
    ]);
    await cli(f.root, ["install", "main/tool@1.0.0", "--json"]);
    const count = f.requests();
    await cli(f.root, ["install", "main/tool@1.0.0", "--offline", "--json"]);
    await cli(f.root, ["install", "main/tool@99.0.0", "--offline"], 1);
    await cli(
      f.root,
      ["install", "main/tool@99.0.0", "--offline", "--with-deps", "--dry-run"],
      1,
    );
    await cli(
      f.root,
      ["install", "main/tool", "--offline", "--distribution", "missing-vendor"],
      1,
    );
    expect(f.requests()).toBe(count);
  } finally {
    f.server.stop(true);
  }
});

test("CLI rejects incompatible service, recovery and source arguments before mutation", async () => {
  const root = join(work, "invalid");
  const cases = [
    ["recover", "--continue", "--rollback"],
    ["recover", "--dry-run", "--force"],
    ["recover", "extra"],
    ["service", "list", "extra"],
    ["service", "tool", "status", "extra"],
    ["service", "tool", "restart", "--force"],
    ["service", "list", "--with-service"],
    ["source", "add", "main", "https://example.invalid/", "--type", "git"],
    ["source", "add", "main", "https://example.invalid/", "--ref", "main"],
    ["source", "refresh", "main", "extra"],
    ["install", "main/tool", "--offline", "--refresh"],
    ["install", "main/tool", "--skip-checksum", "--with-service"],
    ["update", "piko", "--with-service"],
    ["update", "*", "--distribution", "vendor"],
  ];
  for (const args of cases) expect((await cli(root, args, 1)).err).not.toBe("");
  expect(await exists(root)).toBe(false);
});
