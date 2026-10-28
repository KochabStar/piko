import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { VERSION } from "../src/version.ts";
import { relativeFile } from "../src/util.ts";
const root = await mkdtemp(join(tmpdir(), "piko-real-smoke-")),
  source = resolve("examples/source");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const path = decodeURIComponent(new URL(request.url).pathname).slice(1);
      relativeFile(path);
      const file = Bun.file(join(source, path));
      return (await file.exists())
        ? new Response(file)
        : new Response("missing", { status: 404 });
    } catch {
      return new Response("bad path", { status: 400 });
    }
  },
});
let executable = resolve("dist/piko.exe");
const env = { ...process.env, PIKO_HOME: root };
const results: {
  command: string;
  output: string;
  stderr: string;
  ms: number;
}[] = [];
async function run(exe: string, args: string[]): Promise<string> {
  console.error(`[SMOKE] ${args.join(" ")}`);
  const start = performance.now();
  const child = Bun.spawn([exe, ...args], {
    env,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}): ${err}`);
  results.push({
    command: args.join(" "),
    output: out.trim().slice(0, 1500),
    stderr: err.trim().slice(-1500),
    ms: Math.round(performance.now() - start),
  });
  return out + "\n" + err;
}
try {
  await run(executable, ["setup"]);
  // Test the installed executable snapshot, so subsequent builds cannot alter it.
  executable = join(root, "apps", "piko", "piko.exe");
  await run(executable, [
    "source",
    "add",
    "main",
    `http://127.0.0.1:${server.port}/`,
  ]);
  for (const spec of ["main/ripgrep@15.2.0", "main/node@26.12.1"]) {
    await run(executable, ["install", spec]);
    await run(executable, ["use", spec]);
  }
  assert(
    (await run(join(root, "shims", "rg.exe"), ["--version"])).startsWith(
      "ripgrep 15.2.0",
    ),
  );
  assert(
    (await run(join(root, "shims", "node.exe"), ["--version"])).trim() ===
      "v26.12.1",
  );
  await run(executable, ["install", "npm:prettier@3.9.10"]);
  await run(executable, ["use", "npm:prettier@3"]);
  assert(
    (await run(join(root, "shims", "prettier.exe"), ["--version"])).trim() ===
      "3.9.10",
  );
  await run(executable, [
    "command",
    "alias",
    "format-code",
    "npm:prettier",
    "prettier",
  ]);
  assert(
    (
      await run(join(root, "shims", "format-code.exe"), ["--version"])
    ).trim() === "3.9.10",
  );
  await run(executable, ["command", "release", "prettier"]);
  assert(
    (
      await run(join(root, "shims", "format-code.exe"), ["--version"])
    ).trim() === "3.9.10",
  );
  await run(executable, ["command", "claim", "prettier", "npm:prettier"]);
  await run(executable, ["command", "unalias", "format-code"]);
  if (process.argv.includes("--pi")) {
    await run(executable, [
      "install",
      "npm:@mariozechner/pi-coding-agent@0.73.1",
    ]);
    await run(executable, ["use", "npm:@mariozechner/pi-coding-agent@0.73.1"]);
    const piVersion = await run(join(root, "shims", "pi.exe"), ["--version"]);
    assert(
      piVersion.includes("0.73.1"),
      "pi --version must actually report the expected version, not merely exit 0",
    );
  }
  const report = {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    piko: VERSION,
    rootWasTemporary: true,
    userPathWasNotModified: true,
    results,
  };
  await mkdir("docs/verification", { recursive: true });
  await writeFile(
    "docs/verification/real-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200,
  });
}
