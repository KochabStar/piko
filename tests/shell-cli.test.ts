import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../src/util.ts";
import { powershellExecutable } from "../src/windows.ts";
import { psQuote } from "../src/profiles.ts";

const root = await mkdtemp(join(tmpdir(), "piko-shell-cli-中文-"));
const psBytes = Buffer.from(
  "[Console]::WriteLine((ConvertTo-Json -InputObject ([string[]]$args) -Compress))\nexit 7\n",
);
const nativeBytes = await readFile(
  join(process.env.SystemRoot!, "System32", "cmd.exe"),
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
          ["initializer", "ps-entry", "com-entry"].map((name) => [
            name,
            { latest: "1", versions: { "1": `${name}.json` } },
          ]),
        ),
      });
    if (path === "/ps") return new Response(psBytes);
    if (path === "/com") return new Response(nativeBytes);
    const name = path.slice(1).replace(".json", ""),
      script = name === "ps-entry",
      native = name === "com-entry";
    return Response.json({
      schemaVersion: 1,
      name,
      version: "1",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/${native ? "com" : "ps"}`,
          sha256: sha256(native ? nativeBytes : psBytes),
          format: "file",
          file: native ? "tool.com" : "tool.ps1",
          bin:
            name === "initializer"
              ? {}
              : {
                  [name]: {
                    path: native ? "tool.com" : "tool.ps1",
                    kind: script ? "powershell" : "native",
                  },
                },
          ...(name === "initializer"
            ? {
                shell: {
                  powershell:
                    "function global:PikoFixtureFunction { 'shell-function-ok' }",
                  bash: "PikoBashFixture() { printf '%s\\n' 'bash-function-ok'; }",
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
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

test("compiled CLI explicitly approves Profile code; fresh 5.1/7 sessions load the correct root and native/script entries forward arguments", async () => {
  const exe = join(root, "piko.exe"),
    home = join(root, "home"),
    profile = join(root, "Profile 'test.ps1");
  expect(
    (
      await Bun.build({
        entrypoints: ["src/cli.ts"],
        compile: {
          target: "bun-windows-x64",
          outfile: exe,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false,
        },
      })
    ).success,
  ).toBe(true);
  const runExe = async (
    program: string,
    args: string[],
    expected = 0,
    env: NodeJS.ProcessEnv = {},
  ) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PIKO_HOME: home,
      ...env,
      PATH:
        join(home, "shims") +
        ";" +
        (process.env.PATH ?? process.env.Path ?? ""),
    };
    for (const name of Object.keys(childEnv))
      if (name.toLowerCase() === "path" && name !== "PATH")
        delete childEnv[name];
    const child = Bun.spawn([program, ...args], {
      env: childEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: expected, err: "" });
    return out.trim();
  };
  const run = (args: string[], expected = 0) => runExe(exe, args, expected);
  await run(["setup"]);
  await run(["source", "add", "main", `http://127.0.0.1:${server.port}/`]);
  for (const name of ["initializer", "ps-entry", "com-entry"]) {
    await run(["install", `main/${name}@1`]);
    await run(["use", `main/${name}@1`]);
  }
  const common = [
    "main/initializer",
    "--shell",
    "powershell",
    "--profile",
    profile,
  ];
  const plan = JSON.parse(await run(["integrate", ...common, "--dry-run"]));
  const denied = Bun.spawn(
    [exe, "integrate", ...common, "--yes", "--binding", plan.binding],
    {
      env: { ...process.env, PIKO_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [, error, code] = await Promise.all([
    new Response(denied.stdout).text(),
    new Response(denied.stderr).text(),
    denied.exited,
  ]);
  expect(code).toBe(1);
  expect(error).toContain("--approve-shell");
  await run([
    "integrate",
    ...common,
    "--approve-shell",
    "--binding",
    plan.binding,
  ]);
  for (const shell of ["powershell", "pwsh"] as const) {
    if (shell === "pwsh" && !Bun.which("pwsh.exe")) continue;
    const out = await runExe(
      powershellExecutable(shell),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `. ${psQuote(profile)}; PikoFixtureFunction; if ($env:PIKO_HOME -ne ${psQuote(resolve(root, "unrelated"))}) { throw 'PIKO_HOME leaked' }`,
      ],
      0,
      { PIKO_HOME: resolve(root, "unrelated") },
    );
    expect(out).toBe("shell-function-ok");
  }
  const bash = [
    Bun.which("bash.exe"),
    "C:/Program Files/Git/bin/bash.exe",
  ].find(Boolean)!;
  await access(bash);
  const bashProfile = join(root, "Profile 'test.bash");
  await writeFile(bashProfile, "# user bash code\n");
  const bashCommon = [
    "main/initializer",
    "--shell",
    "bash",
    "--profile",
    bashProfile,
  ];
  const bashPlan = JSON.parse(
    await run(["integrate", ...bashCommon, "--dry-run"]),
  );
  await run([
    "integrate",
    ...bashCommon,
    "--approve-shell",
    "--binding",
    bashPlan.binding,
  ]);
  const bashOutput = await runExe(bash, [
    "--noprofile",
    "--norc",
    "-c",
    'source "$1"; PikoBashFixture',
    "--",
    bashProfile.replaceAll("\\", "/"),
  ]);
  expect(bashOutput).toBe("bash-function-ok");
  const bashInit = await run([
    "shell",
    "init",
    "--shell",
    "bash",
    "--profile",
    bashProfile,
  ]);
  expect(bashInit).not.toContain("\r");
  const args = [
    "space value",
    "a'b",
    "$literal;not-code",
    'quote"value',
    "back`tick",
  ];
  expect(
    JSON.parse(await runExe(join(home, "shims", "ps-entry.exe"), args, 7)),
  ).toEqual(args);
  await runExe(join(home, "shims", "com-entry.exe"), ["/d", "/c", "exit 9"], 9);
  await writeFile(
    profile,
    (await readFile(profile, "utf8")) + "\n# preserve user code\n",
  );
  await run(["uninstall", "main/initializer@1", "--force"]);
  expect(await readFile(profile, "utf8")).toContain("# preserve user code");
  expect(await readFile(profile, "utf8")).not.toContain("# >>> piko");
  expect(await readFile(bashProfile, "utf8")).toContain("# user bash code");
  expect(await readFile(bashProfile, "utf8")).not.toContain("# >>> piko");
}, 120000);
