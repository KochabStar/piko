import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractZip } from "./artifacts.ts";
import { artifactBytes } from "./cache.ts";
import { report } from "./progress.ts";
import { helperOutput, installedHelper } from "./helpers-process.ts";
import { exists, fail, noLinks, removeTree, sha256 } from "./util.ts";
import type { State } from "./types.ts";

// Official release asset digests verified against ip7z/7zip release metadata.
export const sevenZipRelease = {
  version: "26.05",
  bootstrap: {
    url: "https://github.com/ip7z/7zip/releases/download/26.05/7zr.exe",
    sha256: "9bf582b894dfa665f852d7e9112b02290a1c303c2d95a21fcdc41ffcb03143b7",
  },
  archive: {
    url: "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-extra.7z",
    sha256: "f27a8f103c84785026edcba1f67faf1357225df9d19ddb0b7760d55947141bc7",
  },
  executableSha256:
    "7ddf0a3bc451e166679296be630d6f0573eb386159c04184761c43020c484291",
};

export const innoRelease = {
  version: "2.71.2",
  url: "https://raw.githubusercontent.com/jrathlev/InnoUnpacker-Windows-GUI/032d64c782efc6b36766d8f9c3b1b2f042144a58/innounp-2/bin/innounp-2.zip",
  sha256: "10fce27b6344b7674d5625cc34afca1c88c12183d957c6d93e401097fa2556cd",
  executableSha256:
    "aecc0d7b1a2669711cd86d50061bb68911faa832ca3c69d4b1d2deb735cb1fcd",
};

export async function ensureInnoUnpacker(
  root: string,
  state: State,
): Promise<string> {
  const installed = await installedHelper(root, state, "innounp", "innounp");
  if (installed) return installed;
  const directory = join(
      root,
      "apps/piko/helpers/innounp",
      innoRelease.version,
    ),
    executable = join(directory, "innounp.exe");
  await noLinks(directory);
  if (await exists(directory)) {
    await noLinks(executable);
    if (sha256(await readFile(executable)) !== innoRelease.executableSha256)
      fail("Inno unpacker helper checksum mismatch; inspect before retrying");
    return executable;
  }
  report({
    kind: "stage",
    label: "Prepare verified Inno unpacker",
    detail: innoRelease.version,
  });
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const stage = await mkdtemp(join(staging, "innounp-"));
  try {
    const bytes = await artifactBytes(
        root,
        innoRelease.url,
        innoRelease.sha256,
        false,
        state,
      ),
      archive = join(stage, "innounp.zip"),
      payload = join(stage, "payload");
    await writeFile(archive, bytes, { flag: "wx" });
    await extractZip(archive, payload);
    if (
      sha256(await readFile(join(payload, "innounp.exe"))) !==
      innoRelease.executableSha256
    )
      fail("Inno unpacker executable checksum mismatch");
    await writeFile(
      join(payload, "receipt.json"),
      JSON.stringify(innoRelease, null, 2),
      { flag: "wx" },
    );
    await mkdir(join(directory, ".."), { recursive: true });
    await rename(payload, directory);
    return executable;
  } finally {
    await removeTree(stage);
  }
}

// Private helper: does not change user defaults, own commands, or use a source-supplied bootstrap.
// Caller holds the Piko mutation lock. Publish only the fully checked helper directory.
export async function ensureSevenZip(
  root: string,
  state: State,
): Promise<string> {
  const installed = await installedHelper(root, state, "7zip", "7z");
  if (installed) return installed;
  const directory = join(
      root,
      "apps/piko/helpers/7zip",
      sevenZipRelease.version,
    ),
    executable = join(directory, "7za.exe");
  await noLinks(directory);
  if (await exists(directory)) {
    await noLinks(executable);
    if (sha256(await readFile(executable)) !== sevenZipRelease.executableSha256)
      fail(
        "7-Zip helper checksum mismatch; inspect the helper directory before retrying",
      );
    return executable;
  }
  report({
    kind: "stage",
    label: "Prepare verified 7-Zip",
    detail: sevenZipRelease.version,
  });
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const stage = await mkdtemp(join(staging, "7zip-"));
  try {
    const bootstrap = await artifactBytes(
        root,
        sevenZipRelease.bootstrap.url,
        sevenZipRelease.bootstrap.sha256,
        false,
        state,
      ),
      archive = await artifactBytes(
        root,
        sevenZipRelease.archive.url,
        sevenZipRelease.archive.sha256,
        false,
        state,
      ),
      bootstrapPath = join(stage, "7zr.exe"),
      archivePath = join(stage, "extra.7z");
    await writeFile(bootstrapPath, bootstrap, { flag: "wx" });
    await writeFile(archivePath, archive, { flag: "wx" });
    const args = [
      "x",
      "-so",
      "-spd",
      "-y",
      "-bd",
      "-bb0",
      "-pPIKO_NO_PASSWORD",
      "--",
      archivePath,
    ];
    const bytes = await helperOutput(
      bootstrapPath,
      [...args, "x64/7za.exe"],
      8 * 1024 * 1024,
    );
    if (sha256(bytes) !== sevenZipRelease.executableSha256)
      fail("7-Zip executable checksum mismatch");
    const payload = join(stage, "payload");
    await mkdir(payload);
    await writeFile(join(payload, "7za.exe"), bytes, { flag: "wx" });
    for (const file of ["License.txt", "readme.txt"])
      await writeFile(
        join(payload, file),
        await helperOutput(bootstrapPath, [...args, file], 1024 * 1024),
        { flag: "wx" },
      );
    await writeFile(
      join(payload, "receipt.json"),
      JSON.stringify(sevenZipRelease, null, 2),
    );
    await mkdir(join(directory, ".."), { recursive: true });
    await rename(payload, directory);
    return executable;
  } finally {
    await removeTree(stage);
  }
}
