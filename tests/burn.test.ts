import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  burnPayloads,
  extractBurnPayload,
  parseBurnManifest,
  peOverlayOffset,
} from "../src/burn.ts";
import { ensureInstallerTool } from "../src/installer-tools.ts";
import { seedInstallerTools } from "./helper-fixtures.ts";
import { emptyState } from "../src/store.ts";

const work = await mkdtemp(join(tmpdir(), "piko-burn-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);

// A minimal PE32+ image: the Burn reader only parses headers, so no code is
// needed to exercise overlay location, container scanning and digest checks.
function syntheticPe(): Buffer {
  const optional = 0x98,
    optionalSize = 0xf0,
    sectionTable = optional + optionalSize,
    image = Buffer.alloc(0x400);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "ascii");
  image.writeUInt16LE(0x8664, 0x84);
  image.writeUInt16LE(2, 0x86);
  image.writeUInt16LE(optionalSize, 0x94);
  image.writeUInt16LE(0x20b, optional);
  // .text at 0x200 for 0x100 bytes, .rsrc at 0x300 for 0x100 bytes.
  const section = (
    index: number,
    name: string,
    size: number,
    offset: number,
  ) => {
    const entry = sectionTable + index * 40;
    image.write(name, entry, "ascii");
    image.writeUInt32LE(size, entry + 16);
    image.writeUInt32LE(offset, entry + 20);
  };
  section(0, ".text", 0x100, 0x200);
  section(1, ".rsrc", 0x100, 0x300);
  return image;
}

async function makeCab(
  name: string,
  root: string,
  files: Record<string, Buffer>,
): Promise<Buffer> {
  const source = join(root, name + "-src");
  await mkdir(source);
  const lines = [
    `.Set CabinetNameTemplate=${name}.cab`,
    `.Set DiskDirectoryTemplate=${root.replaceAll("\\", "\\\\")}`,
    ".Set Cabinet=on",
    ".Set Compress=off",
  ];
  for (const [file, bytes] of Object.entries(files)) {
    await writeFile(join(source, file), bytes);
    lines.push(file);
  }
  const ddf = join(root, name + ".ddf");
  await writeFile(ddf, lines.join("\n") + "\n");
  execFileSync("makecab", ["/F", ddf], { cwd: source, stdio: "pipe" });
  return await readFile(join(root, name + ".cab"));
}

const sha512 = (bytes: Buffer) =>
  createHash("sha512").update(bytes).digest("hex");

async function bundle(
  root: string,
  members = { a0: Buffer.from("MSI-A"), a1: Buffer.from("MSI-B") },
  payloadHash?: string,
) {
  const uxFiles: Record<string, Buffer> = {};
  const attached = await makeCab("attached", root, members);
  const manifest =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<BurnManifest EngineVersion="5.0.2.0" ProtocolVersion="1" Win64="yes">' +
    `<Container Id="WixAttachedContainer" FileSize="${attached.length}" Hash="${sha512(attached)}" Attached="yes" />` +
    Object.entries(members)
      .map(
        ([member, bytes], index) =>
          `<Payload Id="Package${index}" FilePath="package-${index}.msi" SourcePath="${member}" FileSize="${bytes.length}" Hash="${payloadHash ?? sha512(bytes)}" Container="WixAttachedContainer" />`,
      )
      .join("") +
    '<Payload Id="Theme" FilePath="thm.xml" SourcePath="u0" />' +
    "</BurnManifest>";
  uxFiles["0"] = Buffer.from(manifest);
  uxFiles["u0"] = Buffer.from("<Theme />");
  const ux = await makeCab("ux", root, uxFiles);
  const image = syntheticPe();
  const path = join(root, "bundle.exe");
  await writeFile(path, Buffer.concat([image, ux, attached]));
  return { path, image, ux, attached };
}

test("Burn overlay starts after the last section raw data", () => {
  const image = syntheticPe();
  expect(peOverlayOffset(image, image.length)).toBe(0x400);
  expect(() => peOverlayOffset(Buffer.from("not a pe"), 9)).toThrow();
});

test("Burn manifest parsing keeps only attached-container payloads", () => {
  const parsed = parseBurnManifest(
    '<BurnManifest Win64="yes"><Container Id="C" FileSize="8" Hash="' +
      "a".repeat(128) +
      '" /><Payload Id="P" FilePath="p.msi" SourcePath="a1" FileSize="4" Hash="' +
      "b".repeat(128) +
      '" Container="C" /><Payload Id="Theme" FilePath="t.xml" SourcePath="u0" /></BurnManifest>',
  );
  expect(parsed.chain).toHaveLength(1);
  expect(parsed.chain[0]).toMatchObject({ id: "P", member: "a1" });
});

test("Burn manifests reject unsigned shapes, undeclared containers and non-container members", () => {
  const container = `<Container Id="C" FileSize="8" Hash="${"a".repeat(128)}" />`;
  const payload = (attrs: string) =>
    `<BurnManifest Win64="yes">${container}<Payload Id="P" FilePath="p.msi" ${attrs} /></BurnManifest>`;
  expect(() => parseBurnManifest('<BurnManifest EngineVersion="5" />')).toThrow(
    "64-bit",
  );
  expect(() =>
    parseBurnManifest(
      payload(
        `SourcePath="a0" FileSize="4" Hash="${"b".repeat(128)}" Container="Other"`,
      ),
    ),
  ).toThrow("undeclared container");
  expect(() =>
    parseBurnManifest(
      payload(
        `SourcePath="../a0" FileSize="4" Hash="${"b".repeat(128)}" Container="C"`,
      ),
    ),
  ).toThrow("Unsafe relative path");
  expect(() =>
    parseBurnManifest(payload(`SourcePath="a0" FileSize="4" Container="C"`)),
  ).toThrow("digest is missing");
});

test("Burn extraction validates the declared container digest and payload identity", async () => {
  const helperRoot = join(work, "helpers");
  await mkdir(helperRoot);
  await seedInstallerTools(helperRoot);
  const sevenZip = await ensureInstallerTool(
    helperRoot,
    emptyState(),
    "full7zip",
  );
  const root = join(work, "case");
  await mkdir(root);
  const built = await bundle(root);

  const payloads = await burnPayloads(sevenZip, built.path);
  expect(payloads.map((p) => p.id)).toEqual(["Package0", "Package1"]);
  expect(payloads.map((p) => p.member)).toEqual(["a0", "a1"]);

  const target = join(root, "payload.bin");
  const extracted = await extractBurnPayload(
    sevenZip,
    built.path,
    "Package1",
    target,
    Number.MAX_SAFE_INTEGER,
  );
  expect(extracted.filePath).toBe("package-1.msi");
  expect((await readFile(target)).toString()).toBe("MSI-B");

  await expect(
    extractBurnPayload(
      sevenZip,
      built.path,
      "Missing",
      join(root, "x.bin"),
      1024,
    ),
  ).rejects.toThrow("no chained payload");
  await expect(
    extractBurnPayload(
      sevenZip,
      built.path,
      "Package1",
      join(root, "y.bin"),
      3,
    ),
  ).rejects.toThrow("expanded size limit");

  // A payload digest that disagrees with the bytes must fail closed.
  const forgedRoot = join(work, "forged");
  await mkdir(forgedRoot);
  const forged = await bundle(forgedRoot, undefined, "c".repeat(128));
  await expect(
    extractBurnPayload(
      sevenZip,
      forged.path,
      "Package1",
      join(forgedRoot, "z.bin"),
      1 << 20,
    ),
  ).rejects.toThrow("declared digest");
}, 60000);

test("Burn extraction refuses a bundle whose attached container digest is not declared", async () => {
  const helperRoot = join(work, "helpers2");
  await mkdir(helperRoot);
  await seedInstallerTools(helperRoot);
  const sevenZip = await ensureInstallerTool(
    helperRoot,
    emptyState(),
    "full7zip",
  );
  const root = join(work, "case2");
  await mkdir(root);
  const built = await bundle(root);
  // Replace the attached cabinet bytes while keeping the manifest intact.
  const tampered = Buffer.from(await readFile(built.path));
  const start = built.image.length + built.ux.length;
  tampered.write("XXXX", start + 4, "ascii");
  const path = join(root, "tampered.exe");
  await writeFile(path, tampered);
  await expect(burnPayloads(sevenZip, path)).rejects.toThrow(
    "attached container declared by the manifest is missing",
  );
}, 60000);
