import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const work = await mkdtemp(join(tmpdir(), "piko-bootstrap-tests-"));
const installer = resolve("install.ps1");
const exe = resolve("dist/piko.exe");
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const shells = [
  "powershell.exe",
  ...(Bun.which("pwsh.exe") ? [Bun.which("pwsh.exe")!] : []),
];
const requests: string[] = [];
let archive = new Uint8Array();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/release.zip") return new Response(archive);
    if (path === "/index.json")
      return Response.json({ schemaVersion: 1, packages: {} });
    if (path === "/redirect")
      return new Response(null, {
        status: 302,
        headers: { location: "/release.zip" },
      });
    return new Response("not found", { status: 404 });
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
async function run(shell: string, args: string[], env = process.env) {
  const child = Bun.spawn(
    [shell, "-NoLogo", "-NoProfile", "-NonInteractive", ...args],
    { env, stdout: "pipe", stderr: "pipe", cwd: work },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}
const invoke = (shell: string, args: string[], env?: typeof process.env) =>
  run(shell, ["-ExecutionPolicy", "Bypass", "-File", installer, ...args], env);
let fixture:
  { file: string; sha256: string; executableHash: string } | undefined;
async function release() {
  if (fixture) return fixture;
  const folder = join(work, "piko-0.4.0-windows-x64");
  await mkdir(folder);
  await copyFile(exe, join(folder, "piko.exe"));
  const executableHash = hash(await readFile(exe));
  await writeFile(
    join(folder, "release.json"),
    JSON.stringify({
      version: "0.4.0",
      platform: "windows-x64",
      sha256: executableHash,
      signed: false,
    }),
  );
  await writeFile(
    join(folder, "SHA256SUMS.txt"),
    executableHash + "  piko.exe\n",
  );
  // The bootstrap must never execute packaged scripts.
  await writeFile(
    join(folder, "install.ps1"),
    "throw 'DO NOT RUN BUNDLED SCRIPT'",
  );
  const file = join(work, "release.zip");
  const result = await run(
    shells[0]!,
    [
      "-Command",
      "$ErrorActionPreference='Stop';Compress-Archive -LiteralPath $env:PIKO_ZIP_FOLDER -DestinationPath $env:PIKO_ZIP_OUT",
    ],
    { ...process.env, PIKO_ZIP_FOLDER: folder, PIKO_ZIP_OUT: file },
  );
  if (result.code) throw Error(result.err);
  archive = await readFile(file);
  fixture = { file, sha256: hash(archive), executableHash };
  return fixture;
}
for (const shell of shells) {
  test(`${shell}: local archive installs without Git/Node, source is HTTPS-style HTTP catalog and rerun preserves state`, async () => {
    const { file, sha256, executableHash } = await release();
    const home = join(work, "fresh " + crypto.randomUUID());
    const args = [
      "-ArchivePath",
      file,
      "-Sha256",
      sha256,
      "-PikoHome",
      home,
      "-NoPath",
      "-SourceUrl",
      `http://127.0.0.1:${server.port}/`,
    ];
    const env = {
      ...process.env,
      PIKO_HOME: join(work, "must-not-touch"),
      PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    };
    const result = await invoke(shell, args, env);
    expect({ code: result.code, error: result.err }).toEqual({
      code: 0,
      error: "",
    });
    expect(hash(await readFile(join(home, "apps/piko/piko.exe")))).toBe(
      executableHash,
    );
    expect(requests).toContain("/index.json");
    const state = join(home, "apps/piko/state.json"),
      before = await readFile(state, "utf8");
    const second = await invoke(shell, args, env);
    expect({ code: second.code, error: second.err }).toEqual({
      code: 0,
      error: "",
    });
    expect(await readFile(state, "utf8")).toBe(before);
    const parsed = JSON.parse(before);
    expect(parsed.installs).toEqual({});
    expect(parsed.sources.main.type).toBe("http");
    const conflict = await invoke(
      shell,
      [
        ...args.slice(0, -2),
        "-SourceUrl",
        `http://127.0.0.1:${server.port}/different/`,
      ],
      env,
    );
    expect(conflict.code).not.toBe(0);
    expect(conflict.err).toContain("different configuration");
    expect(await readFile(state, "utf8")).toBe(before);
  }, 120000);
  test(`${shell}: wrong archive checksum fails before executing or creating an installation`, async () => {
    const { file } = await release();
    const home = join(work, "reject " + crypto.randomUUID());
    const result = await invoke(shell, [
      "-ArchivePath",
      file,
      "-Sha256",
      "0".repeat(64),
      "-PikoHome",
      home,
      "-NoPath",
      "-NoSource",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Archive checksum mismatch");
    expect(await Bun.file(join(home, "apps/piko/piko.exe")).exists()).toBe(
      false,
    );
  }, 30000);
}
test("download follows bounded loopback redirect, verifies archive and installs with source explicitly disabled", async () => {
  const { sha256 } = await release();
  const home = join(work, "downloaded home");
  const result = await invoke(shells[0]!, [
    "-ArchiveUrl",
    `http://127.0.0.1:${server.port}/redirect`,
    "-Sha256",
    sha256,
    "-PikoHome",
    home,
    "-NoPath",
    "-NoSource",
  ]);
  expect({ code: result.code, error: result.err }).toEqual({
    code: 0,
    error: "",
  });
  expect(requests).toContain("/redirect");
  expect(requests).toContain("/release.zip");
  expect(
    JSON.parse(await readFile(join(home, "apps/piko/state.json"), "utf8"))
      .sources,
  ).toEqual({});
}, 60000);
test("non-HTTPS remote URLs, unsafe roots and different existing builds are refused", async () => {
  const { file, sha256 } = await release();
  const unsafe = await invoke(shells[0]!, [
    "-ArchiveUrl",
    "http://example.com/release.zip",
    "-Sha256",
    sha256,
    "-NoPath",
    "-NoSource",
  ]);
  expect(unsafe.code).not.toBe(0);
  expect(unsafe.err).toContain("Only HTTPS");
  const root = await invoke(shells[0]!, [
    "-ArchivePath",
    file,
    "-Sha256",
    sha256,
    "-PikoHome",
    "D:\\",
    "-NoPath",
    "-NoSource",
  ]);
  expect(root.code).not.toBe(0);
  expect(root.err).toContain("dedicated Piko directory");
  const home = join(work, "different-build");
  await mkdir(join(home, "apps/piko"), { recursive: true });
  const existing = join(home, "apps/piko/piko.exe");
  await writeFile(existing, "preserve existing build");
  const other = await invoke(shells[0]!, [
    "-ArchivePath",
    file,
    "-Sha256",
    sha256,
    "-PikoHome",
    home,
    "-NoPath",
    "-NoSource",
  ]);
  expect(other.code).not.toBe(0);
  expect(other.err).toContain("already installed");
  expect(await readFile(existing, "utf8")).toBe("preserve existing build");
}, 60000);
test("verified ZIP still rejects inconsistent executable bytes before setup", async () => {
  const { file } = await release();
  const bad = join(work, "bad-executable.zip");
  await copyFile(file, bad);
  const modify = await run(
    shells[0]!,
    [
      "-Command",
      "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::Open($env:PIKO_BAD_ZIP,[IO.Compression.ZipArchiveMode]::Update);try{$e=$z.GetEntry('piko-0.4.0-windows-x64/piko.exe');$e.Delete();$e=$z.CreateEntry('piko-0.4.0-windows-x64/piko.exe');$w=[IO.StreamWriter]::new($e.Open());try{$w.Write('corrupt executable')}finally{$w.Dispose()}}finally{$z.Dispose()}",
    ],
    { ...process.env, PIKO_BAD_ZIP: bad },
  );
  expect({ code: modify.code, error: modify.err }).toEqual({
    code: 0,
    error: "",
  });
  const home = join(work, "bad-executable-home");
  const result = await invoke(shells[0]!, [
    "-ArchivePath",
    bad,
    "-Sha256",
    hash(await readFile(bad)),
    "-PikoHome",
    home,
    "-NoPath",
    "-NoSource",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("Executable checksum mismatch");
  expect(await Bun.file(join(home, "apps/piko/piko.exe")).exists()).toBe(false);
}, 60000);

test("installer parses in every available PowerShell without changing persistent PATH or execution policy", async () => {
  for (const shell of shells) {
    const result = await run(
      shell,
      [
        "-Command",
        "$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile($env:PIKO_INSTALL_SCRIPT,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)}",
      ],
      { ...process.env, PIKO_INSTALL_SCRIPT: installer },
    );
    expect({ code: result.code, error: result.err }).toEqual({
      code: 0,
      error: "",
    });
  }
  const text = await readFile(installer, "utf8");
  expect(text).not.toContain("Set-ExecutionPolicy");
  expect(text).not.toContain("Invoke-Expression");
  expect(text).not.toContain("'Machine'");
});
