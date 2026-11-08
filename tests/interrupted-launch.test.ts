import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256, exists, atomicJson } from "../src/util.ts";
import { Store } from "../src/store.ts";

// A single failed or interrupted operation must never take every installed
// command with it, and must never require a separate recovery command.
const root = await mkdtemp(join(tmpdir(), "piko-interrupted-launch-")),
  home = join(root, "home"),
  exe = join(import.meta.dir, "../dist/piko.exe"),
  native = await readFile(join(process.env.SystemRoot!, "System32/cmd.exe"));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          first: {
            latest: "2",
            versions: { "1": "first/1.json", "2": "first/2.json" },
          },
        },
      });
    if (url.pathname === "/native") return new Response(native);
    const match = /^\/first\/(\d)\.json$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    return Response.json({
      schemaVersion: 1,
      name: "first",
      version: match[1],
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/native`,
          sha256: sha256(native),
          format: "file",
          file: "first.exe",
          bin: { first: "first.exe" },
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
      break;
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (!["EBUSY", "EPERM", "EACCES"].includes(code) || attempt === 19)
        throw error;
      await Bun.sleep(100);
    }
  }
});

const run = async (program: string, args: string[], expected = 0) => {
  const child = Bun.spawn([program, ...args], {
    env: { ...process.env, PIKO_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, error: code === expected ? "" : err }).toEqual({
    code: expected,
    error: "",
  });
  return { out, err };
};
const cli = (args: string[], expected = 0) => run(exe, args, expected);

test("an interrupted installation never disables unrelated commands, and its journal is finished by the next write", async () => {
  await cli(["setup"]);
  await cli(["source", "add", "main", `http://127.0.0.1:${server.port}/`]);
  await cli(["install", "main/first@1"]);
  await cli(["use", "main/first@1"]);
  const shim = join(home, "shims", "first.exe");

  // Exactly what Ctrl+C during `piko install` can leave behind: a journal Piko
  // can still finish, here deliberately unrecoverable to prove the blast radius.
  await mkdir(join(home, "operations"), { recursive: true });
  await writeFile(join(home, "operations", "install.json"), "{}");
  const launched = await run(shim, ["/c", "echo", "still-works"]);
  expect(launched.out).toContain("still-works");
  // Read-only commands keep working too.
  expect((await cli(["list"])).out).toContain("main/first");
  // The broken journal is reported, not hidden, when something tries to write.
  const doctor = await cli(["doctor"], 1);
  expect(doctor.err).toContain("Invalid installation journal");
  await rm(join(home, "operations", "install.json"));
  await cli(["doctor"]);
});

test("a pending selection journal neither blocks launches nor needs piko recover", async () => {
  const store = new Store(home),
    state = await store.read(),
    first = Object.values(state.installs).find((i) => i.name === "first")!,
    key = first.key;
  await cli(["install", "main/first@2"]);
  const next = (await store.read()).installs,
    v2 = Object.values(next).find((i) => i.key === key && i.version === "2")!;
  const before = await store.read(),
    after = structuredClone(before);
  after.revision = before.revision + 1;
  after.defaults[key] = { id: v2.id, request: "2" };
  // Crash between publishing the selection journal and the state file.
  await atomicJson(store.journalPath, { before, after, startMenu: [] });
  const launched = await run(join(home, "shims", "first.exe"), [
    "/c",
    "echo",
    "committed-state",
  ]);
  expect(launched.out).toContain("committed-state");
  expect(await exists(store.journalPath)).toBe(true);
  // The next write finishes the interrupted selection on its own. Because the
  // state file never reached the new revision, recovery keeps the old default.
  await cli(["doctor"]);
  expect(await exists(store.journalPath)).toBe(false);
  expect((await store.read()).defaults[key]?.id).toBe(first.id);
});
