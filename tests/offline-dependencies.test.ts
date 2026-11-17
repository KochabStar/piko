import { afterAll, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import {
  planDependencies,
  installWithDependencies,
} from "../src/dependency-install.ts";
import { artifactBytes } from "../src/cache.ts";
import { sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-offline-dependencies-"));
const artifact = Buffer.from("offline dependency fixture; never executed");
let requests = 0;
let rejectNetwork = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    requests++;
    if (rejectNetwork)
      return new Response("unexpected network", { status: 400 });
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          runtime: {
            latest: "1.0.0",
            versions: { "1.0.0": "runtime.json" },
            aliases: { stable: "1" },
          },
          consumer: { latest: "1.0.0", versions: { "1.0.0": "consumer.json" } },
        },
      });
    if (path === "/artifact") return new Response(artifact);
    const name = path === "/runtime.json" ? "runtime" : "consumer";
    return Response.json({
      schemaVersion: 1,
      name,
      version: "1.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/artifact`,
          sha256: sha256(artifact),
          format: "file",
          file: "tool.exe",
          bin: { [name === "runtime" ? "lua" : "consumer"]: "tool.exe" },
          ...(name === "consumer"
            ? {
                depends: [{ package: "runtime@stable", commands: ["lua"] }],
              }
            : {}),
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
    maxRetries: 20,
    retryDelay: 100,
  });
});

test("offline dependency plans bind consent and install cached graphs without metadata or artifact fetches", async () => {
  const seed = new Packages(join(work, "seed"));
  await seed.addSource("main", `http://127.0.0.1:${server.port}/`);
  await planDependencies(seed, "main/consumer@1.0.0");
  await artifactBytes(
    seed.root,
    `http://127.0.0.1:${server.port}/artifact`,
    sha256(artifact),
  );
  const cached = new Packages(join(work, "offline"));
  const source = structuredClone((await seed.store.read()).sources.main!);
  source.fetchedAt = new Date(0).toISOString();
  await cached.store.mutate(async (state) => {
    state.sources.main = source;
  });
  await cp(join(seed.root, "sources"), join(cached.root, "sources"), {
    recursive: true,
  });
  await cp(join(seed.root, "cache"), join(cached.root, "cache"), {
    recursive: true,
  });
  const before = requests;
  rejectNetwork = true;
  try {
    const plan = await planDependencies(cached, "main/consumer@1.0.0", {
      offline: true,
    });
    await expect(
      installWithDependencies(cached, "main/consumer@1.0.0", plan.binding, {
        offline: true,
        withService: true,
      }),
    ).rejects.toThrow("Dependency plan changed");
    expect(Object.keys((await cached.store.read()).installs)).toEqual([]);
    const result = await installWithDependencies(
      cached,
      "main/consumer@1.0.0",
      plan.binding,
      { offline: true },
    );
    expect(result.status).toBe("completed");
    const state = await cached.store.read();
    const runtime = Object.values(state.installs).find(
      (install) => install.name === "runtime",
    )!;
    const consumer = Object.values(state.installs).find(
      (install) => install.name === "consumer",
    )!;
    expect(runtime.version).toBe("1.0.0");
    expect(state.defaults[runtime.key]?.id).toBe(runtime.id);
    expect(state.commands.lua).toBe(runtime.key);
    expect(state.defaults[consumer.key]).toBeUndefined();
    expect(state.receipts?.[runtime.id]?.packageId).toBe(runtime.id);
    expect(state.receipts?.[consumer.id]?.packageId).toBe(consumer.id);
    expect(requests).toBe(before);
  } finally {
    rejectNetwork = false;
  }
});
