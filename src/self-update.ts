import {
  mkdir,
  writeFile,
  rename,
  copyFile,
  link,
  unlink,
  stat,
  rm,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { downloadArtifact } from "./downloader.ts";
import { Store } from "./store.ts";
import { commandNames } from "./commands.ts";
import { inspectShim, writeNativeShim } from "./shims.ts";
import {
  atomicJson,
  capture,
  exists,
  fail,
  json,
  noLinks,
  removeTree,
} from "./util.ts";

export async function executableHash(path: string): Promise<string> {
  await noLinks(path);
  const h = createHash("sha256");
  for await (const part of createReadStream(path)) h.update(part);
  return h.digest("hex");
}
const journal = (root: string) => join(root, "operations", "self-update.json");
export async function prepareSelfUpdate(
  root: string,
  from: string,
  checksum: string,
  parent: number,
  legacyRollback = false,
  expectedVersion?: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(checksum))
    fail("Self-update requires an explicit SHA-256 from a trusted channel");
  const store = new Store(root);
  let result:
    { operation: string; candidate: string; version: string } | undefined;
  await store.mutate(
    async (state) => {
      const target = join(root, "apps", "piko", "piko.exe");
      await noLinks(target);
      if (!(await exists(target))) fail("Set up Piko first");
      const operation = "self-update-" + crypto.randomUUID(),
        dir = join(root, "staging", operation),
        candidate = join(dir, "candidate.exe");
      await noLinks(dir);
      await mkdir(dir, { recursive: true });
      try {
        if (/^https:\/\//i.test(from))
          await writeFile(candidate, await downloadArtifact(root, from, state));
        else {
          await noLinks(resolve(from));
          await copyFile(resolve(from), candidate);
        }
        if ((await executableHash(candidate)) !== checksum.toLowerCase())
          fail("Self-update checksum mismatch");
        const profiles = join(root, "apps/piko/data-profiles.json");
        if (await exists(profiles)) {
          await noLinks(profiles);
          const receipt = await json(profiles);
          if (Object.keys(receipt.profiles ?? {}).length) {
            const features = JSON.parse(
              await capture(candidate, ["self", "check"], {
                cwd: dir,
                env: { ...process.env, PIKO_HOME: root },
              }),
            );
            if (features.dataProfiles !== 1)
              fail(
                "Candidate cannot preserve active data-profile integrations",
              );
          }
        }
        const stateFile = join(root, "apps/piko/state.json");
        if (await exists(stateFile)) {
          const current = await json(stateFile);
          if (Object.keys(current.startMenu ?? {}).length) {
            const features = JSON.parse(
              await capture(candidate, ["self", "check"], {
                cwd: dir,
                env: { ...process.env, PIKO_HOME: root },
              }),
            );
            if (features.startMenu !== 1)
              fail("Candidate cannot preserve Start Menu ownership");
          }
        }
        const env = { ...process.env, PIKO_HOME: root };
        let probe: { protocol: number; version: string };
        try {
          probe = JSON.parse(
            await capture(candidate, ["self", "check"], { cwd: dir, env }),
          );
        } catch (error) {
          if (!legacyRollback) throw error;
          const version = await capture(candidate, ["--version"], {
            cwd: dir,
            env,
          });
          if (
            !["0.1.0", "0.2.0", "0.3.0"].includes(version) ||
            state.schemaVersion > Number(version.split(".")[1])
          )
            fail(
              "Backup Piko is not compatible with current state schema; refusing rollback",
            );
          probe = { protocol: 1, version };
        }
        await copyFile(
          legacyRollback ? target : candidate,
          join(dir, "helper.exe"),
        );
        if (probe.protocol !== 1 || typeof probe.version !== "string")
          fail("Candidate does not support the Piko upgrade protocol");
        if (expectedVersion && probe.version !== expectedVersion)
          fail("Candidate executable version does not match Release metadata");
        const names = [...new Set(["piko", ...commandNames(state)])].sort();
        for (const name of names) await inspectShim(root, name, [target]);
        await copyFile(target, join(dir, "old.exe"));
        const oldHash = await executableHash(target);
        await atomicJson(journal(root), {
          operation,
          parent,
          checksum: checksum.toLowerCase(),
          oldHash,
          names,
          version: probe.version,
          phase: "pending",
        });
        result = { operation, candidate, version: probe.version };
      } catch (error) {
        if (!(await exists(journal(root)))) await removeTree(dir);
        throw error;
      }
    },
    { skipUnchanged: true },
  );
  return result!;
}
async function links(
  root: string,
  names: string[],
  allowed: string[],
  target: string,
) {
  let native = false;
  try {
    const probe = JSON.parse(
      await capture(target, ["self", "check"], {
        env: { ...process.env, PIKO_HOME: root },
      }),
    );
    native = probe.shimProtocol === 1;
  } catch {
    /* Old rollback versions can lack self check. */
  }
  // Preflight the whole set before changing any existing shim.
  for (const name of names) await inspectShim(root, name, allowed);
  if (native) {
    for (const name of names) await writeNativeShim(root, name, allowed);
    return;
  }
  const valid = [];
  for (const file of allowed)
    if (await exists(file)) valid.push(await stat(file));
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9._+-]{0,79}$/.test(name))
      fail("Invalid upgrade shim name");
    const file = join(root, "shims", name + ".exe");
    await noLinks(file);
    if (await exists(file)) {
      const current = await stat(file);
      if (
        !valid.some((i) => i.ino === current.ino && i.dev === current.dev) &&
        (await inspectShim(root, name, allowed)).kind !== "native"
      )
        fail("Unrecognized shim during upgrade; preserving journal");
      await unlink(file);
    }
    const metadata = join(root, "shims", name + ".shim");
    if (await exists(metadata)) await unlink(metadata);
    await link(target, file);
  }
}
export async function applySelfUpdate(
  root: string,
  waitForParent = true,
  rollback = false,
  recoverDeadLock = false,
) {
  const file = journal(root);
  await noLinks(file);
  const entry = await json(file);
  if (
    !/^self-update-[0-9a-f-]{36}$/.test(entry.operation) ||
    !Array.isArray(entry.names) ||
    !Number.isSafeInteger(entry.parent) ||
    entry.parent <= 0 ||
    !["pending", "swapping", "committed", "rolled-back"].includes(
      entry.phase,
    ) ||
    !/^[a-f0-9]{64}$/.test(entry.oldHash) ||
    !/^[a-f0-9]{64}$/.test(entry.checksum)
  )
    fail("Invalid self-update journal");
  if (entry.phase === "rolled-back") rollback = true;
  for (let n = 0; ; n++) {
    try {
      process.kill(entry.parent, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") break;
      throw error;
    }
    if (!waitForParent || n === 300)
      fail("Parent is still alive; self-update remains pending");
    await Bun.sleep(100);
  }
  const lock = join(root, "mutation.lock");
  await noLinks(lock);
  if (await exists(lock)) {
    if (!recoverDeadLock)
      fail(
        "An update lock exists; inspect it and use self recover --force only after the owner exits",
      );
    await noLinks(join(lock, "owner.json"));
    const owner = await json(join(lock, "owner.json"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
      fail("Invalid update lock owner; manual inspection required");
    try {
      process.kill(owner.pid, 0);
      fail("Update lock owner is still running");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
    await rm(lock, { recursive: true });
  }
  await mkdir(lock);
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
      { flag: "wx" },
    );
    const dir = join(root, "staging", entry.operation),
      candidate = join(dir, "candidate.exe"),
      old = join(dir, "old.exe"),
      moved = join(dir, "old-moved.exe"),
      target = join(root, "apps", "piko", "piko.exe");
    for (const path of [dir, candidate, old, moved, target])
      await noLinks(path);
    if ((await executableHash(old)) !== entry.oldHash)
      fail("Old executable backup changed");
    if (!rollback && (await executableHash(candidate)) !== entry.checksum)
      fail("Candidate executable changed");
    if (rollback) {
      if (await exists(target)) {
        const hash = await executableHash(target);
        if (![entry.oldHash, entry.checksum].includes(hash))
          fail("Unknown installed executable; refusing rollback");
      }
      await links(root, entry.names, [target, moved, old], old);
      if (await exists(target)) await unlink(target);
      await link(old, target);
      entry.phase = "rolled-back";
    } else {
      if (entry.phase === "pending") {
        if ((await executableHash(target)) !== entry.oldHash)
          fail("Installed Piko changed after upgrade preparation");
        entry.phase = "swapping";
        await atomicJson(file, entry);
      }
      if (await exists(target)) {
        const currentHash = await executableHash(target);
        if (currentHash === entry.oldHash) {
          if (!(await exists(moved))) await rename(target, moved);
          else await unlink(target);
        } else if (currentHash !== entry.checksum)
          fail("Unknown executable at upgrade target");
      }
      if (!(await exists(target))) {
        const incoming = join(dir, "incoming.exe");
        await noLinks(incoming);
        if (await exists(incoming)) await unlink(incoming);
        await copyFile(candidate, incoming);
        if ((await executableHash(incoming)) !== entry.checksum)
          fail("Incomplete incoming executable");
        await rename(incoming, target);
      }
      await links(root, entry.names, [moved, old, target], target);
      if ((await executableHash(target)) !== entry.checksum)
        fail("Installed upgrade checksum mismatch");
      entry.phase = "committed";
    }
    await atomicJson(file, entry);
    // Keep backup at a fixed unversioned path; never alter state.json.
    const backup = join(root, "apps", "piko", "backup.exe");
    await noLinks(backup);
    if (await exists(backup)) {
      const resultFile = join(root, "apps", "piko", "update-result.json");
      await noLinks(resultFile);
      if (
        (await executableHash(backup)) !== entry.oldHash &&
        (!(await exists(resultFile)) ||
          (await json(resultFile)).oldHash !== (await executableHash(backup)))
      )
        fail(
          "Untracked Piko backup exists; inspect it before completing update",
        );
    }
    const backupPending = join(dir, "backup-pending.exe");
    await noLinks(backupPending);
    if (await exists(backupPending)) await unlink(backupPending);
    await copyFile(old, backupPending);
    if ((await executableHash(backupPending)) !== entry.oldHash)
      fail("Backup copy incomplete");
    await rename(backupPending, backup);
    await atomicJson(join(root, "apps", "piko", "update-result.json"), {
      ...entry,
      finishedAt: new Date().toISOString(),
      backup,
    });
    await rm(file);
    // Running candidate.exe cannot be deleted on Windows. Retain its identified
    // operation directory for explicit maintenance; never sweep unknown staging.
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function selfUpdateStatus(root: string) {
  const pending = journal(root),
    result = join(root, "apps", "piko", "update-result.json");
  for (const file of [pending, result]) await noLinks(file);
  return {
    pending: (await exists(pending)) ? await json(pending) : null,
    last: (await exists(result)) ? await json(result) : null,
  };
}
export async function prepareRollback(root: string, parent: number) {
  const status = await selfUpdateStatus(root),
    backup = join(root, "apps", "piko", "backup.exe");
  if (
    !status.last ||
    status.last.phase !== "committed" ||
    typeof status.last.oldHash !== "string"
  )
    fail("No committed upgrade backup available");
  if ((await executableHash(backup)) !== status.last.oldHash)
    fail("Backup executable changed");
  return await prepareSelfUpdate(
    root,
    backup,
    status.last.oldHash,
    parent,
    true,
  );
}
export async function launchSelfUpdater(root: string, candidate: string) {
  const helper = join(resolve(candidate, ".."), "helper.exe");
  await noLinks(helper);
  if (!(await exists(helper))) fail("Prepared updater helper missing");
  const log = join(root, "apps", "piko", "update.log");
  await noLinks(log);
  const handle = await open(log, "a");
  try {
    const child = Bun.spawn([helper, "self", "apply"], {
      env: { ...process.env, PIKO_HOME: root },
      cwd: join(root, "apps", "piko"),
      stdin: "ignore",
      stdout: handle.fd,
      stderr: handle.fd,
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } finally {
    await handle.close();
  }
  return log;
}
