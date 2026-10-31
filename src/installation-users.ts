import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { noLinks, fail } from "./util.ts";
import { WindowsEffects } from "./windows-effects.ts";
import type { Install } from "./types.ts";

// System integrations can leave executable images mapped in Explorer or other
// applications after registration switches. Query Windows Restart Manager;
// never terminate processes or treat an inspection failure as an empty list.
export async function installationUsers(
  root: string,
  install: Install,
  backend = new WindowsEffects(),
) {
  if (!install.admin) return [];
  const files: string[] = [];
  async function walk(path: string, relative = "") {
    await noLinks(path);
    for (const e of await readdir(path, { withFileTypes: true })) {
      const rel = relative ? relative + "/" + e.name : e.name;
      if (install.persist.some((p) => p.toLowerCase() === rel.toLowerCase()))
        continue;
      const full = join(path, e.name);
      const info = await lstat(full);
      if (info.isSymbolicLink())
        fail("Linked system integration content; refusing removal");
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isFile() && /\.(dll|exe|com)$/i.test(e.name)) {
        files.push(full);
        if (files.length > 4096)
          fail("System integration image count exceeds inspection limit");
      }
    }
  }
  await walk(join(root, install.dir));
  return files.length ? backend.fileUsers(files) : [];
}
