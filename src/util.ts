import { createHash } from "node:crypto";
import {
  isQQDownload,
  QQDownloadSession,
  validateQQDownload,
} from "./qq-download.ts";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  lstat,
  readdir,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

export function fail(message: string): never {
  throw new Error(message);
}
export function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function component(value: string): string {
  if (
    ["constructor", "prototype", "__proto__"].includes(value.toLowerCase()) ||
    !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) ||
    [".", ".."].includes(value)
  )
    fail(`Unsafe name: ${value}`);
  return value.toLowerCase();
}
export function npmName(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 214 ||
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value) ||
    value
      .split("/")
      .some((x) => ["constructor", "prototype", "__proto__"].includes(x))
  )
    fail("Invalid npm package name");
  return value;
}
export function commandName(value: string): string {
  // Command names such as clang++ are valid Windows filenames; package/source
  // component names retain their stricter grammar.
  component(value.replaceAll("+", "-"));
  const name = value.toLowerCase();
  if (name === "piko" || /\.(exe|cmd|bat|ps1)$/i.test(name))
    fail(`Reserved command: ${value}`);
  return name;
}
export function relativeFile(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    /[\\:\x00-\x1f]/.test(value)
  )
    fail(`Unsafe relative path: ${value}`);
  const parts = value.split("/");
  for (const part of parts) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[<>"|?*]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
    )
      fail(`Unsafe relative path: ${value}`);
  }
  return value;
}
export function inside(root: string, path: string): string {
  const full = resolve(path),
    rel = relative(resolve(root), full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    fail(`Path escapes managed directory: ${path}`);
  return full;
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function versionKey(version: string): string {
  if (
    typeof version !== "string" ||
    !version ||
    version.length > 100 ||
    /[\x00-\x1f]/.test(version)
  )
    fail("Invalid version identifier");
  if (/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version))
    return version.toLowerCase();
  return `v-${sha256(version).slice(0, 20)}`;
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export async function noLinks(path: string): Promise<void> {
  const full = resolve(path),
    parent = dirname(full);
  if (parent !== full) await noLinks(parent);
  if (await exists(full)) {
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) fail(`Refusing linked managed path: ${full}`);
  }
}
export async function noLinksTree(path: string): Promise<void> {
  await noLinks(path);
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (!info.isDirectory()) fail(`Persistent data is not a directory: ${path}`);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name),
      stat = await lstat(child);
    if (stat.isSymbolicLink())
      fail(`Refusing linked persistent data: ${child}`);
    if (stat.isDirectory()) await noLinksTree(child);
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await noLinks(dirname(path));
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function json(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function removeTree(path: string): Promise<void> {
  await noLinks(path);
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
export function networkUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    fail(
      "Only HTTPS (or loopback HTTP for local sources) is allowed; credentials must not be embedded in URLs",
    );
  return url;
}
export function publicEndpoint(value: string | URL): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
export async function downloadResponse(
  value: string,
  options: {
    method?: "GET" | "HEAD";
    headers?: Headers;
    signal?: AbortSignal;
    qqSession?: QQDownloadSession;
  } = {},
): Promise<Response> {
  const initial = networkUrl(value);
  const qq = isQQDownload(initial)
    ? (options.qqSession ?? new QQDownloadSession(initial))
    : undefined;
  let url = qq ? await qq.resolve(options.signal) : initial;
  if (qq) validateQQDownload(new QQDownloadSession(initial).identity, url);
  for (let redirects = 0; redirects < 6; redirects++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        method: options.method,
        headers: options.headers,
        signal: options.signal ?? AbortSignal.timeout(120000),
      });
    } catch (error) {
      const code =
        record(error) &&
        typeof error.code === "string" &&
        /^[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : error instanceof Error
            ? error.name
            : "NetworkError";
      throw new Error(
        `Download connection failed (${code}): ${publicEndpoint(url)}`,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) fail("Redirect missing Location");
      const next = networkUrl(new URL(location, url).href);
      if (qq) validateQQDownload(qq.identity, next);
      if (url.protocol === "https:" && next.protocol !== "https:")
        fail("Refusing HTTPS downgrade");
      url = next;
      continue;
    }
    if (qq && [401, 403].includes(response.status)) {
      await response.body?.cancel();
      const refreshed = await qq.refresh(url, options.signal);
      if (refreshed) {
        url = refreshed;
        continue;
      }
    }
    if (!response.ok)
      fail(`Download failed: HTTP ${response.status} (${publicEndpoint(url)})`);
    return response;
  }
  fail("Too many redirects");
}
export async function download(
  value: string,
  limit = 512 * 1024 * 1024,
  progress?: (received: number, total?: number, complete?: boolean) => void,
): Promise<Uint8Array> {
  const response = await downloadResponse(value);
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    fail("Download exceeds size limit");
  }
  const length = Number(response.headers.get("content-length"));
  // Fetch may decompress the body, so encoded Content-Length is not a usable total.
  const expected =
    !response.headers.get("content-encoding") &&
    Number.isSafeInteger(length) &&
    length > 0
      ? length
      : undefined;
  progress?.(0, expected);
  const reader = response.body?.getReader();
  if (!reader) fail("Empty response body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) fail("Download exceeds size limit");
      chunks.push(value);
      progress?.(total, expected);
    }
  } finally {
    await reader.cancel();
  }
  progress?.(total, expected, true);
  return Buffer.concat(chunks, total);
}
export async function capture(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) fail(`Subprocess failed (${code}): ${err.slice(-2000)}`);
  return out.trim();
}
