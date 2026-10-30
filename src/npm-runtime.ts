import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { capture, exists, fail, noLinks } from "./util.ts";
import type { Install } from "./types.ts";

export type NpmCompatibility = {
  nodeAbi: string;
  engines: Record<string, string>;
  nativeFiles: string[];
};
export async function npmCompatibility(
  directory: string,
  node: string,
): Promise<NpmCompatibility> {
  const lock = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );
  const engines: Record<string, string> = {};
  for (const path of Object.keys(lock.packages ?? {})) {
    if (!path) continue;
    const file = join(directory, path, "package.json");
    await noLinks(file);
    if (!(await exists(file))) continue; // Optional packages for other platforms are absent.
    const range = JSON.parse(await readFile(file, "utf8")).engines?.node;
    if (typeof range === "string") engines[path] = range;
  }
  const nativeFiles: string[] = [];
  let count = 0;
  const walk = async (path: string): Promise<void> => {
    await noLinks(join(directory, path));
    for (const entry of await readdir(join(directory, path), {
      withFileTypes: true,
    })) {
      if (++count > 100000) fail("npm compatibility file limit exceeded");
      const relative = path + "/" + entry.name;
      if (entry.isSymbolicLink()) fail("Linked npm compatibility content");
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name.toLowerCase().endsWith(".node"))
        nativeFiles.push(relative);
    }
  };
  await walk("node_modules");
  const nodeAbi = await capture(node, ["-p", "process.versions.modules"]);
  if (!/^\d+$/.test(nodeAbi)) fail("Invalid managed Node ABI");
  return { nodeAbi, engines, nativeFiles: nativeFiles.sort() };
}
export function checkNpmEngines(install: Install, version: string) {
  const engines = {
    ...(install.enginesNode ? { "top-level": install.enginesNode } : {}),
    ...install.npmCompatibility?.engines,
  };
  for (const [path, range] of Object.entries(engines))
    if (
      !semver.valid(version) ||
      !semver.validRange(range) ||
      !semver.satisfies(version, range)
    )
      fail(
        "npm dependency " +
          path +
          " requires Node " +
          range +
          "; selected Node is " +
          version +
          ". Select a compatible managed Node.",
      );
}
export async function checkNpmRuntime(
  root: string,
  install: Install,
  node: string,
  version: string,
) {
  checkNpmEngines(install, version);
  if (!install.npmCompatibility?.nativeFiles.length) return;
  const abi = await capture(node, ["-p", "process.versions.modules"]);
  if (abi !== install.npmCompatibility.nodeAbi)
    fail(
      "Native npm modules were built for Node ABI " +
        install.npmCompatibility.nodeAbi +
        ", selected ABI is " +
        abi +
        ". Approve/rebuild or reinstall this CLI using the selected Node before running it.",
    );
  for (const path of install.npmCompatibility.nativeFiles) {
    const file = join(root, install.dir, path);
    await noLinks(file);
    if (!(await lstat(file)).isFile())
      fail("Native npm module missing; rebuild or reinstall");
  }
}
