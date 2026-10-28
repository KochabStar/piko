// A standalone diagnostic EXE using the same Bun and download() as Piko.
// It does not install software, change DNS/proxy/TLS settings, or disable checks.
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { download, networkUrl, publicEndpoint, sha256 } from "../src/util.ts";

const tests = [
  { url: "https://nodejs.org/dist/v26.12.1/SHASUMS256.txt" },
  {
    url: "https://nodejs.org/dist/v26.12.1/node-v26.12.1-win-x64.zip",
    sha256: "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
  },
  { url: "https://registry.npmjs.org/prettier" },
];
const report: {
  runtime: string;
  platform: string;
  startedAt: string;
  status: string;
  tests: unknown[];
  notes: string[];
} = {
  runtime: `Bun ${Bun.version}`,
  platform: `${process.platform}/${process.arch}`,
  startedAt: new Date().toISOString(),
  status: "running",
  tests: [],
  notes: [
    "Production download() is used for full GET probes; node:https IPv4/IPv6 HEAD probes compare address families without altering production behavior.",
    "TLS verification stays enabled; credentials and environment values are not logged.",
    "This diagnostic is evidence gathering, not an automatic connectivity fix.",
  ],
};
const file = resolve(process.argv[2] ?? "bun-network-report.json");
async function save() {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
}
function safeError(error: unknown) {
  if (error instanceof Error && error.message.startsWith("Download "))
    return error.message;
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : error instanceof Error
      ? error.name
      : "UnknownError";
}
async function headFamily(value: string, family: 4 | 6): Promise<unknown> {
  const url = networkUrl(value),
    started = performance.now();
  return await new Promise((done) => {
    let finished = false;
    const finish = (result: object) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ family, ms: Math.round(performance.now() - started), ...result });
    };
    const req = request(
      url,
      { method: "HEAD", family, rejectUnauthorized: true },
      (response) => {
        const status = response.statusCode ?? 0;
        const redirect = response.headers.location
          ? publicEndpoint(new URL(response.headers.location, url))
          : undefined;
        response.resume();
        finish({ ok: status >= 200 && status < 400, status, redirect });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, error: "TIMEOUT" });
    }, 15000);
    req.once("error", (error) =>
      finish({ ok: false, error: safeError(error) }),
    );
    req.end();
  });
}
await save();
let failed = false;
for (const target of tests) {
  console.log(`[BUN NETWORK] ${target.url}`);
  const entry: {
    url: string;
    addresses?: { address: string; family: number }[];
    dnsError?: string;
    gets: unknown[];
    families?: unknown[];
  } = { url: target.url, gets: [] };
  report.tests.push(entry);
  try {
    entry.addresses = await lookup(new URL(target.url).hostname, { all: true });
  } catch (error) {
    entry.dnsError = safeError(error);
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const start = performance.now();
    try {
      const bytes = await download(target.url, 128 * 1024 * 1024),
        checksum = sha256(bytes);
      const verified = target.sha256 ? checksum === target.sha256 : undefined;
      if (verified === false) throw new Error("Download checksum mismatch");
      entry.gets.push({
        attempt,
        ok: true,
        bytes: bytes.length,
        sha256: checksum,
        verified,
        ms: Math.round(performance.now() - start),
      });
      console.log(`  GET ${attempt}: OK (${bytes.length} bytes)`);
    } catch (error) {
      failed = true;
      entry.gets.push({
        attempt,
        ok: false,
        error: safeError(error),
        ms: Math.round(performance.now() - start),
      });
      console.error(`  GET ${attempt}: ${safeError(error)}`);
    }
    await save();
  }
  entry.families = await Promise.all([
    headFamily(target.url, 4),
    headFamily(target.url, 6),
  ]);
  console.log("  Address-family probes:", JSON.stringify(entry.families));
  await save();
}
report.status = failed ? "failed" : "passed";
await save();
console.log(`Report: ${file}`);
process.exitCode = failed ? 1 : 0;
