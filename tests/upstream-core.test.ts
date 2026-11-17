import { expect, test } from "bun:test";
import {
  compareVersions,
  discover,
  nextManifest,
  validateUpstreamRule,
} from "../src/upstream.ts";
import type {
  UpstreamCandidate,
  UpstreamNetwork,
  UpstreamRule,
} from "../src/upstream.ts";
import type { Manifest } from "../src/types.ts";

const hash = "a".repeat(64);
const baseline: Manifest = {
  schemaVersion: 1,
  name: "tool",
  version: "1.0.0",
  platforms: {
    "windows-x64": {
      url: "https://publisher.example/tool-1.0.0.zip",
      sha256: hash,
      format: "zip",
      stripPrefix: "tool-1.0.0",
      bin: { tool: "tool-1.0.0.exe" },
      configFiles: { "tool.ini": "literal {version} {root}" },
      services: [
        {
          name: "ToolSvc",
          displayName: "Tool",
          binPath: "tool-1.0.0.exe",
          args: ["1.0.0"],
          startType: "demand",
        },
      ],
    },
  },
};
const feedRule: UpstreamRule = {
  provider: "json",
  trust: "publisher",
  url: "http://127.0.0.1:9911/feed.json",
  versionPath: "release.version",
  sha256Path: "release.sha256",
  urlTemplate: "http://127.0.0.1:9911/tool-{version}.zip",
};
function feedNetwork(data: unknown): UpstreamNetwork {
  return {
    async json(url) {
      expect(url).toBe(feedRule.url!);
      return data;
    },
    async text(url) {
      throw new Error("Unexpected text request: " + url);
    },
    async redirect(url) {
      throw new Error("Unexpected redirect request: " + url);
    },
  };
}

test("JSON publisher feeds preserve strong hashes and local origin", async () => {
  const candidate = await discover(
    feedRule,
    baseline,
    feedNetwork({ release: { version: "2.0.0", sha256: hash } }),
  );
  expect(candidate.sha256).toBe(hash);
  expect(candidate.url).toBe("http://127.0.0.1:9911/tool-2.0.0.zip");
  expect(candidate.provenance).toBe(feedRule.url!);
  const rule = {
    ...feedRule,
    sha256Path: undefined,
    sha512Path: "release.sha512",
  };
  const sha512 = "b".repeat(128);
  expect(
    (
      await discover(
        rule,
        baseline,
        feedNetwork({ release: { version: "2.0.0", sha512 } }),
      )
    ).sha512,
  ).toBe(sha512);
});

test("JSON feeds cannot widen constraints or fabricate channel versions", async () => {
  for (const request of ["1", "1.4", "2.0.1", "beta"])
    await expect(
      discover(
        feedRule,
        baseline,
        feedNetwork({ release: { version: "2.0.0", sha256: hash } }),
        request,
      ),
    ).rejects.toThrow("requested version/channel");
});

test("advertised missing, zero, and malformed hashes fail closed", async () => {
  for (const sha256 of [undefined, "0".repeat(64), "bad"])
    await expect(
      discover(
        feedRule,
        baseline,
        feedNetwork({
          release: {
            version: "2.0.0",
            ...(sha256 === undefined ? {} : { sha256 }),
          },
        }),
      ),
    ).rejects.toThrow("digest");
});

test("rule validation rejects undeclared keys, unsafe origins and regex repetition", () => {
  for (const rule of [
    { ...feedRule, bypass: true },
    { ...feedRule, trust: undefined },
    { ...feedRule, url: "http://public.example/feed" },
    { ...feedRule, urlTemplate: "https://{version}.example/tool.zip" },
    { ...feedRule, versionPath: "__proto__.version" },
    { ...feedRule, maxBytes: 0 },
    { ...feedRule, maxExpandedBytes: Number.MAX_SAFE_INTEGER },
    {
      provider: "regex",
      trust: "https",
      url: "https://publisher.example/feed",
      versionRegex: "(a+)+$",
      urlTemplate: "https://publisher.example/{version}.zip",
    },
  ])
    expect(() => validateUpstreamRule(rule)).toThrow();
});

const githubRule: UpstreamRule = {
  provider: "github-release",
  trust: "https",
  repo: "publisher/tool",
  versionRegex: "^v(?<version>[0-9]+(?:\\.[0-9]+)+(?:-beta\\.[0-9]+)?)$",
  assetRegex: "^tool-win64\\.zip$",
};
function githubNetwork(releases: unknown[]): UpstreamNetwork {
  return {
    async json(url) {
      if (
        url === "https://api.github.com/repos/publisher/tool/releases/latest"
      ) {
        const latest = releases.find(
          (r) =>
            r !== null &&
            typeof r === "object" &&
            "prerelease" in r &&
            !r.prerelease,
        );
        if (!latest) throw new Error("No latest stable release");
        return latest;
      }
      expect(url).toBe(
        "https://api.github.com/repos/publisher/tool/releases?per_page=100&page=1",
      );
      return releases;
    },
    async text(url) {
      throw new Error("Unexpected text request: " + url);
    },
    async redirect(url) {
      throw new Error("Unexpected redirect request: " + url);
    },
  };
}
function release(version: string, extras = {}): Record<string, unknown> {
  return {
    tag_name: "v" + version,
    draft: false,
    prerelease: version.includes("beta"),
    assets: [
      {
        name: "tool-win64.zip",
        size: 123,
        browser_download_url:
          "https://github.com/publisher/tool/releases/download/v" +
          version +
          "/tool-win64.zip",
        digest: "sha256:" + hash,
      },
    ],
    ...extras,
  };
}

test("GitHub enumeration retains numeric prefixes and beta channels", async () => {
  const net = githubNetwork([
    release("3.0.0-beta.2"),
    release("2.0.0"),
    release("1.4.3"),
    release("1.4.2"),
  ]);
  expect((await discover(githubRule, baseline, net, "1.4")).version).toBe(
    "1.4.3",
  );
  expect((await discover(githubRule, baseline, net, "latest")).version).toBe(
    "2.0.0",
  );
  expect((await discover(githubRule, baseline, net, "beta")).version).toBe(
    "3.0.0-beta.2",
  );
  expect(
    (await discover(githubRule, baseline, net, "3.0.0-beta.2")).version,
  ).toBe("3.0.0-beta.2");
  await expect(discover(githubRule, baseline, net, "1.5")).rejects.toThrow(
    "requested version/channel",
  );
});

test("selected missing or duplicate assets fail without falling back to an older version", async () => {
  await expect(
    discover(
      githubRule,
      baseline,
      githubNetwork([release("2.0.0", { assets: [] }), release("1.4.3")]),
    ),
  ).rejects.toThrow("Missing or ambiguous");
  const asset = (release("2.0.0").assets as unknown[])[0];
  await expect(
    discover(
      githubRule,
      baseline,
      githubNetwork([release("2.0.0", { assets: [asset, asset] })]),
    ),
  ).rejects.toThrow("Missing or ambiguous");
  expect(
    (
      await discover(
        githubRule,
        baseline,
        githubNetwork([release("2.0.0"), release("1.4.3", { assets: [] })]),
      )
    ).version,
  ).toBe("2.0.0");
});

test("GitHub assets cannot escape publisher repository", async () => {
  const asset = {
    name: "tool-win64.zip",
    size: 123,
    browser_download_url:
      "https://github.com/attacker/tool/releases/download/v2.0.0/tool-win64.zip",
  };
  await expect(
    discover(
      githubRule,
      baseline,
      githubNetwork([release("2.0.0", { assets: [asset] })]),
    ),
  ).rejects.toThrow("escaped");
});

test("same-version URL and digest identities are immutable", () => {
  const candidate: UpstreamCandidate = {
    version: baseline.version,
    url: baseline.platforms["windows-x64"].url!,
    provenance: feedRule.url!,
    sha256: hash,
  };
  expect(nextManifest(baseline, candidate, feedRule)).toEqual(baseline);
  expect(() =>
    nextManifest(
      baseline,
      { ...candidate, url: "https://attacker.example/tool.zip" },
      feedRule,
    ),
  ).toThrow("immutable");
  expect(() =>
    nextManifest(baseline, { ...candidate, sha256: "b".repeat(64) }, feedRule),
  ).toThrow("immutable");
});

test("retargeting changes service payload paths but keeps code and arguments literal", () => {
  const candidate = {
    version: "2.0.0",
    url: "https://publisher.example/tool-2.0.0.zip",
    provenance: "https://publisher.example/feed",
  };
  const rule: UpstreamRule = { provider: "node", trust: "publisher" };
  const next = nextManifest(baseline, candidate, rule).platforms["windows-x64"];
  expect(next.services![0].binPath).toBe("tool-2.0.0.exe");
  expect(next.services![0].args).toEqual(["1.0.0"]);
  expect(next.configFiles).toEqual({ "tool.ini": "literal {version} {root}" });
  expect(next.sha256).toBeUndefined();
  expect(baseline.platforms["windows-x64"].sha256).toBe(hash);
});

test("duplicate shared payload recipes retarget all download identities", () => {
  const current = structuredClone(baseline),
    platform = current.platforms["windows-x64"];
  current.platforms["windows-x64"] = {
    bin: platform.bin,
    downloads: [
      {
        url: platform.url!,
        sha256: hash,
        format: "zip",
        stripPrefix: "first-1.0.0",
      },
      {
        url: platform.url!,
        sha256: hash,
        format: "zip",
        stripPrefix: "second-1.0.0",
      },
    ],
  };
  const next = nextManifest(
    current,
    {
      version: "2.0.0",
      url: "https://publisher.example/tool-2.0.0.zip",
      provenance: "https://publisher.example/feed",
    },
    { provider: "node", trust: "publisher" },
  );
  expect(
    next.platforms["windows-x64"].downloads!.map((d) => [d.url, d.sha256]),
  ).toEqual([
    ["https://publisher.example/tool-2.0.0.zip", undefined],
    ["https://publisher.example/tool-2.0.0.zip", undefined],
  ]);
});

test("candidate stripPrefix does not undergo a second version substitution", () => {
  const next = nextManifest(
    baseline,
    {
      version: "1.0.0.1",
      url: "https://publisher.example/new.zip",
      provenance: "https://publisher.example/feed",
      stripPrefix: "tool-1.0.0.1",
    },
    { provider: "node", trust: "publisher" },
  );
  expect(next.platforms["windows-x64"].stripPrefix).toBe("tool-1.0.0.1");
});

test("version comparison handles prereleases and lossless long build identifiers", () => {
  expect(compareVersions("2.0.0-beta.10", "2.0.0-beta.2")).toBeGreaterThan(0);
  expect(compareVersions("2.0.0", "2.0.0-beta.10")).toBeGreaterThan(0);
  expect(
    compareVersions("1.9007199254740993", "1.9007199254740992"),
  ).toBeGreaterThan(0);
});

test("CloudDrive versionTemplate retains separately numbered payload builds", async () => {
  const rule: UpstreamRule = {
    provider: "regex",
    trust: "https",
    url: "https://publisher.example/feed",
    versionRegex:
      "app-v(?<assetver>[0-9]+(?:[.][0-9]+){1,3})-(?<tag>[0-9]+)/CloudDrive2-(?<assetver2>[0-9]+(?:[.][0-9]+){1,3})-(?<appbuild>[0-9]+)-windows-x64[.]exe",
    versionTemplate: "{assetver}.{appbuild}",
    urlTemplate:
      "https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v{assetver}-{tag}/CloudDrive2-{assetver}-{appbuild}-windows-x64.exe",
  };
  const net: UpstreamNetwork = {
    ...feedNetwork({}),
    async text() {
      return "app-v1.1.3-24/CloudDrive2-1.1.3-3-windows-x64.exe";
    },
  };
  const candidate = await discover(rule, baseline, net, "1.1");
  expect(candidate.version).toBe("1.1.3.3");
  expect(candidate.url).toBe(
    "https://github.com/cloud-fs/cloud-fs.github.io/releases/download/app-v1.1.3-24/CloudDrive2-1.1.3-3-windows-x64.exe",
  );
});

test("Git release assets retain fourth-component publisher versions", async () => {
  const rule: UpstreamRule = {
    ...githubRule,
    versionRegex: "^v(?<version>[0-9]+[.][0-9]+[.][0-9]+)[.]windows[.][0-9]+$",
    assetRegex: "^PortableGit-(?<version>[0-9.]+)-64-bit[.]7z[.]exe$",
    versionFrom: "asset",
  };
  const releases = [
    {
      tag_name: "v2.53.0.windows.1",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: "PortableGit-2.53.0.1-64-bit.7z.exe",
          size: 123,
          browser_download_url:
            "https://github.com/publisher/tool/releases/download/v2.53.0.windows.1/PortableGit-2.53.0.1-64-bit.7z.exe",
        },
      ],
    },
  ];
  const candidate = await discover(
    rule,
    baseline,
    githubNetwork(releases),
    "2.53",
  );
  expect(candidate.version).toBe("2.53.0.1");
  await expect(
    discover(rule, baseline, githubNetwork(releases), "2.53.0"),
  ).rejects.toThrow("requested version/channel");
});

test("Node partial requests select only enumerated versions within their prefix", async () => {
  const net: UpstreamNetwork = {
    ...feedNetwork({}),
    async json(url) {
      expect(url).toBe("https://nodejs.org/dist/index.json");
      return [
        { version: "v22.0.0", files: ["win-x64-zip"] },
        { version: "v18.20.8", files: ["win-x64-zip"] },
      ];
    },
    async text(url) {
      expect(url).toBe("https://nodejs.org/dist/v18.20.8/SHASUMS256.txt");
      return hash + "  node-v18.20.8-win-x64.zip";
    },
  };
  expect(
    (
      await discover(
        { provider: "node", trust: "publisher" },
        baseline,
        net,
        "18.20",
      )
    ).version,
  ).toBe("18.20.8");
  await expect(
    discover({ provider: "node", trust: "publisher" }, baseline, net, "20"),
  ).rejects.toThrow("requested version/channel");
});

test("PE-derived releases retain an explicit payload-finalization marker", async () => {
  const candidate = await discover(
    { ...feedRule, versionFromPE: true },
    baseline,
    feedNetwork({ release: { version: "2.0.0", sha256: hash } }),
  );
  expect(candidate.versionFromPE).toBe(true);
  expect(candidate.version).toBe("2.0.0");
});

test("GitHub file snapshots are not misclassified as prereleases by their commit hash", async () => {
  const net: UpstreamNetwork = {
    ...feedNetwork({}),
    async json() {
      return [
        {
          sha: "a".repeat(40),
          commit: { committer: { date: "2026-11-17T00:00:00Z" } },
        },
      ];
    },
  };
  const candidate = await discover(
    {
      provider: "github-file",
      trust: "https",
      repo: "publisher/tool",
      path: "tool.ps1",
    },
    baseline,
    net,
  );
  expect(candidate.version).toBe("0.2026.11.17-aaaaaaaa");
});
