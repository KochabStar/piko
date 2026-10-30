import { afterAll, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureInstallerTool,
  fullSevenZipRelease,
} from "../src/installer-tools.ts";
import { fixtureAsset, seedInstallerTools } from "./helper-fixtures.ts";
import { msiPlan, msiTable, readMsiPlan } from "../src/msi.ts";
import { containerFile, listContainer } from "../src/containers.ts";
import { psQuote } from "../src/profiles.ts";
import { emptyState } from "../src/store.ts";
import { extractArchive, extractionState } from "../src/artifacts.ts";
import { Packages } from "../src/packages.ts";
import {
  capture,
  exists,
  sha256,
  commandName,
  component,
} from "../src/util.ts";
import { helperFiles } from "../src/helpers-process.ts";
import { normalizeManifest } from "../src/catalog.ts";

const work = await mkdtemp(join(tmpdir(), "piko-installers-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
const helperRoot = join(work, "helpers");
await seedInstallerTools(helperRoot);
const full = await ensureInstallerTool(helperRoot, emptyState(), "full7zip"),
  lessmsi = await ensureInstallerTool(helperRoot, emptyState(), "lessmsi");
const msiAsset = {
  url: "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.msi",
  sha256: "3fe4ab99fa15629c652944309a2b2bc6e41fc933fc6b63f5df1ebcf3aea68263",
};
const msi = await fixtureAsset(msiAsset);

const tables = {
  Directory:
    "Directory,Directory_Parent,DefaultDir\nROOT,,SourceDir\nAPP,ROOT,SHORT|Application\n",
  Component: "Component,Directory_\nMAIN,APP\n",
  File: "File,Component_,FileName,FileSize,Sequence\nFILE,MAIN,TOOL|tool.exe,5,1\n",
  Media: "DiskId,LastSequence,Cabinet,Source\n1,1,#data.cab,\n",
};
test("MSI read-only metadata reconstruction rejects paths, cycles, external cabinets and conflicting targets", () => {
  expect(msiPlan(tables).files[0]).toMatchObject({
    id: "FILE",
    path: "Application/tool.exe",
    size: 5,
    cabinet: "data.cab",
  });
  for (const changed of [
    { Directory: tables.Directory.replace("SHORT|Application", "../escape") },
    { Directory: tables.Directory.replace("APP,ROOT", "APP,MISSING") },
    {
      Directory: tables.Directory + "OTHER,APP,x\n",
      Component: tables.Component.replace("MAIN,APP", "MAIN,OTHER"),
      File: tables.File.replace("FILE,MAIN", "FILE,MISSING"),
    },
    {
      Directory:
        tables.Directory.replace("APP,ROOT", "APP,LOOP") + "LOOP,APP,loop\n",
    },
    { File: tables.File.replace("TOOL|tool.exe", "C:/escape") },
    {
      File: tables.File + "SECOND,MAIN,TOOL.EXE,5,2\n",
      Media: tables.Media.replace("1,1", "1,2"),
    },
    { File: tables.File.replace(",5,1", ",-1,1") },
    { Media: tables.Media.replace("#data.cab", "data.cab") },
    { Media: tables.Media.replace("#data.cab", "#../data.cab") },
  ])
    expect(() => msiPlan({ ...tables, ...changed })).toThrow();
  expect(msiTable('A,B\n"a,b",c\n', ["A", "B"])).toEqual([
    { A: "a,b", B: "c" },
  ]);
  expect(() => msiTable('A,B\n"unclosed,b\n', ["A", "B"])).toThrow();
});

test("MSI external cabinets require explicit names and checksums and install without running MSI actions", async () => {
  const externalTables = {
    ...tables,
    Media: tables.Media.replace("#data.cab", "data.cab"),
  };
  expect(
    msiPlan(externalTables, false, ["data.cab"]).cabinets[0]?.embedded,
  ).toBe(false);
  expect(() => msiPlan(externalTables, false, ["other.cab"])).toThrow(
    "explicit",
  );
  const archive = join(work, "external.msi"),
    cab = join(work, "payload.cab");
  await cp(msi.file, archive);
  const plan = await readMsiPlan(lessmsi, msi.file);
  expect(plan.cabinets.length).toBe(1);
  const stream = (await listContainer(full, msi.file, "Compound")).find(
    (e) => e.path === plan.cabinets[0]!.name,
  )!;
  await containerFile(
    full,
    msi.file,
    "Compound",
    stream,
    cab,
    2 * 1024 * 1024 * 1024,
  );
  // Edit the test copy's metadata only; never invoke msiexec or install actions.
  await capture("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$i=New-Object -ComObject WindowsInstaller.Installer; $d=$i.OpenDatabase(" +
      psQuote(archive) +
      `,1); $v=$d.OpenView("UPDATE Media SET Cabinet='payload.cab'"); $v.Execute(); $d.Commit()`,
  ]);
  const bytes = await readFile(archive),
    cabBytes = await readFile(cab);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/external.msi") return new Response(bytes);
      if (path === "/payload.cab") return new Response(cabBytes);
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: {
            external: {
              latest: "1.0.0",
              versions: { "1.0.0": "external.json" },
            },
          },
        });
      return Response.json({
        schemaVersion: 1,
        name: "external",
        version: "1.0.0",
        platforms: {
          "windows-x64": {
            url: base + "external.msi",
            sha256: sha256(bytes),
            format: "msi",
            stripPrefix: "Files/7-Zip",
            cabinets: {
              "payload.cab": {
                url: base + "payload.cab",
                sha256: sha256(cabBytes),
              },
            },
            bin: { "7z": "7z.exe" },
          },
        },
      });
    },
  });
  const base = "http://127.0.0.1:" + server.port + "/";
  try {
    const p = new Packages(join(work, "external-install"));
    await seedInstallerTools(p.root);
    await p.addSource("main", base);
    const installed = await p.install("main/external@1.0.0");
    expect(
      await capture(join(p.root, installed.dir, "7z.exe"), ["i"]),
    ).toContain("26.05");
    expect((await p.store.read()).defaults).toEqual({});
    expect(installed.verified).toBe(true);
  } finally {
    server.stop(true);
  }
}, 60000);

test("private full unpacker verifies executable, DLL and unexpected injected files", async () => {
  expect(await ensureInstallerTool(helperRoot, emptyState(), "full7zip")).toBe(
    full,
  );
  expect(sha256(await readFile(full))).toBe(
    fullSevenZipRelease.files["7z.exe"],
  );
  const root = join(work, "tampered");
  await seedInstallerTools(root);
  const exe = await ensureInstallerTool(root, emptyState(), "full7zip");
  await writeFile(join(exe, "..", "7z.dll"), "tampered");
  await expect(
    ensureInstallerTool(root, emptyState(), "full7zip"),
  ).rejects.toThrow("checksum");
  await cp(join(full, "..", "7z.dll"), join(exe, "..", "7z.dll"));
  await writeFile(join(exe, "..", "7z.exe.config"), "unexpected");
  await expect(
    ensureInstallerTool(root, emptyState(), "full7zip"),
  ).rejects.toThrow("Unexpected");
});

test("real MSI extracts portable targets using table names and CAB stdout, never running the installer", async () => {
  const output = join(work, "msi-output");
  await extractArchive(
    msi.file,
    "msi",
    output,
    "Files/7-Zip",
    undefined,
    undefined,
    full,
    undefined,
    { lessMsi: lessmsi },
  );
  expect(await capture(join(output, "7z.exe"), ["i"])).toContain("26.05");
  expect(sha256(await readFile(join(output, "7z.dll")))).toBe(
    fullSevenZipRelease.files["7z.dll"],
  );
  expect(await exists(join(output, "Files"))).toBe(false);
  expect(await exists(join(output, "SourceDir"))).toBe(false);
  expect(
    (await readdir(work)).some((n) => n.startsWith("container-extract-")),
  ).toBe(false);
}, 120000);

test("MSI explicit selection and rename require exact entries; failures do not publish package state", async () => {
  const output = join(work, "msi-selected");
  await extractArchive(
    msi.file,
    "msi",
    output,
    "Files/7-Zip",
    undefined,
    "bin",
    full,
    undefined,
    {
      lessMsi: lessmsi,
      files: { "7z.exe": "renamed.exe", "7z.dll": "7z.dll" },
    },
  );
  expect(await exists(join(output, "bin/renamed.exe"))).toBe(true);
  expect(await exists(join(output, "7zFM.exe"))).toBe(false);
  await expect(
    extractArchive(
      msi.file,
      "msi",
      join(work, "missing"),
      "Files/7-Zip",
      undefined,
      undefined,
      full,
      undefined,
      { lessMsi: lessmsi, files: { "missing.exe": "tool.exe" } },
    ),
  ).rejects.toThrow("missing");
});

test("compiled MSI install bootstraps private tools, leaves default unchanged, and preserves working version on bad selection", async () => {
  const root = join(work, "cli"),
    p = new Packages(root);
  await seedInstallerTools(root);
  let version = "1.0.0",
    missing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: {
            tool: { latest: version, versions: { [version]: "manifest.json" } },
          },
        });
      if (path === "/file") return new Response(msi.bytes);
      return Response.json({
        schemaVersion: 1,
        name: "tool",
        version,
        platforms: {
          "windows-x64": {
            url: `http://127.0.0.1:${server.port}/file`,
            sha256: msiAsset.sha256,
            format: "msi",
            stripPrefix: "Files/7-Zip",
            files: {
              [missing ? "missing.exe" : "7z.exe"]: "7z.exe",
              "7z.dll": "7z.dll",
            },
            bin: { sevenzip: "7z.exe", "cc++": "7z.exe" },
          },
        },
      });
    },
  });
  try {
    await p.addSource("main", `http://127.0.0.1:${server.port}/`);
    const child = Bun.spawn(
      [join(import.meta.dir, "../dist/piko.exe"), "install", "main/tool@1.0.0"],
      {
        env: { ...process.env, PIKO_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw Error(err);
    expect(code).toBe(0);
    expect((await p.store.read()).defaults).toEqual({});
    await p.use("main/tool@latest");
    const before = await p.store.read();
    expect(before.commands["cc++"]).toBeDefined();
    version = "2.0.0";
    missing = true;
    await expect(p.update("main/tool")).rejects.toThrow("missing");
    expect(await p.store.read()).toEqual(before);
  } finally {
    server.stop(true);
  }
}, 120000);

test("new archive declarations reject unsafe mappings, unlimited downloads and ambiguous nested steps", () => {
  const base = {
    schemaVersion: 1,
    name: "test",
    version: "1",
    platforms: {
      "windows-x64": {
        url: "https://example.com/file",
        format: "msi",
        bin: {},
      },
    },
  };
  for (const fields of [
    { files: { "../escape": "tool.exe" } },
    { files: { "tool.exe": "../escape" } },
    { files: { a: "Tool.exe", b: "tool.exe" } },
    { files: {} },
    { maxBytes: 0 },
    { maxBytes: 2147483649 },
    { maxExpandedBytes: 0 },
    { maxExpandedBytes: 8589934593 },
    { format: "nsis" },
    { format: "pe" },
    { format: "pe", nested: [{ path: "../resource", format: "7z" }] },
    { format: "nsis", files: { "tool.exe": "tool.exe" }, stripPrefix: "app" },
    {
      format: "nsis",
      files: { "tool.exe": "tool.exe" },
      nested: [{ path: "payload", format: "7z" }],
    },
    { format: "nsis", nested: [{ path: "../escape", format: "7z" }] },
    { format: "7z", nested: [{ path: "payload", format: "msi" }] },
    {
      format: "7z",
      stripPrefix: "x",
      nested: [{ path: "payload", format: "7z" }],
    },
  ])
    expect(() =>
      normalizeManifest(
        {
          ...base,
          platforms: {
            "windows-x64": { ...base.platforms["windows-x64"], ...fields },
          },
        },
        "test",
        "1",
      ),
    ).toThrow();
});

test("explicit nested ZIP/7z chains share extraction budgets and reject missing or unsafe payloads", async () => {
  const input = join(work, "nested-input");
  await mkdir(input);
  await mkdir(join(input, "top"));
  await writeFile(join(input, "top/tool.exe"), "inner tool");
  await capture(full, ["a", "-t7z", join(work, "inner.7z"), "top"], {
    cwd: input,
  });
  await cp(join(work, "inner.7z"), join(input, "inner.7z"));
  await capture(full, ["a", "-tzip", join(input, "inner.zip"), "top"], {
    cwd: input,
  });
  await capture(
    full,
    ["a", "-tzip", join(work, "zip-chain.zip"), "inner.zip"],
    { cwd: input },
  );
  await extractArchive(
    join(work, "zip-chain.zip"),
    "zip",
    join(work, "zip-only-result"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { nested: [{ path: "inner.zip", format: "zip", stripPrefix: "top" }] },
  );
  expect(await readFile(join(work, "zip-only-result/tool.exe"), "utf8")).toBe(
    "inner tool",
  );
  const outer = join(work, "outer.zip");
  await capture(full, ["a", "-tzip", outer, "inner.7z"], { cwd: input });
  const output = join(work, "nested-result");
  await extractArchive(
    outer,
    "zip",
    output,
    undefined,
    undefined,
    "bin",
    full,
    undefined,
    { nested: [{ path: "inner.7z", format: "7z", stripPrefix: "top" }] },
  );
  expect(await readFile(join(output, "bin/tool.exe"), "utf8")).toBe(
    "inner tool",
  );
  expect(await exists(join(output, "inner.7z"))).toBe(false);
  const applicationLimit = Buffer.byteLength("inner tool");
  const layers = extractionState();
  layers.fileLimit = applicationLimit;
  const bounded = join(work, "large-container-small-files");
  await extractArchive(
    outer,
    "zip",
    bounded,
    undefined,
    layers,
    undefined,
    full,
    undefined,
    { nested: [{ path: "inner.7z", format: "7z", stripPrefix: "top" }] },
  );
  expect(await readFile(join(bounded, "tool.exe"), "utf8")).toBe("inner tool");
  expect(layers.fileLimit).toBe(applicationLimit);
  const expanded =
    (await readFile(join(input, "inner.7z"))).length + applicationLimit;
  expect(layers.total).toBe(expanded);
  const tooSmall = extractionState();
  tooSmall.fileLimit = applicationLimit - 1;
  await expect(
    extractArchive(
      outer,
      "zip",
      join(work, "final-file-still-bounded"),
      undefined,
      tooSmall,
      undefined,
      full,
      undefined,
      { nested: [{ path: "inner.7z", format: "7z", stripPrefix: "top" }] },
    ),
  ).rejects.toThrow("size limit");
  await expect(
    extractArchive(
      outer,
      "zip",
      join(work, "shared-layer-limit"),
      undefined,
      extractionState(expanded - 1),
      undefined,
      full,
      undefined,
      { nested: [{ path: "inner.7z", format: "7z", stripPrefix: "top" }] },
    ),
  ).rejects.toThrow("size limit");
  await expect(
    extractArchive(
      outer,
      "zip",
      join(work, "bad-nested"),
      undefined,
      undefined,
      undefined,
      full,
      undefined,
      { nested: [{ path: "missing.7z", format: "7z" }] },
    ),
  ).rejects.toThrow();
  const state = extractionState();
  state.total = 2 * 1024 * 1024 * 1024 - 1;
  await expect(
    extractArchive(
      outer,
      "zip",
      join(work, "budget-nested"),
      undefined,
      state,
      undefined,
      full,
      undefined,
      { nested: [{ path: "inner.7z", format: "7z" }] },
    ),
  ).rejects.toThrow("size limit");
  expect(
    (await readdir(work)).some((n) => n.startsWith("container-extract-")),
  ).toBe(false);
});

test("batched stdout extraction enforces exact byte partitions, empty files and no diagnostics", async () => {
  const root = join(work, "batch");
  await mkdir(root);
  const files = [
    { path: join(root, "empty"), size: 0 },
    { path: join(root, "first"), size: 2 },
    { path: join(root, "second"), size: 3 },
  ];
  await helperFiles(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.from([1,2,3,4,5]))"],
    files,
  );
  expect([...(await readFile(files[1]!.path))]).toEqual([1, 2]);
  expect([...(await readFile(files[2]!.path))]).toEqual([3, 4, 5]);
  for (const [n, script] of [
    'process.stdout.write("toolong")',
    'process.stdout.write("x")',
    'process.stdout.write("abc");process.stderr.write("warning")',
  ].entries())
    await expect(
      helperFiles(
        process.execPath,
        ["-e", script],
        [{ path: join(root, "bad-" + n), size: 3 }],
      ),
    ).rejects.toThrow();
});

test("bounded size overrides apply to cache hits as well as downloads and preserve existing defaults", async () => {
  const { artifactBytes } = await import("../src/cache.ts");
  const root = join(work, "size-limits");
  await mkdir(join(root, "cache/artifacts"), { recursive: true });
  const bytes = Buffer.from("oversized for declared budget"),
    hash = sha256(bytes);
  await writeFile(join(root, "cache/artifacts", hash), bytes);
  await expect(
    artifactBytes(root, "https://example.com/file", hash, false, undefined, 1),
  ).rejects.toThrow("size limit");
  expect(
    await artifactBytes(
      root,
      "https://example.com/file",
      hash,
      false,
      undefined,
      bytes.length,
    ),
  ).toEqual(bytes);
  const state = extractionState(1);
  const { writeArtifactFile } = await import("../src/artifacts.ts");
  await expect(
    writeArtifactFile(join(root, "out"), "file", bytes, state),
  ).rejects.toThrow("size limit");
  expect(() => extractionState(8 * 1024 * 1024 * 1024 + 1)).toThrow();
  expect(commandName("Clang++")).toBe("clang++");
  expect(() => component("clang++")).toThrow();
  for (const name of [
    "clang++;exit",
    "clang++/x",
    "clang++\\x",
    "clang++|x",
    "clang++.exe",
  ])
    expect(() => commandName(name)).toThrow();
});

test("real NSIS selects only its named nested payload or explicit files and never executes installer code", async () => {
  const nsis = await fixtureAsset({
    url: "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip",
    sha256: "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
  });
  const { extractZip } = await import("../src/artifacts.ts");
  const compiler = join(work, "nsis-compiler");
  await extractZip(nsis.file, compiler, "nsis-3.13");
  const input = join(work, "nsis-input");
  await mkdir(input);
  await writeFile(join(input, "tool.exe"), "NSIS inner portable tool");
  await writeFile(join(input, "empty.bin"), "");
  const inner = join(input, "payload.7z");
  await capture(full, ["a", "-t7z", inner, "tool.exe"], { cwd: input });
  const setup = join(input, "setup.exe");
  const script = join(input, "fixture.nsi");
  await writeFile(
    script,
    [
      "Unicode true",
      "SetCompress off",
      'Name "Piko extraction fixture"',
      'OutFile "setup.exe"',
      "SilentInstall silent",
      "Section",
      "SetOutPath $PLUGINSDIR",
      'File /oname=payload.7z "payload.7z"',
      'SetOutPath "$INSTDIR"',
      'File /oname=direct.exe "tool.exe"',
      'File /oname=empty.bin "empty.bin"',
      "FileOpen $0 $EXEDIR\\SETUP_WAS_EXECUTED w",
      'FileWrite $0 "must not execute"',
      "FileClose $0",
      "SectionEnd",
    ].join("\n"),
  );
  await capture(join(compiler, "Bin/makensis.exe"), ["/V2", script], {
    cwd: input,
    env: { ...process.env, NSISDIR: compiler },
  });
  const output = join(work, "nsis-result");
  await extractArchive(
    setup,
    "nsis",
    output,
    undefined,
    undefined,
    undefined,
    full,
    undefined,
    { nested: [{ path: "$PLUGINSDIR/payload.7z", format: "7z" }] },
  );
  expect(await readFile(join(output, "tool.exe"), "utf8")).toBe(
    "NSIS inner portable tool",
  );
  expect(await exists(join(input, "SETUP_WAS_EXECUTED"))).toBe(false);
  expect(await exists(join(output, "$PLUGINSDIR"))).toBe(false);
  await expect(
    extractArchive(
      setup,
      "nsis",
      join(work, "nsis-missing"),
      undefined,
      undefined,
      undefined,
      full,
      undefined,
      { nested: [{ path: "$PLUGINSDIR/missing.7z", format: "7z" }] },
    ),
  ).rejects.toThrow("missing");
  const mapped = join(work, "nsis-mapped");
  const files = {
    "direct.exe": "bin/renamed.exe",
    "empty.bin": "data/empty.bin",
  };
  await extractArchive(
    setup,
    "nsis",
    mapped,
    undefined,
    extractionState(Buffer.byteLength("NSIS inner portable tool")),
    "app",
    full,
    undefined,
    { files },
  );
  expect(await readFile(join(mapped, "app/bin/renamed.exe"), "utf8")).toBe(
    "NSIS inner portable tool",
  );
  expect((await readFile(join(mapped, "app/data/empty.bin"))).length).toBe(0);
  expect(await exists(join(mapped, "$PLUGINSDIR"))).toBe(false);
  expect(await exists(join(input, "SETUP_WAS_EXECUTED"))).toBe(false);
  expect(() =>
    normalizeManifest(
      {
        schemaVersion: 1,
        name: "test",
        version: "1",
        platforms: {
          "windows-x64": {
            url: "https://example.com/setup.exe",
            format: "nsis",
            files,
            bin: { tool: "bin/renamed.exe" },
          },
        },
      },
      "test",
      "1",
    ),
  ).not.toThrow();
  await expect(
    extractArchive(
      setup,
      "nsis",
      join(work, "nsis-small-mapped"),
      undefined,
      extractionState(Buffer.byteLength("NSIS inner portable tool") - 1),
      undefined,
      full,
      undefined,
      { files },
    ),
  ).rejects.toThrow("limit");
  const missingMap = join(work, "nsis-missing-map");
  await expect(
    extractArchive(
      setup,
      "nsis",
      missingMap,
      undefined,
      undefined,
      undefined,
      full,
      undefined,
      { files: { "direct.exe": "kept.exe", "missing.exe": "missing.exe" } },
    ),
  ).rejects.toThrow("missing");
  expect(await exists(join(missingMap, "kept.exe"))).toBe(false);
  await expect(
    extractArchive(
      setup,
      "nsis",
      join(work, "nsis-reserved-map"),
      undefined,
      undefined,
      undefined,
      full,
      undefined,
      { files: { "direct.exe": ".piko-install.json" } },
    ),
  ).rejects.toThrow("reserved");
}, 120000);

test("PE selects an exact archive resource without running its executable", async () => {
  const input = join(work, "pe-resource-input");
  await mkdir(input);
  await writeFile(join(input, "tool.exe"), "PE resource portable tool");
  const payload = join(input, "inner.7z");
  await capture(full, ["a", "-t7z", payload, "tool.exe"], { cwd: input });
  const image = join(input, "resource.exe");
  await cp(full, image);
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices;",
    "public static class PikoPeResourceFixture {",
    '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr BeginUpdateResourceW(string file, bool clear);',
    '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool UpdateResourceW(IntPtr handle, string type, IntPtr name, ushort language, byte[] data, uint length);',
    '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool EndUpdateResourceW(IntPtr handle, bool discard);',
    "}",
    "'@",
    "$bytes=[IO.File]::ReadAllBytes(" + psQuote(payload) + ")",
    "$h=[PikoPeResourceFixture]::BeginUpdateResourceW(" +
      psQuote(image) +
      ",$false)",
    "if($h -eq [IntPtr]::Zero){throw 'Cannot begin fixture resource update'}",
    "if(-not [PikoPeResourceFixture]::UpdateResourceW($h,'PIKO',[IntPtr]101,1033,$bytes,[uint32]$bytes.Length)){[PikoPeResourceFixture]::EndUpdateResourceW($h,$true)|Out-Null;throw 'Cannot write fixture resource'}",
    "if(-not [PikoPeResourceFixture]::EndUpdateResourceW($h,$false)){throw 'Cannot finish fixture resource update'}",
  ].join("\n");
  await capture("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  const resources = (await listContainer(full, image, "PE")).filter((e) =>
    e.path.endsWith("/PIKO/101"),
  );
  expect(resources).toHaveLength(1);
  // 7-Zip elides the language level when a PE has only one resource language.
  const resource = resources[0]!.path;
  const nested = [{ path: resource, format: "7z" as const }],
    output = join(work, "pe-resource-result");
  expect(() =>
    normalizeManifest(
      {
        schemaVersion: 1,
        name: "test",
        version: "1",
        platforms: {
          "windows-x64": {
            url: "https://example.com/image.exe",
            format: "pe",
            nested,
            bin: { tool: "tool.exe" },
          },
        },
      },
      "test",
      "1",
    ),
  ).not.toThrow();
  await extractArchive(
    image,
    "pe",
    output,
    undefined,
    undefined,
    undefined,
    full,
    undefined,
    { nested },
  );
  expect(await readFile(join(output, "tool.exe"), "utf8")).toBe(
    "PE resource portable tool",
  );
  expect(await exists(join(output, ".text"))).toBe(false);
  await expect(
    extractArchive(
      image,
      "pe",
      join(work, "pe-missing"),
      undefined,
      undefined,
      undefined,
      full,
      undefined,
      { nested: [{ path: ".rsrc/1033/PIKO/999", format: "7z" }] },
    ),
  ).rejects.toThrow("missing");
  await expect(
    extractArchive(
      image,
      "pe",
      join(work, "pe-small"),
      undefined,
      extractionState((await readFile(payload)).length - 1),
      undefined,
      full,
      undefined,
      { nested },
    ),
  ).rejects.toThrow("bounded");
  await expect(
    extractArchive(
      image,
      "pe",
      join(work, "pe-no-selection"),
      undefined,
      undefined,
      undefined,
      full,
    ),
  ).rejects.toThrow("explicit");
}, 30000);

test("MSI explicit file identifiers select duplicate-target architecture variants without guessing", async () => {
  const variantTables = {
    ...tables,
    File: tables.File + "SECOND,MAIN,tool.exe,8,2\n",
    Media: tables.Media.replace("1,1", "1,2"),
  };
  expect(() => msiPlan(variantTables)).toThrow("Duplicate");
  expect(msiPlan(variantTables, true).files.map((f) => f.id)).toEqual([
    "FILE",
    "SECOND",
  ]);
  const output = join(work, "msi-id-selection");
  await extractArchive(
    msi.file,
    "msi",
    output,
    undefined,
    undefined,
    undefined,
    full,
    undefined,
    {
      lessMsi: lessmsi,
      files: { "#_7z.exe": "selected.exe", "#_7z.dll": "7z.dll" },
    },
  );
  expect(await exists(join(output, "selected.exe"))).toBe(true);
  expect(await capture(join(output, "selected.exe"), ["i"])).toContain("26.05");
  expect(msiTable('A,B\nfield,VersionNT="x64"\n', ["A", "B"])[0]?.B).toBe(
    'VersionNT="x64"',
  );
});
