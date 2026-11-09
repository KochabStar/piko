import { persistentFolder } from "./layout.ts";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  exists,
  fail,
  noLinks,
  noLinksTree,
  record,
  relativeFile,
  removeTree,
} from "./util.ts";
import type {
  ConfigTemplate,
  Install,
  PersistDeclaration,
  PersistentFile,
  State,
} from "./types.ts";

export function validatePersistentFile(
  value: unknown,
): asserts value is PersistentFile {
  if (
    !record(value) ||
    !["hardlink", "seed"].includes(value.mode) ||
    typeof value.initial !== "string" ||
    Buffer.byteLength(value.initial) > 65536
  )
    fail(
      "Persistent files require mode hardlink/seed and initial text of at most 64 KiB",
    );
}
export function persistence(declarations: PersistDeclaration[] = []) {
  if (!Array.isArray(declarations) || declarations.length > 128)
    fail("Invalid persist list");
  const paths: string[] = [],
    files: Record<string, PersistentFile> = {};
  let size = 0;
  for (const item of declarations) {
    const path = typeof item === "string" ? item : item?.path;
    relativeFile(path);
    if (path.split("/")[0]!.toLowerCase() === ".piko-install.json")
      fail("Reserved persistent path");
    if (
      paths.some(
        (p) =>
          p.toLowerCase() === path.toLowerCase() ||
          p.toLowerCase().startsWith(path.toLowerCase() + "/") ||
          path.toLowerCase().startsWith(p.toLowerCase() + "/"),
      )
    )
      fail("Overlapping persistent paths");
    paths.push(path);
    if (typeof item !== "string") {
      if (
        !record(item) ||
        item.kind !== "file" ||
        Object.keys(item).some(
          (k) => !["path", "kind", "mode", "initial"].includes(k),
        )
      )
        fail("Invalid persistent file declaration");
      validatePersistentFile(item);
      files[path] = { mode: item.mode, initial: item.initial };
      size += Buffer.byteLength(item.initial);
    }
  }
  if (size > 1024 * 1024) fail("Persistent seeds exceed 1 MiB");
  return { paths, files };
}

export function validateTemplates(
  value: unknown,
): asserts value is Record<string, ConfigTemplate> {
  if (!record(value) || Object.keys(value).length > 128)
    fail("Invalid configTemplates");
  let size = 0;
  for (const [path, template] of Object.entries(value)) {
    relativeFile(path);
    if (
      !record(template) ||
      Object.keys(template).some((k) => k !== "text") ||
      typeof template.text !== "string" ||
      Buffer.byteLength(template.text) > 65536
    )
      fail("Config templates require text of at most 64 KiB");
    if (
      /\{\{.*?\}\}/s.test(
        template.text.replaceAll("{{persist}}", "").replaceAll("{{app}}", ""),
      )
    )
      fail("Unknown config template placeholder");
    size += Buffer.byteLength(template.text);
  }
  if (size > 1024 * 1024) fail("Config templates exceed 1 MiB");
}
export function renderTemplate(
  text: string,
  app: string,
  persist: string,
): string {
  for (const path of [app, persist])
    if (/[\r\n\0]/.test(path)) fail("Unsafe configuration template path");
  return text
    .replaceAll("{{app}}", app.replaceAll("\\", "/"))
    .replaceAll("{{persist}}", persist.replaceAll("\\", "/"));
}

export async function checkPersistentFileMappings(
  root: string,
  install: Install,
): Promise<void> {
  for (const [path, mapping] of Object.entries(install.persistFiles ?? {})) {
    const shared = join(
      root,
      "persist",
      persistentFolder(install, install.key),
      path,
    );
    await noLinks(shared);
    const target = await lstat(shared);
    if (!target.isFile()) fail("Persistent file type drift");
    if (mapping.mode === "seed") continue;
    const appFile = join(root, install.dir, path);
    await noLinks(appFile);
    const source = await lstat(appFile);
    if (
      !source.isFile() ||
      source.ino !== target.ino ||
      source.dev !== target.dev
    )
      fail(
        "Persistent file hardlink drift; application may have atomically replaced its configuration. Preserve both files and reconcile manually before retrying.",
      );
  }
}
// Directory mappings must be junctions into the shared persistent tree. An
// application that recreates its data folder replaces the junction with a
// plain directory holding the newer data. Reconcile it automatically: merge
// the newer files back and restore the link instead of refusing removal.
export async function checkPersistentLinkMappings(
  root: string,
  install: Install,
  options: { reconcile?: boolean } = {},
): Promise<void> {
  for (const path of install.persist) {
    if (install.persistFiles?.[path]) continue;
    const link = join(root, install.dir, path),
      expected = resolve(
        join(root, "persist", persistentFolder(install, install.key), path),
      );
    if (!(await exists(link))) continue;
    const info = await lstat(link);
    const actual = info.isSymbolicLink() ? resolve(await readlink(link)) : null,
      found =
        actual !== null
          ? `a link to ${actual}`
          : info.isDirectory()
            ? "a plain directory"
            : "a plain file";
    if (actual !== null && actual.toLowerCase() === expected.toLowerCase())
      continue;
    if (actual === null && info.isDirectory()) {
      // The application recreated its data folder: the plain directory now
      // holds the newer copy while the persist tree keeps the snapshot.
      // Merge the newer files back and restore the junction; a read-only
      // planning pass tolerates the shape and lets execution reconcile.
      if (options.reconcile !== false) await reconcileDrift(link, expected);
      continue;
    }
    fail(
      "Persistent mapping drift; refusing removal: " +
        `${link} is ${found}, expected a link to ${expected}. ` +
        `Reconcile both copies, remove ${link}, then rerun this command ` +
        `or run piko reset ${install.name} to restore the link`,
    );
  }
}
// Reconcile a drifted mapping: copy every file the plain copy holds newer
// than the persist tree (keeping timestamps so reruns are idempotent), drop
// leftovers from an interrupted pass, then restore the junction. Safe to
// rerun at any interruption point; a locked file fails with the owning path.
export async function reconcileDrift(
  source: string,
  target: string,
): Promise<void> {
  await noLinksTree(source);
  if (!(await exists(target)))
    fail(
      "Persistent data or application target missing; reset never recreates lost data: " +
        target,
    );
  await noLinksTree(target);
  const temp = ".piko-reconcile-" + crypto.randomUUID();
  const merge = async (from: string, into: string): Promise<void> => {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name === temp) continue;
      const src = join(from, entry.name),
        dest = join(into, entry.name);
      if (entry.isDirectory()) {
        if (await exists(dest)) {
          if (!(await lstat(dest)).isDirectory())
            fail("Reconcile target conflicts; inspect manually: " + dest);
        } else await mkdir(dest, { recursive: true });
        await merge(src, dest);
      } else if (entry.isFile()) {
        const srcInfo = await lstat(src),
          destInfo = await lstat(dest).catch(() => null);
        if (destInfo?.isFile() && destInfo.mtimeMs >= srcInfo.mtimeMs)
          continue;
        if (destInfo?.isDirectory())
          fail("Reconcile target conflicts; inspect manually: " + dest);
        const stage = join(into, temp);
        try {
          try {
            await copyFile(src, stage);
          } catch (error: any) {
            if (error && ["EBUSY", "EPERM", "EACCES"].includes(error.code))
              fail(
                "Reconcile source file is locked by a running application; " +
                  "stop it and rerun: " +
                  src,
              );
            throw error;
          }
          await utimes(stage, srcInfo.atime, srcInfo.mtime);
          try {
            await rename(stage, dest);
          } catch (error: any) {
            if (!error || !["EBUSY", "EPERM", "EACCES"].includes(error.code))
              throw error;
            // Replacing a read-only archive file fails until the attribute
            // is cleared; the newer copy is supposed to win, so clear it.
            await chmod(dest, 0o666);
            try {
              await rename(stage, dest);
            } catch {
              fail(
                "Reconcile target file is locked or read-only; stop the " +
                  "application and rerun: " +
                  dest,
              );
            }
          }
        } finally {
          await rm(stage, { force: true, maxRetries: 8, retryDelay: 100 });
        }
      } else
        fail(
          "Reconcile source holds an irregular entry; inspect manually: " + src,
        );
    }
  };
  const sweep = async (dir: string): Promise<void> => {
    if (!(await exists(dir))) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.name.startsWith(".piko-reconcile-")) {
        await rm(child, { force: true, maxRetries: 8, retryDelay: 100 });
        continue;
      }
      if (entry.isDirectory()) await sweep(child);
    }
  };
  await sweep(target);
  await merge(source, target);
  try {
    await removeTree(source);
  } catch (error: any) {
    if (error && ["EBUSY", "EPERM", "EACCES"].includes(error.code))
      fail(
        "Reconcile source is locked by a running application; stop it and " +
          "rerun: " +
          source,
      );
    throw error;
  }
  await symlink(resolve(target), source, "junction");
}
export async function checkPackagePersistentFiles(
  root: string,
  state: State,
  key: string,
): Promise<void> {
  for (const install of Object.values(state.installs).filter(
    (i) => i.key === key,
  ))
    await checkPersistentFileMappings(root, install);
}
export async function noLinksData(path: string): Promise<void> {
  await noLinks(path);
  try {
    const info = await lstat(path);
    if (info.isFile()) {
      if (info.nlink !== 1)
        fail("Unowned hardlinks remain on persistent file; inspect manually");
      return;
    }
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await noLinksTree(path);
}
