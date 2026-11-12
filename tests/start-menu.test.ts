import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { WindowsEffects } from "../src/windows-effects.ts";
import { sha256, exists, atomicJson } from "../src/util.ts";
import { startMenuEffects } from "../src/start-menu.ts";
import type { EffectTarget, EffectValue } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-start-menu-"));
const payload = Buffer.from("test GUI; never execute");
const manifests = new Map<string, any>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname.slice(1);
    if (path === "file") return new Response(payload);
    if (path === "index.json") {
      const packages: Record<string, any> = {};
      for (const m of manifests.values()) {
        packages[m.name] ??= { latest: m.version, versions: {} };
        packages[m.name].latest = m.version;
        packages[m.name].versions[m.version] = `${m.name}-${m.version}.json`;
      }
      return Response.json({ schemaVersion: 1, packages });
    }
    return Response.json(manifests.get(path));
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
class Backend extends WindowsEffects {
  failName = "";
  override async shortcut(target: string, args: string) {
    return Buffer.from(JSON.stringify({ target, args }));
  }
  override async write(
    target: EffectTarget,
    before: EffectValue,
    after: EffectValue,
    bytes?: Uint8Array,
  ) {
    if (
      this.failName &&
      target.kind === "file" &&
      target.path.endsWith(this.failName)
    )
      throw Error("injected shortcut failure");
    return await super.write(target, before, after, bytes);
  }
}
function manifest(
  name: string,
  version: string,
  label: string,
  second = false,
) {
  const result = {
    schemaVersion: 1,
    name,
    version,
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        sha256: sha256(payload),
        format: "file",
        file: "gui.exe",
        bin: {},
        desktop: {
          shortcuts: [
            {
              name: label,
              path: "gui.exe",
              args: ["--data", "{persist}/space here", 'quote"&literal'],
            },
            ...(second ? [{ name: label + " B", path: "gui.exe" }] : []),
          ],
          environment: { NEVER_AUTO_ENABLE: "{root}" },
          menus: [
            {
              id: "open",
              label: "Do not enable",
              target: "file",
              path: "gui.exe",
            },
          ],
        },
      },
    },
  };
  manifests.set(`${name}-${version}.json`, result);
  return result;
}
async function fixture() {
  const root = await mkdtemp(join(work, "case-"));
  const backend = new Backend(join(root, "external"));
  const p = new Packages(join(root, "home"), backend);
  const name = "gui-" + crypto.randomUUID().slice(0, 8),
    label = "Test " + name;
  manifest(name, "1", label);
  await p.addSource("test", `http://127.0.0.1:${server.port}/`);
  const folder = join((await backend.folders()).startMenu, "Piko Apps");
  return {
    root,
    backend,
    p,
    name,
    label,
    path: join(folder, label + ".lnk"),
    folder,
  };
}
// The launcher targets the package's current junction; the version directory
// holding the live executable sits right beside it.
const currentLink = (p: { root: string }, i: { dir: string }) =>
  join(dirname(join(p.root, i.dir)), "current");
test("install creates real launcher metadata without selecting commands or enabling other desktop effects", async () => {
  const { p, name, label, path } = await fixture();
  const i = await p.install(`test/${name}@1`);
  const s = await p.store.read(),
    shortcut = JSON.parse(await readFile(path, "utf8"));
  expect(shortcut.target).toBe(join(currentLink(p, i), "gui.exe"));
  expect(shortcut.args).toContain("space here");
  expect(shortcut.target.endsWith(".shim")).toBe(false);
  // Without an explicit selection the junction follows the newest install.
  expect(resolve(await readlink(currentLink(p, i))).toLowerCase()).toBe(
    resolve(join(p.root, i.dir)).toLowerCase(),
  );
  expect(s.defaults).toEqual({});
  expect(s.commands).toEqual({});
  expect(s.desktop).toBeUndefined();
  expect(s.startMenu![i.key]!.entries[0]!.name).toBe(label);
  await p.uninstall(`test/${name}@1`);
  expect(await exists(path)).toBe(false);
  expect(await exists(currentLink(p, i))).toBe(false);
});
test("candidate install preserves selected launcher; switch, rollback and uninstall keep ownership in sync", async () => {
  const { p, name, label, path } = await fixture();
  const v1 = await p.install(`test/${name}@1`);
  await p.use(`test/${name}@1`);
  const first = await readFile(path, "utf8");
  manifest(name, "2", label);
  const v2 = await p.install(`test/${name}@2`);
  expect(await readFile(path, "utf8")).toBe(first);
  // Selection switches only redirect the current junction; the .lnk bytes
  // keep targeting it, so no Start Menu entry is rewritten.
  await p.use(`test/${name}@2`);
  expect(await readFile(path, "utf8")).toBe(first);
  expect(resolve(await readlink(currentLink(p, v2))).toLowerCase()).toBe(
    resolve(join(p.root, v2.dir)).toLowerCase(),
  );
  await p.use(`test/${name}@1`);
  expect(await readFile(path, "utf8")).toBe(first);
  expect(resolve(await readlink(currentLink(p, v1))).toLowerCase()).toBe(
    resolve(join(p.root, v1.dir)).toLowerCase(),
  );
  await p.uninstall(`test/${name}@2`);
  expect(await readFile(path, "utf8")).toBe(first);
  await p.uninstall(`test/${name}@1`, true);
  expect(await exists(path)).toBe(false);
});
test("same-name foreign files are skipped without failing the install, and cross-package names are refused", async () => {
  const { p, name, label, path, folder } = await fixture();
  await mkdir(folder, { recursive: true });
  await writeFile(path, "foreign");
  // One occupied launcher path must not fail the whole install: the package is
  // installed, the foreign file is untouched and no receipt claims it.
  const i = await p.install(`test/${name}@1`);
  expect(await readFile(path, "utf8")).toBe("foreign");
  expect((await p.store.read()).startMenu?.[i.key]).toBeUndefined();
  expect(await exists(join(p.root, i.dir, "gui.exe"))).toBe(true);
  // Recovery no longer loops on that conflict either.
  await p.store.mutate(async () => {});
  await rm(path);
  await p.store.mutate(async () => {});
  expect(await exists(path)).toBe(false);
  const other = name + "-other";
  manifest(other, "1", label);
  await p.use(`test/${name}@1`);
  // A launcher name another Piko package owns stays a refusal for that package,
  // but the already installed one keeps working and no state is rewritten.
  await expect(p.install(`test/${other}@1`)).rejects.toThrow(
    "belongs to another package",
  );
  expect(JSON.parse(await readFile(path, "utf8")).target).toContain(name);
  expect((await p.store.read()).installs[i.id]).toBeDefined();
});
test("user-edited launchers block removal and retain both installation and edited shortcut", async () => {
  const { p, name, path } = await fixture();
  const i = await p.install(`test/${name}@1`);
  await writeFile(path, "user edit");
  await expect(p.uninstall(`test/${name}@1`)).rejects.toThrow(
    "Start Menu resource",
  );
  expect(await readFile(path, "utf8")).toBe("user edit");
  // Ordinary recovery restores the renamed application, without deleting edits.
  await p.store.recoverRemoval();
  expect(await exists(join(p.root, i.dir, "gui.exe"))).toBe(true);
});
test("selection journal repairs partial shortcut writes on either side of state commit and rejects forged targets", async () => {
  for (const committed of [false, true]) {
    const { p, backend, name, path } = await fixture();
    // First installation is the transaction that writes the launcher; version
    // switches now only redirect the current junction and rewrite nothing.
    const before = await p.store.read();
    await p.install(`test/${name}@1`);
    const after = await p.store.read(),
      newBytes = await readFile(path);
    const effects = await startMenuEffects(before, after, backend);
    await atomicJson(p.store.statePath, committed ? after : before);
    if (committed) await rm(path);
    await atomicJson(p.store.journalPath, {
      before,
      after,
      startMenu: effects,
    });
    await p.store.recover();
    if (committed) expect(await readFile(path)).toEqual(newBytes);
    else expect(await exists(path)).toBe(false);
    const forged = structuredClone(effects);
    (forged[0]!.target as { path: string }).path = join(work, "foreign.lnk");
    await atomicJson(p.store.journalPath, { before, after, startMenu: forged });
    await expect(p.store.recover()).rejects.toThrow("does not match");
    await rm(p.store.journalPath);
  }
});
test("partial failure rolls back every already-written shortcut, without enabling registry effects", async () => {
  const { p, backend, name, label, path } = await fixture();
  manifest(name, "1", label, true);
  backend.failName = label + " B.lnk";
  await expect(p.install(`test/${name}@1`)).rejects.toThrow(
    "injected shortcut failure",
  );
  expect(await exists(path)).toBe(false);
  backend.failName = "";
  await p.store.mutate(async () => {});
  expect(await exists(path)).toBe(true);
  expect((await p.store.read()).desktop).toBeUndefined();
});
