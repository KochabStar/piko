import { lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { installedHelper } from "./helpers-process.ts";
import { nativeShimBase64, nativeShimSha256 } from "./generated/shim.ts";
import {
  download,
  downloadResponse,
  fail,
  noLinks,
  publicEndpoint,
  removeTree,
  sha256,
} from "./util.ts";
import { report, progressSink, TransferRanges } from "./progress.ts";
import type { State } from "./types.ts";

export async function findAria2(
  root: string,
  state?: State,
): Promise<string | undefined> {
  const managed =
    state && (await installedHelper(root, state, "aria2", "aria2c"));
  if (managed) return managed;
  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  if (!searchPath) return;
  for (const directory of searchPath
    .split(";")
    .map((d) => d.replace(/^"|"$/g, ""))) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, "aria2c.exe");
    if (
      resolve(path).toLowerCase() ===
      resolve(root, "shims/aria2c.exe").toLowerCase()
    )
      continue;
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      // A different Piko root can also be on PATH. Its dispatcher inherits
      // this process's PIKO_HOME and cannot act as this root's aria2 helper.
      // Identify our launcher bytes rather than trusting a directory name
      // or an editable .shim file; use real managed aria2 or built-in fetch.
      if (
        info.size === Buffer.from(nativeShimBase64, "base64").length &&
        sha256(await readFile(path)) === nativeShimSha256
      )
        continue;
      return path;
    } catch (error: any) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
}

export async function downloadArtifact(
  root: string,
  value: string,
  state?: State,
  limit = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  const aria2 = await findAria2(root, state);
  if (!aria2)
    return await download(value, limit, (received, total, complete) =>
      report({ kind: "download", received, total, complete }),
    );
  return await downloadWithAria2(root, value, aria2, limit);
}

export async function downloadWithAria2(
  root: string,
  value: string,
  executable: string,
  limit = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  // aria2 cannot enforce Piko's redirect policy itself. Relay validated Range GETs
  // over a private loopback endpoint; Bun retains TLS/redirect/credential checks.
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const stage = await mkdtemp(join(staging, "aria2-")),
    token = crypto.randomUUID();
  const emit = progressSink();
  const ranges = new TransferRanges();
  let received = 0,
    expected: number | undefined;
  let failure: Error | undefined,
    requests = 0;
  const abort = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Upstream TLS/proxy handshakes and range responses can be idle for more
    // than Bun's default ten seconds. aria2's inactivity timeout and the
    // bounded child lifetime below still cancel stalled transfers.
    idleTimeout: 0,
    async fetch(request) {
      if (
        new URL(request.url).pathname !== "/" + token ||
        !["GET", "HEAD"].includes(request.method)
      )
        return new Response(null, { status: 404 });
      try {
        if (++requests > 128) fail("Too many aria2 range requests");
        const headers = new Headers({ "Accept-Encoding": "identity" });
        const range = request.headers.get("range");
        if (range) headers.set("Range", range);
        const response = await downloadResponse(value, {
          method: request.method as "GET" | "HEAD",
          headers,
          signal: abort.signal,
        });
        const contentRange = response.headers.get("content-range"),
          length = Number(response.headers.get("content-length") ?? 0),
          rangeParts = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/),
          start = Number(rangeParts?.[1]),
          end = Number(rangeParts?.[2]),
          total = Number(rangeParts?.[3]);
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > limit ||
          (contentRange &&
            (!rangeParts ||
              ![start, end, total].every(Number.isSafeInteger) ||
              start > end ||
              end >= total ||
              total > limit))
        ) {
          await response.body?.cancel();
          fail("Download exceeds size limit or has an invalid Content-Range");
        }
        const outgoing = new Headers({
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        });
        for (const key of [
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified",
        ])
          if (response.headers.has(key))
            outgoing.set(key, response.headers.get(key)!);
        if (request.method === "HEAD")
          return new Response(null, {
            status: response.status,
            headers: outgoing,
          });
        const known = rangeParts ? total : length > 0 ? length : undefined;
        if (!response.headers.get("content-encoding") && known) {
          if (expected !== undefined && expected !== known)
            fail("Download total changed between requests");
          expected = known;
        }
        const offset = rangeParts ? start : 0;
        let size = 0;
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              size += chunk.length;
              if (size > limit) {
                failure = new Error("Download exceeds size limit");
                abort.abort();
                throw failure;
              }
              received = ranges.add(offset + size - chunk.length, chunk.length);
              emit({ kind: "download", received, total: expected });
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: outgoing,
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Download failed");
        return new Response(null, { status: 502 });
      }
    },
    error: () => new Response(null, { status: 502 }),
  });
  try {
    const child = Bun.spawn(
      [
        executable,
        "--no-conf=true",
        "--no-netrc=true",
        "--enable-rpc=false",
        "--check-certificate=true",
        "--follow-torrent=false",
        "--follow-metalink=false",
        "--metalink-enable-unique-protocol=true",
        "--allow-overwrite=false",
        "--auto-file-renaming=false",
        "--file-allocation=none",
        "--split=5",
        "--max-connection-per-server=5",
        "--min-split-size=5M",
        "--max-tries=1",
        "--connect-timeout=20",
        "--timeout=60",
        "--stop=120",
        `--stop-with-process=${process.pid}`,
        "--summary-interval=0",
        "--download-result=hide",
        "--quiet=true",
        "--all-proxy=",
        "--http-proxy=",
        "--https-proxy=",
        "--no-proxy=*",
        "--dir=" + stage,
        "--out=download",
        `http://127.0.0.1:${server.port}/${token}`,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 125000,
        env: { ...process.env, PIKO_HOME: root },
      },
    );
    const code = await child.exited;
    if (failure) throw failure;
    if (code !== 0)
      fail(
        `aria2 download failed (exit ${code}): ${publicEndpoint(value)}; no silent fallback`,
      );
    const file = join(stage, "download");
    await noLinks(file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > limit)
      fail("aria2 download exceeds size limit or is not a regular file");
    const bytes = await readFile(file);
    report({
      kind: "download",
      received: bytes.length,
      total: expected,
      complete: true,
    });
    return bytes;
  } finally {
    abort.abort();
    server.stop(true);
    await removeTree(stage);
  }
}
