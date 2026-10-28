import { mkdir, mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { VERSION } from "../src/version.ts";
import { Packages } from "../src/packages.ts";
import { makeSource } from "../src/catalog.ts";
import { packageKey, installId } from "../src/store.ts";
import { capture } from "../src/util.ts";
const root = await mkdtemp(join(tmpdir(), "piko-benchmark-")),
  node = Bun.which("node.exe") ?? Bun.which("node");
if (!node) throw new Error("Development Node required");
try {
  const env = { ...process.env, PIKO_HOME: root },
    exe = resolve("dist/piko.exe");
  await capture(exe, ["setup"], { env });
  const source = makeSource("fixture", "https://benchmark.invalid/", "http"),
    key = packageKey(source, "node"),
    version = (await capture(node, ["--version"])).replace(/^v/, ""),
    id = installId(key, version),
    dir = join("apps", key, version);
  await mkdir(join(root, dir), { recursive: true });
  await copyFile(node, join(root, dir, "node.exe"));
  const p = new Packages(root);
  await p.store.mutate(async (s) => {
    s.installs[id] = {
      id,
      key,
      name: "node",
      version,
      request: version,
      source,
      dir,
      bins: { node: { path: "node.exe", kind: "native" } },
      persist: [],
      verified: true,
      checksum: "benchmark",
      manifestHash: "benchmark",
      kind: "portable",
    };
  });
  await p.use("fixture/node@" + version);
  const measure = async (file: string, args: string[]) => {
    const ms = [];
    for (let n = 0; n < 11; n++) {
      const start = performance.now();
      await capture(file, args, { env });
      if (n) ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    return {
      medianMs: Math.round(ms[5]!),
      minMs: Math.round(ms[0]!),
      maxMs: Math.round(ms[9]!),
    };
  };
  const report = {
    at: new Date().toISOString(),
    platform: process.platform,
    bun: Bun.version,
    piko: VERSION,
    samples: 10,
    sourceNode: await measure(node, ["--version"]),
    managedNodeDirect: await measure(join(root, dir, "node.exe"), [
      "--version",
    ]),
    managedNodeShim: await measure(join(root, "shims/node.exe"), ["--version"]),
    pikoManagement: await measure(exe, ["--version"]),
  };
  await mkdir("docs/verification", { recursive: true });
  await writeFile(
    "docs/verification/performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(report);
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
