import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendManifest,
  resolveManifestDocument,
} from "../src/manifest-template.ts";
import {
  normalizeManifest,
  normalizeIndex,
  loadManifest,
  makeSource,
} from "../src/catalog.ts";
import { Packages } from "../src/packages.ts";
import { capture, sha256 } from "../src/util.ts";
import { fileURLToPath } from "node:url";
import { checkSource } from "../scripts/check-source.ts";
import type { Manifest } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-template-test-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
);
const release = (version: string, extra = {}): Manifest => ({
  schemaVersion: 1,
  name: "tool",
  version,
  platforms: {
    "windows-x64": {
      url: `https://vendor.example/v${version}/tool-${version}.zip`,
      sha256: sha256(version),
      format: "zip",
      stripPrefix: `tool-${version}`,
      bin: { tool: `bin/${version}/tool.exe` },
      configFiles: { "config.ini": "literal 1.0.0 {root} {persist}" },
      ...extra,
    },
  },
});

test("template recipes share versioned URLs and preserve exact historical manifest serialization", () => {
  const a = release("1.0.0"),
    b = release("2.0.0");
  let document = appendManifest(undefined, a);
  document = appendManifest(document, b);
  expect(Object.keys(document.recipes)).toHaveLength(1);
  for (const m of [a, b]) {
    expect(
      JSON.stringify(resolveManifestDocument(document, "tool", m.version)),
    ).toBe(JSON.stringify(m));
    expect(normalizeManifest(document, "tool", m.version)).toEqual(m);
  }
  expect(() => normalizeManifest(document, "tool", "3.0.0")).toThrow(
    "not registered",
  );
  expect(() => appendManifest(document, a)).toThrow("Never replace");
  expect(normalizeManifest(a, "tool", "1.0.0")).toEqual(a);
});

test("upstream policies preserve exact historical manifests when recipes advance", () => {
  const original = release("1.0.0");
  const document = appendManifest(undefined, original);
  document.upstream = {
    provider: "github-release",
    repo: "publisher/tool",
    versionRegex: "^v(?<version>[0-9]+(?:\\.[0-9]+)+)$",
    assetRegex: "^tool-windows-x64\\.zip$",
    trust: "publisher",
  };
  const advanced = appendManifest(document, release("2.0.0"));
  expect(
    JSON.stringify(resolveManifestDocument(advanced, "tool", "1.0.0")),
  ).toBe(JSON.stringify(original));
  expect(advanced.upstream).toEqual(document.upstream);
  expect(() => resolveManifestDocument(advanced, "tool", "3.0.0")).toThrow(
    "not registered",
  );
});

test("service binPath participates in template expansion while arguments remain literal", () => {
  const manifest = release("1.0.0", {
    services: [
      {
        name: "ToolSvc",
        displayName: "Tool Service",
        binPath: "bin/tool-1.0.0.exe",
        startType: "demand",
        args: ["--version", "1.0.0"],
      },
    ],
  });
  const document = appendManifest(undefined, manifest);
  const recipe = Object.values<any>(document.recipes)[0]!;
  expect(recipe.platforms["windows-x64"].services[0].binPath).toBe(
    "bin/tool-{version}.exe",
  );
  expect(recipe.platforms["windows-x64"].services[0].args).toEqual([
    "--version",
    "1.0.0",
  ]);
  expect(normalizeManifest(document, "tool", "1.0.0")).toEqual(manifest);
});

test("bootstrap arguments pin the distribution version and keep other fields literal", () => {
  const manifest = release("1.0.0", {
    persist: ["home"],
    bootstrap: {
      path: "install.ps1",
      kind: "powershell",
      args: ["-NonInteractive", "-Commit", "v1.0.0"],
      env: { HERMES_HOME: "{persist}/home" },
      outputs: ["home/bin/tool.exe"],
      timeoutMinutes: 120,
    },
    selfUpdate: {
      command: ["{persist}/home/bin/tool.exe", "update"],
      versionCommand: ["{persist}/home/bin/tool.exe", "--version"],
    },
  });
  const document = appendManifest(undefined, manifest);
  const recipe = Object.values<any>(document.recipes)[0]!;
  const platform = recipe.platforms["windows-x64"];
  expect(platform.bootstrap.args).toEqual([
    "-NonInteractive",
    "-Commit",
    "v{version}",
  ]);
  expect(platform.bootstrap.env).toEqual({ HERMES_HOME: "{persist}/home" });
  expect(platform.bootstrap.timeoutMinutes).toBe(120);
  expect(platform.selfUpdate.command[1]).toBe("update");
  expect(normalizeManifest(document, "tool", "1.0.0")).toEqual(manifest);
  const resolved = resolveManifestDocument(document, "tool", "1.0.0") as any;
  expect(resolved.platforms["windows-x64"].bootstrap.args).toEqual([
    "-NonInteractive",
    "-Commit",
    "v1.0.0",
  ]);
});

test("version-specific recipes and multiple download checksums remain isolated", () => {
  const a = release("1.0.0");
  const b = release("2.0.0", {
    bin: { tool: "new-entry.exe" },
    configFiles: { "config.ini": "new recipe" },
  });
  const document = appendManifest(appendManifest(undefined, a), b);
  expect(Object.keys(document.recipes)).toHaveLength(2);
  expect(normalizeManifest(document, "tool", "1.0.0")).toEqual(a);
  const multi = {
    schemaVersion: 1,
    name: "tool",
    version: "3.0.0",
    platforms: {
      "windows-x64": {
        downloads: [
          {
            url: "https://vendor.example/3.0.0/app.zip",
            sha256: "a".repeat(64),
            format: "zip",
          },
          {
            url: "https://vendor.example/license.txt",
            sha256: "b".repeat(64),
            format: "file",
            file: "license.txt",
          },
        ],
        bin: { tool: "tool.exe" },
      },
    },
  };
  const encoded = appendManifest(undefined, multi);
  expect(encoded.versions["3.0.0"].sha2562).toBe("b".repeat(64));
  expect(JSON.stringify(normalizeManifest(encoded, "tool", "3.0.0"))).toBe(
    JSON.stringify(multi),
  );
});

test("HTTP template snapshots keep versions isolated and support explicit offline loading", async () => {
  const root = join(work, "snapshot-home");
  const document = appendManifest(
    appendManifest(undefined, release("1.0.0")),
    release("2.0.0"),
  );
  let requests = 0;
  let invalid = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json(invalid ? { schemaVersion: 1 } : document);
    },
  });
  const source = makeSource(
    "main",
    `http://127.0.0.1:${server.port}/index.json`,
  );
  const path = "packages/tool/package.json";
  try {
    await expect(
      loadManifest(root, source, path, "tool", "1.0.0", { offline: true }),
    ).rejects.toThrow("snapshot unavailable offline");
    expect(requests).toBe(0);
    for (const version of ["1.0.0", "2.0.0"])
      expect(await loadManifest(root, source, path, "tool", version)).toEqual(
        release(version),
      );
    invalid = true;
    await expect(
      loadManifest(root, source, path, "tool", "1.0.0"),
    ).rejects.toThrow();
    const count = requests;
    for (const version of ["1.0.0", "2.0.0"])
      expect(
        await loadManifest(root, source, path, "tool", version, {
          offline: true,
        }),
      ).toEqual(release(version));
    expect(requests).toBe(count);
  } finally {
    server.stop(true);
  }
});

test("templates reject missing checksum, unknown recipe, unsafe versions and unsupported overrides", () => {
  const document = appendManifest(undefined, release("1.0.0"));
  for (const change of [
    (d: any) => {
      delete d.versions["1.0.0"].sha256;
    },
    (d: any) => {
      d.versions["1.0.0"].sha256 = "invalid";
    },
    (d: any) => {
      d.versions["1.0.0"].recipe = "r0000000000000000";
    },
    (d: any) => {
      d.versions["1.0.0"].override = { admin: {} };
    },
  ]) {
    const invalid = structuredClone(document);
    change(invalid);
    expect(() => normalizeManifest(invalid, "tool", "1.0.0")).toThrow();
  }
  expect(() => normalizeManifest(document, "other", "1.0.0")).toThrow(
    "identity",
  );
  expect(() => normalizeManifest(document, "tool", "../escape")).toThrow(
    "Unsafe",
  );
});

test("HTTP and compiled clients install old and latest template versions and preserve legacy installation hashes", async () => {
  const artifacts = {
    "1.0.0": new TextEncoder().encode("old fixture executable"),
    "2.0.0": new TextEncoder().encode("new fixture executable"),
  };
  let document: any;
  let url = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/index.json")
        return Response.json({
          schemaVersion: 1,
          packages: {
            tool: {
              latest: "2.0.0",
              versions: {
                "1.0.0": "packages/tool/package.json",
                "2.0.0": "packages/tool/package.json",
              },
            },
          },
        });
      if (path === "/packages/tool/package.json")
        return Response.json(document);
      const version = /^\/tool-(.+)\.exe$/.exec(
        path,
      )?.[1] as keyof typeof artifacts;
      return artifacts[version]
        ? new Response(artifacts[version])
        : new Response("missing", { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}/`;
  try {
    for (const version of Object.keys(artifacts) as (keyof typeof artifacts)[])
      document = appendManifest(document, {
        schemaVersion: 1,
        name: "tool",
        version,
        platforms: {
          "windows-x64": {
            url: url + `tool-${version}.exe`,
            sha256: sha256(artifacts[version]),
            format: "file",
            file: "tool.exe",
            bin: { tool: "tool.exe" },
          },
        },
      });
    const p = new Packages(join(work, "http-home"));
    await p.addSource("main", url);
    await p.install("main/tool@1.0.0");
    await p.install("main/tool@latest");
    expect(
      new TextDecoder().decode(
        await readFile(join(p.root, "apps/tool/1.0.0/tool.exe")),
      ),
    ).toBe("old fixture executable");
    expect(
      new TextDecoder().decode(
        await readFile(join(p.root, "apps/tool/2.0.0/tool.exe")),
      ),
    ).toBe("new fixture executable");
    expect(() =>
      normalizeIndex({
        schemaVersion: 1,
        packages: {
          tool: { latest: "1.0.0", versions: { "1.0.0": "../escape.json" } },
        },
      }),
    ).toThrow();
    const source = makeSource("main", url);
    expect(
      (
        await loadManifest(
          p.root,
          source,
          "packages/tool/package.json",
          "tool",
          "1.0.0",
        )
      ).version,
    ).toBe("1.0.0");
    const folder = join(work, "source");
    await mkdir(join(folder, "packages/tool"), { recursive: true });
    await writeFile(
      join(folder, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          tool: {
            latest: "2.0.0",
            versions: {
              "1.0.0": "packages/tool/package.json",
              "2.0.0": "packages/tool/package.json",
            },
          },
        },
      }),
    );
    await writeFile(
      join(folder, "packages/tool/package.json"),
      JSON.stringify(document),
    );
    expect((await checkSource(folder)).checked).toHaveLength(2);
    const legacy = normalizeManifest(document, "tool", "1.0.0");
    const template = document;
    document = legacy;
    await p.install("main/tool@1.0.0");
    document = template;
    await p.install("main/tool@1.0.0");
    const cli = fileURLToPath(new URL("../dist/piko.exe", import.meta.url));
    const compiledRoot = join(work, "compiled-home");
    const env = { ...process.env, PIKO_HOME: compiledRoot };
    await capture(cli, ["source", "add", "main", url], { env });
    await capture(cli, ["install", "main/tool@1.0.0", "--json"], { env });
    await capture(cli, ["install", "main/tool@latest", "--json"], { env });
    expect(
      await readFile(join(compiledRoot, "apps/tool/1.0.0/tool.exe"), "utf8"),
    ).toBe("old fixture executable");
    expect(
      await readFile(join(compiledRoot, "apps/tool/2.0.0/tool.exe"), "utf8"),
    ).toBe("new fixture executable");
  } finally {
    server.stop(true);
  }
});

test("repack versions keep the upstream release in URLs via {upstream}", () => {
  // A repack downloads the same upstream artifact; its tag has no -piko.N.
  const repack = release("5.13.1-piko.1", {
    url: "https://vendor.example/v5.13.1/tool-5.13.1.zip",
    stripPrefix: "tool-5.13.1",
    bin: { tool: "bin/tool.exe" },
  });
  const document = appendManifest(undefined, repack);
  const recipe = Object.values<any>(document.recipes)[0]!;
  expect(recipe.platforms["windows-x64"].url).toBe(
    "https://vendor.example/v{upstream}/tool-{upstream}.zip",
  );
  expect(
    JSON.stringify(resolveManifestDocument(document, "tool", "5.13.1-piko.1")),
  ).toBe(JSON.stringify(repack));
  // A later repack of the same release shares the recipe and its checksums.
  const second = release("5.13.1-piko.2", {
    url: "https://vendor.example/v5.13.1/tool-5.13.1.zip",
    stripPrefix: "tool-5.13.1",
    bin: { tool: "bin/tool.exe" },
  });
  const extended = appendManifest(document, second);
  expect(Object.keys(extended.recipes)).toHaveLength(1);
  expect(normalizeManifest(extended, "tool", "5.13.1-piko.2")).toMatchObject({
    version: "5.13.1-piko.2",
  });
  // Plain versions keep substituting the full version as before.
  const plain = release("5.13.2");
  const withPlain = appendManifest(extended, plain);
  expect(normalizeManifest(withPlain, "tool", "5.13.2")).toMatchObject({
    platforms: { "windows-x64": { url: plain.platforms["windows-x64"].url } },
  });
});

test("{upstream} also strips a fourth-component repack revision", () => {
  const revision = release("4.7.2.1", {
    url: "https://vendor.example/4.7.2-stable/tool.zip",
    bin: { tool: "bin/tool.exe" },
  });
  const document = appendManifest(undefined, revision);
  const recipe = Object.values<any>(document.recipes)[0]!;
  expect(recipe.platforms["windows-x64"].url).toBe(
    "https://vendor.example/{upstream}-stable/tool.zip",
  );
  expect(resolveManifestDocument(document, "tool", "4.7.2.1")).toMatchObject({
    version: "4.7.2.1",
    platforms: {
      "windows-x64": { url: "https://vendor.example/4.7.2-stable/tool.zip" },
    },
  });
  // Five-part versions (four-part upstream plus revision) strip one component.
  const five = release("1.15.0.29830.1", {
    url: "https://vendor.example/1.15.0.29830/tool.msi",
    bin: { tool: "bin/tool.exe" },
  });
  const doc2 = appendManifest(undefined, five);
  expect(
    Object.values<any>(doc2.recipes)[0]!.platforms["windows-x64"].url,
  ).toBe("https://vendor.example/{upstream}/tool.msi");
  // A genuine three-part version is never stripped.
  const plain = release("5.13.1");
  const doc3 = appendManifest(undefined, plain);
  expect(
    Object.values<any>(doc3.recipes)[0]!.platforms["windows-x64"].url,
  ).toBe("https://vendor.example/v{version}/tool-{version}.zip");
});
