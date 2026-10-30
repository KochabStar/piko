import { persistentFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureInnoUnpacker, innoRelease } from "../src/helpers.ts";
import { helperOutput } from "../src/helpers-process.ts";
import { extractArchive } from "../src/artifacts.ts";
import { normalizeManifest } from "../src/catalog.ts";
import { emptyState } from "../src/store.ts";
import { Packages } from "../src/packages.ts";
import { capture, exists, sha256 } from "../src/util.ts";
import { seedInno, fixtureAsset } from "./helper-fixtures.ts";
import type { Manifest } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-inno-tests-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
);
const helperRoot = join(work, "helpers");
await seedInno(helperRoot);
const inno = await ensureInnoUnpacker(helperRoot, emptyState());
const official = await fixtureAsset({
  url: "https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe",
  sha256: "0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f",
});
// This is a pinned, verified test-only compiler payload, not an executed installer.
const compiler = join(work, "compiler");
await mkdir(compiler);
await helperOutput(
  inno,
  [
    "-x",
    "-b",
    "-q",
    "-h",
    "-o",
    "-u",
    "-n",
    "-c{app}",
    "-d" + compiler,
    official.file,
  ],
  1024 * 1024,
);
const input = join(work, "input");
await mkdir(input);
await writeFile(join(input, "payload.txt"), "portable inno payload");
await writeFile(join(input, "settings.ini"), "initial settings");
await writeFile(
  join(input, "probe.iss"),
  `
[Setup]
AppName=Piko Inno Fixture
AppVersion=1.0.0
DefaultDirName={autopf}\\PikoFixture
Uninstallable=no
OutputDir=.
OutputBaseFilename=fixture
Compression=lzma2
SolidCompression=yes
[Files]
Source: "payload.txt"; DestDir: "{app}"; DestName: "tool.exe"
Source: "settings.ini"; DestDir: "{app}\\data"
Source: "settings.ini"; DestDir: "{app}\\配置"; DestName: "测试.ini"
Source: "payload.txt"; DestDir: "{tmp}"; DestName: "do-not-install.exe"
[Code]
function InitializeSetup(): Boolean;
begin
  SaveStringToFile(ExpandConstant('{src}\\SETUP_WAS_EXECUTED'), 'must never run', False);
  Result := False;
end;
`,
);
await capture(join(compiler, "ISCC.exe"), ["/Qp", join(input, "probe.iss")], {
  cwd: input,
});
const fixture = join(input, "fixture.exe"),
  bytes = await readFile(fixture);
const manifest: Manifest = {
  schemaVersion: 1,
  name: "inno-tool",
  version: "1.0.0",
  platforms: {
    "windows-x64": {
      url: "",
      sha256: sha256(bytes),
      format: "inno",
      bin: { tool: "tool.exe" },
      persist: ["data"],
    },
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          "inno-tool": {
            latest: manifest.version,
            versions: { [manifest.version]: "manifest.json" },
          },
        },
      });
    if (path === "/manifest.json") return Response.json(manifest);
    if (path === "/setup.exe") return new Response(bytes);
    return new Response(null, { status: 404 });
  },
});
manifest.platforms["windows-x64"]!.url =
  `http://127.0.0.1:${server.port}/setup.exe`;
afterAll(() => server.stop(true));
async function manager() {
  const p = new Packages(join(work, crypto.randomUUID()));
  await seedInno(p.root);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  return p;
}

test("Inno helper installs privately, reuses verified bytes, preserves defaults and rejects tampering", async () => {
  const root = join(work, "bootstrap"),
    state = emptyState(),
    before = structuredClone(state);
  await seedInno(root);
  const executable = await ensureInnoUnpacker(root, state);
  expect(sha256(await readFile(executable))).toBe(innoRelease.executableSha256);
  expect(state).toEqual(before);
  expect(await ensureInnoUnpacker(root, state)).toBe(executable);
  await writeFile(executable, "tampered");
  await expect(ensureInnoUnpacker(root, state)).rejects.toThrow(
    "checksum mismatch",
  );
  const bad = join(work, "bad-bootstrap");
  await seedInno(bad);
  await writeFile(
    join(bad, "cache/artifacts", innoRelease.sha256),
    "bad archive",
  );
  await expect(ensureInnoUnpacker(bad, emptyState())).rejects.toThrow(
    "checksum mismatch",
  );
  expect(await exists(join(bad, "apps/piko/helpers/innounp"))).toBe(false);
});

test("real Inno extraction defaults to {app}, supports unicode and never executes installer code", async () => {
  const output = join(work, "extract");
  await extractArchive(
    fixture,
    "inno",
    output,
    undefined,
    undefined,
    undefined,
    undefined,
    inno,
  );
  expect(await readFile(join(output, "tool.exe"), "utf8")).toBe(
    "portable inno payload",
  );
  expect(await readFile(join(output, "配置/测试.ini"), "utf8")).toBe(
    "initial settings",
  );
  expect(await exists(join(output, "do-not-install.exe"))).toBe(false);
  expect(await exists(join(input, "SETUP_WAS_EXECUTED"))).toBe(false);
  expect(await exists(join(output, "install_script.iss"))).toBe(false);
});

test("Inno app subdirectories and into map into the final installation root", async () => {
  for (const prefix of ["data", "{app}/data"]) {
    const output = join(work, crypto.randomUUID());
    await extractArchive(
      fixture,
      "inno",
      output,
      prefix,
      undefined,
      "portable",
      undefined,
      inno,
    );
    expect(await readFile(join(output, "portable/settings.ini"), "utf8")).toBe(
      "initial settings",
    );
    expect(await exists(join(output, "tool.exe"))).toBe(false);
  }
});

test("compiled CLI auto-prepares Inno helper and commits payload without a default; uninstall preserves user settings", async () => {
  const p = await manager();
  const child = Bun.spawn(
    [
      join(import.meta.dir, "../dist/piko.exe"),
      "install",
      "main/inno-tool@1.0.0",
    ],
    {
      env: { ...process.env, PIKO_HOME: p.root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  expect(code).toBe(0);
  const state = await p.store.read(),
    i = Object.values(state.installs)[0]!;
  expect(state.defaults).toEqual({});
  expect(i.verified).toBe(true);
  expect(await readFile(join(p.root, i.dir, "tool.exe"), "utf8")).toBe(
    "portable inno payload",
  );
  const settings = join(p.root, i.dir, "data/settings.ini");
  await writeFile(settings, "user settings");
  await p.uninstall("main/inno-tool@1.0.0");
  expect(
    await readFile(
      join(p.root, "persist", persistentFolder(i, i.key), "data/settings.ini"),
      "utf8",
    ),
  ).toBe("user settings");
  expect(await exists(join(input, "SETUP_WAS_EXECUTED"))).toBe(false);
});

test("unsupported or corrupt Inno distributions fail without executing them or changing the working default", async () => {
  const p = await manager();
  await p.install("main/inno-tool@1.0.0");
  await p.use("main/inno-tool@latest");
  const before = await p.store.read(),
    previous = structuredClone(manifest);
  manifest.version = "2.0.0";
  manifest.platforms["windows-x64"]!.stripPrefix = "missing";
  try {
    await expect(p.update("main/inno-tool")).rejects.toThrow(
      "no supported files",
    );
    expect(await p.store.read()).toEqual(before);
  } finally {
    Object.assign(manifest, previous);
  }
  const corrupt = join(work, "not-inno.exe");
  await writeFile(corrupt, "this file is not an Inno installer");
  await expect(
    extractArchive(
      corrupt,
      "inno",
      join(work, "bad-output"),
      undefined,
      undefined,
      undefined,
      undefined,
      inno,
    ),
  ).rejects.toThrow("Helper failed");
  expect(await exists(join(work, "bad-output"))).toBe(false);
});

test("Inno manifests cannot select system trees, execute scripts or set arbitrary extraction switches", () => {
  const platform = manifest.platforms["windows-x64"]!;
  for (const fields of [
    { stripPrefix: "{sys}" },
    { stripPrefix: "{tmp}/x" },
    { stripPrefix: "../escape" },
    { file: "setup.exe" },
    { installer: { script: "execute" } },
    { switches: "-m -y" },
  ]) {
    const value = {
      ...manifest,
      platforms: { "windows-x64": { ...platform, ...fields } },
    };
    expect(() => normalizeManifest(value, "inno-tool", "1.0.0")).toThrow();
  }
});

test("hostile Inno listings are rejected before extraction or publication", async () => {
  const root = join(work, "listing");
  await mkdir(root);
  const source = join(root, "fake.ts"),
    fake = join(root, "fake.exe");
  await writeFile(
    source,
    'import {readFileSync} from "node:fs";import {join,dirname} from "node:path";if(process.argv.includes("-e"))process.exit(7);process.stdout.write(readFileSync(join(dirname(process.execPath),"listing.txt")));',
  );
  const result = await Bun.build({
    entrypoints: [source],
    compile: { target: "bun-windows-x64", outfile: fake },
  });
  if (!result.success) throw new Error("Fixture build failed");
  const line = (path: string, size = "1") =>
    `${size} 2026-01-01 12:30 ${path}\n`;
  const cases = [
    line("{app}/../escape"),
    line("C:/escape"),
    line("{app}/file:stream"),
    line("{app}/.piko-install.json"),
    line("{app}/tool.exe", "536870913"),
    line("{app}/x") + line("{app}/X"),
    line("{app}/x") + line("{app}/x/y"),
    line("{app}/x,1"),
    line("{app}/x") + "injected line\n",
    line("{app}/tool.exe") + line("{sys}/../outside"),
  ];
  for (const [n, listing] of cases.entries()) {
    await writeFile(
      join(root, "listing.txt"),
      `Size Date/Time Filename\n--------------------\n${listing}--------------------\n`,
    );
    const destination = join(root, "out-" + n);
    await expect(
      extractArchive(
        fixture,
        "inno",
        destination,
        undefined,
        undefined,
        undefined,
        undefined,
        fake,
      ),
    ).rejects.toThrow();
    expect(await exists(destination)).toBe(false);
  }
  expect(
    (await readdir(root)).some((name) => name.startsWith("inno-extract-")),
  ).toBe(false);
}, 30000);

test("Inno conditional copies require an exact whitelist and rename; unlisted copies never publish", async () => {
  const directory = join(work, "variants");
  await mkdir(directory);
  await writeFile(join(directory, "x86.txt"), "x86 payload");
  await writeFile(join(directory, "x64.txt"), "x64 payload");
  await writeFile(
    join(directory, "variants.iss"),
    [
      "[Setup]",
      "AppName=Piko variants",
      "AppVersion=1",
      "DefaultDirName={autopf}\PikoVariants",
      "Uninstallable=no",
      "OutputDir=.",
      "OutputBaseFilename=variants",
      "[Files]",
      'Source: "x86.txt"; DestDir: "{app}"; DestName: "tool.exe"; Check: not IsWin64',
      'Source: "x64.txt"; DestDir: "{app}"; DestName: "tool.exe"; Check: IsWin64',
    ].join("\n"),
  );
  await capture(join(compiler, "ISCC.exe"), [
    "/Qp",
    join(directory, "variants.iss"),
  ]);
  const archive = join(directory, "variants.exe");
  const listing = Buffer.from(
    await helperOutput(
      inno,
      ["-v", "-a", "-b", "-h", "-o", "-u", "-n", archive],
      1024 * 1024,
    ),
  ).toString("utf8");
  expect(listing).toContain("tool,2.exe");
  await expect(
    extractArchive(
      archive,
      "inno",
      join(work, "ambiguous-variants"),
      undefined,
      undefined,
      undefined,
      undefined,
      inno,
    ),
  ).rejects.toThrow("explicit files mapping");
  const output = join(work, "selected-variant");
  await extractArchive(
    archive,
    "inno",
    output,
    undefined,
    undefined,
    "bin",
    undefined,
    inno,
    { files: { "tool,2.exe": "tool.exe" } },
  );
  expect(await readFile(join(output, "bin/tool.exe"), "utf8")).toBe(
    "x64 payload",
  );
  expect(await exists(join(output, "tool,1.exe"))).toBe(false);
  await expect(
    extractArchive(
      archive,
      "inno",
      join(work, "missing-variant"),
      undefined,
      undefined,
      undefined,
      undefined,
      inno,
      { files: { "tool,3.exe": "tool.exe" } },
    ),
  ).rejects.toThrow("missing");
});
