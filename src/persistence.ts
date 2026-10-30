import { persistentFolder } from "./layout.ts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fail, noLinks, noLinksTree, record, relativeFile } from "./util.ts";
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
