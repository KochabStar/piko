import { join } from "node:path";
import { component, fail, npmName, relativeFile, versionKey } from "./util.ts";
import type { Install, PersistentData, Source, State } from "./types.ts";

export type PackageLayout = "named-v1";
type Owner = Pick<Install, "name" | "source" | "layout">;
export function packageFolder(source: Source, name: string): string {
  if (source.type !== "npm") return component(name);
  npmName(name);
  return (
    "npm-" + (name.startsWith("@") ? name.slice(1).replace("/", "--") : name)
  );
}
export function appFolder(
  install: Pick<Install, "key" | "name" | "source" | "layout">,
): string {
  return install.layout === "named-v1"
    ? packageFolder(install.source, install.name)
    : install.key;
}
export function persistentFolder(owner: Owner, key: string): string {
  return owner.layout === "named-v1"
    ? packageFolder(owner.source, owner.name)
    : key;
}
export function readableVersion(version: string): string {
  versionKey(version); // Retain the existing version identifier bounds.
  try {
    relativeFile(version);
    if (
      !version.includes("/") &&
      version.toLowerCase() !== "current" &&
      version.length <= 100
    )
      return version;
  } catch {
    /* Unsafe identifiers keep their deterministic legacy encoding. */
  }
  return versionKey(version);
}
export function installDirectory(
  source: Source,
  name: string,
  version: string,
  key: string,
  layout?: PackageLayout,
): string {
  return join(
    "apps",
    layout === "named-v1" ? packageFolder(source, name) : key,
    layout === "named-v1" ? readableVersion(version) : versionKey(version),
  );
}
export function chooseLayout(
  state: State,
  source: Source,
  name: string,
): PackageLayout | undefined {
  const wanted = packageFolder(source, name).toLowerCase();
  const owners: (Install | PersistentData)[] = [
    ...Object.values(state.installs),
    ...Object.values(state.data ?? {}),
  ];
  for (const owner of owners)
    if (
      packageFolder(owner.source, owner.name).toLowerCase() === wanted &&
      (owner.source.identity !== source.identity || owner.name !== name)
    )
      fail(
        "Package directory name is already owned by another source/package; uninstall it and explicitly reconcile persistent data before changing sources",
      );
  const existing = owners.find(
    (o) => o.name === name && o.source.identity === source.identity,
  );
  return existing?.layout ?? (existing ? undefined : "named-v1");
}
export function validateLayoutOwners(state: State) {
  const seen = new Map<string, string>();
  const layouts = new Map<string, string>();
  for (const owner of [
    ...Object.values(state.installs),
    ...Object.values(state.data ?? {}),
  ]) {
    const packageIdentity = JSON.stringify([owner.source.identity, owner.name]);
    const chosenLayout = owner.layout ?? "legacy";
    if (
      layouts.has(packageIdentity) &&
      layouts.get(packageIdentity) !== chosenLayout
    )
      fail("Package versions/data have inconsistent directory layouts");
    layouts.set(packageIdentity, chosenLayout);
    if (owner.layout !== undefined && owner.layout !== "named-v1")
      fail("Unknown package directory layout");
    if (owner.layout !== "named-v1") continue;
    if (state.schemaVersion < 8)
      fail("Named package directories require schema 8");
    const folder = packageFolder(owner.source, owner.name).toLowerCase(),
      identity = JSON.stringify([owner.source.identity, owner.name]);
    if (seen.has(folder) && seen.get(folder) !== identity)
      fail("Named package directory has conflicting source ownership");
    seen.set(folder, identity);
  }
}
