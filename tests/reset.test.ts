import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  readlink,
  rm,
  unlink,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { resetPackages } from "../src/reset.ts";
import { applyPersist, planPersist } from "../src/data-profiles.ts";
import { WindowsEffects } from "../src/windows-effects.ts";
import { exists, sha256, atomicJson } from "../src/util.ts";
import { inspectShim } from "../src/shims.ts";
import { startMenuEffects } from "../src/start-menu.ts";

const work = await mkdtemp(join(tmpdir(), "piko-reset-tests-"));
const bytes = Buffer.from("fixture executable: never launched");
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    requests++;
    const path = new URL(request.url).pathname;
    if (path === "/file") return new Response(bytes);
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          ["app", "other", "dingtalk"].map((name) => [
            name,
            {
              latest: "2",
              versions: { "1": `${name}/1.json`, "2": `${name}/2.json` },
            },
          ]),
        ),
      });
    const [, name, versionFile] = path.split("/"),
      version = versionFile!.replace(".json", "");
    return Response.json({
      schemaVersion: 1,
      name,
      version,
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          sha256: sha256(bytes),
          format: "file",
          file: "app.exe",
          bin: { [name!]: "app.exe", [name + "-released"]: "app.exe" },
          persist: [
            "data",
            {
              path: "settings.ini",
              kind: "file",
              mode: "hardlink",
              initial: "first-run",
            },
            {
              path: "seed.ini",
              kind: "file",
              mode: "seed",
              initial: "initial seed",
            },
          ],
          desktop: {
            shortcuts: [{ name: name!, path: "app.exe" }],
            environment: { NO_RESET_ENV: "{root}" },
          },
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 15,
    retryDelay: 100,
  });
});
class Backend extends WindowsEffects {
  fail = false;
  override async shortcut(target: string, args: string) {
    return Buffer.from(JSON.stringify([target, args]));
  }
  override async write(...args: Parameters<WindowsEffects["write"]>) {
    if (this.fail && args[2] !== null)
      throw Error("injected shortcut write failure");
    return await super.write(...args);
  }
}
async function fixture(name = "app") {
  const root = await mkdtemp(join(work, "root-"));
  const backend = new Backend(join(root, "external"));
  const p = new Packages(root, backend);
  await mkdir(join(root, "apps/piko"), { recursive: true });
  await copyFile(resolve("dist/piko.exe"), join(root, "apps/piko/piko.exe"));
  await p.addSource("test", `http://127.0.0.1:${server.port}/`);
  const install = await p.install(`test/${name}@1`);
  await p.use(`test/${name}@1`);
  const shortcut = join(
    (await backend.folders()).startMenu,
    "Piko Apps",
    name + ".lnk",
  );
  return {
    p,
    root,
    backend,
    install,
    shortcut,
    current: join(root, "apps", name, "current"),
    shared: join(root, "persist", name),
    app: join(root, install.dir),
  };
}
test("reset repairs missing shortcut, both shim members, current, directory and file mappings offline without touching user data", async () => {
  const { p, root, install, shortcut, current, shared, app } = await fixture();
  await p.aliasCommand("my-app", "test/app", "app");
  await p.releaseCommand("app-released");
  await writeFile(join(shared, "data/chat"), "keep chat data");
  await writeFile(join(shared, "settings.ini"), "keep settings");
  await writeFile(join(shared, "seed.ini"), "keep seed data");
  await rm(shortcut);
  await unlink(current);
  await unlink(join(app, "data"));
  await unlink(join(app, "settings.ini"));
  await rm(join(root, "shims/app.exe"));
  await rm(join(root, "shims/my-app.shim"));
  const state = await readFile(p.store.statePath, "utf8"),
    count = requests;
  const preview = await resetPackages(p, "test/app", { dryRun: true });
  expect(preview.data).toHaveLength(2);
  expect(preview.current).toHaveLength(1);
  expect(preview.shims.sort()).toEqual(["app", "my-app"]);
  expect(await exists(shortcut)).toBe(false);
  expect(await exists(current)).toBe(false);
  expect(await readFile(p.store.statePath, "utf8")).toBe(state);
  const result = await resetPackages(p, "test/app");
  expect(result.status).toBe("completed");
  expect(requests).toBe(count);
  expect(resolve(await readlink(current))).toBe(resolve(app));
  expect(resolve(await readlink(join(app, "data")))).toBe(
    resolve(join(shared, "data")),
  );
  expect((await lstat(join(app, "settings.ini"))).ino).toBe(
    (await lstat(join(shared, "settings.ini"))).ino,
  );
  expect(await readFile(join(app, "data/chat"), "utf8")).toBe("keep chat data");
  expect(await readFile(join(app, "settings.ini"), "utf8")).toBe(
    "keep settings",
  );
  expect(await readFile(join(shared, "seed.ini"), "utf8")).toBe(
    "keep seed data",
  );
  expect((await inspectShim(root, "app")).kind).toBe("native");
  expect((await inspectShim(root, "my-app")).kind).toBe("native");
  expect(await exists(join(root, "shims/app-released.exe"))).toBe(false);
  expect(await exists(shortcut)).toBe(true);
  const after = await p.store.read();
  expect(after.defaults[install.key]).toEqual(
    JSON.parse(state).defaults[install.key],
  );
  expect(after.desktop).toBeUndefined();
  const stable = await readFile(p.store.statePath, "utf8");
  await resetPackages(p, "test/app");
  expect(await readFile(p.store.statePath, "utf8")).toBe(stable);
});
test("reset --all enrolls legacy GUI receipts and repairs manager shim without switching defaults", async () => {
  const { p, root, install, shortcut } = await fixture();
  await rm(shortcut);
  const state = await p.store.read();
  delete state.startMenu;
  await atomicJson(p.store.statePath, state);
  const v2 = await p.install("test/app@2");
  // Restore a pre-feature state to simulate installations made by an older Piko.
  const legacy = await p.store.read();
  delete legacy.startMenu;
  await atomicJson(p.store.statePath, legacy);
  await rm(shortcut);
  await resetPackages(p);
  expect(await exists(join(root, "shims/piko.exe"))).toBe(true);
  const after = await p.store.read();
  expect(after.startMenu![install.key]!.id).toBe(install.id);
  expect(after.defaults[install.key]!.id).not.toBe(v2.id);
  await expect(resetPackages(p, "test/app@2")).rejects.toThrow(
    "never switches",
  );
});
test("preflight refuses modified shortcuts, external shims, changed data links and hardlink replacements without partial repairs", async () => {
  for (const kind of ["shortcut", "shim", "data", "file"] as const) {
    const { p, root, shortcut, current, shared, app } = await fixture();
    await unlink(current);
    if (kind === "shortcut") await writeFile(shortcut, "foreign shortcut");
    if (kind === "shim")
      await writeFile(join(root, "shims/app.shim"), "foreign shim");
    if (kind === "data") {
      await unlink(join(app, "data"));
      await mkdir(join(app, "data"));
      await writeFile(join(app, "data/user"), "preserve");
    }
    if (kind === "file") {
      await unlink(join(app, "settings.ini"));
      await writeFile(join(app, "settings.ini"), "atomic replaced config");
    }
    const state = await readFile(p.store.statePath, "utf8");
    await expect(resetPackages(p, "test/app")).rejects.toThrow();
    expect(await exists(current)).toBe(false);
    expect(await readFile(p.store.statePath, "utf8")).toBe(state);
    expect(await readFile(join(shared, "settings.ini"), "utf8")).toBe(
      "first-run",
    );
  }
});
test("missing actual data is not recreated from empty defaults, and foreign junctions are not replaced", async () => {
  const { p, app, shared, current } = await fixture();
  await unlink(current);
  await unlink(join(app, "data"));
  await rm(join(shared, "data"), { recursive: true });
  await expect(resetPackages(p, "app")).rejects.toThrow(
    "never recreates lost data",
  );
  expect(await exists(join(shared, "data"))).toBe(false);
  expect(await exists(current)).toBe(false);
  await mkdir(join(shared, "data"));
  const foreign = join(work, "foreign-" + crypto.randomUUID());
  await mkdir(foreign);
  await symlink(foreign, join(app, "data"), "junction");
  await expect(resetPackages(p, "app")).rejects.toThrow("conflicts");
  expect(resolve(await readlink(join(app, "data")))).toBe(resolve(foreign));
});
test("reset repairs only already-approved external profile mappings, requires stopped apps and preserves archives", async () => {
  const { p, root } = await fixture("dingtalk");
  const folders = {
    local: join(root, "local"),
    roaming: join(root, "roaming"),
    documents: join(root, "documents"),
  };
  for (const f of Object.values(folders)) await mkdir(f);
  const original = join(folders.roaming, "DingTalk");
  await mkdir(original);
  await writeFile(join(original, "old"), "keep original");
  let busy = false;
  const context = { folders, processes: async () => (busy ? [55] : []) };
  const plan = await planPersist(p.store, "test/dingtalk", false, context);
  await applyPersist(p.store, "test/dingtalk", plan.binding, false, context);
  const mapping = plan.mappings[0]!;
  await writeFile(join(mapping.target, "new"), "keep new data");
  await unlink(mapping.source);
  busy = true;
  await expect(resetPackages(p, "dingtalk", { context })).rejects.toThrow(
    "Close application",
  );
  expect(await exists(mapping.source)).toBe(false);
  busy = false;
  await resetPackages(p, "dingtalk", { context });
  expect(await readFile(join(mapping.source, "new"), "utf8")).toBe(
    "keep new data",
  );
  expect(await readFile(join(mapping.backup, "old"), "utf8")).toBe(
    "keep original",
  );
});
test("missing-only shortcut repair rolls back failed writes and reconstructs recovery without trusting arbitrary targets", async () => {
  const { p, backend, shortcut, install } = await fixture();
  const before = await p.store.read();
  await rm(shortcut);
  backend.fail = true;
  await expect(resetPackages(p, "app")).rejects.toThrow("injected");
  expect(await exists(shortcut)).toBe(false);
  backend.fail = false;
  await resetPackages(p, "app");
  expect(await exists(shortcut)).toBe(true);
  const after = await p.store.read(),
    effects = await startMenuEffects(
      before,
      after,
      backend,
      [install.key],
      [
        {
          target: { kind: "file", path: shortcut },
          before: null,
          after: { hash: after.startMenu![install.key]!.entries[0]!.hash },
        },
      ],
    );
  // Simulate a committed transaction whose .lnk had not yet been written.
  await rm(shortcut);
  await atomicJson(p.store.journalPath, {
    before,
    after,
    startMenu: effects,
    startMenuRepairKeys: [install.key],
  });
  await p.store.recover();
  expect(await exists(shortcut)).toBe(true);
});
