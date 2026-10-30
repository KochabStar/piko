import {
  validateAdmin,
  validateBootstrap,
  validateDesktop,
} from "./integration-declarations.ts";
import { persistence, validateTemplates } from "./persistence.ts";
import { validateShell } from "./shell-declarations.ts";
import semver from "semver";
import { validateEnv } from "./environment.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  download,
  networkUrl,
  component,
  commandName,
  npmName,
  relativeFile,
  record,
  fail,
  capture,
  exists,
  noLinks,
} from "./util.ts";
import { sourceIdentity } from "./store.ts";
import type {
  Source,
  Index,
  Manifest,
  Distribution,
  Download,
} from "./types.ts";

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
  aliases?: Record<string, string>,
): string {
  if (
    request !== "latest" &&
    !versions.includes(request) &&
    aliases &&
    Object.hasOwn(aliases, request)
  )
    request = aliases[request]!;
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
export function normalizeIndex(value: unknown): Index {
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
    if (p.aliases !== undefined) {
      if (!record(p.aliases) || Object.keys(p.aliases).length > 100)
        fail("Invalid version aliases");
      for (const [alias, target] of Object.entries(p.aliases)) {
        if (
          !/^[a-z][a-z0-9-]{0,39}$/.test(alias) ||
          alias === "latest" ||
          Object.hasOwn(p.versions, alias) ||
          typeof target !== "string" ||
          target === "latest"
        )
          fail("Invalid version alias");
        chooseVersion(Object.keys(p.versions), target);
      }
    }
    if (
      p.runtime !== undefined &&
      (!record(p.runtime) ||
        typeof p.runtime.family !== "string" ||
        component(p.runtime.family) !== p.runtime.family ||
        typeof p.runtime.distribution !== "string" ||
        component(p.runtime.distribution) !== p.runtime.distribution ||
        Object.keys(p.runtime).some(
          (k) => !["family", "distribution"].includes(k),
        ))
    )
      fail("Invalid runtime distribution identity");
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
      i = normalizeIndex(JSON.parse(Buffer.from(bytes).toString("utf8")));
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
  const i = normalizeIndex(JSON.parse(text));
  await writeFile(join(dir, "index.json"), text);
  return i;
}
export function distributionDownloads(platform: Distribution): Download[] {
  return platform.downloads ?? [platform as Download];
}

export function validateDependencies(
  dependencies: unknown,
  name: string,
): void {
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies) || dependencies.length > 100)
      fail("depends must be an array");
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      if (
        !record(dependency) ||
        typeof dependency.package !== "string" ||
        Object.keys(dependency).some(
          (k) => !["package", "commands"].includes(k),
        )
      )
        fail("Invalid dependency declaration");
      const spec = parseSpec(dependency.package);
      if (spec.source === "npm") fail("Portable dependencies cannot use npm");
      if (spec.name === name) fail("A package cannot depend on itself");
      if (spec.request) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(spec.request))
          fail(
            "Dependency versions require exact, major/minor or latest requests",
          );
      }
      const identity = `${spec.source ?? ""}/${spec.name}`;
      if (seen.has(identity)) fail("Duplicate dependency");
      seen.add(identity);
      if (dependency.commands !== undefined) {
        if (!Array.isArray(dependency.commands))
          fail("Dependency commands must be an array");
        const commands = new Set<string>();
        for (const command of dependency.commands) {
          if (typeof command !== "string" || commandName(command) !== command)
            fail("Invalid dependency command name");
          if (commands.has(command)) fail("Duplicate dependency command");
          commands.add(command);
        }
      }
    }
  }
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
  if (!record(p) || !record(p.bin)) fail("Missing Windows x64 distribution");
  const downloadFields = [
    "url",
    "sha256",
    "format",
    "file",
    "stripPrefix",
    "into",
    "files",
    "nested",
    "maxBytes",
    "cabinets",
  ];
  let downloads: unknown[];
  if (p.downloads !== undefined) {
    if (
      !Array.isArray(p.downloads) ||
      !p.downloads.length ||
      p.downloads.length > 32 ||
      downloadFields.some((field) => p[field] !== undefined)
    )
      fail("Use either a single download or 1–32 downloads, not both");
    downloads = p.downloads;
  } else downloads = [p];
  for (const download of downloads) {
    if (
      !record(download) ||
      typeof download.url !== "string" ||
      ![
        "file",
        "zip",
        "7z",
        "tar",
        "tar.gz",
        "tar.xz",
        "inno",
        "msi",
        "nsis",
        "pe",
      ].includes(download.format)
    )
      fail("Unsupported or missing download format/URL");
    if (
      p.downloads &&
      Object.keys(download).some((k) => !downloadFields.includes(k))
    )
      fail("Unsupported download field");
    networkUrl(download.url);
    if (
      download.sha256 !== undefined &&
      (typeof download.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(download.sha256))
    )
      fail("Invalid SHA-256");
    if (
      download.maxBytes !== undefined &&
      (!Number.isSafeInteger(download.maxBytes) ||
        download.maxBytes < 1 ||
        download.maxBytes > 2 * 1024 * 1024 * 1024)
    )
      fail("maxBytes must be an integer from 1 to 2 GiB");
    if (download.cabinets !== undefined) {
      if (
        download.format !== "msi" ||
        !record(download.cabinets) ||
        !Object.keys(download.cabinets).length ||
        Object.keys(download.cabinets).length > 32
      )
        fail("cabinets requires 1–32 explicit MSI CAB downloads");
      const seen = new Set<string>();
      for (const [name, cabinet] of Object.entries(download.cabinets)) {
        relativeFile(name);
        if (
          name.includes("/") ||
          seen.has(name.toLowerCase()) ||
          !record(cabinet) ||
          Object.keys(cabinet).some(
            (k) => !["url", "sha256", "maxBytes"].includes(k),
          ) ||
          typeof cabinet.url !== "string" ||
          typeof cabinet.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(cabinet.sha256)
        )
          fail("Invalid or duplicate MSI CAB declaration");
        networkUrl(cabinet.url);
        if (
          cabinet.maxBytes !== undefined &&
          (!Number.isSafeInteger(cabinet.maxBytes) ||
            cabinet.maxBytes < 1 ||
            cabinet.maxBytes > 2 * 1024 * 1024 * 1024)
        )
          fail("Invalid cabinet maxBytes");
        seen.add(name.toLowerCase());
      }
    }
    if (download.files !== undefined) {
      if (
        !["inno", "msi", "nsis"].includes(download.format) ||
        !record(download.files) ||
        !Object.keys(download.files).length ||
        Object.keys(download.files).length > 100000
      )
        fail("files requires a nonempty explicit Inno/MSI/NSIS mapping");
      const targets = new Set<string>(),
        sources = new Set<string>();
      for (const [from, to] of Object.entries(download.files)) {
        relativeFile(from);
        relativeFile(to as string);
        if (
          sources.has(from.toLowerCase()) ||
          targets.has((to as string).toLowerCase())
        )
          fail("Case-colliding extraction mapping");
        sources.add(from.toLowerCase());
        targets.add((to as string).toLowerCase());
      }
    }
    if (download.nested !== undefined) {
      if (
        !["zip", "7z", "nsis", "pe"].includes(download.format) ||
        download.files ||
        download.stripPrefix ||
        !Array.isArray(download.nested) ||
        !download.nested.length ||
        download.nested.length > 3
      )
        fail(
          "nested requires 1–3 explicit archive steps and no outer stripPrefix/files",
        );
      for (const step of download.nested) {
        if (
          !record(step) ||
          !["7z", "zip"].includes(step.format) ||
          Object.keys(step).some(
            (k) => !["path", "format", "stripPrefix"].includes(k),
          )
        )
          fail("Invalid nested extraction step");
        relativeFile(step.path);
        if (step.stripPrefix !== undefined) relativeFile(step.stripPrefix);
      }
    }
    if (download.format === "nsis") {
      if (!download.nested && !download.files)
        fail("NSIS requires explicit nested payload selection or file mapping");
      if (download.files && download.stripPrefix !== undefined)
        fail("NSIS file mapping cannot also specify stripPrefix");
    }
    if (download.format === "pe" && !download.nested)
      fail("PE requires explicit nested resource selection");
    if (download.format === "file") {
      relativeFile(download.file);
      if (download.stripPrefix !== undefined)
        fail("stripPrefix requires an archive");
    } else {
      if (download.file !== undefined) fail("file requires the file format");
      if (download.stripPrefix !== undefined) {
        relativeFile(download.stripPrefix);
        if (
          download.format === "inno" &&
          download.stripPrefix.startsWith("{") &&
          download.stripPrefix !== "{app}" &&
          !download.stripPrefix.startsWith("{app}/")
        )
          fail("Inno extraction only supports the {app} tree");
      }
    }
    if (download.into !== undefined) relativeFile(download.into);
    for (const path of [
      download.into,
      download.format === "file"
        ? [download.into, download.file].filter(Boolean).join("/")
        : undefined,
    ])
      if (path?.split("/")[0].toLowerCase() === ".piko-install.json")
        fail("Reserved installation metadata path");
  }
  if (
    p.maxExpandedBytes !== undefined &&
    (!Number.isSafeInteger(p.maxExpandedBytes) ||
      p.maxExpandedBytes < 1 ||
      p.maxExpandedBytes > 8 * 1024 * 1024 * 1024)
  )
    fail("maxExpandedBytes must be an integer from 1 to 8 GiB");
  if (p.configFiles !== undefined) {
    if (!record(p.configFiles) || Object.keys(p.configFiles).length > 128)
      fail("Invalid configFiles");
    let size = 0;
    for (const [path, content] of Object.entries(p.configFiles)) {
      relativeFile(path);
      if (path.split("/")[0]!.toLowerCase() === ".piko-install.json")
        fail("Reserved installation metadata path");
      if (typeof content !== "string" || Buffer.byteLength(content) > 64 * 1024)
        fail("Config files must be text of at most 64 KiB each");
      size += Buffer.byteLength(content);
    }
    if (size > 1024 * 1024) fail("Config files exceed 1 MiB total");
  }
  for (const [name, b] of Object.entries(p.bin)) {
    commandName(name);
    const normalized = typeof b === "string" ? { path: b, kind: "native" } : b;
    if (
      !record(normalized) ||
      !["native", "node", "powershell"].includes(normalized.kind)
    )
      fail("Invalid executable mapping");
    if (
      normalized.data !== undefined &&
      (normalized.data !== true || normalized.kind !== "native" || !p.bootstrap)
    )
      fail("Persistent executable mappings require a bootstrap");
    relativeFile(normalized.path);
    if (normalized.kind === "native" && !/\.(exe|com)$/i.test(normalized.path))
      fail("Native mappings must target .exe or .com files");
    if (normalized.kind === "powershell" && !/\.ps1$/i.test(normalized.path))
      fail("PowerShell mappings must target .ps1 files");
  }
  persistence(p.persist);
  if (p.configTemplates !== undefined) validateTemplates(p.configTemplates);
  validateDependencies(p.depends, name);
  if (p.desktop !== undefined) validateDesktop(p.desktop);
  if (p.bootstrap !== undefined) {
    validateBootstrap(p.bootstrap);
    const declarations = persistence(p.persist);
    for (const output of p.bootstrap.outputs) {
      if (
        !declarations.paths.some(
          (path) => !declarations.files[path] && output.startsWith(path + "/"),
        )
      )
        fail("Bootstrap outputs must be inside persistent directories");
    }
    for (const bin of Object.values(p.bin))
      if (record(bin) && bin.data && !p.bootstrap.outputs.includes(bin.path))
        fail("Persistent command is not a declared bootstrap output");
  }
  if (p.admin !== undefined) validateAdmin(p.admin);
  if (p.shell !== undefined) validateShell(p.shell);
  if (p.env !== undefined) validateEnv(p.env);
  if (value.env !== undefined)
    fail("env must be inside the platform distribution");
  const allowed = [
    "url",
    "sha256",
    "format",
    "file",
    "stripPrefix",
    "into",
    "files",
    "nested",
    "maxBytes",
    "cabinets",
    "downloads",
    "maxExpandedBytes",
    "configTemplates",
    "configFiles",
    "desktop",
    "bootstrap",
    "admin",
    "shell",
    "bin",
    "depends",
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
