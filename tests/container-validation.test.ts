import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerFile, listContainer } from "../src/containers.ts";
import { ensureInstallerTool } from "../src/installer-tools.ts";
import { seedInstallerTools } from "./helper-fixtures.ts";
import { emptyState } from "../src/store.ts";
import { extractArchive, extractionState } from "../src/artifacts.ts";
import { exists } from "../src/util.ts";

const root = await mkdtemp(join(tmpdir(), "piko-container-metadata-"));
afterAll(() =>
  rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
test("container metadata rejects unsafe paths, aliasing, streams, links and ambiguous size fields", async () => {
  const source = join(root, "fake.ts"),
    fake = join(root, "fake.exe");
  await writeFile(
    source,
    'import {readFileSync} from "node:fs";import{join,dirname}from"node:path";process.stdout.write(readFileSync(join(dirname(process.execPath),process.argv.includes("l")?"listing.txt":"payload.txt")));',
  );
  expect(
    (
      await Bun.build({
        entrypoints: [source],
        compile: { target: "bun-windows-x64", outfile: fake },
      })
    ).success,
  ).toBe(true);
  const block = (path: string, extra = "", size = "1") =>
    `Path = ${path}\nSize = ${size}\n${extra}\n`;
  for (const listing of [
    block("../escape"),
    block("C:/absolute"),
    block("file:stream"),
    block("x", "Symbolic Link = target\n"),
    block("x", "Attributes = L\n"),
    block("x", "Encrypted = +\n"),
    block("x", "Alternate Stream = hidden\n"),
    block("x") + block("X"),
    block("x", "Size = 2\n"),
    block("x", "", "-1"),
    block("x", "", "9007199254740992"),
    "Path = x\ninjected line\nSize = 1\n",
  ]) {
    await writeFile(join(root, "listing.txt"), listing);
    await expect(listContainer(fake, "unused", "Cab")).rejects.toThrow();
  }
  await writeFile(
    join(root, "listing.txt"),
    "Path = plugin.dll\nSize = \nAttributes = \n\nPath = payload.7z\nSize = 4\nAttributes = \n",
  );
  expect((await listContainer(fake, "unused", "nsis")).at(-1)?.size).toBe(4);
  await expect(listContainer(fake, "unused", "Compound")).rejects.toThrow(
    "Missing",
  );
  await writeFile(join(root, "payload.txt"), "data");
  const unsized = { raw: "payload", path: "payload", directory: false };
  await containerFile(
    fake,
    "unused",
    "nsis",
    unsized,
    join(root, "unsized.bin"),
    4,
  );
  expect(await readFile(join(root, "unsized.bin"), "utf8")).toBe("data");
  await expect(
    containerFile(
      fake,
      "unused",
      "nsis",
      unsized,
      join(root, "too-large.bin"),
      3,
    ),
  ).rejects.toThrow("size limit");
  await expect(
    containerFile(fake, "unused", "Cab", unsized, join(root, "no-size.bin"), 4),
  ).rejects.toThrow("bounded");
  await writeFile(
    join(root, "listing.txt"),
    "Path = unknown.bin\nSize = \nAttributes = \n\nPath = known.bin\nSize = 4\nAttributes = \n",
  );
  const archive = join(root, "fixture.bin");
  await writeFile(archive, "fixture");
  const files = { "unknown.bin": "first.bin", "known.bin": "second.bin" };
  const state = extractionState(8),
    mapped = join(root, "mapped");
  await extractArchive(
    archive,
    "nsis",
    mapped,
    undefined,
    state,
    undefined,
    fake,
    undefined,
    { files },
  );
  expect(await readFile(join(mapped, "first.bin"), "utf8")).toBe("data");
  expect(await readFile(join(mapped, "second.bin"), "utf8")).toBe("data");
  expect(state.total).toBe(8);
  expect(state.count).toBe(2);
  const tooSmall = join(root, "mapped-too-small");
  await expect(
    extractArchive(
      archive,
      "nsis",
      tooSmall,
      undefined,
      extractionState(7),
      undefined,
      fake,
      undefined,
      { files },
    ),
  ).rejects.toThrow("size limit");
  expect(await exists(join(tooSmall, "second.bin"))).toBe(false);
  await expect(
    extractArchive(
      archive,
      "nsis",
      join(root, "mapped-collision"),
      undefined,
      undefined,
      undefined,
      fake,
      undefined,
      { files: { "unknown.bin": "Same.bin", "known.bin": "same.bin" } },
    ),
  ).rejects.toThrow("case-colliding");
}, 30000);

test("lessmsi metadata helper pins config and all application assemblies, not only the launcher", async () => {
  const helperRoot = join(root, "lessmsi");
  await mkdir(helperRoot);
  await seedInstallerTools(helperRoot);
  const exe = await ensureInstallerTool(helperRoot, emptyState(), "lessmsi");
  expect((await readFile(exe)).length).toBeGreaterThan(0);
  await writeFile(join(exe, "..", "wix.dll"), "tampered assembly");
  await expect(
    ensureInstallerTool(helperRoot, emptyState(), "lessmsi"),
  ).rejects.toThrow("checksum");
});
