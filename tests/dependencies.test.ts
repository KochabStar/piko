import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeManifest } from "../src/catalog.ts";
import { Packages } from "../src/packages.ts";
import { exists, sha256 } from "../src/util.ts";
import { checkRuntimeDependencies } from "../src/dependencies.ts";
import {
  planDependencies,
  installWithDependencies,
} from "../src/dependency-install.ts";
import type { Manifest } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-dependencies-"));
const bytes = Buffer.from("dependency fixture, not an executable");
let artifactRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    if (path.at(-1) === "index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          [
            "runtime",
            "consumer",
            "directory-only",
            "unconfigured",
            "conflict",
            "outer",
            "cycle-a",
            "cycle-b",
            "shared",
            "left",
            "right",
          ].map((name) => [
            name,
            {
              latest: "2.0.0",
              versions: {
                "1.0.0": `${name}/1.0.0.json`,
                "1.1.0": `${name}/1.1.0.json`,
                "2.0.0": `${name}/2.0.0.json`,
              },
            },
          ]),
        ),
      });
    if (path.at(-1) === "file.exe") {
      artifactRequests++;
      return new Response(bytes);
    }
    const name = path.at(-2)!;
    const version = path.at(-1)!.replace(/\.json$/, "");
    const m = manifest(name, version);
    const platform = m.platforms["windows-x64"]!;
    if (name === "consumer")
      platform.depends = [
        {
          package: version === "2.0.0" ? "runtime@2" : "runtime@1.0",
          commands: ["lua"],
        },
      ];
    if (name === "directory-only") platform.depends = [{ package: "runtime" }];
    if (name === "outer") platform.depends = [{ package: "consumer@1.0.0" }];
    if (name === "cycle-a") platform.depends = [{ package: "cycle-b" }];
    if (name === "cycle-b") platform.depends = [{ package: "cycle-a" }];
    if (name === "shared")
      platform.depends = [{ package: "left" }, { package: "right" }];
    if (name === "left")
      platform.depends = [{ package: "runtime@latest", commands: ["lua"] }];
    if (name === "right")
      platform.depends = [{ package: "runtime@1.0", commands: ["lua"] }];
    if (name === "unconfigured")
      platform.depends = [{ package: "missing/runtime", commands: ["lua"] }];
    return Response.json(m);
  },
});
const url = `http://127.0.0.1:${server.port}/`;
function manifest(name = "consumer", version = "1.0.0"): Manifest {
  return {
    schemaVersion: 1,
    name,
    version,
    platforms: {
      "windows-x64": {
        url: url + "file.exe",
        sha256: sha256(bytes),
        format: "file",
        file: "tool.exe",
        bin: {
          [name === "runtime" || name === "conflict" ? "lua" : name]:
            "tool.exe",
        },
      },
    },
  };
}
async function manager() {
  const p = new Packages(join(work, crypto.randomUUID()));
  await p.addSource("main", url);
  return p;
}
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

test("dependency declarations reject invalid shapes, names, versions and commands", () => {
  for (const depends of [
    null,
    "runtime",
    {},
    [null],
    ["runtime"],
    [{}],
    [{ package: "../runtime" }],
    [{ package: "npm:runtime" }],
    [{ package: "consumer" }],
    [{ package: "piko" }],
    [{ package: "runtime@" }],
    [{ package: "runtime@^1" }],
    [{ package: "runtime@>=1" }],
    [{ package: "runtime@1 || 2" }],
    [{ package: "runtime@1\n" }],
    [{ package: "runtime@release;exit" }],
    [{ package: "runtime@$(exit)" }],
    [{ package: "runtime@`exit`" }],
    [{ package: "runtime", optional: true }],
    [{ package: "runtime" }, { package: "Runtime@1" }],
    [{ package: "runtime", commands: "lua" }],
    [{ package: "runtime", commands: [null] }],
    [{ package: "runtime", commands: ["Lua"] }],
    [{ package: "runtime", commands: ["lua", "lua"] }],
    [{ package: "runtime", commands: ["install.cmd"] }],
  ]) {
    const m = manifest();
    Object.assign(m.platforms["windows-x64"]!, { depends });
    expect(() => normalizeManifest(m, m.name, m.version)).toThrow();
  }
  for (const request of [
    "",
    "@latest",
    "@1",
    "@1.0",
    "@1.0.0",
    "@release-xyz",
  ]) {
    const m = manifest();
    m.platforms["windows-x64"]!.depends = [
      { package: "runtime" + request, commands: ["lua"] },
    ];
    expect(normalizeManifest(m, m.name, m.version)).toEqual(m);
  }
});

test("missing dependencies fail before download without changing installs, defaults or commands", async () => {
  const p = await manager(),
    before = await p.store.read(),
    requests = artifactRequests;
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "piko install main/runtime@1.0",
  );
  await expect(p.install("main/consumer@1.0.0", true)).rejects.toThrow(
    "Unmet dependencies",
  );
  expect(await p.store.read()).toEqual(before);
  expect(artifactRequests).toBe(requests);
  expect(await exists(join(p.root, "staging"))).toBe(false);
  const info = await p.info("main/consumer@1.0.0");
  expect(info.available[0]?.version).toBe("1.0.0");
  expect(info.available[0]?.dependencies?.[0]).toMatchObject({
    package: "main/runtime@1.0",
    satisfied: false,
    selectedVersion: null,
  });
});

test("installed is not selected; commands must resolve to the dependency's selected version", async () => {
  const p = await manager();
  const runtime = await p.install("main/runtime@1.0.0");
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "no default selected",
  );
  await expect(p.install("main/consumer@2.0.0")).rejects.toThrow(
    "piko install main/runtime@2",
  );
  await p.use("main/runtime@1.0.0", { noCommands: true });
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "No default provider for lua",
  );
  // A data/library dependency may require current without owning a command.
  await p.install("main/directory-only@1.0.0");
  await p.claimCommand("lua", "main/runtime");
  const before = await p.store.read();
  const consumer = await p.install("main/consumer@1.0.0");
  const state = await p.store.read();
  expect(state.defaults).toEqual(before.defaults);
  expect(state.commands).toEqual(before.commands);
  expect(state.defaults[consumer.key]).toBeUndefined();
  expect(state.defaults[runtime.key]?.id).toBe(runtime.id);
  expect(
    (await p.info("main/consumer@1.0.0")).available[0]?.dependencies?.[0]
      ?.satisfied,
  ).toBe(true);
  await p.releaseCommand("lua");
  // Aliases are valid only when they resolve to this exact selected dependency.
  await p.aliasCommand("lua", "main/runtime", "lua");
  await p.install("main/consumer@1.0.0");
  await p.removeAlias("lua");
  await p.install("main/conflict@1.0.0");
  await p.use("main/conflict@1.0.0");
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "owned by another package",
  );
});

test("dependencies are bound to source identity rather than same-name packages or external PATH", async () => {
  const p = await manager();
  await p.addSource("other", url + "other/");
  await p.install("other/runtime@1.0.0");
  await p.use("other/runtime@1.0.0");
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "Not installed",
  );
  await expect(p.install("main/unconfigured@1.0.0")).rejects.toThrow(
    "source missing is not configured",
  );
  await p.addSource("missing", url + "missing/");
  await expect(p.install("missing/runtime@1.0.0")).rejects.toThrow(
    "another source",
  );
  await p.unuse("other/runtime");
  await p.uninstall("other/runtime@1.0.0");
  await p.install("missing/runtime@1.0.0");
  await p.use("missing/runtime@1.0.0", { noCommands: true });
  await p.claimCommand("lua", "missing/runtime");
  await p.install("main/unconfigured@1.0.0");
});

test("selected version must match; failed update retains old default and dependencies", async () => {
  const p = await manager();
  await p.install("main/runtime@1.0.0");
  await p.install("main/runtime@1.1.0");
  await p.use("main/runtime@1.1.0");
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "does not match 1.0",
  );
  await p.use("main/runtime@1.0.0");
  const consumer = await p.install("main/consumer@1.0.0");
  await p.use("main/consumer@latest");
  const before = await p.store.read();
  await expect(p.update("main/consumer")).rejects.toThrow("does not match 2");
  expect(await p.store.read()).toEqual(before);
  expect(before.defaults[consumer.key]?.id).toBe(consumer.id);
  await p.install("main/runtime@2.0.0");
  await expect(p.use("main/runtime@2.0.0")).rejects.toThrow(
    "Dependency protection",
  );
  await p.unuse("main/consumer");
  await p.use("main/runtime@2.0.0");
  await p.install("main/consumer@2.0.0");
  await p.use("main/consumer@latest");
  const updated = await p.update("main/consumer");
  expect(updated.version).toBe("2.0.0");
  expect((await p.store.read()).defaults[consumer.key]?.id).toBe(updated.id);
});

test("explicit dependency plan installs transitively, leaves root unselected and refuses stale approval or cycles", async () => {
  const p = await manager(),
    before = await p.store.read();
  const plan = await planDependencies(p, "main/outer@1.0.0");
  expect(plan.steps.map((s) => s.package)).toEqual([
    "main/runtime",
    "main/consumer",
    "main/outer",
  ]);
  expect(await p.store.read()).toEqual(before);
  await expect(
    installWithDependencies(p, "main/outer@1.0.0", "bad"),
  ).rejects.toThrow("plan changed");
  await installWithDependencies(p, "main/outer@1.0.0", plan.binding);
  const state = await p.store.read();
  const outer = Object.values(state.installs).find((i) => i.name === "outer")!;
  expect(Object.keys(state.defaults).length).toBe(2);
  expect(state.defaults[outer.key]).toBeUndefined();
  await p.use("main/outer@1.0.0");
  await expect(p.unuse("main/consumer")).rejects.toThrow(
    "Dependency protection",
  );
  await expect(planDependencies(p, "main/cycle-a")).rejects.toThrow("cycle");
  const conflict = await manager();
  await conflict.install("main/runtime@2.0.0");
  await conflict.use("main/runtime@2.0.0");
  await expect(planDependencies(conflict, "main/outer@1.0.0")).rejects.toThrow(
    "constraints conflict",
  );
});

test("shared dependency requests converge before installation without replacing existing defaults", async () => {
  const p = await manager();
  const plan = await planDependencies(p, "main/shared@1.0.0");
  expect(plan.steps.find((s) => s.package === "main/runtime")?.version).toBe(
    "1.0.0",
  );
  expect(plan.steps.filter((s) => s.package === "main/runtime")).toHaveLength(
    1,
  );
  await installWithDependencies(p, "main/shared@1.0.0", plan.binding);
  const state = await p.store.read();
  const runtime = Object.values(state.installs).find(
    (i) => i.name === "runtime",
  )!;
  expect(state.defaults[runtime.key]?.id).toBe(runtime.id);
  expect(runtime.version).toBe("1.0.0");
});

test("active dependency protection covers command transfers, aliases, unuse and forced uninstall", async () => {
  const p = await manager();
  const runtime = await p.install("main/runtime@1.0.0");
  await p.use("main/runtime@1.0.0");
  const consumer = await p.install("main/consumer@1.0.0");
  expect(consumer.depends?.length).toBe(1);
  expect((await p.store.read()).schemaVersion).toBe(8);
  await p.use("main/consumer@1.0.0");
  const before = await p.store.read();
  await expect(p.releaseCommand("lua")).rejects.toThrow(
    "Dependency protection",
  );
  await expect(p.unuse("main/runtime")).rejects.toThrow(
    "Dependency protection",
  );
  await expect(p.uninstall("main/runtime@1.0.0", true)).rejects.toThrow(
    "Dependency protection",
  );
  expect(await p.store.read()).toEqual(before);
  expect(await exists(join(p.root, runtime.dir, "tool.exe"))).toBe(true);
  await p.unuse("main/consumer");
  await p.releaseCommand("lua");
  await p.aliasCommand("lua", "main/runtime", "lua");
  await p.use("main/consumer@1.0.0");
  await expect(p.removeAlias("lua")).rejects.toThrow("Dependency protection");
  // External loss is diagnosed again at launch, including transitive consumers.
  const file = join(p.root, runtime.dir, "tool.exe");
  await rename(file, file + ".save");
  await expect(
    checkRuntimeDependencies(p.root, await p.store.read(), consumer),
  ).rejects.toThrow("Runtime dependencies");
  await rename(file + ".save", file);
  await p.unuse("main/consumer");
  await p.unuse("main/runtime");
  await expect(p.use("main/consumer@1.0.0")).rejects.toThrow(
    "Dependency protection",
  );
});

test("compiled CLI reports dependencies and rejects missing ones without modifying defaults", async () => {
  const p = await manager();
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [join(import.meta.dir, "../dist/piko.exe"), ...args],
      {
        env: { ...process.env, PIKO_HOME: p.root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, error, code };
  };
  const info = await run(["info", "main/consumer@1.0.0"]);
  expect(info.code).toBe(0);
  expect(JSON.parse(info.out).available[0].dependencies[0].satisfied).toBe(
    false,
  );
  const before = await p.store.read();
  const missing = await run(["install", "main/consumer@1.0.0"]);
  expect(missing.code).toBe(1);
  expect(missing.error).toContain("piko install main/runtime@1.0");
  expect(await p.store.read()).toEqual(before);
  await p.install("main/runtime@1.0.0");
  await p.use("main/runtime@1.0.0");
  expect((await run(["install", "main/consumer@1.0.0"])).code).toBe(0);
  expect(
    JSON.parse((await run(["info", "main/consumer@1.0.0"])).out).available[0]
      .dependencies[0].satisfied,
  ).toBe(true);
});

test("missing or linked dependency files are not considered usable", async () => {
  const p = await manager();
  const runtime = await p.install("main/runtime@1.0.0");
  await p.use("main/runtime@1.0.0");
  const file = join(p.root, runtime.dir, "tool.exe"),
    backup = file + ".backup";
  await rename(file, backup);
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "Unmet dependencies",
  );
  await rename(backup, file);
  const directory = join(p.root, runtime.dir),
    moved = directory + "-backup";
  await rename(directory, moved);
  await symlink(moved, directory, "junction");
  await expect(p.install("main/consumer@1.0.0")).rejects.toThrow(
    "Refusing linked managed path",
  );
  await rm(directory);
  await rename(moved, directory);
});
