import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { VERSION } from "../src/version.ts";
import { capture } from "../src/util.ts";
import { executableHash } from "../src/self-update.ts";
import { checkSource } from "./check-source.ts";
const file = resolve("dist", `piko-${VERSION}-windows-x64.zip`),
  root = await mkdtemp(join(tmpdir(), "piko-release-check-"));
try {
  const expected = (await readFile(file + ".sha256", "utf8")).split(/\s+/)[0];
  if ((await executableHash(file)) !== expected)
    throw new Error("Archive checksum mismatch");
  await capture(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';Expand-Archive -LiteralPath $env:PIKO_RELEASE_FILE -DestinationPath $env:PIKO_RELEASE_TEMP",
    ],
    {
      env: { ...process.env, PIKO_RELEASE_FILE: file, PIKO_RELEASE_TEMP: root },
    },
  );
  const folder = join(root, basename(file, ".zip")),
    metadata = JSON.parse(await readFile(join(folder, "release.json"), "utf8")),
    exe = join(folder, "piko.exe");
  if (
    metadata.version !== VERSION ||
    metadata.signed !== false ||
    (await executableHash(exe)) !== metadata.sha256
  )
    throw new Error("Release identity mismatch");
  await checkSource(join(folder, "source"));
  const home = join(root, "installation");
  await capture(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(folder, "install.ps1"),
      "-Sha256",
      metadata.sha256,
      "-PikoHome",
      home,
    ],
    { cwd: root },
  );
  if (
    (await capture(join(home, "shims", "piko.exe"), ["--version"], {
      cwd: root,
      env: { ...process.env, PIKO_HOME: home },
    })) !== VERSION
  )
    throw new Error("Installed release did not report expected version");
  console.log(
    JSON.stringify(
      {
        archive: file,
        sha256: expected,
        version: VERSION,
        catalog: "validated",
        isolatedInstall: "passed",
        userPathModified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
