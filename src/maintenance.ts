import { persistentFolder } from "./layout.ts";
import { mkdir, readdir, rename, lstat, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { emptyState, upgradeState, validateState } from "./store.ts";
import { atomicJson, exists, fail, json, noLinks } from "./util.ts";
import type { Install, State } from "./types.ts";
export async function orphanPlan(root: string, state: State) {
  const apps = join(root, "apps"),
    items: { path: string; installation?: Install; issue?: string }[] = [];
  await noLinks(apps);
  if (!(await exists(apps))) return items;
  for (const pkg of await readdir(apps, { withFileTypes: true })) {
    if (pkg.name === "piko") continue;
    const parent = join(apps, pkg.name);
    await noLinks(parent);
    if (!pkg.isDirectory()) continue;
    for (const version of await readdir(parent, { withFileTypes: true })) {
      if (version.name === "current") continue;
      const path = join(parent, version.name),
        rel = relative(root, path);
      if (Object.values(state.installs).some((i) => i.dir === rel)) continue;
      try {
        await noLinks(path);
        if (!version.isDirectory()) continue;
        const file = join(path, ".piko-install.json");
        await noLinks(file);
        if (!(await exists(file))) {
          items.push({
            path,
            issue: "No Piko receipt; never touched automatically",
          });
          continue;
        }
        const install = await json(file),
          check = emptyState();
        upgradeState(check);
        check.schemaVersion = 8;
        check.installs[install.id] = install;
        validateState(check);
        if (install.dir !== rel) fail("Receipt path mismatch");
        const inspect = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name),
              stat = await lstat(full);
            if (stat.isSymbolicLink()) {
              const linkPath = relative(path, full).split(sep).join("/");
              if (
                !install.persist.includes(linkPath) ||
                resolve(await readlink(full)).toLowerCase() !==
                  resolve(
                    join(
                      root,
                      "persist",
                      persistentFolder(install, install.key),
                      linkPath,
                    ),
                  ).toLowerCase()
              )
                fail("Unknown orphan link");
            } else if (stat.isDirectory()) await inspect(full);
          }
        };
        await inspect(path);
        items.push({ path, installation: install });
      } catch (error) {
        items.push({
          path,
          issue: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return items;
}
export async function quarantineOrphans(
  root: string,
  state: State,
  confirmed = false,
) {
  const items = await orphanPlan(root, state),
    results = [];
  for (const item of items) {
    if (!confirmed || !item.installation) {
      results.push({ ...item, quarantined: false });
      continue;
    }
    const destination = join(
      root,
      "quarantine",
      "orphan-" + crypto.randomUUID(),
    );
    await noLinks(destination);
    await mkdir(destination, { recursive: true });
    await atomicJson(join(destination, "record.json"), {
      from: item.path,
      installation: item.installation,
      at: new Date().toISOString(),
      reason: "Unreferenced installation moved, not deleted or adopted",
    });
    await rename(item.path, join(destination, "app"));
    results.push({ ...item, quarantined: true, destination });
  }
  return results;
}
