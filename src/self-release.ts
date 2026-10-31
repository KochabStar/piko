import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import yauzl from "yauzl";
import { downloadArtifact } from "./downloader.ts";
import { report } from "./progress.ts";
import { executableHash, prepareSelfUpdate } from "./self-update.ts";
import { Store } from "./store.ts";
import {
  capture,
  download,
  exists,
  fail,
  networkUrl,
  noLinks,
  record,
  removeTree,
  sha256,
} from "./util.ts";

const latestRelease =
  "https://api.github.com/repos/KochabStar/piko/releases/latest";
const archiveLimit = 512 * 1024 * 1024;

type Options = {
  confirmed?: boolean;
  dryRun?: boolean;
  // Optional independently trusted ZIP checksum, not the EXE checksum.
  checksum?: string;
  // Internal injection for isolated tests; CLI always uses the official endpoint.
  metadataUrl?: string;
};

async function releasePlan(metadataUrl: string) {
  const endpoint = networkUrl(metadataUrl);
  let value: unknown;
  report({ kind: "stage", label: "Check Piko release" });
  try {
    value = JSON.parse(
      Buffer.from(await download(endpoint.href, 2 * 1024 * 1024)).toString(
        "utf8",
      ),
    );
  } catch (error) {
    fail(
      "Cannot check the latest Piko Release. Publish a stable Release first; private repositories require authenticated asset download and manual self update. " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (
    !record(value) ||
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.tag_name !== "string" ||
    !/^v?\d+\.\d+\.\d+$/.test(value.tag_name) ||
    !Array.isArray(value.assets)
  )
    fail("Invalid latest stable Piko Release metadata");
  const version = value.tag_name.replace(/^v/, "");
  if (!semver.valid(version)) fail("Invalid Piko Release version");
  const archive = `piko-${version}-windows-x64.zip`;
  const asset = (name: string) => {
    const matches = value.assets.filter(
      (a: unknown) => record(a) && a.name === name,
    );
    if (
      matches.length !== 1 ||
      typeof matches[0].browser_download_url !== "string"
    )
      fail("Piko Release is missing a unique asset: " + name);
    const url = networkUrl(matches[0].browser_download_url);
    if (endpoint.href === latestRelease) {
      const expected = `https://github.com/KochabStar/piko/releases/download/${value.tag_name}/${name}`;
      if (url.href !== expected)
        fail("Piko Release asset is outside the official release");
    } else if (
      endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      url.origin !== endpoint.origin
    )
      fail("Test release assets must remain on the loopback metadata origin");
    return url.href;
  };
  return {
    version,
    archive,
    archiveUrl: asset(archive),
    checksumUrl: asset(archive + ".sha256"),
  };
}

// Extract only the three exact entries needed to authenticate the candidate.
// Bundled install scripts and arbitrary paths are never extracted or executed.
async function candidateFromZip(file: string, version: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => (error ? reject(error) : resolve(zip!)),
    ),
  );
  const prefix = `piko-${version}-windows-x64/`;
  const wanted = new Map([
    [prefix + "piko.exe", archiveLimit],
    [prefix + "release.json", 65536],
    [prefix + "SHA256SUMS.txt", 65536],
  ]);
  const files = new Map<string, Buffer>();
  try {
    if (zip.entryCount > 20000) fail("Release archive has too many entries");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const error = (reason: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(reason);
      };
      zip.on("error", error);
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const limit = wanted.get(entry.fileName);
          if (limit !== undefined) {
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (
              files.has(entry.fileName) ||
              (mode && mode !== 0x8000) ||
              entry.generalPurposeBitFlag & 1 ||
              entry.uncompressedSize < 1 ||
              entry.uncompressedSize > limit
            )
              fail("Invalid, duplicate or oversized release entry");
            const stream = await new Promise<NodeJS.ReadableStream>(
              (resolve, reject) =>
                zip.openReadStream(entry, (e, stream) =>
                  e ? reject(e) : resolve(stream!),
                ),
            );
            const chunks: Buffer[] = [];
            let count = 0;
            for await (const chunk of stream as NodeJS.ReadableStream &
              AsyncIterable<Buffer>) {
              count += chunk.length;
              if (count > limit || count > entry.uncompressedSize)
                fail("Release entry exceeds size limit");
              chunks.push(chunk);
            }
            if (count !== entry.uncompressedSize)
              fail("Release entry size mismatch");
            files.set(entry.fileName, Buffer.concat(chunks, count));
          }
          if (!settled) zip.readEntry();
        })().catch(error);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (files.size !== wanted.size)
    fail("Release archive metadata or executable missing");
  const metadata: unknown = JSON.parse(
    files.get(prefix + "release.json")!.toString("utf8"),
  );
  const sums = /^([a-f0-9]{64})\s+\*?piko\.exe$/i.exec(
    files
      .get(prefix + "SHA256SUMS.txt")!
      .toString("utf8")
      .trim(),
  );
  if (
    !record(metadata) ||
    metadata.version !== version ||
    metadata.platform !== "windows-x64" ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(metadata.sha256) ||
    !sums ||
    sums[1]!.toLowerCase() !== metadata.sha256.toLowerCase()
  )
    fail("Release executable identity or checksums disagree");
  const executable = files.get(prefix + "piko.exe")!;
  if (sha256(executable) !== metadata.sha256.toLowerCase())
    fail("Release executable checksum mismatch");
  return { executable, checksum: metadata.sha256.toLowerCase() };
}

export async function updateSelfFromRelease(
  root: string,
  parent: number,
  options: Options = {},
) {
  if (options.checksum && !/^[a-f0-9]{64}$/i.test(options.checksum))
    fail("Invalid trusted release ZIP SHA-256");
  const state = await new Store(root).read();
  const target = join(root, "apps/piko/piko.exe");
  await noLinks(target);
  if (!(await exists(target))) fail("Set up Piko first");
  // Compare the installed binary, not the invoking development/newer executable.
  const current = await capture(target, ["--version"], {
    env: { ...process.env, PIKO_HOME: root },
  });
  if (!semver.valid(current))
    fail("Installed Piko reported an invalid version");
  const plan = await releasePlan(options.metadataUrl ?? latestRelease);
  const summary = {
    package: "piko",
    current,
    version: plan.version,
    archive: plan.archiveUrl,
  };
  if (semver.lte(plan.version, current))
    return { ...summary, status: "current" as const };
  if (options.dryRun || !options.confirmed)
    return { ...summary, status: "available" as const };
  let checksum = options.checksum?.toLowerCase();
  if (!checksum) {
    const text = Buffer.from(await download(plan.checksumUrl, 4096))
      .toString("utf8")
      .trim();
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(text);
    if (!match || match[2] !== plan.archive)
      fail("Invalid release ZIP checksum file");
    checksum = match[1]!.toLowerCase();
  }
  report({
    kind: "stage",
    label: "Download Piko release",
    detail: plan.version,
  });
  const bytes = await downloadArtifact(
    root,
    plan.archiveUrl,
    state,
    archiveLimit,
  );
  if (sha256(bytes) !== checksum)
    fail("Release ZIP checksum mismatch; nothing was executed");
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const dir = await mkdtemp(join(staging, "release-download-"));
  try {
    const archive = join(dir, "release.zip");
    await writeFile(archive, bytes, { flag: "wx" });
    const candidate = await candidateFromZip(archive, plan.version);
    const executable = join(dir, "piko.exe");
    await writeFile(executable, candidate.executable, { flag: "wx" });
    if ((await executableHash(executable)) !== candidate.checksum)
      fail("Candidate checksum mismatch");
    const prepared = await prepareSelfUpdate(
      root,
      executable,
      candidate.checksum,
      parent,
      false,
      plan.version,
    );
    return { ...summary, ...prepared, status: "prepared" as const };
  } finally {
    await removeTree(dir);
  }
}
