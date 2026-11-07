import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { noLinks, fail } from "./util.ts";
import { WindowsEffects } from "./windows-effects.ts";
import type { Install } from "./types.ts";

// Deletion of a live directory fails while any process holds an executable
// image inside it. Query Windows Restart Manager before uninstall/version
// cleanup for every install; never terminate processes or treat an
// inspection failure as an empty list.
async function imageFiles(
  path: string,
  install: Install,
  strict: boolean,
): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string, relative = "") {
    await noLinks(path);
    for (const e of await readdir(path, { withFileTypes: true })) {
      const rel = relative ? relative + "/" + e.name : e.name;
      if (install.persist.some((p) => p.toLowerCase() === rel.toLowerCase()))
        continue;
      const full = join(path, e.name);
      const info = await lstat(full);
      // Admin system integrations must stay tamper-evident; ordinary payloads
      // may legitimately ship links, which cannot lock deletion themselves.
      if (info.isSymbolicLink()) {
        if (strict) fail("Linked system integration content; refusing removal");
        continue;
      }
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isFile() && /\.(dll|exe|com)$/i.test(e.name)) {
        files.push(full);
        if (files.length > 4096)
          fail("System integration image count exceeds inspection limit");
      }
    }
  }
  await walk(path);
  return files;
}
export async function installationUsers(
  root: string,
  install: Install,
  backend = new WindowsEffects(),
) {
  const files = await imageFiles(
    join(root, install.dir),
    install,
    !!install.admin,
  );
  return files.length ? backend.fileUsers(files) : [];
}
// Report processes that still hold images under an arbitrary managed
// directory, e.g. partially purged uninstall trash during recovery.
export async function directoryUsers(
  path: string,
  install: Install,
  backend = new WindowsEffects(),
) {
  const files = await imageFiles(path, install, false);
  return files.length ? backend.fileUsers(files) : [];
}
