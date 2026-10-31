import { buildSandboxRegistry } from "../scripts/sandbox-registry.ts";
import { beforeAll, afterAll, test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  cp,
  copyFile,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { packageKey, installId, validateState } from "../src/store.ts";
import { makeSource, parseSpec } from "../src/catalog.ts";
import { Packages } from "../src/packages.ts";
import { npmContext } from "../src/npm.ts";
import { checkNpmEngines, checkNpmRuntime } from "../src/npm-runtime.ts";
import { verifyNpmPolicy } from "../src/npm-policy.ts";
import {
  exportInventory,
  exportLockedInventory,
  importInventory,
  planInventory,
} from "../src/inventory.ts";
import { npmTreeHash, npmSnapshotPath } from "../src/scripts.ts";
import { exists, capture, atomicJson } from "../src/util.ts";
import type { Install } from "../src/types.ts";

const root = await mkdtemp(join(tmpdir(), "piko npm tests-"));
const manager = new Packages(root),
  oldRegistry = process.env.PIKO_NPM_REGISTRY;
const node = Bun.which("node.exe") ?? Bun.which("node");
if (!node)
  throw new Error(
    "Integration tests require a development Node/npm installation",
  );
const nodeSource = makeSource(
  "fixture",
  "https://node-fixture.invalid/",
  "http",
);
const archives: Record<string, Uint8Array> = {},
  metadata: Record<string, any> = {};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
      .slice(1)
      .replace(/^private\//, "");
    if (archives[path]) return new Response(new Uint8Array(archives[path]!));
    if (metadata[path]) {
      const value = structuredClone(metadata[path]);
      if (new URL(request.url).pathname.startsWith("/private/"))
        for (const version of Object.values(value.versions ?? {}) as any[])
          version.dist.tarball = version.dist.tarball.replace(
            registry,
            registry + "private/",
          );
      return Response.json(value);
    }
    return new Response("not found", { status: 404 });
  },
});
const registry = `http://127.0.0.1:${server.port}/`;

beforeAll(async () => {
  const key = packageKey(nodeSource, "node"),
    version = "26.12.1",
    id = installId(key, version),
    dir = join("apps", key, version);
  await mkdir(join(root, dir, "node_modules"), { recursive: true });
  await copyFile(node!, join(root, dir, "node.exe"));
  await cp(
    join(dirname(node!), "node_modules", "npm"),
    join(root, dir, "node_modules", "npm"),
    { recursive: true },
  );
  const installation: Install = {
    id,
    key,
    name: "node",
    version,
    request: version,
    source: nodeSource,
    dir,
    bins: { node: { path: "node.exe", kind: "native" } },
    persist: [],
    verified: true,
    checksum: "fixture",
    kind: "portable",
    manifestHash: "fixture",
  };
  await manager.store.mutate(async (s) => {
    s.installs[id] = installation;
    s.defaults[key] = { id, request: version };
    s.commands.node = key;
  });
  for (const version of ["1.0.0", "1.1.0", "2.0.0", "2.1.0"]) {
    const name = "@piko-fixture/cli";
    const pkg = {
      name,
      version,
      bin: { "piko-fixture-cli": "cli.js" },
      dependencies: {
        "piko-fixture-dep": "1.0.0",
        ...(version === "2.0.0"
          ? { "piko-fixture-alias": "npm:piko-fixture-dep@1.0.0" }
          : {}),
      },
      scripts: {
        ...(version === "2.0.0"
          ? { prepare: 'node -e "process.exit(99)"' }
          : version === "2.1.0"
            ? {
                prepare: "piko-fixture-build",
                preprepare: 'node -e "process.exit(98)"',
                postprepare: 'node -e "process.exit(97)"',
              }
            : {}),
        postinstall: `node -e "require('fs').writeFileSync('SHOULD_NOT_EXIST','approved');if(process.env.PIKO_FIXTURE_FAIL){require('fs').writeFileSync('cli.js','broken');process.exit(23)}"`,
      },
    };
    const bytes = await new Bun.Archive(
      {
        "package/package.json": JSON.stringify(pkg),
        "package/cli.js":
          "#!/usr/bin/env node\nconsole.log(JSON.stringify({node:process.version,args:process.argv.slice(2),toolEnv:process.env.TOOL_MESSAGE}));\n",
      },
      { compress: "gzip" },
    ).bytes();
    const path = `@piko-fixture/cli/-/cli-${version}.tgz`;
    archives[path] = bytes;
    const entry = {
      ...pkg,
      dist: {
        tarball: registry + path,
        integrity:
          "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      },
    };
    metadata[name] ??= { name, "dist-tags": { latest: "1.1.0" }, versions: {} };
    metadata[name].versions[version] = entry;
  }
  const dep = {
    name: "piko-fixture-dep",
    version: "1.0.0",
    bin: { "piko-fixture-build": "build.cjs" },
    scripts: {
      postinstall: `node -e "require('fs').writeFileSync('DEPENDENCY_SHOULD_NOT_EXIST','unsafe')"`,
    },
  };
  const bytes = await new Bun.Archive(
    {
      "package/package.json": JSON.stringify(dep),
      "package/build.cjs":
        "#!/usr/bin/env node\nrequire('fs').writeFileSync('PREPARE_COMPLETED','private bin executed');",
    },
    { compress: "gzip" },
  ).bytes();
  const path = "piko-fixture-dep/-/piko-fixture-dep-1.0.0.tgz";
  archives[path] = bytes;
  metadata[dep.name] = {
    name: dep.name,
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        ...dep,
        dist: {
          tarball: registry + path,
          integrity:
            "sha512-" + createHash("sha512").update(bytes).digest("base64"),
        },
      },
    },
  };
  process.env.PIKO_NPM_REGISTRY = registry;
});
afterAll(async () => {
  if (oldRegistry === undefined) delete process.env.PIKO_NPM_REGISTRY;
  else process.env.PIKO_NPM_REGISTRY = oldRegistry;
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

test("scoped registries retain separate provenance and locked export restores the exact graph", async () => {
  const previous = process.env.PIKO_NPM_SCOPED_REGISTRIES;
  process.env.PIKO_NPM_SCOPED_REGISTRIES = JSON.stringify({
    "@piko-fixture": registry + "private/",
  });
  try {
    const cli = await manager.install("npm:@piko-fixture/cli@1.0.0");
    expect(cli.source.url).toBe(registry + "private/");
    const locked = await exportLockedInventory(manager);
    expect(locked.npmRegistries?.["@piko-fixture/cli"]).toBe(
      registry + "private/",
    );
    expect(locked.npmLocks?.["npm:@piko-fixture/cli@1.0.0"]).toBeDefined();
    // Restore just the CLI into a root with an explicitly selected managed Node.
    const target = new Packages(join(root, "locked-restore"));
    const state = await manager.store.read();
    const ni = Object.values(state.installs).find((i) => i.name === "node")!;
    await mkdir(join(target.root, ni.dir), { recursive: true });
    await cp(join(root, ni.dir), join(target.root, ni.dir), {
      recursive: true,
    });
    await target.store.mutate(async (s) => {
      s.installs[ni.id] = ni;
      s.defaults[ni.key] = state.defaults[ni.key]!;
      s.commands.node = ni.key;
    });
    const inventory = {
      ...locked,
      sources: [],
      packages: locked.packages.filter((p) => p.source === "npm"),
      aliases: [],
      integrations: [],
    };
    await importInventory(target, inventory, { confirmed: true });
    const restored = Object.values((await target.store.read()).installs).find(
      (i) => i.kind === "npm",
    )!;
    expect(restored.checksum).toBe(cli.checksum);
    expect(restored.npmBuild?.approvals).toEqual({});
    await manager.uninstall("npm:@piko-fixture/cli@1.0.0");
  } finally {
    if (previous === undefined) delete process.env.PIKO_NPM_SCOPED_REGISTRIES;
    else process.env.PIKO_NPM_SCOPED_REGISTRIES = previous;
  }
}, 60000);

test("npm compatibility checks nested engines and native ABI; script policy is tested rather than version-pinned", async () => {
  const cli = await manager.install("npm:@piko-fixture/cli@1.0.0");
  const context = await npmContext(root, await manager.store.read(), cli.name);
  expect(cli.npmCompatibility?.nodeAbi).toMatch(/^\d+$/);
  const changed = structuredClone(cli);
  changed.npmCompatibility!.engines["node_modules/nested"] = "<1";
  expect(() => checkNpmEngines(changed, "26.12.1")).toThrow("nested");
  changed.npmCompatibility!.engines = {};
  changed.npmCompatibility!.nodeAbi = "0";
  changed.npmCompatibility!.nativeFiles = ["node_modules/addon.node"];
  await expect(
    checkNpmRuntime(root, changed, context.node, "26.12.1"),
  ).rejects.toThrow("ABI");
  await verifyNpmPolicy({ ...context, version: "11.21.0" }, root);
}, 60000);

test("npm specs retain scoped names and exact requests", () => {
  expect(parseSpec("npm:@piko-fixture/cli@1")).toEqual({
    source: "npm",
    name: "@piko-fixture/cli",
    request: "1",
  });
  expect(parseSpec("npm:prettier")).toEqual({
    source: "npm",
    name: "prettier",
    request: undefined,
  });
  expect(() => parseSpec("npm:../../escape")).toThrow();
});

test("npm requires an explicitly selected managed Node", async () => {
  const dir = join(root, "empty");
  await expect(new Packages(dir).install("npm:prettier")).rejects.toThrow(
    "select Node",
  );
});

test("npm installs scoped CLI in its own version directory and never runs lifecycle scripts", async () => {
  const i = await manager.install("npm:@piko-fixture/cli@1.0.0");
  const file = join(
    root,
    i.dir,
    "node_modules",
    "@piko-fixture",
    "cli",
    "cli.js",
  );
  expect(await exists(file)).toBe(true);
  expect(await exists(join(root, i.dir, "package-lock.json"))).toBe(true);
  expect(
    await exists(
      join(
        root,
        i.dir,
        "node_modules",
        "@piko-fixture",
        "cli",
        "SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  expect(
    await exists(
      join(
        root,
        i.dir,
        "node_modules",
        "piko-fixture-dep",
        "DEPENDENCY_SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  expect(i.scripts).toHaveLength(2);
  expect((await manager.store.read()).defaults[i.key]).toBeUndefined();
  await manager.use("npm:@piko-fixture/cli@1");
  const newer = await manager.update("npm:@piko-fixture/cli");
  expect(newer.version).toBe("1.1.0");
  expect(await exists(file)).toBe(true);
  expect((await manager.store.read()).defaults[newer.key]?.request).toBe("1");
  const unchangedState = await readFile(manager.store.statePath, "utf8");
  expect((await manager.update("npm:@piko-fixture/cli")).id).toBe(newer.id);
  expect(await readFile(manager.store.statePath, "utf8")).toBe(unchangedState);
}, 60000);

test("compiled EXE supports native and npm commands from direct spawn, PowerShell and CMD", async () => {
  const built = await Bun.build({
    entrypoints: ["src/cli.ts"],
    compile: {
      target: "bun-windows-x64",
      outfile: join(root, "piko.exe"),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  expect(built.success).toBe(true);
  const env = { ...process.env, PIKO_HOME: root, PIKO_NPM_REGISTRY: registry };
  const run = async (exe: string, args: string[]) => {
    const child = Bun.spawn([exe, ...args], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) throw new Error(`${exit}: ${stderr}`);
    return stdout.trim();
  };
  await run(join(root, "piko.exe"), ["setup"]);
  // Recreate existing command entries as executable shims now that Piko is installed.
  await run(join(root, "piko.exe"), ["use", "fixture/node@26.12.1"]);
  await run(join(root, "piko.exe"), ["use", "npm:@piko-fixture/cli@1"]);
  const shim = join(root, "shims", "piko-fixture-cli.exe");
  const args = ["中文 空格", 'a"b', "&|<>^%!*", "", "trail\\"];
  expect(JSON.parse(await run(shim, args)).args).toEqual(args);
  const native = await run(join(root, "shims", "node.exe"), ["--version"]);
  expect(native).toMatch(/^v26\./);
  const psScript = `& '${shim.replaceAll("'", "''")}' 'PowerShell 空格'`;
  expect(
    JSON.parse(
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        psScript,
      ]),
    ).args,
  ).toEqual(["PowerShell 空格"]);
  const batch = join(root, "invoke.cmd");
  await writeFile(
    batch,
    `@echo off\r\n"${shim}" "CMD spaces"\r\nexit /b %errorlevel%\r\n`,
  );
  expect(
    JSON.parse(await run("cmd.exe", ["/d", "/c", "invoke.cmd"])).args,
  ).toEqual(["CMD spaces"]);
  const mainExe = join(root, "shims", "piko.exe");
  const cleanEnv = { ...env };
  Reflect.deleteProperty(cleanEnv, "PIKO_HOME");
  const noHome = Bun.spawn([mainExe, "list", "--json"], {
    env: cleanEnv,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    JSON.parse(await new Response(noHome.stdout).text()).length,
  ).toBeGreaterThan(0);
  expect(await noHome.exited).toBe(0);
  await run(join(root, "piko.exe"), [
    "command",
    "alias",
    "alternate-cli",
    "npm:@piko-fixture/cli",
    "piko-fixture-cli",
  ]);
  const alternate = join(root, "shims", "alternate-cli.exe");
  expect(JSON.parse(await run(alternate, ["alias argument"])).args).toEqual([
    "alias argument",
  ]);
  expect(
    await run(join(root, "piko.exe"), ["which", "alternate-cli"]),
  ).toContain("cli.js");
  await run(join(root, "piko.exe"), ["command", "release", "piko-fixture-cli"]);
  expect(await exists(shim)).toBe(false);
  expect(JSON.parse(await run(alternate, ["alias still active"])).args).toEqual(
    ["alias still active"],
  );
  await run(join(root, "piko.exe"), [
    "command",
    "claim",
    "piko-fixture-cli",
    "npm:@piko-fixture/cli",
  ]);
  expect(await exists(shim)).toBe(true);
  await run(join(root, "piko.exe"), ["command", "unalias", "alternate-cli"]);
  expect(await exists(alternate)).toBe(false);
  await run(join(root, "piko.exe"), [
    "scripts",
    "approve",
    "npm:@piko-fixture/cli@1.0.0",
    "--yes",
  ]);
  const original = Object.values((await manager.store.read()).installs).find(
    (i) => i.kind === "npm" && i.version === "1.0.0",
  )!;
  expect(
    await exists(
      join(
        root,
        original.dir,
        "node_modules/@piko-fixture/cli/SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  await run(join(root, "piko.exe"), [
    "scripts",
    "rebuild",
    "npm:@piko-fixture/cli@1.0.0",
  ]);
  expect(
    await exists(
      join(
        root,
        original.dir,
        "node_modules/@piko-fixture/cli/SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(true);
  expect(
    await exists(
      join(
        root,
        original.dir,
        "node_modules/piko-fixture-dep/DEPENDENCY_SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  await run(join(root, "piko.exe"), [
    "scripts",
    "revoke",
    "npm:@piko-fixture/cli@1.0.0",
  ]);
  expect(
    (await manager.inspectScripts("npm:@piko-fixture/cli@1.0.0")).scripts.every(
      (s) => !s.approved,
    ),
  ).toBe(true);
  await manager.store.mutate(async (state) => {
    state.schemaVersion = 4;
    const selected =
      state.defaults[
        Object.values(state.installs).find(
          (i) => i.kind === "npm" && i.version === "1.1.0",
        )!.key
      ]!;
    state.installs[selected.id]!.env = { TOOL_MESSAGE: "from-{version}" };
  });
  expect(JSON.parse(await run(shim, ["environment"])).toolEnv).toBe(
    "from-1.1.0",
  );
  const interactive = join(root, "echo-input.cjs");
  await writeFile(
    interactive,
    "process.stdin.once('data',b=>{process.stdout.write(b);process.exit(19)});",
  );
  const echo = Bun.spawn([join(root, "shims/node.exe"), interactive], {
    env,
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await echo.stdin.write("stdin-through-shim");
  echo.stdin.end();
  expect(await new Response(echo.stdout).text()).toBe("stdin-through-shim");
  expect(await echo.exited).toBe(19);
  const signalProbe = join(root, "signal.cjs"),
    marker = join(root, "ctrl-c-marker");
  await writeFile(
    signalProbe,
    "const fs=require('fs'),p=process.argv[2];process.on('SIGINT',()=>{fs.writeFileSync(p,'interrupted');process.exit(130)});fs.writeFileSync(p+'.ready','ready');setInterval(()=>{},1000);",
  );
  const baselineMarker = join(root, "baseline-ctrl-c");
  await capture(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(process.cwd(), "tests/ctrl-c.test.ps1"),
      "-Executable",
      node!,
      "-Probe",
      signalProbe,
      "-Marker",
      baselineMarker,
    ],
    { env, cwd: root },
  );
  const signalTest = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(process.cwd(), "tests/ctrl-c.test.ps1"),
      "-Executable",
      join(root, "shims/node.exe"),
      "-Probe",
      signalProbe,
      "-Marker",
      marker,
    ],
    { env, cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [signalOut, signalErr, signalExit] = await Promise.all([
    new Response(signalTest.stdout).text(),
    new Response(signalTest.stderr).text(),
    signalTest.exited,
  ]);
  if (signalExit !== 0)
    throw new Error("Ctrl+C test failed: " + signalOut + signalErr);
  expect(await readFile(marker, "utf8")).toBe("interrupted");
  const ienv = await manager.store.read();
  for (const inst of Object.values(ienv.installs))
    if (inst.kind === "npm" && inst.version === "1.1.0")
      expect(inst.env?.TOOL_MESSAGE).toBe("from-{version}");
  await run(join(root, "piko.exe"), ["unuse", "npm:@piko-fixture/cli"]);
  expect(await exists(shim)).toBe(false);
  expect(await exists(join(root, "apps", "piko", "state.json"))).toBe(true);
  expect(await exists(join(root, "state.json"))).toBe(false);
}, 60000);

test("content-bound approval runs only the selected package and revocation rebuilds clean content", async () => {
  const spec = "npm:@piko-fixture/cli@1.1.0";
  const initial = await manager.inspectScripts(spec),
    top = initial.scripts.find((s) => s.name === "@piko-fixture/cli")!,
    dep = initial.scripts.find((s) => s.name === "piko-fixture-dep")!;
  expect(top.approved).toBe(false);
  await expect(manager.rebuildScripts(spec)).rejects.toThrow(
    "No content-bound",
  );
  await expect(
    manager.approveScripts(spec, top.path, "0".repeat(64)),
  ).rejects.toThrow("changed");
  await manager.approveScripts(spec, top.path, top.binding);
  const legacy = structuredClone(await manager.store.read());
  legacy.schemaVersion = 2;
  expect(() => validateState(legacy)).toThrow("schema 8");
  await manager.use("npm:@piko-fixture/cli@1.1.0");
  const selection = structuredClone((await manager.store.read()).defaults);
  const polluted = [
    "npm_config_dangerously_allow_all_scripts",
    "npm_config_strict_allow_scripts",
    "npm_config_ignore_scripts",
  ];
  const previous = polluted.map((key) => process.env[key]);
  process.env[polluted[0]!] = "true";
  process.env[polluted[1]!] = "false";
  process.env[polluted[2]!] = "false";
  try {
    await manager.rebuildScripts(spec);
  } finally {
    polluted.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
  const state = await manager.store.read(),
    i = state.installs[initial.install]!;
  expect(await exists(join(root, i.dir, top.path, "SHOULD_NOT_EXIST"))).toBe(
    true,
  );
  expect(
    await exists(join(root, i.dir, dep.path, "DEPENDENCY_SHOULD_NOT_EXIST")),
  ).toBe(false);
  expect(state.defaults).toEqual(selection);
  expect(i.npmBuild!.lastRun!.paths).toEqual([top.path]);
  expect(
    (await manager.inspectScripts("npm:@piko-fixture/cli@1.0.0")).scripts.every(
      (s) => !s.approved,
    ),
  ).toBe(true);
  await manager.revokeScripts(spec, top.path);
  await expect(manager.rebuildScripts(spec)).rejects.toThrow(
    "No content-bound",
  );
  await manager.approveScripts(spec, dep.path, dep.binding);
  await manager.rebuildScripts(spec);
  expect(await exists(join(root, i.dir, top.path, "SHOULD_NOT_EXIST"))).toBe(
    false,
  );
  expect(
    await exists(join(root, i.dir, dep.path, "DEPENDENCY_SHOULD_NOT_EXIST")),
  ).toBe(true);
}, 60000);

test("changed snapshot, installed bytes, failure and links never replace the working installation", async () => {
  const spec = "npm:@piko-fixture/cli@1.0.0",
    plan = await manager.inspectScripts(spec),
    top = plan.scripts.find((s) => s.name === "@piko-fixture/cli")!;
  const state = await manager.store.read(),
    i = state.installs[plan.install]!,
    snapshot = npmSnapshotPath(root, plan.inputHash),
    source = join(snapshot, top.path, "cli.js"),
    live = join(root, i.dir, top.path, "cli.js");
  const bytes = await readFile(source);
  await writeFile(source, Buffer.concat([bytes, Buffer.from("//changed")]));
  await expect(
    manager.approveScripts(spec, top.path, top.binding),
  ).rejects.toThrow("snapshot");
  await writeFile(source, bytes);
  await manager.approveScripts(spec, top.path, top.binding);
  await writeFile(live, Buffer.concat([bytes, Buffer.from("//changed")]));
  await expect(manager.rebuildScripts(spec)).rejects.toThrow("content changed");
  await writeFile(live, bytes);
  const link = join(root, i.dir, top.path, "outside");
  await symlink(join(root, "cache"), link, "junction");
  await expect(manager.rebuildScripts(spec)).rejects.toThrow("Linked");
  await rm(link);
  const oldMarker = await exists(
    join(root, i.dir, top.path, "SHOULD_NOT_EXIST"),
  );
  const shell = process.env.SystemRoot;
  process.env.PIKO_FIXTURE_FAIL = "1";
  try {
    await expect(manager.rebuildScripts(spec)).rejects.toThrow("23");
  } finally {
    delete process.env.PIKO_FIXTURE_FAIL;
  }
  expect(await exists(join(root, i.dir, top.path, "SHOULD_NOT_EXIST"))).toBe(
    oldMarker,
  );
  expect(await readFile(live)).toEqual(bytes);
  expect(await npmTreeHash(join(root, i.dir))).toBe(i.npmBuild!.currentHash);
  process.env.SystemRoot = join(root, "missing-windows");
  try {
    await expect(manager.rebuildScripts(spec)).rejects.toThrow();
  } finally {
    if (shell === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = shell;
  }
  expect(await npmTreeHash(join(root, i.dir))).toBe(i.npmBuild!.currentHash);
  expect(await exists(manager.store.rebuildPath)).toBe(false);
}, 60000);

test("npm rebuild journal restores uncommitted files and cleans committed backups", async () => {
  const spec = "npm:@piko-fixture/cli@1.0.0",
    plan = await manager.inspectScripts(spec),
    before = (await manager.store.read()).installs[plan.install]!;
  for (const committed of [false, true]) {
    const operation = "npm-rebuild-" + crypto.randomUUID(),
      control = join(root, "staging", operation),
      stage = join(control, "app"),
      live = join(root, before.dir),
      backup = join(control, "old");
    await cp(live, stage, { recursive: true });
    await writeFile(join(stage, "generated.txt"), "built");
    const after = structuredClone(before);
    after.npmBuild!.currentHash = await npmTreeHash(stage);
    await atomicJson(join(stage, ".piko-install.json"), after);
    await atomicJson(manager.store.rebuildPath, { operation, before, after });
    await rename(live, backup);
    await rename(stage, live);
    if (committed) {
      const s = await manager.store.read();
      s.installs[after.id] = after;
      await atomicJson(manager.store.statePath, s);
    }
    if (committed) {
      // Simulate power loss during deletion, after cleanup intent is durable.
      await atomicJson(manager.store.rebuildPath, {
        operation,
        before,
        after,
        cleanup: true,
      });
      await rm(join(backup, ".piko-install.json"));
    }
    await manager.store.mutate(async () => {});
    expect(await exists(join(live, "generated.txt"))).toBe(committed);
    expect(await exists(control)).toBe(false);
    expect(await exists(manager.store.rebuildPath)).toBe(false);
  }
}, 60000);

test("packaged Sandbox registry fixtures install and rebuild through compiled CLI", async () => {
  const files = join(root, "sandbox-registry");
  await buildSandboxRegistry(files, registry);
  const entries = JSON.parse(
    await readFile(join(files, "metadata.json"), "utf8"),
  );
  Object.assign(metadata, entries);
  for (const name of [
    "helper-1.0.0.tgz",
    "scripts-1.0.0.tgz",
    "scripts-1.1.0.tgz",
  ])
    archives["archives/" + name] = new Uint8Array(
      await readFile(join(files, "archives", name)),
    );
  const run = async (args: string[], expected = 0) => {
    const child = Bun.spawn([join(root, "piko.exe"), ...args], {
      env: { ...process.env, PIKO_HOME: root },
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== expected)
      throw new Error(
        `${args.join(" ")}: expected ${expected}, got ${code}: ${err}`,
      );
    return out;
  };
  const spec = "npm:@piko-fixture/scripts@1.0.0";
  await run(["install", spec]);
  await run(["scripts", "approve", spec], 1);
  await run(
    ["scripts", "approve", spec, "--binding", "0".repeat(64), "--yes"],
    1,
  );
  await run(["scripts", "approve", spec, "--yes"]);
  await run(["scripts", "rebuild", spec]);
  const i = Object.values((await manager.store.read()).installs).find(
    (i) => i.name === "@piko-fixture/scripts",
  )!;
  expect(
    await readFile(
      join(root, i.dir, "node_modules/@piko-fixture/scripts/generated.txt"),
      "utf8",
    ),
  ).toBe("approved build");
  expect(
    await exists(
      join(
        root,
        i.dir,
        "node_modules/piko-fixture-helper/dependency-generated.txt",
      ),
    ),
  ).toBe(false);
  await run(["install", "npm:@piko-fixture/scripts@1.1.0"]);
  await run(["scripts", "rebuild", "npm:@piko-fixture/scripts@1.1.0"], 1);
  await run(["scripts", "revoke", spec]);
  await run(["scripts", "rebuild", spec], 1);
  await manager.uninstall("npm:@piko-fixture/scripts@1.1.0");
  expect(
    (await manager.inspectScripts(spec)).scripts.every((s) => !s.approved),
  ).toBe(true);
}, 60000);

test("prepare requires explicit approval and duplicate-source path approval stays fail-closed", async () => {
  const spec = "npm:@piko-fixture/cli@2.0.0";
  await manager.install(spec);
  const plan = await manager.inspectScripts(spec),
    top = plan.scripts.find(
      (s) => s.path === "node_modules/@piko-fixture/cli",
    )!,
    dep = plan.scripts.find((s) => s.path === "node_modules/piko-fixture-dep")!;
  await manager.approveScripts(spec, top.path, top.binding);
  await expect(manager.rebuildScripts(spec)).rejects.toThrow("99");
  await expect(
    manager.approveScripts(spec, dep.path, dep.binding),
  ).rejects.toThrow("Duplicate");
  expect(
    (await manager.inspectScripts(spec)).scripts
      .filter((s) => s.approved)
      .map((s) => s.path),
  ).toEqual([top.path]);
}, 60000);

test("approved prepare can use private dependency bins without running dependency lifecycle or pre/post hooks", async () => {
  const spec = "npm:@piko-fixture/cli@2.1.0";
  const install = await manager.install(spec);
  const plan = await manager.inspectScripts(spec),
    top = plan.scripts.find(
      (s) => s.path === "node_modules/@piko-fixture/cli",
    )!;
  expect(
    await exists(join(root, install.dir, top.path, "PREPARE_COMPLETED")),
  ).toBe(false);
  await manager.approveScripts(spec, top.path, top.binding);
  await manager.rebuildScripts(spec);
  expect(
    await readFile(
      join(root, install.dir, top.path, "PREPARE_COMPLETED"),
      "utf8",
    ),
  ).toBe("private bin executed");
  expect(
    await exists(
      join(
        root,
        install.dir,
        "node_modules/piko-fixture-dep/DEPENDENCY_SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  expect(await exists(join(root, "shims/piko-fixture-build.exe"))).toBe(false);
}, 60000);

test("npm strict mode blocks unreviewed scripts and explicit denials keep dependencies silent", async () => {
  const state = await manager.store.read(),
    context = await npmContext(root, state);
  const install = Object.values(state.installs).find(
    (i) => i.kind === "npm" && i.version === "1.0.0",
  )!;
  const copy = join(root, "strict-policy");
  await cp(npmSnapshotPath(root, install.npmBuild!.inputHash), copy, {
    recursive: true,
  });
  const packageJson = join(copy, "package.json"),
    pkg = JSON.parse(await readFile(packageJson, "utf8"));
  pkg.allowScripts = { "@piko-fixture/cli@1.0.0": true };
  await writeFile(packageJson, JSON.stringify(pkg));
  const args = [
    context.npm,
    "rebuild",
    "--strict-allow-scripts=true",
    "--ignore-scripts=false",
    "--dangerously-allow-all-scripts=false",
    "--bin-links=false",
    "--registry=" + registry,
    "--no-audit",
    "--no-fund",
  ];
  await expect(
    capture(context.node, args, { cwd: copy, env: context.env }),
  ).rejects.toThrow();
  expect(
    await exists(
      join(copy, "node_modules", "@piko-fixture", "cli", "SHOULD_NOT_EXIST"),
    ),
  ).toBe(false);
  pkg.allowScripts["piko-fixture-dep@1.0.0"] = false;
  await writeFile(packageJson, JSON.stringify(pkg));
  await capture(context.node, args, { cwd: copy, env: context.env });
  expect(
    await exists(
      join(copy, "node_modules", "@piko-fixture", "cli", "SHOULD_NOT_EXIST"),
    ),
  ).toBe(true);
  expect(
    await exists(
      join(
        copy,
        "node_modules",
        "piko-fixture-dep",
        "DEPENDENCY_SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
}, 60000);

test("npm P1 preview and portable inventory restore retain registry provenance and never restore script approvals", async () => {
  const spec = "npm:@piko-fixture/cli";
  await manager.use(spec + "@1.0.0");
  await manager.store.mutate(async (state) => {
    const i = Object.values(state.installs).find(
      (i) =>
        i.kind === "npm" &&
        i.name === "@piko-fixture/cli" &&
        i.version === "1.0.0",
    )!;
    state.defaults[i.key]!.request = "1";
  });
  const before = await manager.store.read();
  const row = (await manager.outdated(spec))[0]!;
  expect(row).toMatchObject({
    current: "1.0.0",
    candidate: "1.1.0",
    request: "1",
    status: "outdated",
  });
  expect(await manager.store.read()).toEqual(before);
  const inventory = exportInventory(before);
  inventory.sources = [];
  inventory.packages = inventory.packages.filter(
    (p) => p.source === "npm" && p.name === "@piko-fixture/cli",
  );
  inventory.packages[0]!.versions = ["1.0.0"];
  inventory.npmRegistries = { "@piko-fixture/cli": registry };
  inventory.aliases = [];
  expect(JSON.stringify(inventory)).not.toContain("approvals");
  const nodeInstall = Object.values(before.installs).find(
    (i) => i.name === "node",
  )!;
  const target = new Packages(join(root, "inventory-target"));
  await cp(join(root, nodeInstall.dir), join(target.root, nodeInstall.dir), {
    recursive: true,
  });
  await target.store.mutate(async (state) => {
    state.schemaVersion = 4;
    state.aliases = {};
    state.data = {};
    state.installs[nodeInstall.id] = structuredClone(nodeInstall);
    state.defaults[nodeInstall.key] = {
      id: nodeInstall.id,
      request: nodeInstall.version,
      commands: ["node"],
    };
    state.commands.node = nodeInstall.key;
  });
  const plan = await planInventory(target, inventory);
  expect(plan.conflicts).toEqual([]);
  await importInventory(target, inventory, {
    confirmed: true,
    binding: plan.binding,
  });
  const restored = Object.values((await target.store.read()).installs).find(
    (i) => i.kind === "npm",
  )!;
  expect(restored.version).toBe("1.0.0");
  expect(restored.source.url).toBe(registry);
  expect(restored.npmBuild?.approvals).toEqual({});
  expect(
    await exists(
      join(
        target.root,
        restored.dir,
        "node_modules/@piko-fixture/cli/SHOULD_NOT_EXIST",
      ),
    ),
  ).toBe(false);
  expect((await target.store.read()).defaults[nodeInstall.key]?.id).toBe(
    nodeInstall.id,
  );
  const old = process.env.PIKO_NPM_REGISTRY;
  process.env.PIKO_NPM_REGISTRY = "https://different-registry.invalid/";
  try {
    expect((await manager.outdated(spec))[0]?.reason).toContain(
      "registry changed",
    );
  } finally {
    if (old === undefined) delete process.env.PIKO_NPM_REGISTRY;
    else process.env.PIKO_NPM_REGISTRY = old;
  }
}, 60000);
