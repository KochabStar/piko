import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { installedHelper } from "./helpers-process.ts";
import { nativeShimBase64, nativeShimSha256 } from "./generated/shim.ts";
import {
  download,
  downloadResponse,
  exists,
  fail,
  failTransient,
  isTransient,
  noLinks,
  publicEndpoint,
  removeTree,
  sha256,
  withRetries,
} from "./util.ts";
import { report, progressSink, TransferRanges } from "./progress.ts";
import { isQQDownload, QQDownloadSession } from "./qq-download.ts";
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
    return await withRetries(() =>
      download(value, limit, (received, total, complete) =>
        report({ kind: "download", received, total, complete }),
      ),
    );
  return await downloadWithAria2(root, value, aria2, limit);
}

// The stage keeps a sequential `partial` prefix plus the entity `total`, so
// a later attempt — or a later install — resumes from bytes already saved.
// aria2 only ever fetches the remainder; its scratch files are folded back
// into `partial` after every run.
async function prefixSize(stage: string, limit: number): Promise<number> {
  for (const entry of await readdir(stage))
    if (entry !== "partial" && entry !== "total")
      await removeTree(join(stage, entry));
  const partial = join(stage, "partial");
  if (!(await exists(partial))) return 0;
  const info = await lstat(partial);
  // A non-file, empty or over-limit leftover cannot resume; drop it.
  if (!info.isFile() || info.size === 0 || info.size > limit) {
    await removeTree(partial);
    await removeTree(join(stage, "total"));
    return 0;
  }
  return info.size;
}

async function readTotal(stage: string): Promise<number | undefined> {
  try {
    const total = Number(await readFile(join(stage, "total"), "utf8"));
    return Number.isSafeInteger(total) && total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

async function writeTotal(stage: string, total: number): Promise<void> {
  const temp = join(stage, "total.tmp");
  await writeFile(temp, String(total));
  await rename(temp, join(stage, "total"));
}

type Aria2Attempt = {
  abort: AbortController;
  ranges: TransferRanges;
  failure: Error | undefined;
  received: number;
  requests: number;
  offset: number;
};

export async function downloadWithAria2(
  root: string,
  value: string,
  executable: string,
  limit = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  // aria2 cannot enforce Piko's redirect policy itself. Relay validated GETs
  // over a private loopback endpoint; Bun retains TLS/redirect/credential
  // checks. The relay always asks upstream for `bytes=<saved prefix>-` and
  // answers aria2 with a length-opaque stream, so aria2's one sequential
  // connection is exactly the remainder and every received byte survives
  // in-run retries, failed runs and process restarts.
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const stage = join(staging, "aria2-" + sha256(value).slice(0, 16));
  await noLinks(stage);
  await mkdir(stage, { recursive: true });
  const partial = join(stage, "partial"),
    token = crypto.randomUUID();
  const emit = progressSink();
  let expected: number | undefined = await readTotal(stage);
  const identity = new URL(value);
  const qqSession = isQQDownload(identity)
    ? new QQDownloadSession(identity)
    : undefined;
  let active: Aria2Attempt | undefined;
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
        !["GET", "HEAD"].includes(request.method) ||
        !active
      )
        return new Response(null, { status: 404 });
      const attempt = active;
      try {
        if (++attempt.requests > 128) fail("Too many aria2 range requests");
        const response = await downloadResponse(value, {
          method: request.method as "GET" | "HEAD",
          headers: new Headers({
            "Accept-Encoding": "identity",
            Range: `bytes=${attempt.offset}-`,
          }),
          signal: attempt.abort.signal,
          qqSession,
        });
        const contentRange = response.headers.get("content-range"),
          length = Number(response.headers.get("content-length") ?? 0),
          rangeParts = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/),
          start = Number(rangeParts?.[1]),
          end = Number(rangeParts?.[2]),
          total = Number(rangeParts?.[3]);
        if (response.status === 206 && rangeParts) {
          if (
            ![start, end, total].every(Number.isSafeInteger) ||
            start !== attempt.offset ||
            end !== total - 1 ||
            total > limit ||
            (length !== 0 && length !== total - start)
          ) {
            await response.body?.cancel();
            fail("Resume range was not honored or exceeds the size limit");
          }
        } else if (
          response.status !== 200 ||
          attempt.offset !== 0 ||
          contentRange ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > limit
        ) {
          await response.body?.cancel();
          fail("Resume range was not honored or exceeds the size limit");
        }
        const known =
          response.status === 206 ? total : length > 0 ? length : undefined;
        if (known) {
          if (expected === undefined) {
            expected = known;
            await writeTotal(stage, known);
          } else if (expected !== known)
            fail("Download total changed between requests");
        }
        if (request.method === "HEAD")
          return new Response(null, {
            status: 200,
            headers: { "Cache-Control": "no-store" },
          });
        // A later successful request recovers an earlier transient failure;
        // aria2 can only finish when every request ultimately succeeded.
        if (isTransient(attempt.failure)) attempt.failure = undefined;
        let size = 0;
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              size += chunk.length;
              if (size > limit) {
                attempt.failure = new Error("Download exceeds size limit");
                attempt.abort.abort();
                throw attempt.failure;
              }
              attempt.received =
                attempt.offset +
                attempt.ranges.add(size - chunk.length, chunk.length);
              emit({
                kind: "download",
                received: attempt.received,
                total: expected,
              });
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("Download failed");
        // Once a permanent failure aborts the attempt, abort noise from the
        // other connections must not mask it.
        if (!attempt.failure || isTransient(attempt.failure))
          attempt.failure = failure;
        // aria2 retries 5xx responses itself; report policy violations as 4xx
        // so a permanent failure stops the run instead of being hammered.
        return new Response(null, {
          status: isTransient(failure) ? 502 : 400,
        });
      }
    },
    error: () => new Response(null, { status: 502 }),
  });
  const run = async (): Promise<Uint8Array> => {
    const attempt: Aria2Attempt = {
      abort: new AbortController(),
      ranges: new TransferRanges(),
      failure: undefined,
      received: 0,
      requests: 0,
      offset: await prefixSize(stage, limit),
    };
    if (expected !== undefined && attempt.offset === expected) {
      // An earlier attempt already saved every byte of the entity.
      const bytes = await readFile(partial);
      report({
        kind: "download",
        received: bytes.length,
        total: expected,
        complete: true,
      });
      return bytes;
    }
    if (expected !== undefined)
      emit({ kind: "download", received: attempt.offset, total: expected });
    active = attempt;
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
          "--allow-overwrite=true",
          "--auto-file-renaming=false",
          "--file-allocation=none",
          // The relay streams a length-opaque remainder; one sequential
          // connection is what keeps the saved prefix resumable.
          "--split=1",
          "--max-connection-per-server=1",
          "--max-tries=5",
          "--retry-wait=2",
          "--connect-timeout=20",
          "--timeout=60",
          "--stop=3600",
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
          timeout: 3605000,
          env: { ...process.env, PIKO_HOME: root },
        },
      );
      const code = await child.exited;
      // aria2's scratch is a sequential prefix of the remainder; fold it into
      // the saved prefix whether the run failed or succeeded.
      const scratch = join(stage, "download");
      if (await exists(scratch)) {
        const info = await lstat(scratch);
        if (info.isFile() && info.size > 0) {
          let remaining =
            expected === undefined ? Infinity : expected - attempt.offset;
          for await (const chunk of Bun.file(scratch).stream()) {
            const take = Math.min(chunk.length, remaining);
            if (take > 0)
              await appendFile(
                partial,
                take === chunk.length ? chunk : chunk.subarray(0, take),
              );
            remaining -= take;
            if (remaining <= 0) break;
          }
        }
        await removeTree(scratch);
      }
      await removeTree(scratch + ".aria2");
      if (attempt.failure) throw attempt.failure;
      if (code !== 0)
        failTransient(
          `aria2 download failed (exit ${code}): ${publicEndpoint(value)}; no silent fallback`,
        );
      const bytes = await readFile(partial);
      if (expected !== undefined && bytes.length !== expected)
        failTransient(
          "aria2 finished without the full entity; resuming from the saved prefix",
        );
      report({
        kind: "download",
        received: bytes.length,
        total: expected,
        complete: true,
      });
      return bytes;
    } finally {
      attempt.abort.abort();
    }
  };
  try {
    // Each aria2 run retries its own requests (--max-tries); respawning after
    // a failed run resumes from the saved prefix.
    const bytes = await withRetries(async () => {
      try {
        return await run();
      } catch (error) {
        // Transient failures keep the partial download for resume; permanent
        // violations have nothing resumable and must not linger in staging.
        if (!isTransient(error)) await removeTree(stage);
        throw error;
      }
    });
    await removeTree(stage);
    return bytes;
  } finally {
    server.stop(true);
  }
}
