import {
  mkdir,
  rm,
  writeFile,
  rename,
  readdir,
  lstat,
  readlink,
  unlink,
} from "node:fs/promises";
import { join, resolve, relative, sep, dirname } from "node:path";
import {
  atomicJson,
  component,
  commandName,
  npmName,
  exists,
  fail,
  json,
  noLinks,
  noLinksTree,
  record,
  relativeFile,
  sha256,
  versionKey,
  removeTree,
} from "./util.ts";
import { selectedEnvironment, validateEnv } from "./environment.ts";
import { npmTreeHash } from "./scripts.ts";
import { commandNames } from "./commands.ts";
import { setCurrent, ensureShim, removeShim } from "./windows.ts";
import type { State, Source, Install, PersistentData } from "./types.ts";

export function emptyState(): State {
  return {
    schemaVersion: 1,
    revision: 0,
    sources: {},
    installs: {},
    defaults: {},
    commands: {},
  };
}
export function sourceIdentity(
  type: string,
  url: string,
  ref?: string,
): string {
  return sha256(JSON.stringify([type, url, ref ?? null]));
}
export function packageKey(source: Source, name: string): string {
  return `${source.type === "npm" ? "npm-" + sha256(npmName(name)).slice(0, 24) : component(name)}--${source.identity.slice(0, 16)}`;
}
export function installId(key: string, version: string): string {
  return sha256(JSON.stringify([key, version]));
}
export function validateState(state: any): asserts state is State {
  if (![1, 2, 3, 4].includes(state?.schemaVersion))
    fail(
      "Unsupported state schema; do not use an older Piko on this installation",
    );
  if (
    !record(state) ||
    ![1, 2, 3, 4].includes(state.schemaVersion) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  )
    fail("Invalid state header; refusing to reset it");
  for (const name of ["sources", "installs", "defaults", "commands"])
    if (!record(state[name])) fail(`Invalid state section: ${name}`);
  if (
    state.schemaVersion === 1 &&
    (state.aliases !== undefined ||
      state.data !== undefined ||
      Object.values(state.defaults).some(
        (value: any) => record(value) && value.commands !== undefined,
      ))
  )
    fail("Schema 1 cannot contain schema 2 command/data metadata");
  if (
    state.schemaVersion >= 2 &&
    (!record(state.aliases) || !record(state.data))
  )
    fail("Schema 2 requires alias and persistent-data sections");
  const checkSource = (s: any) => {
    if (
      !record(s) ||
      typeof s.alias !== "string" ||
      component(s.alias) !== s.alias ||
      typeof s.url !== "string" ||
      !["http", "git", "npm"].includes(s.type) ||
      (s.ref !== undefined && typeof s.ref !== "string") ||
      s.identity !== sourceIdentity(s.type, s.url, s.ref)
    )
      fail("Invalid source identity in state");
    if (s.commit !== undefined && state.schemaVersion < 4)
      fail("Git commit metadata requires schema 4");
    if (
      s.commit !== undefined &&
      (s.type !== "git" ||
        typeof s.commit !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(s.commit))
    )
      fail("Invalid Git source commit");
  };
  for (const [alias, s] of Object.entries(state.sources)) {
    checkSource(s);
    if ((s as Source).alias !== alias || (s as Source).type === "npm")
      fail("Source alias mismatch or invalid source type");
  }
  for (const [id, value] of Object.entries(state.installs)) {
    const i = value as Install;
    if (!record(i)) fail("Invalid installation");
    checkSource(i.source);
    if (
      typeof i.name !== "string" ||
      i.name === "piko" ||
      i.key !== packageKey(i.source, i.name) ||
      i.id !== id ||
      typeof i.version !== "string" ||
      id !== installId(i.key, i.version)
    )
      fail("Invalid installed identity");
    const expected = join("apps", i.key, versionKey(i.version));
    if (
      i.dir !== expected ||
      !record(i.bins) ||
      !Array.isArray(i.persist) ||
      typeof i.verified !== "boolean" ||
      typeof i.checksum !== "string" ||
      typeof i.manifestHash !== "string" ||
      typeof i.request !== "string" ||
      !["portable", "npm"].includes(i.kind)
    )
      fail("Invalid installation receipt in state");
    for (const [name, b] of Object.entries(i.bins)) {
      commandName(name);
      if (!record(b) || !["native", "node"].includes(b.kind))
        fail("Invalid bin");
      relativeFile(b.path);
    }
    if (i.env !== undefined) {
      if (state.schemaVersion < 4)
        fail("Environment metadata requires schema 4");
      validateEnv(i.env);
    }
    for (const p of i.persist) relativeFile(p);
    if (i.npmBuild !== undefined) {
      const b = i.npmBuild;
      if (
        state.schemaVersion < 3 ||
        i.kind !== "npm" ||
        !record(b) ||
        !/^[a-f0-9]{64}$/.test(b.inputHash) ||
        !/^[a-f0-9]{64}$/.test(b.currentHash) ||
        !record(b.approvals)
      )
        fail("Invalid content-bound npm build metadata");
      for (const [path, approval] of Object.entries(b.approvals)) {
        relativeFile(path);
        if (
          !path.startsWith("node_modules/") ||
          !record(approval) ||
          !/^[a-f0-9]{64}$/.test(approval.binding) ||
          typeof approval.approvedAt !== "string" ||
          !Number.isFinite(Date.parse(approval.approvedAt))
        )
          fail("Invalid npm script approval");
      }
      if (
        b.lastRun !== undefined &&
        (!record(b.lastRun) ||
          typeof b.lastRun.at !== "string" ||
          typeof b.lastRun.node !== "string" ||
          typeof b.lastRun.npm !== "string" ||
          !Array.isArray(b.lastRun.paths) ||
          !b.lastRun.paths.every((p) => typeof p === "string"))
      )
        fail("Invalid npm build result");
    }
  }
  for (const [key, selection] of Object.entries(state.defaults)) {
    if (
      !record(selection) ||
      typeof selection.id !== "string" ||
      typeof selection.request !== "string" ||
      !state.installs[selection.id] ||
      state.installs[selection.id].key !== key
    )
      fail("Invalid default selection");
    if (selection.commands !== undefined) {
      if (
        !Array.isArray(selection.commands) ||
        new Set(selection.commands).size !== selection.commands.length
      )
        fail("Invalid selected command set");
      for (const name of selection.commands) {
        if (
          typeof name !== "string" ||
          commandName(name) !== name ||
          !state.installs[selection.id].bins[name]
        )
          fail("Selected version does not provide an enabled command");
      }
    }
  }
  for (const [name, key] of Object.entries(state.commands)) {
    if (commandName(name) !== name) fail("Non-canonical command name");
    if (
      typeof key !== "string" ||
      !state.defaults[key] ||
      !state.installs[state.defaults[key].id].bins[name] ||
      (state.defaults[key].commands !== undefined &&
        !state.defaults[key].commands.includes(name))
    )
      fail("Invalid command ownership");
  }
  for (const [name, alias] of Object.entries(state.aliases ?? {})) {
    if (
      commandName(name) !== name ||
      Object.hasOwn(state.commands, name) ||
      !record(alias) ||
      typeof alias.key !== "string" ||
      typeof alias.command !== "string"
    )
      fail("Invalid alias or command collision");
    commandName(alias.command);
    const selected = state.defaults[alias.key],
      installation = selected && state.installs[selected.id];
    if (!installation?.bins[alias.command])
      fail("Alias does not reference a real selected package command");
  }
  for (const [key, data] of Object.entries(state.data ?? {})) {
    if (!record(data)) fail("Invalid persistent-data ownership");
    checkSource(data.source);
    if (
      typeof data.name !== "string" ||
      data.name === "piko" ||
      key !== packageKey(data.source, data.name) ||
      !Array.isArray(data.paths) ||
      !data.paths.length
    )
      fail("Invalid persistent-data identity");
    const paths: string[] = [];
    for (const path of data.paths) {
      relativeFile(path);
      const normalized = path.toLowerCase();
      if (
        paths.some(
          (prior) =>
            prior === normalized ||
            prior.startsWith(normalized + "/") ||
            normalized.startsWith(prior + "/"),
        )
      )
        fail("Overlapping persistent-data paths");
      paths.push(normalized);
    }
  }
}
export function upgradeState(state: State): void {
  if (state.schemaVersion === 1) {
    state.schemaVersion = 2;
    state.aliases = {};
    state.data = {};
  }
  for (const i of Object.values(state.installs)) {
    if (!i.persist.length) continue;
    const prior = state.data![i.key];
    state.data![i.key] = {
      name: i.name,
      source: i.source,
      paths: [
        ...new Map(
          [...(prior?.paths ?? []), ...i.persist].map((path) => [
            path.toLowerCase(),
            path,
          ]),
        ).values(),
      ],
    };
  }
}
export class Store {
  readonly statePath: string;
  readonly installPath: string;
  readonly journalPath: string;
  readonly removalPath: string;
  readonly rebuildPath: string;
  readonly dataRemovalPath: string;
  constructor(readonly root: string) {
    this.root = resolve(root);
    this.statePath = join(root, "apps", "piko", "state.json");
    this.installPath = join(root, "operations", "install.json");
    this.journalPath = join(root, "operations", "selection.json");
    this.removalPath = join(root, "operations", "removal.json");
    this.rebuildPath = join(root, "operations", "npm-rebuild.json");
    this.dataRemovalPath = join(root, "operations", "data-removal.json");
  }
  async read(): Promise<State> {
    await noLinks(this.statePath);
    if (!(await exists(this.statePath))) return emptyState();
    const s = await json(this.statePath);
    validateState(s);
    return s;
  }
  async publishInstall(
    installation: Install,
    stage: string,
    operation: string,
  ): Promise<void> {
    if (await exists(this.installPath)) fail("Unrecovered installation");
    if (!/^[0-9a-f-]{36}$/.test(operation))
      fail("Invalid installation operation");
    const rel = relative(join(this.root, "staging", operation), stage)
      .split(sep)
      .join("/");
    if (rel !== "app" && rel !== "") fail("Invalid staged installation path");
    const existing = await this.read();
    const created = installation.persist.filter(
      (path) =>
        !existing.data?.[installation.key]?.paths.some(
          (p) => p.toLowerCase() === path.toLowerCase(),
        ) &&
        !Object.values(existing.installs).some(
          (i) =>
            i.key === installation.key &&
            i.persist.some((p) => p.toLowerCase() === path.toLowerCase()),
        ),
    );
    for (const path of created)
      if (await exists(join(this.root, "persist", installation.key, path)))
        fail(
          "Untracked persistent directory exists; inspect before installation",
        );
    await atomicJson(this.installPath, {
      installation,
      operation,
      payload: rel,
      created,
    });
    await this.finishInstallFiles({
      installation,
      operation,
      payload: rel,
      created,
    });
  }
  private async finishInstallFiles(entry: any): Promise<void> {
    const i = entry.installation as Install,
      check = emptyState();
    upgradeState(check);
    check.schemaVersion = 4;
    check.installs[i.id] = i;
    validateState(check);
    if (
      !/^[0-9a-f-]{36}$/.test(entry.operation) ||
      !["", "app"].includes(entry.payload) ||
      !Array.isArray(entry.created) ||
      !entry.created.every(
        (p: unknown) => typeof p === "string" && i.persist.includes(p),
      )
    )
      fail("Invalid installation journal");
    const stage = join(this.root, "staging", entry.operation, entry.payload),
      target = join(this.root, i.dir);
    await noLinks(stage);
    await noLinks(target);
    if (await exists(target)) {
      await noLinks(join(target, ".piko-install.json"));
      const receipt = await json(join(target, ".piko-install.json"));
      if (JSON.stringify(receipt) !== JSON.stringify(i))
        fail("Installation destination identity mismatch");
      if (await exists(stage))
        fail("Both staged and published install exist; inspect manually");
      return;
    }
    if (!(await exists(stage)))
      fail("Staged installation missing; preserve journal for inspection");
    await noLinks(join(stage, ".piko-install.json"));
    if (
      JSON.stringify(await json(join(stage, ".piko-install.json"))) !==
      JSON.stringify(i)
    )
      fail("Staged installation receipt mismatch");
    for (const path of i.persist) {
      const source = join(stage, path),
        shared = join(this.root, "persist", i.key, path);
      await noLinks(shared);
      if ((await exists(source)) && (await lstat(source)).isSymbolicLink()) {
        if (
          resolve(await readlink(source)).toLowerCase() !==
          resolve(shared).toLowerCase()
        )
          fail("Staged persistent mapping changed");
        continue;
      }
      await noLinks(source);
      if ((await exists(source)) && !(await lstat(source)).isDirectory())
        fail("Persistent source is not a directory");
      await mkdir(dirname(shared), { recursive: true });
      if (!(await exists(shared))) {
        if (await exists(source)) await rename(source, shared);
        else await mkdir(shared, { recursive: true });
      } else {
        if (!(await lstat(shared)).isDirectory())
          fail("Persistent target is not a directory");
        if (await exists(source)) await removeTree(source);
      }
      await mkdir(dirname(source), { recursive: true });
      await (
        await import("node:fs/promises")
      ).symlink(resolve(shared), source, "junction");
    }
    for (const bin of Object.values(i.bins)) {
      const file = join(stage, bin.path);
      await noLinks(file);
      if (!(await lstat(file)).isFile()) fail("Installed executable missing");
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(stage, target);
  }
  async recoverInstallation(): Promise<void> {
    if (!(await exists(this.installPath))) return;
    await noLinks(this.installPath);
    const entry = await json(this.installPath);
    if (!record(entry) || !record(entry.installation))
      fail("Invalid installation journal");
    await this.finishInstallFiles(entry);
    const before = await this.read(),
      i = entry.installation as Install;
    if (!before.installs[i.id]) {
      const after = structuredClone(before);
      after.installs[i.id] = i;
      if (i.npmBuild || i.env) {
        upgradeState(after);
        after.schemaVersion = i.env
          ? 4
          : (Math.max(after.schemaVersion, 3) as State["schemaVersion"]);
      }
      if (i.persist.length) upgradeState(after);
      await this.commit(before, after);
    } else if (JSON.stringify(before.installs[i.id]) !== JSON.stringify(i))
      fail("Recovered installation differs from state");
    const stage = join(this.root, "staging", entry.operation);
    if (await exists(stage)) {
      await noLinksTree(stage);
      await removeTree(stage);
    }
    await rm(this.installPath);
  }
  async recoverDataRemoval(): Promise<void> {
    if (!(await exists(this.dataRemovalPath))) return;
    await noLinks(this.dataRemovalPath);
    const entry = await json(this.dataRemovalPath);
    if (
      !record(entry) ||
      typeof entry.key !== "string" ||
      !record(entry.data) ||
      typeof entry.operation !== "string" ||
      !/^data-cleanup-[0-9a-f-]{36}$/.test(entry.operation)
    )
      fail("Invalid data cleanup journal");
    const check = emptyState();
    check.schemaVersion = 4;
    check.aliases = {};
    check.data = { [entry.key]: entry.data as PersistentData };
    validateState(check);
    const stage = join(this.root, "staging", entry.operation);
    await noLinks(stage);
    const state = await this.read(),
      owned = state.data?.[entry.key];
    if (!(await exists(stage))) {
      if (
        !owned &&
        !Object.values(state.installs).some((i) => i.key === entry.key)
      ) {
        await rm(this.dataRemovalPath);
        return;
      }
      fail(
        "Data cleanup staging directory is missing; manual inspection required",
      );
    }
    await noLinks(join(stage, ".piko-cleanup.json"));
    const proof = await json(join(stage, ".piko-cleanup.json"));
    if (
      proof.key !== entry.key ||
      JSON.stringify(proof.data) !== JSON.stringify(entry.data)
    )
      fail("Data cleanup proof mismatch");
    if (owned && JSON.stringify(owned) !== JSON.stringify(entry.data))
      fail("Persistent data ownership changed during cleanup");
    if (
      !owned &&
      Object.values(state.installs).some((i) => i.key === entry.key)
    )
      fail("Cleanup committed while installed versions still reference data");
    const allowedNames = new Set([
      ".piko-cleanup.json",
      ...entry.data.paths.map((_: string, index: number) => String(index)),
    ]);
    for (const file of await readdir(stage))
      if (!allowedNames.has(file))
        fail("Unrecognized file in data cleanup staging directory");
    for (let n = 0; n < entry.data.paths.length; n++) {
      const from = join(this.root, "persist", entry.key, entry.data.paths[n]),
        to = join(stage, String(n));
      await noLinks(from);
      await noLinks(to);
      if (owned && (await exists(to))) {
        if (await exists(from))
          fail(
            "Both persistent data and cleanup trash exist; inspect manually",
          );
        await noLinksTree(to);
        await mkdir(dirname(from), { recursive: true });
        await rename(to, from);
      }
    }
    await noLinksTree(stage);
    await removeTree(stage);
    await rm(this.dataRemovalPath);
  }
  async recoverRebuild(): Promise<void> {
    if (!(await exists(this.rebuildPath))) return;
    await noLinks(this.rebuildPath);
    const entry = await json(this.rebuildPath);
    if (
      !record(entry) ||
      typeof entry.operation !== "string" ||
      !/^npm-rebuild-[0-9a-f-]{36}$/.test(entry.operation)
    )
      fail("Invalid npm rebuild journal");
    for (const i of [entry.before, entry.after]) {
      if (!record(i)) fail("Missing npm rebuild identity");
      const check = emptyState();
      upgradeState(check);
      check.schemaVersion = i.env ? 4 : 3;
      check.installs[i.id] = i as Install;
      validateState(check);
      if (i.kind !== "npm" || !i.npmBuild)
        fail("Invalid npm rebuild installation");
    }
    if (
      entry.before.id !== entry.after.id ||
      entry.before.checksum !== entry.after.checksum ||
      entry.before.npmBuild.inputHash !== entry.after.npmBuild.inputHash ||
      entry.before.dir !== entry.after.dir
    )
      fail("npm rebuild identity changed");
    const state = await this.read(),
      current = state.installs[entry.before.id];
    const committed = JSON.stringify(current) === JSON.stringify(entry.after);
    if (!committed && JSON.stringify(current) !== JSON.stringify(entry.before))
      fail("npm rebuild state mismatch; manual inspection required");
    const operation = join(this.root, "staging", entry.operation),
      live = join(this.root, entry.before.dir),
      backup = join(operation, "old"),
      candidate = join(operation, "app");
    for (const path of [operation, live, backup, candidate])
      await noLinks(path);
    const verify = async (path: string, expected: Install) => {
      await noLinks(join(path, ".piko-install.json"));
      const receipt = await json(join(path, ".piko-install.json"));
      if (
        receipt.id !== expected.id ||
        receipt.checksum !== expected.checksum ||
        (await npmTreeHash(path)) !== expected.npmBuild!.currentHash
      )
        fail(
          "npm rebuild files changed; preserve staging for manual inspection",
        );
    };
    if (entry.cleanup !== true) {
      if (committed) {
        await verify(live, entry.after);
        if (await exists(backup)) await verify(backup, entry.before);
      } else {
        if (await exists(backup)) {
          await verify(backup, entry.before);
          if (await exists(live)) {
            await verify(live, entry.after);
            if (await exists(candidate))
              fail(
                "Duplicate npm rebuild candidates; manual inspection required",
              );
            await rename(live, candidate);
          }
          await rename(backup, live);
        } else await verify(live, entry.before);
      }
      if (await exists(candidate)) await verify(candidate, entry.after);
      // Persist the cleanup phase BEFORE recursive removal, so partial deletes
      // after a crash do not need a now-missing receipt or complete tree digest.
      await atomicJson(this.rebuildPath, { ...entry, cleanup: true });
    } else await verify(live, committed ? entry.after : entry.before);
    await noLinksTree(operation);
    await removeTree(operation);
    await rm(this.rebuildPath);
  }
  async recoverRemoval(): Promise<void> {
    if (!(await exists(this.removalPath))) return;
    await noLinks(this.removalPath);
    const entry = await json(this.removalPath),
      i = entry.installation;
    if (
      !record(entry) ||
      !record(i) ||
      typeof entry.trash !== "string" ||
      !/^uninstall-[0-9a-f-]{36}$/.test(entry.trash)
    )
      fail("Invalid uninstall recovery record");
    const check = emptyState();
    upgradeState(check);
    check.schemaVersion = 4;
    check.installs[i.id] = i as Install;
    validateState(check);
    const from = join(this.root, i.dir),
      to = join(this.root, "staging", entry.trash);
    await noLinks(from);
    await noLinks(to);
    const current = await this.read();
    if (current.installs[i.id]) {
      if (await exists(to)) {
        if (await exists(from))
          fail(
            "Both uninstall source and trash exist; manual inspection required",
          );
        const receipt = await json(join(to, ".piko-install.json"));
        if (receipt.id !== i.id || receipt.checksum !== i.checksum)
          fail("Uninstall recovery receipt mismatch");
        await rename(to, from);
      }
    } else if (await exists(to)) {
      const receipt = await json(join(to, ".piko-install.json"));
      if (receipt.id !== i.id || receipt.checksum !== i.checksum)
        fail("Refusing to remove unrecognized uninstall trash");
      const detach = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, e.name),
            s = await lstat(path);
          if (s.isSymbolicLink()) {
            const rel = relative(to, path).split(sep).join("/");
            if (
              !i.persist.includes(rel) ||
              resolve(await readlink(path)).toLowerCase() !==
                resolve(join(this.root, "persist", i.key, rel)).toLowerCase()
            )
              fail("Unknown link found in uninstall trash");
            await unlink(path);
          } else if (s.isDirectory()) await detach(path);
        }
      };
      await detach(to);
      await removeTree(to);
    }
    await rm(this.removalPath);
  }
  async recover(): Promise<void> {
    if (!(await exists(this.journalPath))) return;
    await noLinks(this.journalPath);
    const j = await json(this.journalPath);
    validateState(j.before);
    validateState(j.after);
    const state = await this.read();
    if (
      j.after.revision !== j.before.revision + 1 ||
      ![j.before.revision, j.after.revision].includes(state.revision)
    )
      fail(
        "Recovery revision mismatch; preserve files and inspect operations/selection.json",
      );
    const chosen = state.revision === j.after.revision ? j.after : j.before;
    if (JSON.stringify(state) !== JSON.stringify(chosen))
      fail("Recovery state mismatch");
    await this.syncCurrents(chosen, j.before, j.after);
    for (const name of new Set([
      ...commandNames(j.before),
      ...commandNames(j.after),
    ]))
      if (!commandNames(chosen).includes(name))
        await removeShim(this.root, name);
    await rm(this.journalPath);
  }
  private async syncCurrents(
    target: State,
    before: State,
    after: State,
  ): Promise<void> {
    const keys = new Set([
      ...Object.keys(before.defaults),
      ...Object.keys(after.defaults),
    ]);
    for (const key of keys) {
      const allowed = [
        ...Object.values(before.installs),
        ...Object.values(after.installs),
      ]
        .filter((i) => i.key === key)
        .map((i) => join(this.root, i.dir));
      const selection = target.defaults[key],
        install = selection && target.installs[selection.id];
      await setCurrent(
        this.root,
        key,
        install ? join(this.root, install.dir) : undefined,
        allowed,
      );
    }
  }
  async commit(before: State, after: State): Promise<void> {
    after.revision = before.revision + 1;
    const recordedSources = [
      ...Object.values(after.sources),
      ...Object.values(after.installs).map((i) => i.source),
      ...Object.values(after.data ?? {}).map((d) => d.source),
    ];
    if (
      after.schemaVersion < 4 &&
      recordedSources.some((s) => s.commit !== undefined)
    ) {
      upgradeState(after);
      after.schemaVersion = 4;
    }
    selectedEnvironment(this.root, after);
    validateState(after);
    if (await exists(this.journalPath)) fail("Unrecovered selection operation");
    for (const name of commandNames(after)) await ensureShim(this.root, name);
    await atomicJson(this.journalPath, { before, after });
    try {
      await this.syncCurrents(after, before, after);
      await atomicJson(this.statePath, after);
    } catch (e) {
      await this.recover();
      throw e;
    }
    for (const name of commandNames(before))
      if (!commandNames(after).includes(name))
        await removeShim(this.root, name);
    await rm(this.journalPath);
  }
  async mutate<T>(
    fn: (state: State) => Promise<T>,
    options: { skipUnchanged?: boolean } = {},
  ): Promise<T> {
    await noLinks(join(this.root, "operations", "self-update.json"));
    if (await exists(join(this.root, "operations", "self-update.json")))
      fail(
        "Piko self-update is pending; run the staged candidate with self recover before other mutations",
      );
    await noLinks(this.root);
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, "mutation.lock");
    try {
      await mkdir(lock);
    } catch (e: any) {
      if (e.code === "EEXIST")
        fail(
          "Another operation or interrupted process holds mutation.lock; inspect it before removing it",
        );
      throw e;
    }
    try {
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
        { flag: "wx" },
      );
      await this.recoverRebuild();
      await this.recoverDataRemoval();
      await this.recoverRemoval();
      await this.recover();
      await this.recoverInstallation();
      const before = await this.read(),
        state = structuredClone(before);
      try {
        const result = await fn(state);
        if (
          !options.skipUnchanged ||
          JSON.stringify(before) !== JSON.stringify(state)
        )
          await this.commit(before, state);
        await this.recoverInstallation();
        await this.recoverRebuild();
        await this.recoverRemoval();
        await this.recoverDataRemoval();
        return result;
      } catch (error) {
        await this.recoverRebuild();
        await this.recoverRemoval();
        await this.recoverDataRemoval();
        throw error;
      }
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}
