import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/util.ts";
import { psQuote } from "../src/profiles.ts";
import { powershellExecutable } from "../src/windows.ts";

const folder = await mkdtemp(join(tmpdir(), "piko-native-workflow-"));
const home = join(folder, "fresh home");
const exe = join(import.meta.dir, "../dist/piko.exe");
const native = await readFile(
  join(process.env.SystemRoot!, "System32/cmd.exe"),
);
const bootstrap = Buffer.from(
  "param([string]$Output)\n" +
    "$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output))\n" +
    "[IO.File]::WriteAllText($Output,'native-bootstrap-ok')\n",
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          ["runtime", "shell-addon", "bootstrap"].map((name) => [
            name,
            { latest: "1", versions: { "1": name + ".json" } },
          ]),
        ),
      });
    if (path === "/native") return new Response(native);
    if (path === "/script") return new Response(bootstrap);
    const name = path.slice(1).replace(/\.json$/, "");
    if (!["runtime", "shell-addon", "bootstrap"].includes(name))
      return new Response("not found", { status: 404 });
    const isBootstrap = name === "bootstrap";
    return Response.json({
      schemaVersion: 1,
      name,
      version: "1",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/${isBootstrap ? "script" : "native"}`,
          sha256: sha256(isBootstrap ? bootstrap : native),
          format: "file",
          file: isBootstrap ? "bootstrap.ps1" : "runtime.exe",
          bin: name === "runtime" ? { "fixture-runtime": "runtime.exe" } : {},
          ...(name === "shell-addon"
            ? {
                depends: [
                  { package: "runtime@1", commands: ["fixture-runtime"] },
                ],
                shell: {
                  powershell:
                    "$native = $PikoDependencies['fixture-runtime']; Set-Item -Path Function:global:Invoke-PikoNativeFixture -Value { & $native /d /c echo native-shell-ok }.GetNewClosure()",
                },
              }
            : {}),
          ...(isBootstrap
            ? {
                persist: ["data"],
                bootstrap: {
                  kind: "powershell",
                  path: "bootstrap.ps1",
                  args: ["{persist}/data/ready.txt"],
                  outputs: ["data/ready.txt"],
                },
              }
            : {}),
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(folder, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

async function run(program: string, args: string[], expected = 0) {
  const child = Bun.spawn([program, ...args], {
    env: { ...process.env, PIKO_HOME: home },
    cwd: folder,
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
}
const cli = (args: string[], expected = 0) => run(exe, args, expected);

test("fresh root installs a batch through public CLI then verifies bootstrap, dependency and approved shell together", async () => {
  await cli(["setup"]);
  await cli(["source", "add", "main", `http://127.0.0.1:${server.port}/`]);
  // Install/select first, then assess all behavior together. No private state
  // writes, migration helper or copied host package data is required.
  for (const name of ["runtime", "shell-addon", "bootstrap"]) {
    await cli(["install", "main/" + name + "@1"]);
    await cli(["use", "main/" + name + "@1"]);
  }
  const approval = JSON.parse(
    (await cli(["bootstrap", "main/bootstrap", "--dry-run"])).out,
  );
  await cli([
    "bootstrap",
    "main/bootstrap",
    "--approve-exec",
    "--binding",
    approval.binding,
  ]);
  const profile = join(folder, "native profile.ps1");
  await writeFile(profile, "# existing user settings\n");
  const common = [
    "main/shell-addon",
    "--shell",
    "powershell",
    "--profile",
    profile,
  ];
  const integration = JSON.parse(
    (await cli(["integrate", ...common, "--dry-run"])).out,
  );
  await cli([
    "integrate",
    ...common,
    "--approve-shell",
    "--binding",
    integration.binding,
  ]);
  const statePath = join(home, "apps/piko/state.json");
  const snapshot = await readFile(statePath, "utf8");
  const diagnostic = JSON.parse((await cli(["doctor"])).out);
  expect(diagnostic.installs).toBe(3);
  expect(diagnostic.orphans).toEqual([]);
  expect(diagnostic.shellIntegrations).toMatchObject([{ status: "ready" }]);
  expect(await readFile(statePath, "utf8")).toBe(snapshot);
  expect(
    await readFile(join(home, "persist/bootstrap/data/ready.txt"), "utf8"),
  ).toBe("native-bootstrap-ok");
  expect(
    (
      await run(join(home, "shims/fixture-runtime.exe"), [
        "/d",
        "/c",
        "echo native-command-ok",
      ])
    ).out.trim(),
  ).toBe("native-command-ok");
  for (const shell of ["powershell", "pwsh"] as const) {
    if (shell === "pwsh" && !Bun.which("pwsh.exe")) continue;
    const output = await run(powershellExecutable(shell), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `. ${psQuote(profile)}; Invoke-PikoNativeFixture`,
    ]);
    expect(output.out.trim()).toBe("native-shell-ok");
    expect(output.err).toBe("");
  }
  expect(await readFile(profile, "utf8")).toContain("# existing user settings");
}, 60000);
