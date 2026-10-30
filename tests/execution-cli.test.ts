import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/util.ts";
import { nativeRequest } from "../src/windows-effects.ts";
const root = await mkdtemp(join(tmpdir(), "piko-execution-cli-")),
  home = join(root, "home"),
  exe = join(import.meta.dir, "../dist/piko.exe");
const bytes = Buffer.from(
  "param([string]$Output)\n[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output))|Out-Null\n[IO.File]::WriteAllText($Output,'cli-bootstrap')\n",
);
const manifest = {
  schemaVersion: 1,
  name: "bootstrap",
  version: "1",
  platforms: {
    "windows-x64": {
      url: "",
      sha256: sha256(bytes),
      format: "file",
      file: "bootstrap.ps1",
      bin: {},
      persist: ["data"],
      bootstrap: {
        kind: "powershell",
        path: "bootstrap.ps1",
        args: ["{persist}/data/result.txt"],
        outputs: ["data/result.txt"],
      },
      admin: {
        install: {
          kind: "powershell",
          path: "bootstrap.ps1",
          args: ["{persist}/data/admin-result.txt"],
        },
        remove: {
          kind: "powershell",
          path: "bootstrap.ps1",
          args: ["{persist}/data/admin-result.txt"],
        },
      },
    },
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(r): Response {
    const path = new URL(r.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          bootstrap: { latest: "1", versions: { "1": "manifest.json" } },
        },
      });
    if (path === "/file") return new Response(bytes);
    return Response.json(manifest);
  },
});
manifest.platforms["windows-x64"].url = `http://127.0.0.1:${server.port}/file`;
afterAll(async () => {
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});
const run = async (args: string[], expected = 0) => {
  const child = Bun.spawn([exe, ...args], {
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
  expect(code).toBe(expected);
  if (code !== expected) throw Error(err);
  return { out, err };
};
test("compiled bootstrap separates download, code approval and default selection; system integration never auto-elevates", async () => {
  await run(["setup"]);
  await run(["source", "add", "main", `http://127.0.0.1:${server.port}/`]);
  await run(["install", "main/bootstrap@1"]);
  const plan = JSON.parse(
    (await run(["bootstrap", "main/bootstrap", "--dry-run"])).out,
  );
  expect(plan.script).toContain("WriteAllText");
  const denied = await run(
    ["bootstrap", "main/bootstrap", "--yes", "--binding", plan.binding],
    1,
  );
  expect(denied.err).toContain("--approve-exec");
  await run([
    "bootstrap",
    "main/bootstrap",
    "--approve-exec",
    "--binding",
    plan.binding,
  ]);
  const state = JSON.parse(
    await readFile(join(home, "apps/piko/state.json"), "utf8"),
  );
  expect(state.defaults).toEqual({});
  expect(
    Object.values(state.bootstraps).some((r: any) => r.status === "completed"),
  ).toBe(true);
  const admin = JSON.parse(
    (await run(["system", "main/bootstrap", "--dry-run"])).out,
  );
  expect(admin.warning).toContain("ADMINISTRATOR");
  const noAdminFlag = await run(
    ["system", "main/bootstrap", "--yes", "--binding", admin.binding],
    1,
  );
  expect(noAdminFlag.err).toContain("--approve-admin");
  if (!(await nativeRequest({ op: "elevated" }))) {
    const nonElevated = await run(
      [
        "system",
        "main/bootstrap",
        "--approve-admin",
        "--binding",
        admin.binding,
      ],
      1,
    );
    expect(nonElevated.err).toContain("elevated terminal");
  }
  const unchanged = JSON.parse(
    await readFile(join(home, "apps/piko/state.json"), "utf8"),
  );
  expect(unchanged.admin).toBeUndefined();
}, 30000);
