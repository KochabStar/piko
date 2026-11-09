import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { containerFile, listContainer } from "./containers.ts";
import { fail, noLinks, relativeFile } from "./util.ts";

// WiX Burn bundles are single-file EXEs whose payload lives in cabinets
// appended after the PE image: the UX container (BurnManifest.xml, theme,
// licence) followed by the attached container that holds the chained packages
// as members a0, a1, ... Neither the `.wixburn` section (its layout differs
// between Burn versions) nor cabinet chaining (Burn pads between containers)
// can locate them reliably, so containers are found by the MSCF signature and
// then proven against the size and SHA-512 digest the manifest records.
//
// Nothing here executes a bootstrapper, MSI or payload.

export type BurnPayload = {
  id: string;
  // Name recorded in the manifest, e.g. CloudDrive-x64.msi.
  filePath: string;
  // Member inside the attached container, e.g. a1.
  member: string;
  size: number;
  sha512: string;
};

type Cabinet = { offset: number; size: number };
type Container = { size: number; sha512: string };

const signature = Buffer.from("MSCF", "ascii");
const chunk = 4 * 1024 * 1024;
const manifestLimit = 4 * 1024 * 1024;

function attribute(xml: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, "i").exec(xml)?.[1];
}

// The appended payload starts after the last section's raw data.
export function peOverlayOffset(image: Buffer, fileSize: number): number {
  if (image.length < 0x40 || image.toString("ascii", 0, 2) !== "MZ")
    fail("Burn bundle is not a PE executable");
  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 > image.length) fail("Burn PE header is truncated");
  if (image.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0")
    fail("Burn PE signature is missing");
  if (image.readUInt16LE(peOffset + 4) !== 0x8664)
    fail("Burn bundle is not an x64 image");
  const sections = image.readUInt16LE(peOffset + 6),
    optionalSize = image.readUInt16LE(peOffset + 20),
    optional = peOffset + 24;
  if (image.readUInt16LE(optional) !== 0x20b)
    fail("Burn bundle is not a PE32+ image");
  if (optional + optionalSize > image.length)
    fail("Burn optional header is truncated");
  const sectionTable = optional + optionalSize;
  if (sections > 96 || sectionTable + sections * 40 > image.length)
    fail("Burn PE section table is invalid");
  let end = sectionTable + sections * 40;
  for (let n = 0; n < sections; n++) {
    const entry = sectionTable + n * 40,
      rawSize = image.readUInt32LE(entry + 16),
      rawOffset = image.readUInt32LE(entry + 20);
    if (!rawSize) continue;
    if (rawOffset + rawSize > fileSize)
      fail("Burn PE section escapes the image");
    end = Math.max(end, rawOffset + rawSize);
  }
  return end;
}

// Find every MSCF container at or after `start`. Candidates are only addresses;
// a container becomes trusted after its digest matches the manifest.
async function scanCabinets(
  archive: string,
  start: number,
  fileSize: number,
): Promise<Cabinet[]> {
  const handle = await open(archive, "r"),
    buffer = Buffer.alloc(Math.min(chunk, Math.max(fileSize - start, 1))),
    found: Cabinet[] = [];
  try {
    let position = start;
    while (position + 36 <= fileSize) {
      const length = Math.min(buffer.length, fileSize - position),
        { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      const window = buffer.subarray(0, bytesRead);
      for (let index = window.indexOf(signature); index >= 0; ) {
        const offset = position + index,
          size = index + 36 <= bytesRead ? window.readUInt32LE(index + 8) : 0;
        // A real cabinet declares its own bounded size; compressed payload
        // bytes rarely form both a signature and a consistent header.
        if (size >= 36 && offset + size <= fileSize) {
          found.push({ offset, size });
          if (found.length > 4096) fail("Burn candidate scan exceeded");
        }
        index = window.indexOf(signature, index + 4);
      }
      position += bytesRead - Math.min(3, bytesRead);
    }
  } finally {
    await handle.close();
  }
  if (!found.length) fail("Burn bundle contains no appended container");
  return found;
}

export function parseBurnManifest(xml: string): {
  chain: BurnPayload[];
  containers: Container[];
} {
  if (!/<BurnManifest\b[^>]*\bWin64="yes"/i.test(xml))
    fail("Unsupported Burn manifest: expected a 64-bit bundle");
  const containers: Container[] = [],
    named = new Set<string>();
  for (const match of xml.matchAll(/<Container\b([^>]*)\/?>/gi)) {
    const body = match[1]!,
      id = attribute(body, "Id");
    if (!id) continue;
    const size = Number(attribute(body, "FileSize") ?? ""),
      sha512 = attribute(body, "Hash") ?? "";
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !/^[0-9a-f]{128}$/i.test(sha512)
    )
      fail("Burn container size or digest is missing");
    named.add(id);
    containers.push({ size, sha512 });
  }
  const chain: BurnPayload[] = [],
    seen = new Set<string>();
  for (const match of xml.matchAll(/<Payload\b([^>]*)\/?>/gi)) {
    const body = match[1]!,
      id = attribute(body, "Id"),
      sourcePath = attribute(body, "SourcePath"),
      filePath = attribute(body, "FilePath"),
      container = attribute(body, "Container");
    // Payloads outside the attached container are UX assets (theme, licence),
    // never package payloads, so only container-backed entries join the chain.
    if (!id || !sourcePath || !filePath || !container) continue;
    if (!named.has(container))
      fail("Burn payload references an undeclared container");
    relativeFile(sourcePath);
    if (seen.has(id.toLowerCase())) fail("Duplicate Burn payload identity");
    seen.add(id.toLowerCase());
    const size = Number(attribute(body, "FileSize") ?? ""),
      sha512 = attribute(body, "Hash") ?? "";
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !/^[0-9a-f]{128}$/i.test(sha512)
    )
      fail("Burn payload size or digest is missing");
    // Only the documented a0, a1, ... naming may reach the attached container.
    if (!/^a\d+$/.test(sourcePath))
      fail("Burn attached payload member is unexpected: " + sourcePath);
    chain.push({ id, filePath, member: sourcePath, size, sha512 });
  }
  if (!chain.length) fail("Burn bundle declares no chained payload");
  chain.sort((a, b) => Number(a.member.slice(1)) - Number(b.member.slice(1)));
  return { chain, containers };
}

async function extractRange(
  archive: string,
  cabinet: Cabinet,
  target: string,
): Promise<void> {
  await noLinks(target);
  const handle = await open(archive, "r"),
    output = createWriteStream(target, { flags: "wx" });
  try {
    await pipeline(
      handle.createReadStream({
        start: cabinet.offset,
        end: cabinet.offset + cabinet.size - 1,
        autoClose: false,
      }),
      output,
    );
  } finally {
    await handle.close();
  }
  if ((await stat(target)).size !== cabinet.size)
    fail("Burn cabinet size changed during extraction");
}

async function sha512File(file: string): Promise<string> {
  const handle = await open(file, "r"),
    digest = createHash("sha512"),
    buffer = Buffer.alloc(chunk);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function readManifest(
  sevenZip: string,
  ux: string,
  scratch: string,
): Promise<string> {
  const members = await listContainer(sevenZip, ux, "Cab");
  let index = 0;
  for (const entry of members) {
    if (entry.directory || !entry.size || entry.size > manifestLimit) continue;
    const target = join(scratch, "manifest-" + index++);
    await containerFile(sevenZip, ux, "Cab", entry, target, manifestLimit);
    const handle = await open(target, "r");
    try {
      const bytes = Buffer.alloc(entry.size);
      await handle.read(bytes, 0, bytes.length, 0);
      if (bytes.includes("<BurnManifest")) return bytes.toString("utf8");
    } finally {
      await handle.close();
      await rm(target, { force: true });
    }
  }
  return fail("Burn UX container has no BurnManifest.xml");
}

type Layout = {
  chain: BurnPayload[];
  // Extracted attached container inside the caller's scratch directory.
  attached: string;
};

// The UX container is the first cabinet in the appended payload; the attached
// container is whichever later candidate matches a declared digest.
async function readLayout(
  sevenZip: string,
  archive: string,
  scratch: string,
): Promise<Layout> {
  await noLinks(archive);
  const { size: fileSize } = await stat(archive),
    handle = await open(archive, "r");
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(fileSize, 64 * 1024));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead !== head.length) fail("Burn bundle is truncated");
  } finally {
    await handle.close();
  }
  const candidates = await scanCabinets(
      archive,
      peOverlayOffset(head, fileSize),
      fileSize,
    ),
    ux = join(scratch, "ux.cab");
  await extractRange(archive, candidates[0]!, ux);
  const { chain, containers } = parseBurnManifest(
    await readManifest(sevenZip, ux, scratch),
  );
  for (const candidate of candidates.slice(1)) {
    if (!containers.some((c) => c.size === candidate.size)) continue;
    const attached = join(scratch, "attached.cab");
    await extractRange(archive, candidate, attached);
    const digest = await sha512File(attached);
    if (
      containers.some(
        (c) => c.size === candidate.size && c.sha512.toLowerCase() === digest,
      )
    )
      return { chain, attached };
    await rm(attached, { force: true });
  }
  return fail("Burn attached container declared by the manifest is missing");
}

export async function burnPayloads(
  sevenZip: string,
  archive: string,
): Promise<BurnPayload[]> {
  const scratch = await mkdtemp(join(dirname(resolve(archive)), "burn-"));
  try {
    const layout = await readLayout(sevenZip, archive, scratch),
      members = await listContainer(sevenZip, layout.attached, "Cab");
    return layout.chain.map((payload) => {
      const member = members.find((m) => m.path === payload.member);
      if (!member || member.directory)
        fail(`Burn attached container is missing ${payload.member}`);
      if (member.size !== payload.size)
        fail("Burn attached container size disagrees with its manifest");
      return payload;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function extractBurnPayload(
  sevenZip: string,
  archive: string,
  payloadId: string,
  target: string,
  limit: number,
): Promise<BurnPayload> {
  const scratch = await mkdtemp(join(dirname(resolve(archive)), "burn-"));
  try {
    const layout = await readLayout(sevenZip, archive, scratch),
      payload = layout.chain.find((p) => p.id === payloadId);
    if (!payload)
      fail(
        `Burn bundle has no chained payload "${payloadId}" (available: ${layout.chain
          .map((p) => p.id)
          .join(", ")})`,
      );
    if (payload.size > limit)
      fail("Burn payload exceeds the expanded size limit");
    const members = await listContainer(sevenZip, layout.attached, "Cab"),
      member = members.find((m) => m.path === payload.member);
    if (!member || member.directory)
      fail(`Burn attached container is missing ${payload.member}`);
    if (member.size !== payload.size)
      fail("Burn attached container size disagrees with its manifest");
    await noLinks(target);
    await containerFile(sevenZip, layout.attached, "Cab", member, target, limit);
    if ((await sha512File(target)) !== payload.sha512.toLowerCase())
      fail("Burn attached payload does not match its declared digest");
    return payload;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
