import { VERSION } from "../src/version.ts";
import { test, expect, afterAll } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
  link,
  stat,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ensureShim, removeShim } from "../src/windows.ts";
import { inspectShim, shimConfiguration } from "../src/shims.ts";
import { capture, exists } from "../src/util.ts";
const work = await mkdtemp(join(tmpdir(), "piko-native-shim-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
);
const exe = resolve("dist/piko.exe");
const env = (root: string) => {
  const e = { ...process.env, PIKO_HOME: root };
  return e;
};
async function setup(root: string) {
  await capture(exe, ["setup"], { env: env(root) });
  return join(root, "apps/piko/piko.exe");
}

test("native shim is a small PE with Scoop-shaped companion metadata, not the runtime hardlink", async () => {
  const root = join(work, "small"),
    target = await setup(root),
    shim = join(root, "shims/piko.exe");
  const [a, b] = await Promise.all([stat(target), stat(shim)]);
  expect(b.size).toBeLessThan(65536);
  expect(b.ino).not.toBe(a.ino);
  expect((await readFile(shim)).subarray(0, 2).toString()).toBe("MZ");
  expect(await readFile(join(root, "shims/piko.shim"), "utf8")).toBe(
    shimConfiguration("piko"),
  );
  expect((await capture(shim, ["--version"], { env: env(root) })).trim()).toBe(
    VERSION,
  );
});
test("verified old hardlinks migrate without truncating the real executable", async () => {
  const root = join(work, "legacy");
  await mkdir(join(root, "apps/piko"), { recursive: true });
  await mkdir(join(root, "shims"));
  const target = join(root, "apps/piko/piko.exe"),
    shim = join(root, "shims/piko.exe");
  await copyFile(exe, target);
  await link(target, shim);
  const before = await readFile(target);
  await ensureShim(root, "piko");
  expect(await readFile(target)).toEqual(before);
  expect((await stat(shim)).size).toBeLessThan(65536);
  expect((await stat(shim)).ino).not.toBe((await stat(target)).ino);
});
test("native launcher refuses changed configuration instead of running its injected target", async () => {
  const root = join(work, "config"),
    target = await setup(root),
    shim = join(root, "shims/piko.exe"),
    config = join(root, "shims/piko.shim");
  await writeFile(
    config,
    'path = "C:\\Windows\\System32\\cmd.exe"\r\nargs = /c echo injected\r\n',
  );
  await expect(
    capture(shim, ["--version"], { env: env(root) }),
  ).rejects.toThrow();
  await expect(ensureShim(root, "piko")).rejects.toThrow(".shim");
  await expect(removeShim(root, "piko")).rejects.toThrow(".shim");
  expect(await exists(target)).toBe(true);
});
test("external EXEs and orphan hostile metadata are never overwritten", async () => {
  const root = join(work, "foreign");
  await setup(root);
  await writeFile(join(root, "shims/foreign.exe"), "external");
  await expect(ensureShim(root, "foreign")).rejects.toThrow("external");
  await expect(removeShim(root, "foreign")).rejects.toThrow("external");
  expect(await readFile(join(root, "shims/foreign.exe"), "utf8")).toBe(
    "external",
  );
  await writeFile(join(root, "shims/orphan.shim"), "foreign configuration");
  await expect(ensureShim(root, "orphan")).rejects.toThrow("configuration");
});
test("remove/recreate handles both members and retains unrelated files", async () => {
  const root = join(work, "remove");
  await setup(root);
  await ensureShim(root, "test-command");
  await writeFile(join(root, "shims/unrelated.txt"), "user");
  await removeShim(root, "test-command");
  expect(await exists(join(root, "shims/test-command.exe"))).toBe(false);
  expect(await exists(join(root, "shims/test-command.shim"))).toBe(false);
  expect(await readFile(join(root, "shims/unrelated.txt"), "utf8")).toBe(
    "user",
  );
  await ensureShim(root, "test-command");
  expect((await inspectShim(root, "test-command")).kind).toBe("native");
});
test("the relative shim follows a relocated root without PIKO_HOME", async () => {
  const root = join(work, "before relocation"),
    moved = join(work, "after relocation 中文");
  await setup(root);
  await rename(root, moved);
  const e = { ...process.env };
  Reflect.deleteProperty(e, "PIKO_HOME");
  expect(
    (
      await capture(join(moved, "shims/piko.exe"), ["--version"], { env: e })
    ).trim(),
  ).toBe(VERSION);
  expect(
    JSON.parse(
      await capture(join(moved, "shims/piko.exe"), ["list", "--json"], {
        env: e,
      }),
    ),
  ).toEqual([]);
});
test("native dispatch keeps its own command identity and rejects unauthorised missing commands", async () => {
  const root = join(work, "identity"),
    target = await setup(root);
  await ensureShim(root, "unknown-cli");
  await expect(
    capture(join(root, "shims/unknown-cli.exe"), ["--help"], {
      env: env(root),
    }),
  ).rejects.toThrow();
  expect(
    (await capture(target, ["--version"], { env: env(root) })).trim(),
  ).toBe(VERSION);
});
