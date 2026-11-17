import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { artifactBytes } from "./cache.ts";
import { distributionDownloads, normalizeManifest } from "./catalog.ts";
import { downloadArtifact } from "./downloader.ts";
import { extractionState, writeArtifactFile } from "./artifacts.ts";
import { ensureInnoUnpacker, ensureSevenZip } from "./helpers.ts";
import { ensureInstallerTool } from "./installer-tools.ts";
import { helperOutput } from "./helpers-process.ts";
import { powershellExecutable } from "./windows.ts";
import { psQuote } from "./profiles.ts";
import {
  component,
  exists,
  fail,
  inside,
  noLinks,
  relativeFile,
  removeTree,
  sha256,
} from "./util.ts";
import {
  compareVersions,
  nextManifest,
  validateUpstreamRule,
} from "./upstream.ts";
import { extractUpstreamArchive } from "./upstream-layout.ts";
import {
  peFileVersion,
  verifyPublishedDigests,
} from "./upstream-validation.ts";
import type { UpstreamCandidate, UpstreamRule } from "./upstream.ts";
import type { PublishedDigests } from "./upstream-validation.ts";
import type { UpstreamTools } from "./upstream-layout.ts";
import type { Distribution, Download, Manifest, State } from "./types.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
type PreparedArtifact = { file: string; hash: string; bytes: number };

/**
 * Produce a normalized, exact manifest before journal binding. No downloaded
 * application code, installer, source script or integration hook is executed.
 *
 * Preview returns discovery metadata only (possibly without SHA-256). It is
 * not an installable/persistable verification result. Trust is recorded by the
 * resolver as rule.trust + candidate's advertised digests/signature policy;
 * computed SHA-256 here is a content pin, not publisher authentication.
 */
export async function prepareUpstreamManifest(
  root: string,
  state: State,
  current: Manifest,
  candidate: UpstreamCandidate,
  rule: UpstreamRule,
  options: { preview?: boolean; offline?: boolean } = {},
): Promise<Manifest> {
  rule = validateUpstreamRule(rule);
  const next = nextManifest(current, candidate, rule);
  const platform = next.platforms["windows-x64"]!;
  const downloads = distributionDownloads(platform);
  const primary = downloads[0]!;
  const derivesVersion = !!(candidate.versionFromPE || rule.versionFromPE);
  if (!derivesVersion && compareVersions(next.version, current.version) < 0)
    fail("Upstream release is behind the current version; refusing downgrade");
  if (options.preview) {
    if (derivesVersion || rule.verifyPEVersion)
      fail(
        "Payload inspection required: preview cannot determine an exact PE-derived or PE-verified version",
      );
    if (
      ["tabbit", "wecom", "baidu", "apptree", "epic"].includes(
        rule.layout ?? "",
      )
    )
      fail(
        "Payload inspection required: preview cannot derive the current application layout",
      );
    // Never retain a historical hash as evidence for a mutable upstream URL.
    for (const download of downloads)
      if (download.url === candidate.url && !candidate.sha256)
        delete download.sha256;
    return normalizeManifest(next, next.name, next.version);
  }

  // Validate the reviewed recipe before fetching or invoking a decoder. apptree
  // intentionally has no file whitelist until the new File table is inspected.
  normalizeManifest(next, next.name, next.version);
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const scratch = await mkdtemp(join(staging, "upstream-"));
  const app = join(scratch, "app");
  await mkdir(app);
  const pending = new Map<string, Promise<PreparedArtifact>>();
  const verified = new Map<string, PreparedArtifact>();
  let serial = 0;
  try {
    // Identical distributions can intentionally be extracted with disjoint
    // maps. Download once, while still enforcing every declared constraint.
    const acquire = async (
      url: string,
      expected: PublishedDigests,
      limit: number,
      assetBytes?: number,
    ): Promise<PreparedArtifact> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 * GiB)
        fail("Invalid upstream artifact size limit");
      const key = JSON.stringify([
        url,
        expected.sha256,
        expected.sha512,
        expected.md5,
      ]);
      let work = pending.get(key);
      if (!work) {
        work = (async () => {
          const cached =
            expected.sha256 &&
            join(root, "cache/artifacts", expected.sha256.toLowerCase());
          const bytes =
            cached && (await exists(cached))
              ? await artifactBytes(
                  root,
                  url,
                  expected.sha256,
                  false,
                  state,
                  limit,
                  true,
                )
              : options.offline
                ? fail(
                    "Offline upstream preparation requires a saved exact manifest and verified cached artifacts",
                  )
                : await downloadArtifact(root, url, state, limit);
          const hash = verifyPublishedDigests(bytes, expected);
          if (assetBytes !== undefined && bytes.length !== assetBytes)
            fail(
              "Distribution length differs from advertised upstream asset size",
            );
          const extension = /\.msi$/i.test(new URL(url).pathname)
            ? ".msi"
            : ".exe";
          const file = join(scratch, "distribution-" + serial++ + extension);
          await writeFile(file, bytes, { flag: "wx" });
          return { file, hash, bytes: bytes.length };
        })();
        pending.set(key, work);
      }
      const artifact = await work;
      if (
        artifact.bytes > limit ||
        (assetBytes !== undefined && artifact.bytes !== assetBytes)
      )
        fail(
          "Distribution exceeds its declared size or differs from upstream metadata",
        );
      return artifact;
    };

    const budget = extractionState(platform.maxExpandedBytes);
    const tools = await prepareTools(
      root,
      state,
      downloads,
      rule,
      options.offline,
      derivesVersion,
    );
    let signedArtifact: PreparedArtifact | undefined;
    for (const [n, download] of downloads.entries()) {
      const fromCandidate =
        download.url === primary.url && download.url === candidate.url;
      const expected: PublishedDigests = fromCandidate
        ? {
            sha256: candidate.sha256,
            sha512: candidate.sha512,
            md5: candidate.md5,
          }
        : { sha256: download.sha256 };
      // A same-version exact anchor is still a binding even when the feed does
      // not repeat its digest. Changed-version historical hashes were removed
      // by nextManifest and can never be used as a publisher checksum.
      const historicalPin =
        fromCandidate && current.version === next.version
          ? download.sha256
          : undefined;
      const strongDigest = !!(expected.sha256 || expected.sha512);
      if (
        rule.trust === "publisher" &&
        !strongDigest &&
        !(fromCandidate && rule.signature)
      )
        fail(
          "Publisher trust requires an advertised SHA-256/SHA-512 digest or declared Authenticode verification",
        );
      const limit = fromCandidate
        ? (rule.maxBytes ?? 2 * GiB)
        : (download.maxBytes ?? 512 * MiB);
      if (fromCandidate && candidate.assetBytes !== undefined) {
        if (
          !Number.isSafeInteger(candidate.assetBytes) ||
          candidate.assetBytes < 1 ||
          candidate.assetBytes > limit
        )
          fail("Upstream asset length exceeds the source download ceiling");
      }
      const artifact = await acquire(
        download.url,
        expected,
        limit,
        fromCandidate ? candidate.assetBytes : undefined,
      );
      if (historicalPin && historicalPin.toLowerCase() !== artifact.hash)
        fail(
          "Distribution changed without a newer application version; immutable version retained",
        );
      download.sha256 = artifact.hash;
      if (fromCandidate)
        download.maxBytes = Math.min(
          limit,
          Math.max(
            download.maxBytes ?? 512 * MiB,
            Math.ceil(artifact.bytes / MiB) * MiB + 8 * MiB,
          ),
        );
      verified.set(artifact.hash, artifact);
      if (fromCandidate) signedArtifact ??= artifact;
      const cabinets: Record<string, string> = {};
      for (const [name, cabinet] of Object.entries(download.cabinets ?? {})) {
        const payload = await acquire(
          cabinet.url,
          { sha256: cabinet.sha256 },
          cabinet.maxBytes ?? 512 * MiB,
        );
        cabinet.sha256 = payload.hash;
        cabinets[name] = payload.file;
        verified.set(payload.hash, payload);
      }
      if (download.format === "file") {
        if (/\.exe$/i.test(download.file!)) await requirePE(artifact.file);
        const bytes = await readFile(artifact.file);
        await writeArtifactFile(
          app,
          [download.into, download.file!].filter(Boolean).join("/"),
          bytes,
          budget,
        );
      } else {
        const layoutScratch = join(scratch, "layout-" + n);
        await mkdir(layoutScratch);
        await extractUpstreamArchive(
          artifact.file,
          download,
          rule,
          app,
          budget,
          tools,
          layoutScratch,
          cabinets,
        );
      }
    }

    const outputs = new Map(
      [...budget.paths.entries()].filter(([, entry]) => !entry.directory),
    );
    validateRequiredPayloads(platform, outputs, rule);
    if (rule.signature) {
      const image =
        typeof rule.signature === "string"
          ? await outputPath(app, outputs, rule.signature)
          : (signedArtifact?.file ??
            fail("Declared signed distribution is missing"));
      await verifyAuthenticode(image);
    }
    if (derivesVersion || rule.verifyPEVersion) {
      const bin = Object.values(platform.bin)
        .map((value) => (typeof value === "string" ? value : value.path))
        .find((path) => /\.exe$/i.test(path));
      if (!bin || !tools.sevenZip)
        fail("Cannot inspect the native application PE version");
      const image = await outputPath(app, outputs, bin);
      await requirePE(image);
      const info = Buffer.from(
        await helperOutput(
          tools.sevenZip,
          ["l", "-tPE", "-slt", "-sccUTF-8", image],
          32 * MiB,
        ),
      ).toString("utf8");
      const version = peFileVersion(
        info,
        rule.verifyPEVersion ? next.version : undefined,
      );
      if (derivesVersion) {
        component(version);
        if (compareVersions(version, current.version) < 0)
          fail(
            "Upstream PE version is behind the current release; refusing downgrade",
          );
        next.version = version;
      }
    }
    enforceImmutableVersion(current, next);
    const exact = normalizeManifest(next, next.name, next.version);
    // Publish no newly pinned application artifact until all signature, layout,
    // required-file, quota and version checks have succeeded. The caller alone
    // may bind this exact result to a journal or source-scoped resolution cache.
    for (const artifact of verified.values())
      await cacheVerifiedArtifact(root, artifact);
    return exact;
  } finally {
    await removeTree(scratch);
  }
}

async function prepareTools(
  root: string,
  state: State,
  downloads: Download[],
  rule: UpstreamRule,
  offline = false,
  derivesVersion = false,
): Promise<UpstreamTools> {
  const tools: UpstreamTools = {};
  if (
    downloads.some((download) =>
      ["msi", "burn", "nsis", "pe"].includes(download.format),
    ) ||
    derivesVersion ||
    rule.versionFromPE ||
    rule.verifyPEVersion
  )
    tools.sevenZip = await ensureInstallerTool(
      root,
      state,
      "full7zip",
      offline,
    );
  if (
    downloads.some(
      (download) => download.format === "msi" || download.format === "burn",
    )
  )
    tools.lessMsi = await ensureInstallerTool(root, state, "lessmsi", offline);
  if (
    !tools.sevenZip &&
    downloads.some(
      (download) =>
        ["7z", "tar", "tar.gz", "tar.xz"].includes(download.format) ||
        download.nested?.some((step) => step.format === "7z"),
    )
  )
    tools.sevenZip = await ensureSevenZip(root, state, offline);
  if (downloads.some((download) => download.format === "inno"))
    tools.inno = await ensureInnoUnpacker(root, state, offline);
  return tools;
}

type OutputFiles = Map<string, { path: string; directory: boolean }>;
function validateRequiredPayloads(
  platform: Distribution,
  outputs: OutputFiles,
  rule: UpstreamRule,
): void {
  const generated = new Set(
    [
      ...Object.keys(platform.configFiles ?? {}),
      ...Object.keys(platform.configTemplates ?? {}),
    ].map((path) => path.toLowerCase()),
  );
  const required = [...(rule.required ?? [])];
  for (const bin of Object.values(platform.bin)) {
    if (typeof bin === "string") required.push(bin);
    else if (!bin.data) required.push(bin.path);
  }
  for (const kind of ["shortcuts", "fonts", "associations", "menus"] as const)
    for (const entry of platform.desktop?.[kind] ?? [])
      required.push(typeof entry === "string" ? entry : entry.path);
  if (platform.bootstrap) required.push(platform.bootstrap.path);
  if (platform.admin)
    required.push(platform.admin.install.path, platform.admin.remove.path);
  for (const file of required) {
    relativeFile(file);
    if (!outputs.has(file.toLowerCase()) && !generated.has(file.toLowerCase()))
      fail("Required application entry missing: " + file);
  }
  if (rule.layout === "qqnt") {
    const packages = [...outputs.values()].filter((entry) =>
      /^versions\/\d+\.\d+\.\d+-\d+\/resources\/app\/package\.json$/.test(
        entry.path,
      ),
    );
    if (packages.length !== 1)
      fail("QQ application package layout is ambiguous or missing");
    const prefix = packages[0]!.path.split("/resources/")[0]!;
    for (const path of [
      "resources/app/package.json",
      "QQNT.dll",
      "chrome_100_qq.pak",
      "resources.pak",
      "icudtl.dat",
    ])
      if (!outputs.has((prefix + "/" + path).toLowerCase()))
        fail("QQ application resource missing: " + path);
  }
}

async function outputPath(
  app: string,
  outputs: OutputFiles,
  path: string,
): Promise<string> {
  relativeFile(path);
  const entry = outputs.get(path.toLowerCase());
  if (!entry) fail("Declared inspection payload is missing: " + path);
  const file = inside(app, join(app, entry.path));
  await noLinks(file);
  if (!(await lstat(file)).isFile())
    fail("Inspection payload is not a regular file");
  return file;
}

async function requirePE(file: string): Promise<void> {
  const reader = await open(file, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await reader.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header.toString("ascii") !== "MZ")
      fail("Native file is not a PE executable");
  } finally {
    await reader.close();
  }
}

async function verifyAuthenticode(file: string): Promise<void> {
  if (process.platform !== "win32")
    fail(
      "Authenticode verification requires Windows; no portable signature bypass is available",
    );
  await noLinks(file);
  // Only our constant script runs. The downloaded image is an inert LiteralPath
  // argument, encoded by the shared quoting helper, never an entrypoint.
  const script =
    "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; if((Get-AuthenticodeSignature -LiteralPath " +
    psQuote(file) +
    ").Status -ne 'Valid'){throw 'Distribution signature is not Valid'}";
  await helperOutput(
    powershellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    MiB,
  );
}

function enforceImmutableVersion(current: Manifest, next: Manifest): void {
  if (current.version !== next.version) return;
  const oldDownloads = distributionDownloads(current.platforms["windows-x64"]!);
  const newDownloads = distributionDownloads(next.platforms["windows-x64"]!);
  if (
    oldDownloads.length !== newDownloads.length ||
    oldDownloads.some(
      (download, n) =>
        !download.sha256 ||
        download.sha256.toLowerCase() !==
          newDownloads[n]!.sha256?.toLowerCase(),
    )
  )
    fail(
      "Distribution changed without a newer application version; immutable version retained",
    );
}

async function cacheVerifiedArtifact(
  root: string,
  artifact: PreparedArtifact,
): Promise<void> {
  const directory = join(root, "cache/artifacts");
  await noLinks(directory);
  await mkdir(directory, { recursive: true });
  const file = join(directory, artifact.hash);
  await noLinks(file);
  if (await exists(file)) {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.size !== artifact.bytes ||
      sha256(await readFile(file)) !== artifact.hash
    )
      fail(
        "Existing artifact cache content is invalid; refusing to trust or replace it",
      );
    return;
  }
  const temporary = join(
    directory,
    artifact.hash + "." + crypto.randomUUID() + ".tmp",
  );
  try {
    await copyFile(artifact.file, temporary, constants.COPYFILE_EXCL);
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await noLinks(file);
      const info = await lstat(file);
      if (
        !info.isFile() ||
        info.size !== artifact.bytes ||
        sha256(await readFile(file)) !== artifact.hash
      )
        fail(
          "Concurrent artifact cache content is invalid; refusing to trust or replace it",
        );
    }
  } finally {
    if (await exists(temporary)) await removeTree(temporary);
  }
}
