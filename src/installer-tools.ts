import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { artifactBytes } from "./cache.ts";
import { extractZip } from "./artifacts.ts";
import { ensureSevenZip } from "./helpers.ts";
import { helperOutput } from "./helpers-process.ts";
import { exists, fail, noLinks, removeTree, sha256 } from "./util.ts";
import type { State } from "./types.ts";

export const lessMsiRelease = {
  version: "2.12.9",
  url: "https://github.com/activescott/lessmsi/releases/download/v2.12.9/lessmsi-v2.12.9.zip",
  sha256: "5b4e187e74b184ad3a63ccf06c3d17dae2b8c4b6c298a996dbd51a9f6db29d21",
  files: {
    "lessmsi.exe":
      "256eee4ae43768088749bb0d47f80ecad31bed1b221e3520f58de46a83233753",
    "lessmsi.exe.config":
      "41719f373e4be04ba5c9c8b5a04809ba1a475066a4e86db9f7aa2b0b5a2e0fff",
    "lessmsi.core.dll":
      "2ceae95e4b3e7e6d59c745c7fb91604c41cdc229517a4cc88b8c307f745d140d",
    "LessIO.dll":
      "2a57766723c57547d185d570686216d55c114613c82305bad8099e635ab8395c",
    "wix.dll":
      "30ca53d36550746974d1bfed78192407f65937603164b0dfb39352f8a31f8333",
    "mspack.dll":
      "62e8f4154202cc9db867bb24097c8d669d58a0ee56be475f3eaf5ab1468207e0",
    "libmspackn.dll":
      "15a52767a8d8202b9516054375cfd9060e471611c278e65ad4bafcd0ee700a1c",
    "wixcab.dll":
      "6bedfb95db4e38e7461dbfcebc25f7d5fe2498877564bba5495cf5b419676e42",
  },
};
export const fullSevenZipRelease = {
  version: "26.05",
  url: "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.exe",
  sha256: "fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0",
  files: {
    "7z.exe":
      "94205cfc054dd3bbeb978905bc619a65b3f04e9e73bb2717841110b6f46d962e",
    "7z.dll":
      "78bf6b668d75801e3aa180b4ccb16e6d8395fba80dec8a065055bb6f8dfabb82",
    "License.txt":
      "519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d",
  },
};
async function verify(directory: string, files: Record<string, string>) {
  await noLinks(directory);
  const names = await readdir(directory);
  if (
    names.length !== Object.keys(files).length ||
    names.some((n) => !Object.hasOwn(files, n))
  )
    fail("Unexpected private unpacker helper content");
  for (const [name, hash] of Object.entries(files)) {
    const path = join(directory, name);
    await noLinks(path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      sha256(await readFile(path)) !== hash
    )
      fail(
        "Private unpacker helper checksum/type mismatch; inspect before retrying",
      );
  }
}
export async function ensureInstallerTool(
  root: string,
  state: State,
  kind: "lessmsi" | "full7zip",
): Promise<string> {
  const release = kind === "lessmsi" ? lessMsiRelease : fullSevenZipRelease,
    directory = join(root, "apps/piko/helpers", kind, release.version),
    executable = join(directory, kind === "lessmsi" ? "lessmsi.exe" : "7z.exe");
  await noLinks(directory);
  if (await exists(directory)) {
    await verify(directory, release.files);
    return executable;
  }
  console.error(
    `Preparing verified private ${kind} ${release.version} (no installer execution or default changes)`,
  );
  const staging = join(root, "staging");
  await noLinks(staging);
  await mkdir(staging, { recursive: true });
  const stage = await mkdtemp(join(staging, kind + "-"));
  try {
    const bytes = await artifactBytes(
        root,
        release.url,
        release.sha256,
        false,
        state,
      ),
      archive = join(stage, "archive"),
      payload = join(stage, "payload");
    await writeFile(archive, bytes, { flag: "wx" });
    await mkdir(payload);
    if (kind === "lessmsi") {
      const unpacked = join(stage, "unpacked");
      await extractZip(archive, unpacked);
      for (const name of Object.keys(release.files))
        await writeFile(
          join(payload, name),
          await readFile(join(unpacked, name)),
          { flag: "wx" },
        );
    } else {
      const sevenZip = await ensureSevenZip(root, state);
      for (const name of Object.keys(release.files))
        await writeFile(
          join(payload, name),
          await helperOutput(
            sevenZip,
            [
              "x",
              "-t7z",
              "-so",
              "-spd",
              "-y",
              "-bd",
              "-bb0",
              "--",
              archive,
              name,
            ],
            8 * 1024 * 1024,
          ),
          { flag: "wx" },
        );
    }
    await verify(payload, release.files);
    await mkdir(join(directory, ".."), { recursive: true });
    await rename(payload, directory);
    return executable;
  } finally {
    await removeTree(stage);
  }
}
