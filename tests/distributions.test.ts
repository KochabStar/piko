import { persistentFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractArchive,
  extractionState,
  writeArtifactFile,
} from "../src/artifacts.ts";
import { distributionDownloads, normalizeManifest } from "../src/catalog.ts";
import { Packages } from "../src/packages.ts";
import { capture, exists, sha256 } from "../src/util.ts";
import { seedSevenZip } from "./helper-fixtures.ts";
import { ensureSevenZip } from "../src/helpers.ts";
import { emptyState } from "../src/store.ts";
import { checkSource } from "../scripts/check-source.ts";
import type { Download, Distribution, Manifest } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-distributions-"));
const helperRoot = join(work, "helper-root");
await seedSevenZip(helperRoot);
const sevenZip = await ensureSevenZip(helperRoot, emptyState());
await mkdir(join(work, "fixture-input/top/data"), { recursive: true });
await writeFile(join(work, "fixture-input/top/tool.exe"), "fixture executable");
await writeFile(join(work, "fixture-input/top/data/settings.ini"), "initial");
const artifacts = new Map<string, Uint8Array>();
const manifests = new Map<string, Manifest>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname.slice(1);
    if (path === "index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          [...manifests].map(([key, m]) => [
            m.name,
            { latest: m.version, versions: { [m.version]: key } },
          ]),
        ),
      });
    if (manifests.has(path)) return Response.json(manifests.get(path));
    if (artifacts.has(path))
      return new Response(Buffer.from(artifacts.get(path)!));
    return new Response("not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}/`;
const tarBytes = await new Bun.Archive({
  "top/tool.exe": "fixture executable",
  "top/data/settings.ini": "initial",
}).bytes();
const fixtures: Record<string, string> = {};
for (const format of ["tar", "tar.gz", "tar.xz", "7z", "zip"] as const) {
  const path = join(work, "fixture." + format);
  if (format === "tar") await writeFile(path, tarBytes);
  else if (format === "tar.gz")
    await Bun.Archive.write(
      path,
      {
        "top/tool.exe": "fixture executable",
        "top/data/settings.ini": "initial",
      },
      { compress: "gzip" },
    );
  else
    await capture(
      sevenZip,
      [
        "a",
        "-t" + (format === "tar.xz" ? "xz" : format),
        path,
        format === "tar.xz" ? join(work, "fixture.tar") : "top",
      ],
      { cwd: join(work, "fixture-input") },
    );
  fixtures[format] = path;
}
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function manager() {
  const p = new Packages(join(work, crypto.randomUUID()));
  await p.addSource("main", url);
  return p;
}
function download(
  path: string,
  format: Download["format"],
  extra = {},
): Download {
  return {
    url: url + path,
    format,
    sha256: sha256(artifacts.get(path)!),
    ...extra,
  };
}
function publish(platform: Distribution, name = "tool") {
  const m: Manifest = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    platforms: { "windows-x64": platform },
  };
  manifests.set(name + ".json", m);
  return m;
}

// Tiny ustar fixture builder: also exercises entry types that Windows cannot create.
function hostileTar(
  entries: { name: string; type?: string; link?: string; data?: string }[],
) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512),
      data = Buffer.from(entry.data ?? "");
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

for (const format of ["zip", "tar", "tar.gz", "tar.xz", "7z"] as const)
  test(`${format} safely extracts into a subdirectory and supports compiled installation`, async () => {
    const root = join(work, "extract-" + format);
    await extractArchive(
      fixtures[format]!,
      format,
      root,
      "top",
      extractionState(),
      "tools",
      sevenZip,
    );
    expect(await readFile(join(root, "tools/tool.exe"), "utf8")).toBe(
      "fixture executable",
    );
    artifacts.set("fixture." + format, await readFile(fixtures[format]!));
    const m = publish({
      ...download("fixture." + format, format, {
        stripPrefix: "top",
        into: "tools",
      }),
      bin: { tool: "tools/tool.exe" },
    });
    normalizeManifest(m, "tool", "1.0.0");
    const p = await manager();
    if (format !== "zip") await seedSevenZip(p.root);
    const child = Bun.spawn(
      [join(import.meta.dir, "../dist/piko.exe"), "install", "main/tool@1.0.0"],
      {
        env: { ...process.env, PIKO_HOME: p.root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const error = await new Response(child.stderr).text();
    const code = await child.exited;
    if (code !== 0) throw new Error(error);
    expect(code).toBe(0);
    const state = await p.store.read(),
      installation = Object.values(state.installs)[0]!;
    expect(installation.verified).toBe(true);
    expect(
      await readFile(join(p.root, installation.dir, "tools/tool.exe"), "utf8"),
    ).toBe("fixture executable");
    expect(state.defaults).toEqual({});
  });

test("multiple verified downloads merge shared directories and config seeds survive reinstall/uninstall", async () => {
  artifacts.set("one.zip", await readFile(fixtures.zip!));
  artifacts.set("helper.dll", Buffer.from("fixture library"));
  const m = publish({
    downloads: [
      download("one.zip", "zip", { stripPrefix: "top" }),
      download("helper.dll", "file", { file: "helper.dll", into: "data" }),
    ],
    configFiles: {
      "portable.ini": "[General]\nPortable=true\n",
      "data/seed.ini": "seed",
    },
    persist: ["data"],
    bin: { tool: "tool.exe" },
  });
  const p = await manager();
  const i = await p.install("main/tool@1.0.0");
  expect(i.verified).toBe(true);
  expect(i.checksum).toBe(
    sha256(
      JSON.stringify(
        distributionDownloads(m.platforms["windows-x64"]!).map((d) => d.sha256),
      ),
    ),
  );
  expect(await readFile(join(p.root, i.dir, "portable.ini"), "utf8")).toContain(
    "Portable=true",
  );
  const persisted = join(
    p.root,
    "persist",
    persistentFolder(i, i.key),
    "data/seed.ini",
  );
  await writeFile(persisted, "user settings");
  await p.uninstall("main/tool@1.0.0");
  expect(await readFile(persisted, "utf8")).toBe("user settings");
  const reinstalled = await p.install("main/tool@1.0.0");
  expect(
    await readFile(join(p.root, reinstalled.dir, "data/seed.ini"), "utf8"),
  ).toBe("user settings");
});

test("multi-download checksum failure and collisions never publish partial installs or change defaults", async () => {
  artifacts.set("exe", Buffer.from("fixture exe"));
  artifacts.set("dll", Buffer.from("fixture dll"));
  const cases: Distribution[] = [
    {
      downloads: [
        download("exe", "file", { file: "tool.exe" }),
        {
          ...download("dll", "file", { file: "helper.dll" }),
          sha256: "0".repeat(64),
        },
      ],
      bin: { tool: "tool.exe" },
    },
    {
      downloads: [
        download("exe", "file", { file: "tool.exe" }),
        download("dll", "file", { file: "TOOL.exe" }),
      ],
      bin: { tool: "tool.exe" },
    },
    {
      downloads: [
        download("exe", "file", { file: "data" }),
        download("dll", "file", { file: "data/helper.dll" }),
      ],
      bin: {},
    },
    {
      downloads: [download("exe", "file", { file: "tool.exe" })],
      configFiles: { "tool.exe": "overwrite" },
      bin: { tool: "tool.exe" },
    },
  ];
  for (const platform of cases) {
    publish(platform);
    const p = await manager(),
      before = await p.store.read();
    await expect(p.install("main/tool@1.0.0")).rejects.toThrow();
    expect(await p.store.read()).toEqual(before);
    expect(await exists(p.store.installPath)).toBe(false);
  }
});

test("failed multi-download update preserves the working default and existing files", async () => {
  artifacts.set("exe", Buffer.from("working executable fixture"));
  artifacts.set("dll", Buffer.from("library fixture"));
  const m = publish({
    ...download("exe", "file", { file: "tool.exe" }),
    bin: { tool: "tool.exe" },
  });
  const p = await manager(),
    installation = await p.install("main/tool@1.0.0");
  await p.use("main/tool@latest");
  const before = await p.store.read();
  m.version = "2.0.0";
  m.platforms["windows-x64"] = {
    downloads: [
      download("exe", "file", { file: "tool.exe" }),
      {
        ...download("dll", "file", { file: "helper.dll" }),
        sha256: "0".repeat(64),
      },
    ],
    bin: { tool: "tool.exe" },
  };
  await expect(p.update("main/tool")).rejects.toThrow("SHA-256 mismatch");
  expect(await p.store.read()).toEqual(before);
  expect(
    await readFile(join(p.root, installation.dir, "tool.exe"), "utf8"),
  ).toBe("working executable fixture");
});

test("TAR extraction uses 7-Zip even when Windows system tar is unavailable", async () => {
  const prior = process.env.SystemRoot;
  process.env.SystemRoot = join(work, "missing-windows");
  try {
    await extractArchive(
      fixtures.tar!,
      "tar",
      join(work, "no-system-tar"),
      "top",
      undefined,
      undefined,
      sevenZip,
    );
    expect(await readFile(join(work, "no-system-tar/tool.exe"), "utf8")).toBe(
      "fixture executable",
    );
  } finally {
    if (prior === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prior;
  }
});

test("7-Zip TAR extraction rejects hostile paths, links, special files, duplicates and bad prefixes", async () => {
  const cases = [
    [{ name: "../escape", data: "bad" }],
    [{ name: "/absolute", data: "bad" }],
    [{ name: "C:/escape", data: "bad" }],
    [{ name: ".piko-install.json", data: "bad" }],
    [{ name: "link", type: "2", link: "../outside" }],
    [{ name: "hardlink", type: "1", link: "../outside" }],
    [{ name: "pipe", type: "6" }],
    [
      { name: "A.exe", data: "one" },
      { name: "a.exe", data: "two" },
    ],
    [
      { name: "same", data: "one" },
      { name: "same", data: "two" },
    ],
  ];
  for (const [n, entries] of cases.entries()) {
    const path = join(work, `hostile-${n}.tar`);
    await writeFile(path, hostileTar(entries));
    await expect(
      extractArchive(
        path,
        "tar",
        join(work, `hostile-out-${n}`),
        undefined,
        undefined,
        undefined,
        sevenZip,
      ),
    ).rejects.toThrow();
  }
  await expect(
    extractArchive(
      fixtures.tar!,
      "tar",
      join(work, "bad-prefix"),
      "other",
      undefined,
      undefined,
      sevenZip,
    ),
  ).rejects.toThrow("outside stripPrefix");
  expect(await exists(join(work, "escape"))).toBe(false);
  const bad = join(work, "broken.tar.xz");
  await writeFile(bad, "not an archive");
  await expect(
    extractArchive(
      bad,
      "tar.xz",
      join(work, "broken"),
      undefined,
      undefined,
      undefined,
      sevenZip,
    ),
  ).rejects.toThrow("Helper failed");
});

test("shared extraction budget rejects cross-download case and directory/file aliases", async () => {
  const root = join(work, "shared"),
    state = extractionState();
  await writeArtifactFile(root, "Data/first.dll", Buffer.from("one"), state);
  await expect(
    writeArtifactFile(root, "data/second.dll", Buffer.from("two"), state),
  ).rejects.toThrow("case-colliding");
  await expect(
    writeArtifactFile(root, "Data", Buffer.from("two"), state),
  ).rejects.toThrow("overlapping");
  await expect(
    writeArtifactFile(root, ".PIKO-install.json/x", Buffer.from("two"), state),
  ).rejects.toThrow("reserved");
  state.total = 2 * 1024 * 1024 * 1024;
  await expect(
    writeArtifactFile(root, "limit", Buffer.from("two"), state),
  ).rejects.toThrow("size limit");
});

test("manifest and source validation cover multi-downloads, config sizes and forbidden operations", async () => {
  const base = {
    url: url + "exe",
    format: "file",
    file: "tool.exe",
    bin: { tool: "tool.exe" },
  };
  const invalid = [
    { ...base, downloads: [] },
    { downloads: [], bin: {} },
    { downloads: Array(33).fill(base), bin: {} },
    { downloads: [{ ...base }], bin: {} },
    { ...base, format: "msi" },
    { ...base, stripPrefix: "top" },
    { ...base, into: "../outside" },
    { ...base, file: ".piko-install.json" },
    { ...base, configFiles: { "../outside": "x" } },
    { ...base, configFiles: { ".piko-install.json": "x" } },
    { ...base, configFiles: { "config.ini": "x".repeat(65537) } },
    { ...base, configFiles: { "config.ini": 12 } },
    { ...base, installer: { script: "run-me" } },
  ];
  for (const platform of invalid) {
    const m = {
      schemaVersion: 1,
      name: "tool",
      version: "1.0.0",
      platforms: { "windows-x64": platform },
    };
    expect(() => normalizeManifest(m, "tool", "1.0.0")).toThrow();
  }
  const root = join(work, "source-check");
  await mkdir(root);
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: {
        tool: { latest: "1.0.0", versions: { "1.0.0": "tool.json" } },
      },
    }),
  );
  const m = publish({
    downloads: [{ url: url + "exe", format: "file", file: "tool.exe" }],
    bin: {},
  });
  await writeFile(join(root, "tool.json"), JSON.stringify(m));
  await expect(checkSource(root)).rejects.toThrow("require checksums");
});
