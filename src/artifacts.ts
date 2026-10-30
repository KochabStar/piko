import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { fail, inside, noLinks, relativeFile, removeTree } from "./util.ts";
import { helperFile, helperFiles, helperOutput } from "./helpers-process.ts";
import { containerFile, listContainer, withScratch } from "./containers.ts";
import { readMsiPlan } from "./msi.ts";
import type { Download } from "./types.ts";

const fileLimit = 512 * 1024 * 1024;
const totalLimit = 2 * 1024 * 1024 * 1024;
export function extractionState(limit = totalLimit) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 8 * 1024 * 1024 * 1024
  )
    fail("Invalid expanded size limit");
  return {
    limit,
    count: 0,
    total: 0,
    fileLimit,
    paths: new Map<string, { path: string; directory: boolean }>(),
  };
}
type ExtractionState = ReturnType<typeof extractionState>;

function targetPath(
  destination: string,
  path: string,
  directory: boolean,
  state: ExtractionState,
): string {
  relativeFile(path);
  if (path.split("/")[0]!.toLowerCase() === ".piko-install.json")
    fail("Archive conflicts with reserved installation receipt");
  const parts = path.split("/");
  for (let n = 1; n <= parts.length; n++) {
    const parent = parts.slice(0, n).join("/"),
      isDir = n < parts.length || directory,
      normalized = parent.toLowerCase(),
      prior = state.paths.get(normalized);
    if (prior && (prior.path !== parent || !prior.directory || !isDir))
      fail(`Duplicate, overlapping or case-colliding artifact path: ${path}`);
    state.paths.set(normalized, { path: parent, directory: isDir });
  }
  return inside(destination, join(destination, path));
}
function entryBudget(state: ExtractionState, size: number) {
  if (++state.count > 100000) fail("Archive entry count limit exceeded");
  state.total += size;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > state.fileLimit ||
    state.total > state.limit
  )
    fail("Archive expanded size limit exceeded");
}
export async function writeArtifactFile(
  destination: string,
  path: string,
  bytes: Uint8Array,
  state = extractionState(),
): Promise<void> {
  entryBudget(state, bytes.length);
  const target = targetPath(destination, path, false, state);
  await noLinks(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
}

export async function extractZip(
  zipPath: string,
  destination: string,
  stripPrefix?: string,
  state = extractionState(),
  into?: string,
): Promise<void> {
  await noLinks(destination);
  await mkdir(destination, { recursive: true });
  const archive = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (e, z) => (e ? reject(e) : resolve(z!)),
    ),
  );
  const seen = new Set<string>();
  await new Promise<void>((done, reject) => {
    let settled = false;
    const error = (e: unknown) => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(e);
    };
    archive.on("error", error);
    archive.on("end", () => {
      if (!settled) {
        settled = true;
        done();
      }
    });
    archive.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        const raw = entry.fileName,
          isDir = raw.endsWith("/");
        entryBudget(state, isDir ? 0 : entry.uncompressedSize);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode && mode !== 0x8000 && mode !== 0x4000)
          fail("Archive links and special files are not supported");
        if (mode && (mode === 0x4000) !== isDir)
          fail("Archive entry type mismatch");
        if (entry.generalPurposeBitFlag & 1)
          fail("Encrypted ZIP entries are not supported");
        // TAR tools conventionally include a harmless ./ directory prefix.
        let path = isDir ? raw.slice(0, -1) : raw;
        while (path.startsWith("./")) path = path.slice(2);
        if (path === "." && isDir) {
          archive.readEntry();
          return;
        }
        relativeFile(path);
        if (stripPrefix) {
          if (path === stripPrefix && isDir) {
            archive.readEntry();
            return;
          }
          if (!path.startsWith(stripPrefix + "/"))
            fail("Archive entry is outside stripPrefix");
          path = path.slice(stripPrefix.length + 1);
        }
        relativeFile(path);
        if (into) path = into + "/" + path;
        const normalized = path.toLowerCase();
        if (seen.has(normalized))
          fail("Duplicate or case-colliding ZIP entry: " + path);
        seen.add(normalized);
        const target = targetPath(destination, path, isDir, state);
        await noLinks(target);
        if (isDir) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>(
            (resolve, reject) =>
              archive.openReadStream(entry, (e, s) =>
                e ? reject(e) : resolve(s!),
              ),
          );
          let bytes = 0;
          await pipeline(
            stream,
            async function* (source) {
              for await (const chunk of source) {
                bytes += chunk.length;
                if (bytes > entry.uncompressedSize || bytes > state.fileLimit)
                  fail("ZIP entry exceeds declared size or extraction limit");
                yield chunk;
              }
            },
            createWriteStream(target, { flags: "wx" }),
          );
          if (bytes !== entry.uncompressedSize) fail("ZIP entry size mismatch");
        }
        if (!settled) archive.readEntry();
      })().catch(error);
    });
    archive.readEntry();
  });
}

async function extractSevenZip(
  executable: string,
  archive: string,
  type: "7z" | "tar",
  destination: string,
  stripPrefix: string | undefined,
  state: ExtractionState,
  into: string | undefined,
) {
  const listing = Buffer.from(
    await helperOutput(
      executable,
      [
        "l",
        "-t" + type,
        "-slt",
        "-ba",
        "-sccUTF-8",
        "-pPIKO_NO_PASSWORD",
        "--",
        resolve(archive),
      ],
      32 * 1024 * 1024,
    ),
  ).toString("utf8");
  const entries: {
    raw: string;
    path: string;
    directory: boolean;
    size: number;
  }[] = [];
  const seen = new Set<string>();
  for (const block of listing
    .replace(/[\r\n]+$/, "")
    .split(/\r?\n\r?\n/)
    .filter(Boolean)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(" = ");
      if (at < 0 || fields.has(line.slice(0, at)))
        fail("Ambiguous 7-Zip entry metadata");
      fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const raw = fields.get("Path");
    if (!raw || /[\r\n\x00]/.test(raw)) fail("Invalid 7-Zip entry path");
    let path = raw.replaceAll("\\", "/");
    const attributes = fields.get("Attributes") ?? "",
      mode = fields.get("Mode") ?? "";
    const directory =
      type === "tar"
        ? fields.get("Folder") === "+"
        : attributes.startsWith("D");
    if (
      (type === "7z" && (!attributes || fields.get("Encrypted") !== "-")) ||
      (type === "tar" &&
        (!/^[d-][rwxstST-]{9}$/.test(mode) ||
          !["+", "-"].includes(fields.get("Folder") ?? "") ||
          directory !== mode.startsWith("d"))) ||
      /[Ll]/.test(attributes) ||
      [...fields].some(
        ([key, value]) =>
          /link|reparse|alternate|stream/i.test(key) && value !== "",
      ) ||
      (attributes.includes("_") && !/_(d|-)r/.test(attributes))
    )
      fail(
        "7-Zip links, special files, streams and encrypted entries are not supported",
      );
    while (path.startsWith("./")) path = path.slice(2);
    if (path === "." && directory) {
      entryBudget(state, 0);
      continue;
    }
    relativeFile(path);
    const sizeText = fields.get("Size");
    if (!sizeText || !/^\d+$/.test(sizeText)) fail("Invalid 7-Zip entry size");
    const size = Number(sizeText),
      normalized = path.toLowerCase();
    if (seen.has(normalized)) fail("Duplicate or case-colliding 7-Zip entry");
    seen.add(normalized);
    entryBudget(state, directory ? 0 : size);
    if (stripPrefix) {
      if (path === stripPrefix && directory) continue;
      if (!path.startsWith(stripPrefix + "/"))
        fail("Archive entry is outside stripPrefix");
      path = path.slice(stripPrefix.length + 1);
    }
    if (into) path = into + "/" + path;
    targetPath(destination, path, directory, state);
    entries.push({ raw, path, directory, size });
  }
  if (!entries.length) fail("7-Zip archive contains no usable entries");
  // Keep archive order and divide stdout using the already-validated lengths.
  // Bounded batches avoid decompressing the same solid block once per file;
  // 7-Zip never receives an output directory or chooses filesystem targets.
  const files: { raw: string; path: string; size: number }[] = [];
  for (const entry of entries) {
    const target = inside(destination, join(destination, entry.path));
    await noLinks(target);
    if (entry.directory) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      files.push({ raw: entry.raw, path: target, size: entry.size });
    }
  }
  for (let offset = 0; offset < files.length;) {
    const batch: typeof files = [];
    let characters = resolve(archive).length + 256;
    while (offset < files.length && batch.length < 128) {
      const file = files[offset]!;
      if (batch.length && characters + file.raw.length + 4 > 16000) break;
      characters += file.raw.length + 4;
      batch.push(file);
      offset++;
    }
    await helperFiles(
      executable,
      [
        "x",
        "-t" + type,
        "-so",
        "-spd",
        "-y",
        "-bd",
        "-bb0",
        "-pPIKO_NO_PASSWORD",
        "--",
        resolve(archive),
        ...batch.map((file) => file.raw),
      ],
      batch,
    );
  }
}

async function extractInno(
  executable: string,
  archive: string,
  destination: string,
  stripPrefix: string | undefined,
  state: ExtractionState,
  into: string | undefined,
  files?: Record<string, string>,
) {
  // Only the app tree is allowed; an explicit map chooses exact conditional copies.
  const prefix =
    !stripPrefix || stripPrefix === "{app}"
      ? "{app}"
      : stripPrefix.startsWith("{app}/")
        ? stripPrefix
        : "{app}/" + stripPrefix;
  relativeFile(prefix);
  if (prefix !== "{app}" && !prefix.startsWith("{app}/"))
    fail("Inno extraction only supports {app}");
  const listing = Buffer.from(
    await helperOutput(
      executable,
      ["-v", "-a", "-b", "-h", "-o", "-u", "-n", resolve(archive)],
      32 * 1024 * 1024,
    ),
  ).toString("utf8");
  const entries: { raw: string; path: string; size: number }[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  if (files)
    for (const [from, to] of Object.entries(files)) {
      relativeFile(from);
      relativeFile(to);
    }
  let table = false,
    finished = false;
  for (const line of listing.split(/\r?\n/)) {
    if (/^-{10,}$/.test(line)) {
      if (table) finished = true;
      else table = true;
      continue;
    }
    if (!table) continue;
    if (!line.trim()) continue;
    if (finished) fail("Unexpected trailing Inno listing metadata");
    const match =
      /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/.exec(
        line,
      );
    if (!match) fail("Ambiguous or unsupported Inno file listing");
    const raw = match[2]!,
      normalized = raw.replaceAll("\\", "/");
    relativeFile(normalized);
    if (/(?:,[0-9]+$|,[0-9]+\.[^/]+$)/.test(normalized) && !files)
      fail("Inno duplicate file variants require an explicit files mapping");
    const identity = normalized.toLowerCase();
    if (seen.has(identity)) fail("Duplicate or case-colliding Inno entry");
    seen.add(identity);
    if (seen.size > 100000) fail("Inno entry count limit exceeded");
    if (!normalized.startsWith(prefix + "/")) continue;
    let path = normalized.slice(prefix.length + 1);
    if (files) {
      if (!Object.hasOwn(files, path)) continue;
      matched.add(path);
      path = files[path]!;
    }
    relativeFile(path);
    if (into) path = into + "/" + path;
    const size = Number(match[1]);
    entryBudget(state, size);
    targetPath(destination, path, false, state);
    entries.push({ raw, path, size });
  }
  if (files && matched.size !== Object.keys(files).length)
    fail("Explicit Inno mapping entry is missing");
  if (!table || !finished || !entries.length)
    fail(
      "Inno archive contains no supported files in the requested {app} tree",
    );
  // Flatten one validated, exact file into a fresh directory; never run setup.exe.
  // Reject unexpected outputs before copying into the managed installation.
  const scratch = await mkdtemp(
    join(dirname(resolve(archive)), "inno-extract-"),
  );
  try {
    for (const [n, entry] of entries.entries()) {
      const directory = join(scratch, String(n));
      await mkdir(directory);
      await helperOutput(
        executable,
        [
          "-e",
          "-a",
          "-b",
          "-q",
          "-h",
          "-o",
          "-u",
          "-n",
          "-d" + directory,
          resolve(archive),
          entry.raw,
        ],
        1024 * 1024,
      );
      const files = await readdir(directory);
      const expected = entry.raw.replaceAll("\\", "/").split("/").at(-1)!;
      if (files.length !== 1 || files[0] !== expected)
        fail("Unexpected Inno extraction output");
      const file = join(directory, expected);
      await noLinks(file);
      const info = await lstat(file);
      if (!info.isFile() || info.size !== entry.size)
        fail("Inno extracted file size/type mismatch");
      const target = inside(destination, join(destination, entry.path));
      await noLinks(target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(file), { flag: "wx" });
      await rm(file);
      await removeTree(directory);
    }
  } finally {
    await removeTree(scratch);
  }
}

export async function extractArchive(
  archivePath: string,
  format: Exclude<Download["format"], "file">,
  destination: string,
  stripPrefix?: string,
  state = extractionState(),
  into?: string,
  sevenZip?: string,
  inno?: string,
  options: {
    files?: Record<string, string>;
    nested?: Download["nested"];
    lessMsi?: string;
    cabinets?: Record<string, string>;
  } = {},
): Promise<void> {
  await noLinks(archivePath);
  await noLinks(destination);
  if (options.nested?.length) {
    return await extractNested(
      archivePath,
      format,
      destination,
      state,
      into,
      sevenZip,
      options.nested,
    );
  }
  if (format === "msi") {
    if (!sevenZip || !options.lessMsi)
      fail("MSI requires verified full 7-Zip and lessmsi metadata reader");
    return await extractMsi(
      archivePath,
      destination,
      stripPrefix,
      state,
      into,
      sevenZip,
      options.lessMsi,
      options.files,
      options.cabinets,
    );
  }
  if (format === "nsis") {
    if (!sevenZip || !options.files || stripPrefix !== undefined)
      fail(
        "NSIS requires verified full 7-Zip and explicit file mapping or nested payload selection",
      );
    return await extractNsisFiles(
      sevenZip,
      archivePath,
      destination,
      state,
      into,
      options.files,
    );
  }
  if (format === "pe") fail("PE requires explicit nested resource selection");
  if (format === "inno") {
    if (!inno) fail("Inno extraction requires the verified innounp helper");
    await noLinks(archivePath);
    return await extractInno(
      inno,
      archivePath,
      destination,
      stripPrefix,
      state,
      into,
      options.files,
    );
  }
  if (format === "zip")
    return await extractZip(archivePath, destination, stripPrefix, state, into);
  if (!sevenZip)
    fail(format + " extraction requires the verified 7-Zip helper");
  await noLinks(archivePath);
  if (format === "7z" || format === "tar")
    return await extractSevenZip(
      sevenZip,
      archivePath,
      format,
      destination,
      stripPrefix,
      state,
      into,
    );
  const tar = archivePath + "." + crypto.randomUUID() + ".inner.tar";
  await noLinks(tar);
  try {
    // Ignore any filename stored in gzip/xz: only write a fixed staging filename.
    await helperFile(
      sevenZip,
      [
        "x",
        "-t" + (format === "tar.gz" ? "gzip" : "xz"),
        "-so",
        "-y",
        "-bd",
        "-bb0",
        "--",
        resolve(archivePath),
      ],
      tar,
      totalLimit,
    );
    await extractSevenZip(
      sevenZip,
      tar,
      "tar",
      destination,
      stripPrefix,
      state,
      into,
    );
  } finally {
    await rm(tar, { force: true });
  }
}

async function extractNsisFiles(
  executable: string,
  archive: string,
  destination: string,
  state: ExtractionState,
  into: string | undefined,
  files: Record<string, string>,
) {
  if (!Object.keys(files).length) fail("NSIS file mapping is empty");
  const listing = new Map(
    (await listContainer(executable, archive, "nsis")).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const selected = Object.entries(files).map(([from, to]) => {
    relativeFile(from);
    const entry = listing.get(from);
    if (!entry || entry.directory)
      fail("Explicit NSIS file is missing or not a regular file");
    entryBudget(state, entry.size ?? 0);
    const path = into ? into + "/" + to : to;
    return { entry, target: targetPath(destination, path, false, state) };
  });
  // Only the exact declared regular files go through bounded stdout.
  // Validate every mapping before creating files; never execute NSIS code.
  for (const { entry, target } of selected) {
    await noLinks(target);
    await mkdir(dirname(target), { recursive: true });
    await containerFile(
      executable,
      archive,
      "nsis",
      entry,
      target,
      entry.size === undefined
        ? Math.min(state.fileLimit, state.limit - state.total)
        : state.fileLimit,
    );
    if (entry.size === undefined) {
      state.total += (await lstat(target)).size;
      if (!Number.isSafeInteger(state.total) || state.total > state.limit)
        fail("Archive expanded size limit exceeded");
    }
  }
}

async function extractNested(
  archive: string,
  format: Exclude<Download["format"], "file">,
  destination: string,
  state: ExtractionState,
  into: string | undefined,
  executable: string | undefined,
  steps: NonNullable<Download["nested"]>,
) {
  if (
    steps.length < 1 ||
    steps.length > 3 ||
    !["zip", "7z", "nsis", "pe"].includes(format)
  )
    fail("Unsupported nested extraction chain");
  await withScratch(archive, async (scratch) => {
    let current = archive,
      currentFormat = format,
      prefix: string | undefined;
    for (const [n, step] of steps.entries()) {
      relativeFile(step.path);
      if (step.stripPrefix) relativeFile(step.stripPrefix);
      if (!["7z", "zip"].includes(step.format))
        fail("Unsupported nested format");
      // Large selected container layers remain bounded to 2 GiB and the shared
      // expanded quota; final application files keep their original limit.
      const intermediate = {
        ...state,
        fileLimit: Math.min(totalLimit, state.limit),
        paths: new Map(),
      };
      if (currentFormat === "nsis" || currentFormat === "pe") {
        if (!executable)
          fail("Nested container extraction requires verified full 7-Zip");
        const container = currentFormat === "pe" ? "PE" : "nsis";
        const listing = await listContainer(executable, current, container),
          entry = listing.find((e) => e.path === step.path);
        if (!entry) fail("Explicit nested payload is missing");
        const target = join(scratch, "payload-" + n);
        await containerFile(
          executable,
          current,
          container,
          entry,
          target,
          Math.min(intermediate.fileLimit, state.limit - state.total),
        );
        entryBudget(intermediate, (await lstat(target)).size);
        current = target;
      } else {
        const output = join(scratch, "layer-" + n);
        await extractArchive(
          current,
          currentFormat,
          output,
          prefix,
          intermediate,
          undefined,
          executable,
        );
        const selected = inside(output, join(output, step.path));
        await noLinks(selected);
        const info = await lstat(selected);
        if (!info.isFile() || info.size > intermediate.fileLimit)
          fail("Nested payload is not a bounded regular file");
        current = selected;
      }
      state.count = intermediate.count;
      state.total = intermediate.total;
      currentFormat = step.format;
      prefix = step.stripPrefix;
    }
    await extractArchive(
      current,
      currentFormat,
      destination,
      prefix,
      state,
      into,
      executable,
    );
  });
}

async function extractMsi(
  archive: string,
  destination: string,
  stripPrefix: string | undefined,
  state: ExtractionState,
  into: string | undefined,
  sevenZip: string,
  lessMsi: string,
  files?: Record<string, string>,
  cabinets: Record<string, string> = {},
) {
  await noLinks(archive);
  const plan = await readMsiPlan(
      lessMsi,
      resolve(archive),
      !!files,
      Object.keys(cabinets),
    ),
    matched = new Set<string>();
  const selected = plan.files.flatMap((file) => {
    if (stripPrefix && !file.path.startsWith(stripPrefix + "/")) return [];
    const relative = stripPrefix
      ? file.path.slice(stripPrefix.length + 1)
      : file.path;
    const selection =
      files && Object.hasOwn(files, "#" + file.id) ? "#" + file.id : relative;
    if (files && !Object.hasOwn(files, selection)) return [];
    if (files) matched.add(selection);
    const path = (into ? into + "/" : "") + (files?.[selection] ?? relative);
    entryBudget(state, file.size);
    targetPath(destination, path, false, state);
    return [{ ...file, target: path }];
  });
  if (!selected.length || (files && matched.size !== Object.keys(files).length))
    fail("Explicit MSI payload selection is missing");
  const streams = await listContainer(sevenZip, archive, "Compound");
  await withScratch(archive, async (scratch) => {
    let cabinetBytes = 0;
    for (const [n, cabinet] of plan.cabinets.entries()) {
      const wanted = selected.filter((f) => f.cabinet === cabinet.name);
      if (!wanted.length) continue;
      const stream = streams.find((e) => e.path === cabinet.name);
      if (
        cabinet.embedded &&
        (!stream || stream.directory || stream.size === undefined)
      )
        fail("Embedded MSI cabinet stream missing");
      const external = !cabinet.embedded ? cabinets[cabinet.name] : undefined;
      if (!cabinet.embedded && !external)
        fail("Verified external MSI cabinet missing");
      if (external) await noLinks(external);
      cabinetBytes += external ? (await lstat(external)).size : stream!.size!;
      if (cabinetBytes > totalLimit || ++state.count > 100000)
        fail("MSI intermediate cabinet budget exceeded");
      const cab = external ?? join(scratch, "cabinet-" + n);
      if (!external)
        await containerFile(
          sevenZip,
          archive,
          "Compound",
          stream!,
          cab,
          totalLimit,
        );
      const entries = await listContainer(sevenZip, cab, "Cab"),
        declaredFiles = new Map(
          plan.files
            .filter((f) => f.cabinet === cabinet.name)
            .map((f) => [f.id, f]),
        ),
        wantedFiles = new Map(wanted.map((f) => [f.id, f]));
      for (const entry of entries) {
        if (entry.directory || entry.path.includes("/"))
          fail("Unsafe MSI cabinet identifier");
        const declared = declaredFiles.get(entry.path);
        if (!declared || entry.size !== declared.size)
          fail("MSI cabinet and File table disagree");
      }
      const ordered = entries.flatMap((entry) => {
        const file = wantedFiles.get(entry.path);
        return file ? [{ ...file, raw: entry.raw }] : [];
      });
      if (ordered.length !== wanted.length)
        fail("MSI file missing from its embedded cabinet");
      for (let offset = 0; offset < ordered.length; offset += 64) {
        const batch = ordered.slice(offset, offset + 64),
          outputs: { path: string; size: number }[] = [];
        for (const file of batch) {
          const target = inside(destination, join(destination, file.target));
          await noLinks(target);
          await mkdir(dirname(target), { recursive: true });
          outputs.push({ path: target, size: file.size });
        }
        await helperFiles(
          sevenZip,
          [
            "x",
            "-tCab",
            "-so",
            "-spd",
            "-y",
            "-bd",
            "-bb0",
            "-pPIKO_NO_PASSWORD",
            "--",
            resolve(cab),
            ...batch.map((f) => f.raw),
          ],
          outputs,
        );
      }
    }
  });
}
