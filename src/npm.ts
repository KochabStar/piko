import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import semver from "semver";
import { selectedNode } from "./windows.ts";
import {
  capture,
  commandName,
  exists,
  fail,
  noLinks,
  npmName,
  record,
  relativeFile,
  sha256,
  networkUrl,
} from "./util.ts";
import { chooseVersion } from "./catalog.ts";
import { validateNpmLock } from "./npm-lock.ts";
import { sourceIdentity } from "./store.ts";
import type { Source, State, Bin, Install } from "./types.ts";

export function npmEnvironment(node: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.toLowerCase().startsWith("npm_config_") ||
      key.toLowerCase() === "path" ||
      ["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())
    )
      delete env[key];
  env.PATH = dirname(node) + ";" + (process.env.PATH ?? process.env.Path ?? "");
  return env;
}
export async function npmContext(
  root: string,
  state: State,
  name?: string,
): Promise<{
  node: string;
  npm: string;
  registry: string;
  defaultRegistry: string;
  registries: Record<string, string>;
  version: string;
  env: NodeJS.ProcessEnv;
  run: (args: string[], cwd: string) => Promise<string>;
}> {
  const selected = selectedNode(root, state);
  await noLinks(selected.exe);
  await noLinks(selected.npm);
  const env = npmEnvironment(selected.exe);
  const control = join(root, "apps", "piko");
  await mkdir(control, { recursive: true });
  const base = [
    "--global=false",
    "--ignore-scripts=true",
    "--dangerously-allow-all-scripts=false",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--fetch-retries=0",
    "--fetch-timeout=30000",
    "--cache=" + join(root, "cache", "npm"),
  ];
  const registries: Record<string, string> = {};
  if (process.env.PIKO_NPM_SCOPED_REGISTRIES) {
    const configured = JSON.parse(process.env.PIKO_NPM_SCOPED_REGISTRIES);
    if (!record(configured) || Object.keys(configured).length > 100)
      fail("Invalid PIKO_NPM_SCOPED_REGISTRIES");
    for (const [scope, url] of Object.entries(configured)) {
      if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope) || typeof url !== "string")
        fail("Invalid npm scope registry");
      registries[scope] = networkUrl(url).href;
    }
  }
  const run = async (args: string[], cwd: string) => {
    const result = await capture(
      selected.exe,
      [
        selected.npm,
        ...args,
        ...base,
        ...Object.entries(registries).map(
          ([scope, url]) => "--" + scope + ":registry=" + url,
        ),
        "--prefix=" + cwd,
      ],
      { cwd, env },
    );
    return result;
  };
  const version = await run(["--version"], control);
  if (!semver.valid(version) || semver.lt(version, "11.20.0"))
    fail(
      `npm ${version} is not verified for dependency-source controls; use a managed Node with npm >=11.20.0`,
    );
  const defaultRegistry = networkUrl(
    process.env.PIKO_NPM_REGISTRY ??
      (await run(["config", "get", "registry"], control)).trim(),
  ).href;
  if (name?.startsWith("@")) {
    const scope = name.split("/")[0]!;
    const configured = await run(
      ["config", "get", scope + ":registry"],
      control,
    );
    if (!["undefined", "null", ""].includes(configured))
      registries[scope] = networkUrl(configured).href;
  }
  const registry =
    (name?.startsWith("@") && registries[name.split("/")[0]!]) ||
    defaultRegistry;
  return {
    node: selected.exe,
    npm: selected.npm,
    registry,
    defaultRegistry,
    registries,
    version,
    env,
    run,
  };
}
export function npmSource(registry: string): Source {
  return {
    alias: "npm",
    url: registry,
    type: "npm",
    identity: sourceIdentity("npm", registry),
  };
}
export async function resolveNpm(
  context: Awaited<ReturnType<typeof npmContext>>,
  name: string,
  request: string,
  cwd: string,
): Promise<{ version: string; source: Source }> {
  npmName(name);
  if (
    name.startsWith("@") &&
    context.registries[name.split("/")[0]!] &&
    context.registry !== context.registries[name.split("/")[0]!]
  )
    fail("Resolve npm context for the requested package scope first");
  const value = JSON.parse(
    await context.run(
      ["view", name, "versions", "--json", "--registry=" + context.registry],
      cwd,
    ),
  );
  const versions = typeof value === "string" ? [value] : value;
  if (!Array.isArray(versions) || !versions.every((v) => typeof v === "string"))
    fail("Invalid npm version metadata");
  return {
    version: chooseVersion(versions, request),
    source: npmSource(context.registry),
  };
}
export async function prepareNpm(
  context: Awaited<ReturnType<typeof npmContext>>,
  stage: string,
  name: string,
  version: string,
  locked?: unknown,
): Promise<{
  bins: Record<string, Bin>;
  scripts: NonNullable<Install["scripts"]>;
  checksum: string;
  runtimeVersion: string;
  enginesNode?: string;
}> {
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "piko-private-install",
      version: "0.0.0",
      private: true,
      dependencies: { [name]: version },
    }),
  );
  if (locked !== undefined) {
    validateNpmLock(locked, name, version);
    await writeFile(join(stage, "package-lock.json"), JSON.stringify(locked));
  }
  await context.run(
    [
      locked === undefined ? "install" : "ci",
      "--registry=" + context.defaultRegistry,
      "--save-exact",
      "--engine-strict=true",
      "--bin-links=false",
      "--allow-directory=none",
      "--allow-file=none",
      "--allow-git=none",
      "--allow-remote=none",
    ],
    stage,
  );
  const lock = JSON.parse(
    await readFile(join(stage, "package-lock.json"), "utf8"),
  );
  if (!record(lock.packages)) fail("Missing resolved npm dependency graph");
  if (
    locked !== undefined &&
    sha256(JSON.stringify(lock)) !== sha256(JSON.stringify(locked))
  )
    fail("npm ci changed the locked dependency graph; refusing commit");
  const scripts: NonNullable<Install["scripts"]> = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    relativeFile(path);
    if (
      !record(entry) ||
      entry.link ||
      typeof entry.resolved !== "string" ||
      typeof entry.integrity !== "string" ||
      !/^sha(256|384|512)-/.test(entry.integrity)
    )
      fail("Unverifiable dependency source or integrity; refusing to commit");
    networkUrl(entry.resolved);
    const file = join(stage, path, "package.json");
    await noLinks(file);
    if (!(await exists(file))) {
      if (entry.optional === true) continue;
      fail("Required npm dependency is missing from installation");
    }
    const pkg = JSON.parse(await readFile(file, "utf8"));
    const events: Record<string, string> = {};
    for (const event of ["preinstall", "install", "postinstall", "prepare"])
      if (typeof pkg.scripts?.[event] === "string")
        events[event] = pkg.scripts[event];
    if (
      pkg.gypfile !== false &&
      !events.preinstall &&
      !events.install &&
      (await exists(join(stage, path, "binding.gyp")))
    )
      events.install = "node-gyp rebuild";
    if (Object.keys(events).length)
      scripts.push({
        path,
        name: String(pkg.name ?? path),
        version: String(entry.version ?? pkg.version),
        resolved: entry.resolved,
        integrity: entry.integrity,
        events,
      });
  }
  const packageDir = join("node_modules", ...name.split("/")),
    file = join(stage, packageDir, "package.json");
  await noLinks(file);
  const pkg = JSON.parse(await readFile(file, "utf8"));
  if (pkg.name !== name || pkg.version !== version)
    fail("Installed npm package does not match the requested identity");
  const top = lock.packages[`node_modules/${name}`];
  if (!top?.integrity) fail("Top-level npm integrity missing");
  const mappings =
    typeof pkg.bin === "string"
      ? { [name.split("/").at(-1)!]: pkg.bin }
      : pkg.bin;
  if (!record(mappings) || !Object.keys(mappings).length)
    fail("Package does not provide any CLI commands");
  const bins: Record<string, Bin> = {};
  for (const [command, value] of Object.entries(mappings)) {
    const key = commandName(command);
    if (Object.hasOwn(bins, key) || typeof value !== "string")
      fail("Invalid npm bin mapping");
    const path = relativeFile(value.replace(/^\.\//, "")),
      target = join(stage, packageDir, path);
    await noLinks(target);
    const s = await lstat(target);
    if (!s.isFile()) fail("npm bin is not a regular file");
    let kind: Bin["kind"] = "node";
    if (path.toLowerCase().endsWith(".exe")) kind = "native";
    else {
      const first = (await readFile(target, "utf8")).split(/\r?\n/, 1)[0]!;
      if (!/^#!.*\bnode\b/.test(first))
        fail(
          "Only Node shebang scripts and native EXE npm bins are currently supported",
        );
    }
    bins[key] = {
      path: relativeFile(
        [...packageDir.split(/[\\/]/), ...path.split("/")].join("/"),
      ),
      kind,
    };
  }
  const runtimeVersion = await capture(context.node, ["--version"], {
    env: context.env,
  });
  return {
    bins,
    scripts,
    checksum: sha256(JSON.stringify(lock)),
    runtimeVersion,
    enginesNode:
      typeof pkg.engines?.node === "string" ? pkg.engines.node : undefined,
  };
}
