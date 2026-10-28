import { selectedEnvironment } from "./environment.ts";
import { commandNames } from "./commands.ts";
import semver from "semver";
import {
  mkdir,
  lstat,
  readlink,
  symlink,
  unlink,
  link,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { exists, fail, noLinks, capture } from "./util.ts";
import { resolveCommand } from "./commands.ts";
import type { State } from "./types.ts";

export function home(): string {
  if (process.env.PIKO_HOME) return resolve(process.env.PIKO_HOME);
  const exe = resolve(process.execPath),
    parent = dirname(exe);
  if (basename(parent).toLowerCase() === "shims") return dirname(parent);
  if (
    basename(parent).toLowerCase() === "piko" &&
    basename(dirname(parent)).toLowerCase() === "apps"
  )
    return dirname(dirname(parent));
  if (!process.env.LOCALAPPDATA) fail("Set PIKO_HOME or LOCALAPPDATA");
  return join(process.env.LOCALAPPDATA, "piko");
}
export async function setCurrent(
  root: string,
  key: string,
  target: string | undefined,
  allowed: string[],
): Promise<void> {
  const parent = join(root, "apps", key),
    path = join(parent, "current");
  await noLinks(parent);
  await mkdir(parent, { recursive: true });
  if (await exists(path)) {
    const s = await lstat(path);
    if (!s.isSymbolicLink()) fail(`current is not a managed junction: ${path}`);
    const actual = resolve(await readlink(path));
    if (!allowed.some((t) => resolve(t).toLowerCase() === actual.toLowerCase()))
      fail(`current target drift detected: ${path}`);
    if (target && actual.toLowerCase() === resolve(target).toLowerCase())
      return;
    await unlink(path);
  }
  if (target) {
    await noLinks(target);
    await symlink(resolve(target), path, "junction");
  }
}
export async function ensureShim(root: string, name: string): Promise<void> {
  const original = join(root, "apps", "piko", "piko.exe"),
    dir = join(root, "shims"),
    destination = join(dir, `${name}.exe`);
  if (!(await exists(original))) return; // Source-mode use does not manufacture non-executable shims.
  await noLinks(original);
  await noLinks(dir);
  await noLinks(destination);
  await mkdir(dir, { recursive: true });
  if (await exists(destination)) {
    const [a, b] = await Promise.all([stat(original), stat(destination)]);
    if (a.ino !== b.ino || a.dev !== b.dev)
      fail(`Refusing to overwrite external shim: ${destination}`);
    return;
  }
  await link(original, destination);
}
export async function removeShim(root: string, name: string): Promise<void> {
  const original = join(root, "apps", "piko", "piko.exe"),
    destination = join(root, "shims", `${name}.exe`);
  if (!(await exists(destination))) return;
  await noLinks(destination);
  if (!(await exists(original)))
    fail("Cannot verify ownership of existing shim");
  const [a, b] = await Promise.all([stat(original), stat(destination)]);
  if (a.ino !== b.ino || a.dev !== b.dev)
    fail("Refusing to remove external command entry");
  await unlink(destination);
}
export function selectedNode(
  root: string,
  state: State,
): { exe: string; npm: string; version: string } {
  const key = state.commands.node,
    selection = key && state.defaults[key];
  const choice = selection && state.installs[selection.id];
  if (!choice || choice.name !== "node" || choice.kind !== "portable")
    fail(
      "Install and select Node first: piko install <source>/node@<version>; piko use <source>/node@<version>",
    );
  const bin = choice.bins.node;
  if (!bin || bin.kind !== "native")
    fail("Selected Node does not provide a native node command");
  return {
    exe: join(root, choice.dir, bin.path),
    npm: join(root, choice.dir, "node_modules", "npm", "bin", "npm-cli.js"),
    version: choice.version,
  };
}
export async function dispatch(
  root: string,
  state: State,
  command: string,
  args: string[],
): Promise<number> {
  const { install, bin } = resolveCommand(state, command);
  const target = join(root, install.dir, bin.path);
  await noLinks(target);
  if (bin.kind === "node") {
    const node = selectedNode(root, state);
    await noLinks(node.exe);
    if (
      install.enginesNode &&
      (!semver.valid(node.version) ||
        !semver.satisfies(node.version, install.enginesNode))
    )
      fail(
        `This CLI requires Node ${install.enginesNode}; selected Node is ${node.version}. Select a compatible managed Node.`,
      );
  }
  const cmd =
    bin.kind === "node"
      ? [selectedNode(root, state).exe, target, ...args]
      : [target, ...args];
  const env = { ...process.env };
  for (const [key, value] of Object.entries(selectedEnvironment(root, state))) {
    for (const existing of Object.keys(env))
      if (existing.toUpperCase() === key) delete env[existing];
    env[key] = value;
  }
  if (state.commands.node) {
    const node = selectedNode(root, state);
    for (const k of Object.keys(env))
      if (k.toLowerCase() === "path") delete env[k];
    env.PATH =
      dirname(node.exe) + ";" + (process.env.PATH ?? process.env.Path ?? "");
  }
  const child = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  // Console Ctrl+C is delivered to both inherited-console processes on Windows.
  // Keep the launcher alive until its child exits; do not swallow termination.
  const interrupted = () => {};
  process.on("SIGINT", interrupted);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", interrupted);
  }
}
export async function pathDiagnostics(
  root: string,
  state: State,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const path = environment.PATH ?? environment.Path ?? "",
    extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter((x) => /^\.[a-z0-9]+$/i.test(x));
  const directories = [
    cwd,
    ...path
      .split(";")
      .filter(Boolean)
      .map((d) => d.replace(/^"|"$/g, "")),
  ].filter(isAbsolute);
  const results = [];
  for (const name of ["piko", ...commandNames(state)].sort()) {
    const expected = resolve(root, "shims", name + ".exe"),
      matches: string[] = [];
    for (const dir of directories)
      for (const ext of extensions) {
        const file = resolve(dir, name + ext);
        try {
          if (
            (await stat(file)).isFile() &&
            !matches.some((p) => p.toLowerCase() === file.toLowerCase())
          )
            matches.push(file);
        } catch (error: any) {
          if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code))
            throw error;
        }
      }
    const resolved = matches[0];
    results.push({
      name,
      expected,
      resolved: resolved ?? null,
      matches,
      shadowed: !!resolved && resolved.toLowerCase() !== expected.toLowerCase(),
      missing: !resolved,
      advice:
        resolved && resolved.toLowerCase() !== expected.toLowerCase()
          ? "Move Piko shims before conflicting PATH entries or use the full shim path; external files were not modified. PowerShell aliases/functions need Get-Command -All."
          : undefined,
    });
  }
  return results;
}
export async function addUserPath(root: string): Promise<void> {
  const path = join(root, "shims");
  const script = `$ErrorActionPreference='Stop';$p=$env:PIKO_SETUP_PATH;$old=[Environment]::GetEnvironmentVariable('Path','User');$parts=@($old -split ';' | Where-Object { $_ });if(-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $p.TrimEnd('\\') })){[Environment]::SetEnvironmentVariable('Path',(($p)+ ';' + $old),'User')}`;
  await capture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, PIKO_SETUP_PATH: path } },
  );
}
