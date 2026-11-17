import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareUpstreamManifest } from "../src/upstream-payload.ts";
import { distributionDownloads } from "../src/catalog.ts";
import { emptyState } from "../src/store.ts";
import { exists, sha256 } from "../src/util.ts";
import {
  applicationFiles,
  epicApplicationFiles,
  nsisApplicationFiles,
  peFileVersion,
  tabbitMiniInstallerPath,
  verifyPublishedDigests,
} from "../src/upstream-validation.ts";
import type { Manifest } from "../src/types.ts";
import type { UpstreamCandidate, UpstreamRule } from "../src/upstream.ts";

const work = await mkdtemp(join(tmpdir(), "piko-upstream-payload-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
const rule: UpstreamRule = {
  provider: "github-release",
  trust: "https",
  repo: "vendor/project",
  versionRegex: "^v(?<version>[0-9.]+)$",
  assetRegex: "^project[.]zip$",
};
const manifest = (): Manifest => ({
  schemaVersion: 1,
  name: "project",
  version: "1.0.0",
  platforms: {
    "windows-x64": {
      url: "https://example.com/project-1.0.0.exe",
      sha256: "1".repeat(64),
      format: "file",
      file: "tool.exe",
      bin: { tool: "tool.exe" },
    },
  },
});
const bytes = Buffer.from("MZ-inert-test-fixture");
const candidate = (
  url: string,
  extra: Partial<UpstreamCandidate> = {},
): UpstreamCandidate => ({
  version: "2.0.0",
  url,
  provenance: "https://example.com/feed",
  ...extra,
});

// Minimal stored ZIP fixture, built as test data rather than by invoking any
// application/installer. Used to exercise the actual guarded ZIP extractor.
function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path),
      data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let n = 0; n < 8; n++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

async function serve<T>(
  payload: Uint8Array,
  run: (url: string, requests: () => number) => Promise<T>,
): Promise<T> {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(Buffer.from(payload));
    },
  });
  try {
    return await run(`http://127.0.0.1:${server.port}/payload`, () => requests);
  } finally {
    server.stop(true);
  }
}

test("published SHA256/SHA512/MD5 are all enforced and zero digests are never accepted", () => {
  const digests = {
    sha256: sha256(bytes),
    sha512: createHash("sha512").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("hex"),
  };
  expect(verifyPublishedDigests(bytes, digests)).toBe(digests.sha256);
  for (const key of ["sha256", "sha512", "md5"] as const) {
    expect(() =>
      verifyPublishedDigests(bytes, {
        ...digests,
        [key]: "a".repeat(digests[key].length),
      }),
    ).toThrow("mismatch");
    expect(() =>
      verifyPublishedDigests(bytes, { [key]: "0".repeat(digests[key].length) }),
    ).toThrow("Invalid advertised");
  }
});

test("application maps follow new runtime/extension files and reject ambiguous identities", () => {
  const plan = {
    files: [
      { path: "App/tool.exe" },
      { path: "App/python-9.9/bin/python.exe" },
      { path: "App/extensions/new/data.json" },
      { path: "System64/runtime.dll" },
      { path: "System64/runtime.dll" },
    ],
  };
  expect(applicationFiles(plan, "App")).toEqual({
    "tool.exe": "tool.exe",
    "python-9.9/bin/python.exe": "python-9.9/bin/python.exe",
    "extensions/new/data.json": "extensions/new/data.json",
  });
  expect(() => applicationFiles(plan, undefined)).toThrow("stripPrefix");
  expect(() => applicationFiles(plan, "Absent")).toThrow("empty");
  expect(() =>
    applicationFiles(
      { files: [{ path: "App/A.dll" }, { path: "App/a.dll" }] },
      "App",
    ),
  ).toThrow("colliding");
  expect(
    epicApplicationFiles({
      files: [
        { path: "Epic Games/Launcher/Portal/Binaries/Win64/Launcher.exe" },
        { path: "Epic Games/DirectXRedist/setup.exe" },
        { path: "Epic Games/GameInputRedist/setup.exe" },
        { path: "Epic/EpicGamesLauncher/config" },
        { path: "Win/System64/runtime.dll" },
        { path: "System/runtime.dll" },
      ],
    }),
  ).toEqual({
    "Epic Games/Launcher/Portal/Binaries/Win64/Launcher.exe":
      "Epic Games/Launcher/Portal/Binaries/Win64/Launcher.exe",
  });
  const nsis = [
    "$PLUGINSDIR/temp",
    "app.exe",
    "new.dll",
    "uninstall.exe",
    "uninst.exe",
  ].map((path) => ({ path, directory: false }));
  expect(Object.keys(nsisApplicationFiles(nsis, "wecom"))).toEqual([
    "app.exe",
    "new.dll",
    "uninst.exe",
  ]);
  expect(Object.keys(nsisApplicationFiles(nsis, "baidu"))).toEqual([
    "app.exe",
    "new.dll",
    "uninstall.exe",
  ]);
});

test("Tabbit GUID selections and PE version evidence cannot be guessed", () => {
  const path =
    "bin/Offline/{91a6ace8-cbaa-4829-9a65-d91a31a5c6e8}/{908E3278-51FC-4D62-A1D5-CCB182BCCC26}/mini_installer.exe";
  expect(tabbitMiniInstallerPath(["unrelated", path])).toBe(path);
  expect(() => tabbitMiniInstallerPath([])).toThrow("missing");
  expect(() =>
    tabbitMiniInstallerPath([path, path.replace("91a6ace8", "11a6ace8")]),
  ).toThrow("ambiguous");
  expect(peFileVersion("FileVersion: 2.0.0.4\nFileVersion: 2.0.0.4\n")).toBe(
    "2.0.0.4",
  );
  expect(() => peFileVersion("ProductVersion: 2.0.0\n")).toThrow("missing");
  expect(() =>
    peFileVersion("FileVersion: 2.0.0\nFileVersion: 3.0.0\n"),
  ).toThrow("Ambiguous");
  expect(
    peFileVersion("FileVersion: 2.0.0\nFileVersion: 3.0.0\n", "2.0.0"),
  ).toBe("2.0.0");
  expect(() => peFileVersion("FileVersion: 2.0.0\n", "3.0.0")).toThrow(
    "differs",
  );
});

test("HTTPS delegation computes an exact content pin without inventing publisher authentication", async () => {
  const root = join(work, "https");
  await serve(bytes, async (url, requests) => {
    const upstream = candidate(url);
    const original = structuredClone(upstream);
    const next = await prepareUpstreamManifest(
      root,
      emptyState(),
      manifest(),
      upstream,
      rule,
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!)[0]!.sha256,
    ).toBe(sha256(bytes));
    expect(upstream).toEqual(original);
    expect(
      await readFile(join(root, "cache/artifacts", sha256(bytes))),
    ).toEqual(bytes);
    expect(requests()).toBe(1);
    expect(await exists(join(root, "apps"))).toBe(false);
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });
});

test("publisher trust rejects MD5-only metadata and never caches failed validation", async () => {
  const root = join(work, "publisher-refused");
  await serve(bytes, async (url, requests) => {
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url, {
          md5: createHash("md5").update(bytes).digest("hex"),
        }),
        { ...rule, trust: "publisher" },
      ),
    ).rejects.toThrow("Publisher trust");
    expect(requests()).toBe(0);
    expect(await exists(join(root, "cache/artifacts", sha256(bytes)))).toBe(
      false,
    );
  });
});

test("SHA512-only publisher evidence pins SHA256 after validation and rejects conflicts", async () => {
  const digest = createHash("sha512").update(bytes).digest("hex");
  await serve(bytes, async (url) => {
    const next = await prepareUpstreamManifest(
      join(work, "sha512"),
      emptyState(),
      manifest(),
      candidate(url, { sha512: digest }),
      { ...rule, trust: "publisher" },
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!)[0]!.sha256,
    ).toBe(sha256(bytes));
    const failed = join(work, "sha512-failed");
    await expect(
      prepareUpstreamManifest(
        failed,
        emptyState(),
        manifest(),
        candidate(url, { sha512: "a".repeat(128) }),
        { ...rule, trust: "publisher" },
      ),
    ).rejects.toThrow("SHA512 mismatch");
    expect(await exists(join(failed, "cache/artifacts", sha256(bytes)))).toBe(
      false,
    );
  });
});

test("strict offline uses only digest-verified exact cache and rejects tampering without a request", async () => {
  const root = join(work, "offline"),
    hash = sha256(bytes);
  await mkdir(join(root, "cache/artifacts"), { recursive: true });
  await writeFile(join(root, "cache/artifacts", hash), bytes);
  await serve(bytes, async (url, requests) => {
    const next = await prepareUpstreamManifest(
      root,
      emptyState(),
      manifest(),
      candidate(url, { sha256: hash }),
      { ...rule, trust: "publisher" },
      { offline: true },
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!)[0]!.sha256,
    ).toBe(hash);
    expect(requests()).toBe(0);
    await writeFile(join(root, "cache/artifacts", hash), "corrupt");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url, { sha256: hash }),
        rule,
        { offline: true },
      ),
    ).rejects.toThrow("Cached artifact checksum mismatch");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url),
        rule,
        { offline: true },
      ),
    ).rejects.toThrow("saved exact manifest");
    expect(requests()).toBe(0);
  });
});

test("metadata-only preview neither downloads nor presents old digest as publisher verification", async () => {
  await serve(bytes, async (url, requests) => {
    const root = join(work, "preview");
    const next = await prepareUpstreamManifest(
      root,
      emptyState(),
      manifest(),
      candidate(url),
      rule,
      { preview: true },
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!)[0]!.sha256,
    ).toBeUndefined();
    expect(requests()).toBe(0);
    expect(await exists(root)).toBe(false);
    for (const layout of [
      "tabbit",
      "wecom",
      "baidu",
      "apptree",
      "epic",
    ] as const)
      await expect(
        prepareUpstreamManifest(
          root,
          emptyState(),
          manifest(),
          candidate(url),
          { ...rule, layout },
          { preview: true },
        ),
      ).rejects.toThrow("Payload inspection required");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url),
        { ...rule, versionFromPE: true },
        { preview: true },
      ),
    ).rejects.toThrow("PE-derived");
    expect(requests()).toBe(0);
  });
});

test("ZIP requirements, reserved paths and shared expanded quota are checked before caching", async () => {
  const current = manifest();
  current.platforms["windows-x64"] = {
    url: "https://example.com/old.zip",
    sha256: "1".repeat(64),
    format: "zip",
    bin: { tool: "tool.exe" },
    maxExpandedBytes: 64,
  };
  const payload = zip({ "tool.exe": "MZdata", "assets/data.json": "{}" });
  await serve(payload, async (url) => {
    const next = await prepareUpstreamManifest(
      join(work, "zip-valid"),
      emptyState(),
      current,
      candidate(url),
      { ...rule, required: ["assets/data.json"] },
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!)[0]!.sha256,
    ).toBe(sha256(payload));
    const root = join(work, "zip-missing");
    await expect(
      prepareUpstreamManifest(root, emptyState(), current, candidate(url), {
        ...rule,
        required: ["new/required.json"],
      }),
    ).rejects.toThrow("Required application entry missing");
    expect(await exists(join(root, "cache/artifacts", sha256(payload)))).toBe(
      false,
    );
    const small = structuredClone(current);
    small.platforms["windows-x64"]!.maxExpandedBytes = 2;
    await expect(
      prepareUpstreamManifest(
        join(work, "zip-quota"),
        emptyState(),
        small,
        candidate(url),
        rule,
      ),
    ).rejects.toThrow("expanded size");
  });
  const reserved = zip({ "tool.exe": "MZdata", ".piko-install.json": "{}" });
  await serve(reserved, async (url) => {
    await expect(
      prepareUpstreamManifest(
        join(work, "zip-reserved"),
        emptyState(),
        current,
        candidate(url),
        rule,
      ),
    ).rejects.toThrow("reserved");
  });
});

test("multiple independent downloads retain their own exact digest and share output collision checks", async () => {
  const payload = zip({ "tool.exe": "MZdata" });
  await serve(payload, async (url, requests) => {
    const current = manifest();
    current.platforms["windows-x64"] = {
      bin: { tool: "tool.exe" },
      downloads: [
        {
          url: "https://example.com/old.zip",
          sha256: "1".repeat(64),
          format: "zip",
        },
        { url, sha256: sha256(payload), format: "zip", into: "extra" },
      ],
    };
    const next = await prepareUpstreamManifest(
      join(work, "multi"),
      emptyState(),
      current,
      candidate(url, { sha256: sha256(payload) }),
      { ...rule, trust: "publisher" },
    );
    expect(
      distributionDownloads(next.platforms["windows-x64"]!).map(
        (download) => download.sha256,
      ),
    ).toEqual([sha256(payload), sha256(payload)]);
    expect(requests()).toBe(1);
    current.platforms["windows-x64"]!.downloads![1]!.into = undefined;
    const root = join(work, "multi-collision");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        current,
        candidate(url, { sha256: sha256(payload) }),
        rule,
      ),
    ).rejects.toThrow("Duplicate");
    expect(await exists(join(root, "cache/artifacts", sha256(payload)))).toBe(
      false,
    );
  });
});

test("signature policy is mandatory even alongside a strong digest, for distribution and named payload", async () => {
  await serve(bytes, async (url) => {
    const root = join(work, "invalid-signature");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url, { sha256: sha256(bytes) }),
        { ...rule, trust: "publisher", signature: true },
      ),
    ).rejects.toThrow();
    expect(await exists(join(root, "cache/artifacts", sha256(bytes)))).toBe(
      false,
    );
  });
  const payload = zip({ "tool.exe": "MZ-inert" });
  await serve(payload, async (url) => {
    const current = manifest();
    current.platforms["windows-x64"] = {
      url: "https://example.com/old.zip",
      sha256: "1".repeat(64),
      format: "zip",
      bin: { tool: "tool.exe" },
    };
    const root = join(work, "invalid-payload-signature");
    await expect(
      prepareUpstreamManifest(root, emptyState(), current, candidate(url), {
        ...rule,
        trust: "publisher",
        signature: "tool.exe",
      }),
    ).rejects.toThrow();
    expect(await exists(join(root, "cache/artifacts", sha256(payload)))).toBe(
      false,
    );
    await expect(
      prepareUpstreamManifest(
        join(work, "signature-missing"),
        emptyState(),
        current,
        candidate(url),
        { ...rule, trust: "publisher", signature: "missing.exe" },
      ),
    ).rejects.toThrow("inspection payload is missing");
  });
});

test("Lua binary names follow the new major/minor release", async () => {
  const current = manifest();
  current.version = "5.4.8";
  current.platforms["windows-x64"] = {
    url: "https://example.com/lua-5.4.8.zip",
    sha256: "1".repeat(64),
    format: "zip",
    bin: { lua: "lua54.exe", luac: "luac54.exe" },
  };
  const payload = zip({ "lua55.exe": "MZlua", "luac55.exe": "MZluac" });
  await serve(payload, async (url) => {
    const next = await prepareUpstreamManifest(
      join(work, "lua"),
      emptyState(),
      current,
      candidate(url, { version: "5.5.1" }),
      { ...rule, layout: "lua" },
    );
    expect(next.platforms["windows-x64"]!.bin).toEqual({
      lua: "lua55.exe",
      luac: "luac55.exe",
    });
  });
});

test("QQ layout requires one complete native application resource tree", async () => {
  const current = manifest();
  current.platforms["windows-x64"] = {
    url: "https://example.com/qq.zip",
    sha256: "1".repeat(64),
    format: "zip",
    bin: { qq: "QQ.exe" },
  };
  const files: Record<string, string> = {
    "QQ.exe": "MZqq",
    "QQEX.exe": "MZhelper",
    "versions/config.json": "{}",
  };
  const prefix = "versions/9.9.99-99999/";
  for (const path of [
    "resources/app/package.json",
    "QQNT.dll",
    "chrome_100_qq.pak",
    "resources.pak",
    "icudtl.dat",
  ])
    files[prefix + path] = "payload";
  await serve(zip(files), async (url) => {
    await prepareUpstreamManifest(
      join(work, "qq-complete"),
      emptyState(),
      current,
      candidate(url),
      {
        ...rule,
        layout: "qqnt",
        required: ["QQEX.exe", "versions/config.json"],
      },
    );
  });
  delete files[prefix + "QQNT.dll"];
  const missing = zip(files);
  await serve(missing, async (url) => {
    const root = join(work, "qq-incomplete");
    await expect(
      prepareUpstreamManifest(root, emptyState(), current, candidate(url), {
        ...rule,
        layout: "qqnt",
      }),
    ).rejects.toThrow("QQ application resource missing");
    expect(await exists(join(root, "cache/artifacts", sha256(missing)))).toBe(
      false,
    );
  });
});

test("invalid PE bytes, advertised length conflicts and same-version replacement never become trusted cache", async () => {
  const invalid = Buffer.from("not an executable");
  await serve(invalid, async (url) => {
    const root = join(work, "not-pe");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url),
        rule,
      ),
    ).rejects.toThrow("not a PE executable");
    expect(await exists(join(root, "cache/artifacts", sha256(invalid)))).toBe(
      false,
    );
  });
  await serve(bytes, async (url, requests) => {
    const root = join(work, "wrong-size");
    await expect(
      prepareUpstreamManifest(
        root,
        emptyState(),
        manifest(),
        candidate(url, { assetBytes: bytes.length + 1 }),
        rule,
      ),
    ).rejects.toThrow("length differs");
    expect(await exists(join(root, "cache/artifacts", sha256(bytes)))).toBe(
      false,
    );
    const current = manifest();
    current.platforms["windows-x64"]!.url = url;
    const unchanged = candidate(url, { version: current.version });
    await expect(
      prepareUpstreamManifest(
        join(work, "immutable"),
        emptyState(),
        current,
        unchanged,
        rule,
      ),
    ).rejects.toThrow("immutable version retained");
    const before = requests();
    await expect(
      prepareUpstreamManifest(
        join(work, "old-pin-not-publisher"),
        emptyState(),
        current,
        unchanged,
        { ...rule, trust: "publisher" },
      ),
    ).rejects.toThrow("Publisher trust");
    expect(requests()).toBe(before);
  });
});
