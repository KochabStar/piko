import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareUpstreamManifest } from "../src/upstream-payload.ts";
import { distributionDownloads } from "../src/catalog.ts";
import { containerFile, listContainer } from "../src/containers.ts";
import { ensureInstallerTool } from "../src/installer-tools.ts";
import { readMsiPlan } from "../src/msi.ts";
import { emptyState } from "../src/store.ts";
import { capture, exists, sha256 } from "../src/util.ts";
import { psQuote } from "../src/profiles.ts";
import { fixtureAsset, seedInstallerTools } from "./helper-fixtures.ts";
import { extractZip } from "../src/artifacts.ts";
import { helperOutput } from "../src/helpers-process.ts";
import { peFileVersion } from "../src/upstream-validation.ts";
import type { Manifest } from "../src/types.ts";
import type { UpstreamRule } from "../src/upstream.ts";
import { Packages } from "../src/packages.ts";
import { appendManifest } from "../src/manifest-template.ts";
import { resolvePackageManifest } from "../src/package-resolution.ts";

const work = await mkdtemp(join(tmpdir(), "piko-upstream-installer-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
const rule: UpstreamRule = {
  provider: "github-release",
  trust: "publisher",
  repo: "vendor/project",
  versionRegex: "^v(?<version>[0-9.]+)$",
  assetRegex: "^app[.]msi$",
  layout: "apptree",
};
const baseline = (): Manifest => ({
  schemaVersion: 1,
  name: "application",
  version: "1.0.0",
  platforms: {
    "windows-x64": {
      url: "https://example.com/old.msi",
      sha256: "1".repeat(64),
      format: "msi",
      stripPrefix: "Files/7-Zip",
      files: { "old-runtime.dll": "old-runtime.dll" },
      bin: { tool: "7z.exe" },
    },
  },
});

const installerTest = process.platform === "win32" ? test : test.skip;
installerTest(
  "real MSI app-tree regeneration retains new files and validates supplementary cabinets without running MSI actions",
  async () => {
    const root = join(work, "root");
    await seedInstallerTools(root);
    const full = await ensureInstallerTool(root, emptyState(), "full7zip");
    const less = await ensureInstallerTool(root, emptyState(), "lessmsi");
    const asset = await fixtureAsset({
      url: "https://github.com/ip7z/7zip/releases/download/26.05/7z2605-x64.msi",
      sha256:
        "3fe4ab99fa15629c652944309a2b2bc6e41fc933fc6b63f5df1ebcf3aea68263",
    });
    const archive = join(work, "external.msi"),
      cabinet = join(work, "payload.cab");
    await cp(asset.file, archive);
    const plan = await readMsiPlan(less, archive);
    const stream = (await listContainer(full, archive, "Compound")).find(
      (entry) => entry.path === plan.cabinets[0]!.name,
    )!;
    await containerFile(
      full,
      archive,
      "Compound",
      stream,
      cabinet,
      2 * 1024 * 1024 * 1024,
    );
    // Rewrite fixture metadata only. msiexec and application actions never run.
    await capture("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$i=New-Object -ComObject WindowsInstaller.Installer; $d=$i.OpenDatabase(${psQuote(archive)},1); $v=$d.OpenView("UPDATE Media SET Cabinet='payload.cab'"); $v.Execute(); $d.Commit()`,
    ]);
    const msiBytes = await readFile(archive),
      cabBytes = await readFile(cabinet);
    let cabinetRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/payload.cab") {
          cabinetRequests++;
          return new Response(cabBytes);
        }
        return new Response(msiBytes);
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const current = baseline();
      distributionDownloads(current.platforms["windows-x64"]!)[0]!.cabinets = {
        "payload.cab": { url: base + "/payload.cab", sha256: sha256(cabBytes) },
      };
      const next = await prepareUpstreamManifest(
        root,
        emptyState(),
        current,
        {
          version: "2.0.0",
          url: base + "/installer.msi",
          sha256: sha256(msiBytes),
          provenance: base + "/feed",
        },
        rule,
      );
      const download = distributionDownloads(
        next.platforms["windows-x64"]!,
      )[0]!;
      expect(download.files!["7z.exe"]).toBe("7z.exe");
      expect(download.files!["7z.dll"]).toBe("7z.dll");
      expect(download.files!["old-runtime.dll"]).toBeUndefined();
      expect(cabinetRequests).toBe(1);
      expect(
        await exists(join(root, "cache/artifacts", sha256(msiBytes))),
      ).toBe(true);
      expect(
        await exists(join(root, "cache/artifacts", sha256(cabBytes))),
      ).toBe(true);
      expect(await exists(join(root, "apps", "application"))).toBe(false);
      const bad = structuredClone(current);
      distributionDownloads(bad.platforms["windows-x64"]!)[0]!.cabinets![
        "payload.cab"
      ]!.sha256 = "a".repeat(64);
      await expect(
        prepareUpstreamManifest(
          root,
          emptyState(),
          bad,
          {
            version: "2.0.0",
            url: base + "/installer.msi",
            sha256: sha256(msiBytes),
            provenance: base + "/feed",
          },
          rule,
        ),
      ).rejects.toThrow("SHA256 mismatch");
    } finally {
      server.stop(true);
    }
  },
  120000,
);

installerTest(
  "Tabbit resolves changed GUID metadata into the exact nested recipe and enforces intermediate quota",
  async () => {
    const root = join(work, "tabbit-root");
    await seedInstallerTools(root);
    const full = await ensureInstallerTool(root, emptyState(), "full7zip");
    const input = join(work, "tabbit-input");
    await mkdir(join(input, "Chrome-bin"), { recursive: true });
    await writeFile(
      join(input, "Chrome-bin", "browser.exe"),
      "MZinert-browser",
    );
    await capture(full, ["a", "-t7z", join(input, "chrome.7z"), "Chrome-bin"], {
      cwd: input,
    });
    const guid =
      "bin/Offline/{11111111-1111-1111-1111-111111111111}/{22222222-2222-2222-2222-222222222222}/mini_installer.exe";
    await mkdir(join(input, guid, ".."), { recursive: true });
    await capture(full, ["a", "-t7z", join(input, guid), "chrome.7z"], {
      cwd: input,
    });
    await capture(full, ["a", "-t7z", join(input, "updater.7z"), "bin"], {
      cwd: input,
    });
    const outer = join(work, "tabbit.exe");
    await capture(full, ["a", "-t7z", outer, "updater.7z"], { cwd: input });
    const payload = await readFile(outer);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(payload),
    });
    try {
      const current = baseline();
      current.platforms["windows-x64"] = {
        url: "https://example.com/old.exe",
        sha256: "1".repeat(64),
        format: "7z",
        bin: { browser: "browser.exe" },
        nested: [
          { path: "updater.7z", format: "7z" },
          { path: guid.replaceAll("11111111", "aaaaaaaa"), format: "7z" },
          { path: "chrome.7z", format: "7z", stripPrefix: "Chrome-bin" },
        ],
      };
      const candidate = {
        version: "2.0.0",
        url: `http://127.0.0.1:${server.port}/payload`,
        sha256: sha256(payload),
        provenance: "https://example.com/feed",
      };
      const next = await prepareUpstreamManifest(
        root,
        emptyState(),
        current,
        candidate,
        { ...rule, layout: "tabbit" },
      );
      expect(
        distributionDownloads(next.platforms["windows-x64"]!)[0]!.nested![1]!
          .path,
      ).toBe(guid);
      const small = structuredClone(current);
      small.platforms["windows-x64"]!.maxExpandedBytes = 1;
      await expect(
        prepareUpstreamManifest(root, emptyState(), small, candidate, {
          ...rule,
          layout: "tabbit",
        }),
      ).rejects.toThrow("limit");
    } finally {
      server.stop(true);
    }
  },
  120000,
);

installerTest(
  "PE-derived versions come from actual application bytes and mismatched release hints fail",
  async () => {
    const root = join(work, "pe-root");
    await seedInstallerTools(root);
    const full = await ensureInstallerTool(root, emptyState(), "full7zip");
    const image = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "cmd.exe",
    );
    const payload = await readFile(image);
    const info = Buffer.from(
      await helperOutput(
        full,
        ["l", "-tPE", "-slt", "-sccUTF-8", image],
        32 * 1024 * 1024,
      ),
    ).toString("utf8");
    const exactVersion = peFileVersion(info);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(payload),
    });
    try {
      const current = baseline();
      current.platforms["windows-x64"] = {
        url: "https://example.com/old.exe",
        sha256: "1".repeat(64),
        format: "file",
        file: "tool.exe",
        bin: { tool: "tool.exe" },
      };
      const candidate = {
        version: "2.0.0",
        url: `http://127.0.0.1:${server.port}/tool.exe`,
        sha256: sha256(payload),
        provenance: "https://example.com/feed",
        versionFromPE: true,
      };
      const next = await prepareUpstreamManifest(
        root,
        emptyState(),
        current,
        candidate,
        { ...rule, layout: undefined, versionFromPE: true },
      );
      expect(next.version).toBe(exactVersion);
      await expect(
        prepareUpstreamManifest(
          root,
          emptyState(),
          current,
          { ...candidate, versionFromPE: false },
          { ...rule, layout: undefined, verifyPEVersion: true },
        ),
      ).rejects.toThrow("differs from upstream release hint");
      await expect(
        prepareUpstreamManifest(
          root,
          emptyState(),
          current,
          { ...candidate, versionFromPE: false },
          { ...rule, layout: undefined, verifyPEVersion: true },
          { preview: true },
        ),
      ).rejects.toThrow("Payload inspection required");
      const newer = structuredClone(current);
      newer.version = "999.0.0";
      await expect(
        prepareUpstreamManifest(root, emptyState(), newer, candidate, {
          ...rule,
          layout: undefined,
          versionFromPE: true,
        }),
      ).rejects.toThrow("refusing downgrade");
    } finally {
      server.stop(true);
    }
  },
  120000,
);

installerTest(
  "WeCom and Baidu rebuild moving NSIS application maps without executing setup",
  async () => {
    const root = join(work, "nsis-root");
    await seedInstallerTools(root);
    const compilerAsset = await fixtureAsset({
      url: "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip",
      sha256:
        "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
    });
    const compiler = join(work, "nsis-compiler");
    await extractZip(compilerAsset.file, compiler, "nsis-3.13");
    const input = join(work, "nsis-input");
    await mkdir(input);
    await writeFile(join(input, "tool.exe"), "MZinert-app");
    const script = join(input, "fixture.nsi");
    await writeFile(
      script,
      [
        "Unicode true",
        "SetCompress off",
        'Name "Piko upstream inert fixture"',
        'OutFile "setup.exe"',
        "SilentInstall silent",
        "Section",
        "SetOutPath $PLUGINSDIR",
        'File /oname=plugin.dll "tool.exe"',
        'SetOutPath "$INSTDIR"',
        'File /oname=app.exe "tool.exe"',
        'File /oname=new-runtime.dll "tool.exe"',
        'File /oname=uninstall.exe "tool.exe"',
        'File /oname=uninst.exe "tool.exe"',
        'FileOpen $0 "$EXEDIR/SETUP_WAS_EXECUTED" w',
        'FileWrite $0 "must not execute"',
        "FileClose $0",
        "SectionEnd",
      ].join("\n"),
    );
    await capture(join(compiler, "Bin/makensis.exe"), ["/V2", script], {
      cwd: input,
      env: { ...process.env, NSISDIR: compiler },
    });
    const payload = await readFile(join(input, "setup.exe"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(payload),
    });
    try {
      const current = baseline();
      current.platforms["windows-x64"] = {
        url: "https://example.com/old.exe",
        sha256: "1".repeat(64),
        format: "nsis",
        files: { "old-runtime.dll": "old-runtime.dll" },
        bin: { app: "app.exe" },
      };
      const candidate = {
        version: "2.0.0",
        url: `http://127.0.0.1:${server.port}/setup.exe`,
        sha256: sha256(payload),
        provenance: "https://example.com/feed",
      };
      for (const layout of ["wecom", "baidu"] as const) {
        const next = await prepareUpstreamManifest(
          root,
          emptyState(),
          current,
          candidate,
          { ...rule, layout },
        );
        const files = distributionDownloads(next.platforms["windows-x64"]!)[0]!
          .files!;
        expect(files["app.exe"]).toBe("app.exe");
        expect(files["new-runtime.dll"]).toBe("new-runtime.dll");
        expect(files["old-runtime.dll"]).toBeUndefined();
        expect(
          files[layout === "wecom" ? "uninstall.exe" : "uninst.exe"],
        ).toBeUndefined();
        expect(Object.keys(files).some((path) => path.startsWith("$"))).toBe(
          false,
        );
      }
      expect(await exists(join(input, "SETUP_WAS_EXECUTED"))).toBe(false);
    } finally {
      server.stop(true);
    }
  },
  120000,
);

installerTest(
  "PE-derived latest reuses exact manifests by entity identity and detects stable-URL patches",
  async () => {
    // A real inert Windows PE fixture, with only its fixed file-version resource
    // changed. The HTTPS-trust recipe deliberately makes no publisher-signature
    // claim; signature failures are covered by preparation tests separately.
    const original = await readFile(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    );
    const payload = (patch: number) => {
      const bytes = Buffer.from(original);
      const fixed = bytes.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
      expect(fixed).toBeGreaterThan(0);
      bytes.writeUInt32LE(2 << 16, fixed + 8);
      bytes.writeUInt32LE(patch, fixed + 12);
      return bytes;
    };
    for (const header of ["etag", "x-cos-version-id"] as const) {
      const root = join(work, crypto.randomUUID());
      await seedInstallerTools(root);
      let patch = 1,
        downloads = 0,
        mismatch = false;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const base = `http://127.0.0.1:${server.port}/`;
          const path = new URL(request.url).pathname;
          if (path === "/index.json")
            return Response.json({
              schemaVersion: 1,
              packages: {
                application: {
                  latest: "1.0.0.0",
                  versions: { "1.0.0.0": "application.json" },
                },
              },
            });
          if (path === "/feed.json") return Response.json({ version: "2.0.0" });
          if (path === "/application.json") {
            const document = appendManifest(undefined, {
              schemaVersion: 1,
              name: "application",
              version: "1.0.0.0",
              platforms: {
                "windows-x64": {
                  url: base + "old.exe",
                  sha256: "1".repeat(64),
                  format: "file",
                  file: "tool.exe",
                  bin: { tool: "tool.exe" },
                },
              },
            });
            document.upstream = {
              provider: "json",
              trust: "https",
              url: base + "feed.json",
              versionPath: "version",
              urlTemplate: base + "tool.exe",
              versionFromPE: true,
            };
            return Response.json(document);
          }
          const bytes = payload(patch);
          const version = String(
            mismatch && request.method !== "HEAD" ? patch + 1 : patch,
          );
          const headers = new Headers({
            "Content-Length": String(bytes.length),
            [header]: header === "etag" ? JSON.stringify(version) : version,
          });
          if (request.method === "HEAD") return new Response(null, { headers });
          downloads++;
          const start = Number(
            /^bytes=(\d+)-/.exec(request.headers.get("range") ?? "")?.[1] ?? 0,
          );
          headers.set("Content-Length", String(bytes.length - start));
          headers.set(
            "Content-Range",
            `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
          );
          return new Response(bytes.subarray(start), { status: 206, headers });
        },
      });
      try {
        const packages = new Packages(root);
        await packages.addSource("main", `http://127.0.0.1:${server.port}/`);
        const first = await packages.install("main/application@latest");
        expect(first.version).toBe("2.0.0.1");
        expect(
          (await packages.install("main/application@latest")).manifestHash,
        ).toBe(first.manifestHash);
        expect(downloads).toBe(1);
        const state = await packages.store.read();
        const source = state.sources.main!;
        const entry = {
          latest: "1.0.0.0",
          versions: { "1.0.0.0": "application.json" },
        };
        expect(
          (
            await resolvePackageManifest(
              root,
              state,
              source,
              "application",
              entry,
              "latest",
              { preview: true },
            )
          ).version,
        ).toBe("2.0.0.1");
        expect(downloads).toBe(1);
        // Same three-part hint and URL, different object/ETag and PE patch.
        patch = 2;
        const second = await packages.install("main/application@latest");
        expect(second.version).toBe("2.0.0.2");
        expect(downloads).toBe(2);
        expect(
          (
            await resolvePackageManifest(
              root,
              state,
              source,
              "application",
              entry,
              "latest",
              { offline: true },
            )
          ).version,
        ).toBe("2.0.0.2");
        expect(
          (
            await resolvePackageManifest(
              root,
              state,
              source,
              "application",
              entry,
              "2.0.0.1",
              { offline: true },
            )
          ).version,
        ).toBe("2.0.0.1");
        expect(downloads).toBe(2);
        // A successful content validation with mismatching HEAD/GET validators
        // must not create freshness evidence, even for an already-known version.
        patch = 3;
        mismatch = true;
        await packages.install("main/application@latest");
        expect(downloads).toBe(3);
        mismatch = false;
        await packages.install("main/application@latest");
        expect(downloads).toBe(4);
        await packages.install("main/application@latest");
        expect(downloads).toBe(4);
        await writeFile(
          join(root, "cache/artifacts", sha256(payload(3))),
          "tampered",
        );
        await expect(
          packages.install("main/application@latest"),
        ).rejects.toThrow("Cached artifact checksum mismatch");
        expect(downloads).toBe(4);
      } finally {
        server.stop(true);
      }
    }
  },
  120000,
);
