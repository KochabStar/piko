import { test, expect, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { inspectExecution, runExecution } from "../src/execution.ts";
import { sha256 } from "../src/util.ts";

// End-to-end coverage for source-installed bootstrap packages: the manifest
// passes the catalog validators (bootstrap outputs inside persist, data bins
// declared as outputs, version-interpolated bootstrap arguments), the approved
// bootstrap runs, and the declared outputs are verified afterwards.
const work = await mkdtemp(join(tmpdir(), "piko-hermes-test-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
);

test("source-installer bootstrap runs with interpolated pins and persists outputs", async () => {
  const version = "0.2026.11.14-232e27fe";
  // A minimal stand-in for the vendor installer: it materialises the two
  // declared launcher outputs inside the persistent home.
  const installer = [
    "param()",
    "$ErrorActionPreference = 'Stop'",
    "$hermesHome = Join-Path $env:HERMES_HOME 'home'",
    "New-Item -ItemType Directory -Force -Path (Join-Path $hermesHome 'bin') | Out-Null",
    "Set-Content -Path (Join-Path $hermesHome 'bin/hermes.exe') -Value 'launcher'",
    "Set-Content -Path (Join-Path $hermesHome 'bin/hermes-acp.exe') -Value 'launcher'",
  ].join("\n");
  const bytes = new TextEncoder().encode(installer);
  let INSTALLER_URL = "";
  const makeDocument = () => ({
    schemaVersion: 2,
    name: "hermes",
    upstream: {
      provider: "manual",
      reason: "test fixture",
      trust: "https",
    },
    recipes: {
      r0123456789abcdef: {
        schemaVersion: 1,
        name: "hermes",
        version: "{version}",
        platforms: {
          "windows-x64": {
            url: INSTALLER_URL,
            sha256: "{sha256}",
            format: "file",
            file: "install.ps1",
            bin: {
              hermes: { path: "home/bin/hermes.exe", kind: "native", data: true },
              "hermes-acp": {
                path: "home/bin/hermes-acp.exe",
                kind: "native",
                data: true,
              },
            },
            persist: ["home"],
            env: { HERMES_HOME: "{persist}" },
            bootstrap: {
              path: "install.ps1",
              kind: "powershell",
              args: ["-NonInteractive", "-HermesHome", "{persist}", "-Commit", "v{version}"],
              env: { HERMES_HOME: "{persist}" },
              outputs: ["home/bin/hermes.exe", "home/bin/hermes-acp.exe"],
              timeoutMinutes: 120,
            },
            selfUpdate: {
              command: ["{persist}/home/bin/hermes.exe", "update"],
              versionCommand: ["{persist}/home/bin/hermes.exe", "--version"],
            },
            maxBytes: "{maxBytes}",
          },
        },
      },
    },
    versions: {
      [version]: { recipe: "r0123456789abcdef", sha256: sha256(bytes), maxBytes: 1048576 },
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: {
            hermes: {
              latest: version,
              versions: { [version]: "packages/ai/hermes/package.json" },
            },
          },
        });
      if (path === "/packages/ai/hermes/package.json")
        return Response.json(makeDocument());
      if (path === "/install.ps1") return new Response(bytes);
      return new Response("missing", { status: 404 });
    },
  });
  try {
    INSTALLER_URL = `http://127.0.0.1:${server.port}/install.ps1`;
    const p = new Packages(join(work, "home"));
    await p.addSource("main", `http://127.0.0.1:${server.port}/`);
    const install = await p.install("main/hermes@0.2026.11.14-232e27fe");
    expect(install.bootstrap?.timeoutMinutes).toBe(120);
    expect(install.selfUpdate?.command).toEqual([
      "{persist}/home/bin/hermes.exe",
      "update",
    ]);
    const preview = await inspectExecution(
      p.store,
      "main/hermes@" + version,
      false,
      false,
    );
    expect(preview.args).toEqual([
      "-NonInteractive",
      "-HermesHome",
      expect.stringMatching(/[\\/]persist[\\/]hermes$/),
      "-Commit",
      "v" + version,
    ]);
    expect(preview.outputs).toEqual(install.bootstrap!.outputs);
    const result = await runExecution(
      p.store,
      "main/hermes@" + version,
      { confirmed: true, binding: preview.binding },
    );
    expect(result.status).toBe("completed");
    const persistRoot = join(p.root, "persist");
    await readFile(join(persistRoot, "hermes/home/bin/hermes.exe"));
    await readFile(join(persistRoot, "hermes/home/bin/hermes-acp.exe"));
  } finally {
    server.stop(true);
  }
}, 60000);
