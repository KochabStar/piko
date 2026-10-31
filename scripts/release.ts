import { cp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { checkSource } from "./check-source.ts";
import { VERSION } from "../src/version.ts";
import { executableHash } from "../src/self-update.ts";
import { capture, exists } from "../src/util.ts";
const folder = resolve("dist", `piko-${VERSION}-windows-x64`);
if (await exists(folder))
  throw new Error(
    "Release folder already exists; preserve it or explicitly choose a new version",
  );
await checkSource("examples/source");
await mkdir(folder, { recursive: true });
await cp("dist/piko.exe", join(folder, "piko.exe"));
await cp("scripts/install.ps1", join(folder, "install.ps1"));
await cp("examples/source", join(folder, "source"), { recursive: true });
await cp("README.md", join(folder, "README.md"));
const hash = await executableHash(join(folder, "piko.exe"));
await writeFile(join(folder, "SHA256SUMS.txt"), `${hash}  piko.exe\n`);
await writeFile("dist/piko.exe.sha256", `${hash}  piko.exe\n`);
await writeFile(
  join(folder, "release.json"),
  JSON.stringify(
    {
      version: VERSION,
      platform: "windows-x64",
      sha256: hash,
      signed: false,
      bun: Bun.version,
      stateSchemas: [1, 2, 3, 4, 5, 6, 7, 8],
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(folder, "INSTALL.txt"),
  `Unsigned preview. Verify checksum against a trusted separate channel before running.\nPowerShell:\n.\\install.ps1 -Sha256 ${hash} -Path\n\nThe bundled source/ directory can be hosted as an HTTPS static Piko source. It is a fixed catalog, not a claim of continuous upstream tracking.\n`,
);
const zip = folder + ".zip";
await capture(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference='Stop';Compress-Archive -LiteralPath $env:PIKO_RELEASE_FOLDER -DestinationPath $env:PIKO_RELEASE_ZIP",
  ],
  {
    env: { ...process.env, PIKO_RELEASE_FOLDER: folder, PIKO_RELEASE_ZIP: zip },
  },
);
const zipHash = await executableHash(zip);
await writeFile(zip + ".sha256", `${zipHash}  ${zip.split(/[\\/]/).at(-1)}\n`);
console.log(
  JSON.stringify(
    { folder, zip, sha256: zipHash, executableSha256: hash, signed: false },
    null,
    2,
  ),
);
