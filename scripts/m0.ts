import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "piko-m0-"));
try {
  const source = join(root, "probe.ts");
  const exe = join(root, "piko.exe");
  const shim = join(root, "hello.exe");
  await writeFile(
    source,
    "console.log(JSON.stringify({exe:process.execPath,args:process.argv.slice(2),env:process.env.PIKO_CWD_PROBE}));process.exit(Number(process.env.PIKO_PROBE_EXIT??0));",
  );
  const build = await Bun.build({
    entrypoints: [source],
    compile: {
      target: "bun-windows-x64",
      outfile: exe,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });
  assert(build.success, String(build.logs));
  await link(exe, shim);
  await writeFile(join(root, ".env"), "PIKO_CWD_PROBE=unexpected\n");
  await writeFile(join(root, "bunfig.toml"), "invalid = [\n");
  const args = ["中文 空格", 'a"b', "&|<>^%!*", "", "trail\\"];
  const env = {
    ...process.env,
    PATH: process.env.SystemRoot + "\\System32",
    PIKO_PROBE_EXIT: "17",
  };
  const child = Bun.spawn([shim, ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 17);
  assert.deepEqual(output.args, args);
  assert.equal(output.env, undefined);
  assert(
    output.exe.toLowerCase().endsWith("hello.exe"),
    "Hard-linked executable must retain its launch name",
  );
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const run = Bun.spawn([shim], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    assert.equal(await run.exited, 17);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        platform: process.platform,
        architecture: process.arch,
        verified: [
          "self-contained launch without Node or Bun on PATH",
          "hard-link launch identity",
          "argument forwarding",
          "exit code",
          "disabled working-directory dotenv and bunfig loading",
        ],
        startupMs: {
          median: (samples[4]! + samples[5]!) / 2,
          min: samples[0],
          max: samples.at(-1),
        },
        probeScope:
          "Minimal executable startup probe; package integration is verified separately by bun test",
        pendingInThisProbe: [
          "Windows 10 clean-machine validation",
          "CMD and PowerShell integration",
          "Ctrl+C propagation",
          "npm strict script policy",
          "current junction recovery",
          "ZIP extraction security",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
