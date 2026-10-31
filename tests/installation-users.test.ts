import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packages } from "../src/packages.ts";
import { WindowsEffects } from "../src/windows-effects.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-loaded-images-"));
const payload = Buffer.from("not executed fixture image");
let latest = "1.0.0";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const name = new URL(request.url).pathname;
    if (name === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          extension: {
            latest,
            versions: { "1.0.0": "1.json", "2.0.0": "2.json" },
          },
        },
      });
    if (name === "/payload") return new Response(payload);
    return Response.json({
      schemaVersion: 1,
      name: "extension",
      version: name === "/1.json" ? "1.0.0" : "2.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/payload`,
          sha256: sha256(payload),
          format: "file",
          file: "extension.exe",
          bin: { extension: "extension.exe" },
          persist: ["data"],
          configFiles: {
            "register.ps1":
              "param([string]$Action)\nthrow 'never execute fixture'\n",
          },
          admin: {
            install: {
              kind: "powershell",
              path: "register.ps1",
              args: ["install"],
            },
            remove: {
              kind: "powershell",
              path: "register.ps1",
              args: ["remove"],
            },
          },
        },
      },
    });
  },
});
class Effects extends WindowsEffects {
  locked = "";
  queryError = false;
  override async fileUsers(files: string[]) {
    if (this.queryError) throw Error("Restart Manager inspection failed");
    return files.some((f) => f.startsWith(this.locked) && this.locked)
      ? [{ pid: 321, name: "Explorer fixture" }]
      : [];
  }
}
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function fixture() {
  latest = "1.0.0";
  const root = await mkdtemp(join(work, "root-")),
    effects = new Effects(join(root, "external")),
    p = new Packages(root, effects);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const old = await p.install("main/extension@latest");
  await p.use("main/extension@latest");
  effects.locked = join(root, old.dir);
  await writeFile(join(root, old.dir, "data/settings"), "persistent data kept");
  return { p, effects, old };
}
test("loaded old executable images never block side-by-side update; cleanup defers without rename/delete", async () => {
  const { p, effects, old } = await fixture();
  latest = "2.0.0";
  const next = await p.update("main/extension");
  expect(next.version).toBe("2.0.0");
  expect((await p.store.read()).defaults[old.key]!.id).toBe(next.id);
  expect(await readFile(join(p.root, old.dir, "extension.exe"))).toEqual(
    payload,
  );
  const before = await readFile(p.store.statePath, "utf8");
  const plan = await p.versionCleanupPlan("main/extension", 0);
  expect(plan.entries.find((e) => e.version === old.version)?.action).toBe(
    "defer-in-use",
  );
  const result = await p.cleanupVersions("main/extension", 0, {
    confirmed: true,
  });
  expect(result).toMatchObject([
    { version: "1.0.0", status: "deferred-in-use" },
  ]);
  expect(await readFile(p.store.statePath, "utf8")).toBe(before);
  await expect(p.uninstall("main/extension@1.0.0")).rejects.toThrow(
    "loaded DLLs/processes",
  );
  expect(await exists(p.store.removalPath)).toBe(false);
  expect(await readFile(join(p.root, old.dir, "data/settings"), "utf8")).toBe(
    "persistent data kept",
  );
  effects.locked = "";
  expect(
    (await p.cleanupVersions("main/extension", 0, { confirmed: true }))[0]!
      .status,
  ).toBe("removed");
  expect(await exists(join(p.root, old.dir))).toBe(false);
  expect(await readFile(join(p.root, next.dir, "data/settings"), "utf8")).toBe(
    "persistent data kept",
  );
});
test("process inspection failure is not treated as permission to remove old Shell images", async () => {
  const { p, effects, old } = await fixture();
  latest = "2.0.0";
  await p.update("main/extension");
  effects.queryError = true;
  await expect(p.versionCleanupPlan("main/extension", 0)).rejects.toThrow(
    "inspection failed",
  );
  await expect(p.uninstall("main/extension@1.0.0")).rejects.toThrow(
    "inspection failed",
  );
  expect(await exists(join(p.root, old.dir, "extension.exe"))).toBe(true);
  expect(await exists(p.store.removalPath)).toBe(false);
});
test("active system registration is still content-approved; loaded-image support never bypasses removal approval", async () => {
  const { p, old } = await fixture();
  const state = await p.store.read();
  state.admin = {
    [old.id]: {
      id: old.id,
      binding: "a".repeat(64),
      at: new Date().toISOString(),
      status: "completed",
      action: "install",
    },
  };
  await atomicJson(p.store.statePath, state);
  latest = "2.0.0";
  const next = await p.install("main/extension@2.0.0");
  await expect(p.use("main/extension@2.0.0")).rejects.toThrow(
    "system integration",
  );
  expect((await p.store.read()).defaults[old.key]!.id).toBe(old.id);
  expect(await exists(join(p.root, next.dir, "extension.exe"))).toBe(true);
});
