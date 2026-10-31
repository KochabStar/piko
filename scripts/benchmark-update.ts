import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Packages } from "../src/packages.ts";
import { capture, sha256 } from "../src/util.ts";

// Optional baseline EXE: compare the same no-op update workload, not Scoop.
const baseline = process.argv[2] && resolve(process.argv[2]);
const current = resolve("dist/piko.exe");
const root = await mkdtemp(join(tmpdir(), "piko-update-benchmark-"));
const names = Array.from({ length: 12 }, (_, n) => `tool-${n}`);
const bytes = Buffer.from("isolated benchmark payload; never executed");
const hash = sha256(bytes);
const requests = new Map<string, number>();
const latencyMs = 25;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    await Bun.sleep(latencyMs);
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          names.map((name) => [
            name,
            { latest: "1.0.0", versions: { "1.0.0": `${name}.json` } },
          ]),
        ),
      });
    if (path === "/file.exe") return new Response(bytes);
    const name = path.slice(1, -5);
    if (!path.endsWith(".json") || !names.includes(name))
      return new Response("missing", { status: 404 });
    return Response.json({
      schemaVersion: 1,
      name,
      version: "1.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file.exe`,
          sha256: hash,
          format: "file",
          file: `${name}.exe`,
          bin: { [name]: `${name}.exe` },
        },
      },
    });
  },
});
try {
  const env = { ...process.env, PIKO_HOME: root };
  // Install only inside a disposable root; never alter user PATH or profiles.
  await capture(current, ["setup"], { env });
  const packages = new Packages(root);
  await packages.addSource("fixture", `http://127.0.0.1:${server.port}/`);
  for (const name of names) {
    await packages.install(`fixture/${name}`);
    await packages.use(`fixture/${name}@latest`);
  }
  // Keep the installed manager identical in both runs (only the invoked CLI varies).
  await mkdir(join(root, "apps/piko"), { recursive: true });
  await copyFile(current, join(root, "apps/piko/piko.exe"));
  const variants = [
    ...(baseline ? [{ label: "before", exe: baseline }] : []),
    { label: "after", exe: current },
  ];
  const results: Record<
    string,
    { medianMs: number; minMs: number; maxMs: number; indexRequests: number[] }
  > = {};
  for (const { label, exe } of variants) {
    const times: number[] = [];
    const indexes: number[] = [];
    for (let sample = 0; sample < 6; sample++) {
      requests.clear();
      const started = performance.now();
      const rows = JSON.parse(
        await capture(exe, ["update", "--all", "--json", "--no-progress"], {
          env,
        }),
      ) as { status: string }[];
      const elapsed = performance.now() - started;
      if (
        rows.length !== names.length ||
        rows.some((row) => row.status !== "unchanged") ||
        requests.has("/file.exe")
      )
        throw new Error("Benchmark must perform only verified no-op updates");
      if (sample) {
        times.push(elapsed);
        indexes.push(requests.get("/index.json") ?? 0);
      }
    }
    times.sort((a, b) => a - b);
    results[label] = {
      medianMs: Math.round(times[2]!),
      minMs: Math.round(times[0]!),
      maxMs: Math.round(times.at(-1)!),
      indexRequests: indexes,
    };
  }
  console.log(
    JSON.stringify(
      {
        workload: "12 unchanged portable packages sharing one HTTP source",
        samples: 5,
        simulatedLatencyPerRequestMs: latencyMs,
        isolated: true,
        results,
        ...(results.before && results.after
          ? { speedup: results.before.medianMs / results.after.medianMs }
          : {}),
        note: "Synthetic before/after Piko benchmark, not a measured Scoop comparison or a real download benchmark.",
      },
      null,
      2,
    ),
  );
} finally {
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
