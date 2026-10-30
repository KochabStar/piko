import { lstat, readlink, mkdir, symlink, link } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSpec } from "./catalog.ts";
import { commandNames, resolveCommand } from "./commands.ts";
import { appFolder, persistentFolder } from "./layout.ts";
import { profileRepairPlan, restoreProfileSettings } from "./data-profiles.ts";
import type { Context } from "./data-profiles.ts";
import {
  enrollStartMenu,
  startMenuEffects,
  checkStartMenu,
} from "./start-menu.ts";
import { effectBytes } from "./desktop.ts";
import { inspectShim, writeNativeShim } from "./shims.ts";
import { WindowsEffects } from "./windows-effects.ts";
import { exists, fail, json, noLinks } from "./util.ts";
import type { Packages } from "./packages.ts";
import type { State } from "./types.ts";

type Mapping = {
  source: string;
  target: string;
  kind: "junction" | "hardlink";
  category: "current" | "data";
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const normalized = (p: string) => resolve(p).toLowerCase();
async function checkMapping(m: Mapping) {
  await noLinks(m.target);
  const target = await lstat(m.target).catch(() =>
    fail(
      "Persistent data or application target missing; reset never recreates lost data: " +
        m.target,
    ),
  );
  if (m.kind === "junction" ? !target.isDirectory() : !target.isFile())
    fail("Reset target type changed: " + m.target);
  await noLinks(dirname(m.source));
  if (!(await exists(m.source))) return true;
  const source = await lstat(m.source);
  if (m.kind === "junction") {
    if (
      !source.isSymbolicLink() ||
      normalized(await readlink(m.source)) !== normalized(m.target)
    )
      fail("Reset mapping conflicts; preserve both paths: " + m.source);
  } else if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.dev !== target.dev ||
    source.ino !== target.ino
  )
    fail(
      "Persistent file hardlink drift; reset preserves both files: " + m.source,
    );
  return false;
}
function owners(state: State, spec?: string) {
  const parsed = spec ? parseSpec(spec) : undefined;
  const matches = Object.values(state.installs).filter(
    (i) =>
      !parsed ||
      (i.name === parsed.name &&
        (!parsed.source || parsed.source === i.source.alias)),
  );
  const keys = [...new Set(matches.map((i) => i.key))];
  if (parsed && keys.length !== 1)
    fail("Unknown or ambiguous installed package; specify source/package");
  return keys.map((key) => {
    const installs = matches.filter((i) => i.key === key);
    const id =
      state.defaults[key]?.id ??
      state.startMenu?.[key]?.id ??
      (installs.length === 1 ? installs[0]!.id : undefined);
    const install = id && state.installs[id];
    if (!install)
      fail(
        "Multiple versions without a default; choose one with piko use before reset: " +
          installs[0]!.name,
      );
    if (parsed?.request && parsed.request !== install.version)
      fail(
        "Reset never switches versions; use the selected exact version or run piko use first",
      );
    return { install, installs };
  });
}
async function plan(
  packages: Packages,
  state: State,
  spec?: string,
  context: Context = {},
) {
  const root = packages.root,
    backend = packages.effectsBackend ?? new WindowsEffects();
  const groups = owners(state, spec),
    keys = groups.map((g) => g.install.key),
    candidate = structuredClone(state);
  const mappings: Mapping[] = [],
    seeds: string[] = [];
  for (const { install, installs } of groups) {
    for (const i of installs) {
      const receipt = join(root, i.dir, ".piko-install.json");
      await noLinks(receipt);
      if (!same(await json(receipt), i))
        fail("Installation receipt changed; reset refused");
      await noLinks(join(root, i.dir));
      for (const path of i.persist) {
        const target = join(root, "persist", persistentFolder(i, i.key), path),
          source = join(root, i.dir, path),
          file = i.persistFiles?.[path];
        if (file?.mode === "seed") {
          await noLinks(target);
          if (!(await exists(target)) || !(await lstat(target)).isFile())
            fail(
              "Persistent seed data missing; restore from backup: " + target,
            );
          seeds.push(target);
          continue;
        }
        mappings.push({
          source,
          target,
          kind: file ? "hardlink" : "junction",
          category: "data",
        });
      }
    }
    if (state.defaults[install.key])
      mappings.push({
        source: join(root, "apps", appFolder(install), "current"),
        target: join(root, install.dir),
        kind: "junction",
        category: "current",
      });
    await enrollStartMenu(root, candidate, install, backend);
  }
  const profiles = await profileRepairPlan(root, state, keys, context);
  for (const m of profiles.links)
    mappings.push({ ...m, kind: "junction", category: "data" });
  const missing: Mapping[] = [];
  for (const m of mappings) if (await checkMapping(m)) missing.push(m);
  const names = commandNames(state).filter((n) =>
    keys.includes(resolveCommand(state, n).install.key),
  );
  const manager = join(root, "apps/piko/piko.exe");
  if (!spec && (await exists(manager))) names.unshift("piko");
  const shims = [];
  for (const name of names) {
    if (!(await exists(manager))) fail("Set up Piko before rebuilding shims");
    const entry = await inspectShim(root, name, [manager]);
    if (entry.kind !== "native") shims.push(name);
  }
  const shortcutKeys = keys.filter((key) => !!candidate.startMenu?.[key]);
  const effects = await startMenuEffects(
    state,
    candidate,
    backend,
    shortcutKeys,
  );
  await checkStartMenu(effects, backend);
  for (const e of effects) await effectBytes(root, e.after);
  return {
    candidate,
    missing,
    shims,
    effects,
    shortcutKeys,
    profiles,
    seeds,
    packages: groups.map(
      (g) => `${g.install.source.alias}/${g.install.name}@${g.install.version}`,
    ),
  };
}
// Missing-only repairs are additive and idempotent: a crash leaves data untouched
// and the command can be rerun. Shortcut writes use the selection recovery journal.
export async function resetPackages(
  packages: Packages,
  spec?: string,
  options: { dryRun?: boolean; context?: Context } = {},
) {
  const repairKeys: string[] = [];
  const preview = (p: Awaited<ReturnType<typeof plan>>) => ({
    action: "reset",
    packages: p.packages,
    shims: p.shims,
    current: p.missing.filter((m) => m.category === "current"),
    data: p.missing.filter((m) => m.category === "data"),
    settings: p.profiles.settings,
    shortcuts: p.effects,
    seedDataPreserved: p.seeds,
    downloads: false,
    dataDeleted: false,
    versionsChanged: false,
  });
  if (options.dryRun)
    return {
      ...preview(
        await plan(
          packages,
          await packages.store.read(),
          spec,
          options.context,
        ),
      ),
      status: "preview",
    };
  return await packages.store.mutate(
    async (state) => {
      const p = await plan(packages, state, spec, options.context);
      // Check again immediately before publishing any missing resources.
      for (const m of p.missing) await checkMapping(m);
      for (const name of p.shims)
        await inspectShim(packages.root, name, [
          join(packages.root, "apps/piko/piko.exe"),
        ]);
      await checkStartMenu(p.effects, packages.effectsBackend);
      for (const m of p.missing) {
        if (!(await checkMapping(m))) continue;
        await mkdir(dirname(m.source), { recursive: true });
        if (m.kind === "junction")
          await symlink(resolve(m.target), m.source, "junction");
        else await link(m.target, m.source);
      }
      await restoreProfileSettings(p.profiles.settings, options.context);
      for (const name of p.shims)
        await writeNativeShim(packages.root, name, [
          join(packages.root, "apps/piko/piko.exe"),
        ]);
      if (p.candidate.startMenu) state.startMenu = p.candidate.startMenu;
      if (p.candidate.schemaVersion > state.schemaVersion)
        state.schemaVersion = p.candidate.schemaVersion;
      if (p.effects.length) repairKeys.push(...p.shortcutKeys);
      return { ...preview(p), status: "completed" };
    },
    {
      skipUnchanged: true,
      effectsBackend: packages.effectsBackend,
      startMenuRepairKeys: repairKeys,
    },
  );
}
