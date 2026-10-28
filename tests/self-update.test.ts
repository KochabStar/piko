import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  rename,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareSelfUpdate,
  prepareRollback,
  launchSelfUpdater,
  applySelfUpdate,
  executableHash,
  selfUpdateStatus,
} from "../src/self-update.ts";
import { Packages } from "../src/packages.ts";
import { capture, exists } from "../src/util.ts";
const work = await mkdtemp(join(tmpdir(), "piko-self-tests-"));
afterAll(async () => {
  for (let n = 0; ; n++) {
    try {
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      break;
    } catch (e: any) {
      if (n === 19 || !["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
      await Bun.sleep(100);
    }
  }
});
const exe = resolve("dist/piko.exe");
const run = (root: string, file: string, args: string[]) =>
  capture(file, args, { cwd: work, env: { ...process.env, PIKO_HOME: root } });

test("self update rebinds hardlink shims, preserves state, supports rollback and rejects unknown targets", async () => {
  const root = join(work, "installation");
  await run(root, exe, ["setup"]);
  const manager = new Packages(root),
    target = join(root, "apps/piko/piko.exe");
  const before = await readFile(manager.store.statePath, "utf8"),
    hash = await executableHash(exe);
  await expect(
    prepareSelfUpdate(root, exe, "0".repeat(64), process.pid),
  ).rejects.toThrow("checksum");
  const dead = Bun.spawn([exe, "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  const prepared = await prepareSelfUpdate(root, exe, hash, dead.pid);
  const preparedState = await readFile(manager.store.statePath, "utf8");
  await expect(manager.store.mutate(async () => {})).rejects.toThrow(
    "self-update",
  );
  const lock = join(root, "mutation.lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  await expect(applySelfUpdate(root, false, false, true)).rejects.toThrow(
    "still running",
  );
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: dead.pid }));
  await applySelfUpdate(root, false, false, true);
  expect(await executableHash(target)).toBe(hash);
  expect(await readFile(manager.store.statePath, "utf8")).toBe(preparedState);
  const [installed, shim] = await Promise.all([
    stat(target),
    stat(join(root, "shims/piko.exe")),
  ]);
  expect(shim.ino).toBe(installed.ino);
  expect((await selfUpdateStatus(root)).last.phase).toBe("committed");
  expect(
    (await run(root, join(root, "shims/piko.exe"), ["--version"])).trim(),
  ).toBe("0.4.0");
  const again = await prepareSelfUpdate(root, exe, hash, dead.pid);
  await writeFile(target, "unknown executable");
  await expect(applySelfUpdate(root, false)).rejects.toThrow(
    "Installed Piko changed",
  );
  expect(await readFile(target, "utf8")).toBe("unknown executable");
  await copyFile(exe, target);
  await applySelfUpdate(root, false, true);
  expect((await selfUpdateStatus(root)).last.phase).toBe("rolled-back");
  expect(await exists(join(root, "apps/piko/current"))).toBe(false);
  expect(await exists(again.candidate)).toBe(true);
  expect(before.length).toBeGreaterThan(0);
  expect(prepared.version).toBe("0.4.0");
}, 60000);

test("older executable upgrades to new bytes and interrupted directory swap rolls forward", async () => {
  const root = join(work, "real-upgrade"),
    older = (await exists(
      resolve(".sandbox/20261027-163007-991fe338/input/piko.exe"),
    ))
      ? resolve(".sandbox/20261027-163007-991fe338/input/piko.exe")
      : exe;
  await run(root, older, ["setup"]);
  expect(
    (await run(root, join(root, "shims/piko.exe"), ["--version"])).trim(),
  ).toMatch(/^0\.[34]\.0$/);
  const dead = Bun.spawn([exe, "--version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  const plan = await prepareSelfUpdate(
      root,
      exe,
      await executableHash(exe),
      dead.pid,
    ),
    state = await readFile(join(root, "apps/piko/state.json"), "utf8");
  expect(
    await executableHash(join(root, "staging", plan.operation, "helper.exe")),
  ).toBe(await executableHash(exe));
  const journal = join(root, "operations/self-update.json"),
    entry = JSON.parse(await readFile(journal, "utf8"));
  entry.phase = "swapping";
  await writeFile(journal, JSON.stringify(entry));
  await rename(
    join(root, "apps/piko/piko.exe"),
    join(root, "staging", plan.operation, "old-moved.exe"),
  );
  await applySelfUpdate(root, false);
  expect(
    (await run(root, join(root, "shims/piko.exe"), ["--version"])).trim(),
  ).toBe("0.4.0");
  expect(await readFile(join(root, "apps/piko/state.json"), "utf8")).toBe(
    state,
  );
  expect(await executableHash(join(root, "apps/piko/backup.exe"))).toBe(
    await executableHash(older),
  );
  const rollback = await prepareRollback(root, dead.pid);
  await launchSelfUpdater(root, rollback.candidate);
  const started = Date.now();
  while ((await selfUpdateStatus(root)).pending) {
    if (Date.now() - started > 30000)
      throw new Error("Legacy rollback remained pending");
    await Bun.sleep(100);
  }
  expect(
    (await run(root, join(root, "shims/piko.exe"), ["--version"])).trim(),
  ).toBe(older === exe ? "0.4.0" : "0.3.0");
  expect(await readFile(join(root, "apps/piko/state.json"), "utf8")).toBe(
    state,
  );
}, 60000);

test("release installer verifies checksum before execution and uses an isolated requested root", async () => {
  const folder = join(work, "release-fixture"),
    root = join(work, "installer-root");
  await mkdir(folder);
  await copyFile(exe, join(folder, "piko.exe"));
  await copyFile(resolve("scripts/install.ps1"), join(folder, "install.ps1"));
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(folder, "install.ps1"),
    "-PikoHome",
    root,
    "-Sha256",
  ];
  await expect(
    capture("powershell.exe", [...args, "0".repeat(64)], { cwd: work }),
  ).rejects.toThrow("checksum");
  expect(await exists(join(root, "apps/piko/state.json"))).toBe(false);
  await capture("powershell.exe", [...args, await executableHash(exe)], {
    cwd: work,
  });
  expect(await exists(join(root, "apps/piko/state.json"))).toBe(true);
  expect(await exists(join(root, "state.json"))).toBe(false);
}, 60000);

test("compiled self update runs after initiating process exits and reports completion", async () => {
  const root = join(work, "detached");
  await run(root, exe, ["setup"]);
  const target = join(root, "apps/piko/piko.exe"),
    hash = await executableHash(exe);
  const response = JSON.parse(
    await run(root, target, ["self", "update", exe, "--sha256", hash, "--yes"]),
  );
  expect(response.status).toBe("pending");
  const started = Date.now();
  while ((await selfUpdateStatus(root)).pending) {
    if (Date.now() - started > 30000)
      throw new Error(
        "Updater did not finish: " +
          (await readFile(join(root, "apps/piko/update.log"), "utf8")),
      );
    await Bun.sleep(100);
  }
  expect((await selfUpdateStatus(root)).last.phase).toBe("committed");
  expect(await executableHash(target)).toBe(hash);
  await run(root, target, ["self", "rollback", "--yes"]);
  const rollbackStarted = Date.now();
  while ((await selfUpdateStatus(root)).pending) {
    if (Date.now() - rollbackStarted > 30000)
      throw new Error("Rollback did not finish");
    await Bun.sleep(100);
  }
  expect((await selfUpdateStatus(root)).last.phase).toBe("committed");
  expect(await executableHash(target)).toBe(hash);
}, 60000);
