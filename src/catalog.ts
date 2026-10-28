import semver from "semver";
import { validateEnv } from "./environment.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  download,
  networkUrl,
  component,
  npmName,
  relativeFile,
  record,
  fail,
  capture,
  exists,
  noLinks,
} from "./util.ts";
import { sourceIdentity } from "./store.ts";
import type { Source, Index, Manifest } from "./types.ts";

export function parseSpec(value: string): {
  source?: string;
  name: string;
  request?: string;
} {
  if (!value) fail("Package required");
  if (value.startsWith("npm:")) {
    const raw = value.slice(4),
      at = raw.lastIndexOf("@"),
      hasVersion = at > 0;
    const name = hasVersion ? raw.slice(0, at) : raw,
      request = hasVersion ? raw.slice(at + 1) : undefined;
    npmName(name);
    if (request !== undefined && !request) fail("Version request is empty");
    return { source: "npm", name, request };
  }
  const at = value.lastIndexOf("@"),
    base = at > 0 ? value.slice(0, at) : value,
    request = at > 0 ? value.slice(at + 1) : undefined;
  if (request !== undefined && !request) fail("Version request is empty");
  const parts = base.split("/");
  if (parts.length > 2) fail("Use <source>/<package>@<version>");
  const name = component(parts.at(-1)!);
  if (name === "piko") fail("piko is reserved for the package manager itself");
  return {
    source: parts.length === 2 ? component(parts[0]!) : undefined,
    name,
    request,
  };
}
export function chooseVersion(
  versions: string[],
  request: string,
  latest?: string,
): string {
  if (request === "latest") {
    if (latest && versions.includes(latest)) return latest;
    const stable = versions
      .filter((v) => semver.valid(v) && semver.prerelease(v) === null)
      .sort(semver.rcompare);
    if (!stable.length) fail("No stable version available");
    return stable[0]!;
  }
  if (versions.includes(request)) return request;
  if (!/^\d+(?:\.\d+)?$/.test(request))
    fail(`Version not found or unsupported range: ${request}`);
  const v = semver.maxSatisfying(
    versions.filter((v) => semver.valid(v)),
    request,
  );
  if (!v) fail(`No installed/available version matches ${request}`);
  return v;
}
export function makeSource(
  alias: string,
  url: string,
  type: "http" | "git",
  ref?: string,
): Source {
  alias = component(alias);
  if (alias === "npm") fail("npm is reserved for the npm package provider");
  if (type === "http") {
    const u = networkUrl(url);
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    url = u.href;
  } else {
    const u = new URL(url);
    if (
      (!["https:", "ssh:"].includes(u.protocol) &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        )) ||
      u.password ||
      (u.protocol === "https:" && u.username)
    )
      fail(
        "Git sources require HTTPS or ssh:// URLs without embedded passwords",
      );
    url = u.href;
  }
  if (
    ref &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(ref) || ref.includes(".."))
  )
    fail("Invalid Git ref");
  return { alias, url, type, ref, identity: sourceIdentity(type, url, ref) };
}
function index(value: unknown): Index {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.packages))
    fail("Invalid source index");
  for (const [name, p] of Object.entries(value.packages)) {
    component(name);
    if (
      !record(p) ||
      !record(p.versions) ||
      typeof p.latest !== "string" ||
      !Object.hasOwn(p.versions, p.latest)
    )
      fail(`Invalid index entry: ${name}`);
    for (const [v, path] of Object.entries(p.versions)) {
      if (!v || v.length > 100 || typeof path !== "string")
        fail("Invalid indexed version");
      relativeFile(path);
    }
  }
  return value as Index;
}
export async function refresh(root: string, s: Source): Promise<Index> {
  const dir = join(root, "sources", s.identity);
  await noLinks(dir);
  await mkdir(dir, { recursive: true });
  if (s.type === "http") {
    const bytes = await download(
        new URL("index.json", s.url).href,
        8 * 1024 * 1024,
      ),
      i = index(JSON.parse(Buffer.from(bytes).toString("utf8")));
    await writeFile(join(dir, "index.json"), bytes);
    return i;
  }
  if (!Bun.which("git"))
    fail(
      "Git source requires an existing Git installation on PATH; install Git yourself or use an HTTPS manifest source",
    );
  const repo = join(dir, "repo");
  const args = [
    "-c",
    "core.hooksPath=NUL",
    "-c",
    "submodule.recurse=false",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
  ];
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  if (!(await exists(repo)))
    await capture(
      "git",
      [...args, "clone", "--no-checkout", "--", s.url, repo],
      { env },
    );
  await capture(
    "git",
    [...args, "-C", repo, "fetch", "--no-tags", "origin", s.ref ?? "HEAD"],
    { env },
  );
  const commit = await capture(
    "git",
    [...args, "-C", repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
    { env },
  );
  if (!/^[a-f0-9]{40,64}$/.test(commit)) fail("Invalid Git commit identity");
  s.commit = commit;
  // Read committed bytes through git show: no checkout, hooks, filters or repository code executes.
  const text = await capture(
    "git",
    [...args, "-C", repo, "show", `${commit}:index.json`],
    { env },
  );
  const i = index(JSON.parse(text));
  await writeFile(join(dir, "index.json"), text);
  return i;
}
export function normalizeManifest(
  value: unknown,
  name: string,
  version: string,
): Manifest {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.name !== name ||
    value.version !== version ||
    !record(value.platforms)
  )
    fail("Manifest identity mismatch");
  const p = value.platforms["windows-x64"];
  if (
    !record(p) ||
    typeof p.url !== "string" ||
    !["file", "zip"].includes(p.format) ||
    !record(p.bin)
  )
    fail("Missing Windows x64 distribution");
  networkUrl(p.url);
  if (
    p.sha256 !== undefined &&
    (typeof p.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(p.sha256))
  )
    fail("Invalid SHA-256");
  if (p.format === "file") relativeFile(p.file);
  if (p.stripPrefix !== undefined) relativeFile(p.stripPrefix);
  for (const b of Object.values(p.bin)) {
    const normalized = typeof b === "string" ? { path: b, kind: "native" } : b;
    if (!record(normalized) || !["native", "node"].includes(normalized.kind))
      fail("Invalid executable mapping");
    relativeFile(normalized.path);
    if (
      normalized.kind === "native" &&
      !normalized.path.toLowerCase().endsWith(".exe")
    )
      fail("Native mappings must target .exe files");
  }
  if (
    p.persist !== undefined &&
    (!Array.isArray(p.persist) ||
      !p.persist.every((x: unknown) => typeof x === "string"))
  )
    fail("Invalid persist list");
  for (const path of p.persist ?? []) relativeFile(path);
  if (p.env !== undefined) validateEnv(p.env);
  if (value.env !== undefined)
    fail("env must be inside the platform distribution");
  const allowed = [
    "url",
    "sha256",
    "format",
    "file",
    "stripPrefix",
    "bin",
    "env",
    "persist",
  ];
  for (const k of Object.keys(p))
    if (!allowed.includes(k)) fail(`Unsupported distribution field: ${k}`);
  for (const k of Object.keys(value))
    if (!["schemaVersion", "name", "version", "platforms"].includes(k))
      fail(`Unsupported manifest field: ${k}`);
  return value as Manifest;
}
export async function loadManifest(
  root: string,
  s: Source,
  path: string,
  name: string,
  version: string,
): Promise<Manifest> {
  relativeFile(path);
  let text: string;
  if (s.type === "http")
    text = Buffer.from(
      await download(new URL(path, s.url).href, 2 * 1024 * 1024),
    ).toString("utf8");
  else
    text = await capture(
      "git",
      [
        "-c",
        "core.hooksPath=NUL",
        "-C",
        join(root, "sources", s.identity, "repo"),
        "show",
        `${s.commit ?? fail("Refresh Git source before reading a manifest")}:${path}`,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
  return normalizeManifest(JSON.parse(text), name, version);
}
