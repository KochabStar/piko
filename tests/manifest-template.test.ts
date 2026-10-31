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
import { execFileSync } from "node:child_process";
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

test("Git template loading reads the pinned commit instead of untrusted working-tree bytes", async () => {
  const root = join(work, "git-home");
  const source = makeSource(
    "git",
    "https://vendor.example/source.git",
    "git",
    "main",
  );
  const repo = join(root, "sources", source.identity, "repo");
  await mkdir(join(repo, "packages/tool"), { recursive: true });
  const document = appendManifest(
    appendManifest(undefined, release("1.0.0")),
    release("2.0.0"),
  );
  const path = "packages/tool/package.json";
  await writeFile(join(repo, path), JSON.stringify(document));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(repo, "empty-hooks"),
    "commit",
    "-m",
    "template fixture",
  ]);
  source.commit = git(["rev-parse", "HEAD"]);
  await writeFile(join(repo, path), "untrusted local bytes");
  expect(await loadManifest(root, source, path, "tool", "1.0.0")).toEqual(
    release("1.0.0"),
  );
  expect(await loadManifest(root, source, path, "tool", "2.0.0")).toEqual(
    release("2.0.0"),
  );
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
    const source = makeSource("main", url, "http");
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
