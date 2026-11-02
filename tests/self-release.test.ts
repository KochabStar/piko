import { VERSION } from "../src/version.ts";
import { afterAll, expect, test } from "bun:test";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { updateSelfFromRelease } from "../src/self-release.ts";
import {
  applySelfUpdate,
  executableHash,
  selfUpdateStatus,
} from "../src/self-update.ts";
import { capture, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-self-release-"));
const exe = resolve("dist/piko.exe");
const executable = await readFile(exe);
const executableChecksum = sha256(executable);
const oldSource = join(work, "old.ts");
await writeFile(
  oldSource,
  'console.log(process.argv.includes("--version") ? "0.3.0" : JSON.stringify({protocol:1,version:"0.3.0",shimProtocol:1}));\n',
);
const old = join(work, "old.exe");
const built = await Bun.build({
  entrypoints: [oldSource],
  compile: { target: "bun-windows-x64", outfile: old },
});
if (!built.success)
  throw new Error("Cannot build isolated old version fixture");
const oldChecksum = await executableHash(old);
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }),
);

// Several rejection cases reuse the same large Bun EXE. Compress and checksum
// each immutable fixture buffer once instead of repeating that CPU work inside
// the test timeout on slower CI runners.
const zipPayloads = new WeakMap<
  Buffer,
  { compressed: Buffer; crc32: number }
>();
function zip(entries: { name: string; bytes: Buffer }[]) {
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) {
      c ^= byte;
      for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name: path, bytes } of entries) {
    const name = Buffer.from(path);
    let payload = zipPayloads.get(bytes);
    if (!payload) {
      payload = { compressed: deflateRawSync(bytes), crc32: crc(bytes) };
      zipPayloads.set(bytes, payload);
    }
    const { compressed, crc32 } = payload;
    const header = Buffer.alloc(30),
      cd = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(bytes.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    central.push(cd, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function archive(version = VERSION, candidate = executable, duplicate = false) {
  const prefix = `piko-${version}-windows-x64/`;
  const entries = [
    { name: prefix + "piko.exe", bytes: candidate },
    {
      name: prefix + "release.json",
      bytes: Buffer.from(
        JSON.stringify({
          version,
          platform: "windows-x64",
          sha256: executableChecksum,
        }),
      ),
    },
    {
      name: prefix + "SHA256SUMS.txt",
      bytes: Buffer.from(executableChecksum + "  piko.exe\n"),
    },
    {
      name: prefix + "install.ps1",
      bytes: Buffer.from("throw 'DO NOT EXECUTE PACKAGED SCRIPT'"),
    },
  ];
  if (duplicate) entries.push(entries[0]!);
  return zip(entries);
}
const releaseArchive = archive();
async function fixture() {
  const root = await mkdtemp(join(work, "home-"));
  const env = { ...process.env, PIKO_HOME: root };
  await capture(exe, ["setup"], { env });
  await copyFile(old, join(root, "apps/piko/piko.exe"));
  let version = VERSION,
    payload: Buffer = releaseArchive,
    checksum = sha256(payload);
  let draft = false,
    prerelease = false,
    missing = false,
    crossOrigin = false,
    unavailable = false;
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/latest") {
        if (unavailable) return new Response("not found", { status: 404 });
        const asset = `piko-${version}-windows-x64.zip`;
        return Response.json({
          tag_name: "v" + version,
          draft,
          prerelease,
          assets: (missing ? [] : [asset, asset + ".sha256"]).map((name) => ({
            name,
            browser_download_url:
              (crossOrigin
                ? "http://127.0.0.1:1"
                : `http://127.0.0.1:${server.port}`) +
              "/" +
              name,
          })),
        });
      }
      if (path.endsWith(".zip.sha256"))
        return new Response(`${checksum}  piko-${version}-windows-x64.zip\n`);
      if (path.endsWith(".zip")) return new Response(new Uint8Array(payload));
      return new Response("missing", { status: 404 });
    },
  });
  return {
    root,
    env,
    server,
    requests,
    metadataUrl: `http://127.0.0.1:${server.port}/latest`,
    set(changes: {
      version?: string;
      payload?: Buffer;
      checksum?: string;
      draft?: boolean;
      prerelease?: boolean;
      missing?: boolean;
      crossOrigin?: boolean;
      unavailable?: boolean;
    }) {
      if (changes.version !== undefined) version = changes.version;
      if (changes.payload !== undefined) {
        payload = changes.payload;
        checksum = sha256(payload);
      }
      if (changes.checksum !== undefined) checksum = changes.checksum;
      if (changes.draft !== undefined) draft = changes.draft;
      if (changes.prerelease !== undefined) prerelease = changes.prerelease;
      if (changes.missing !== undefined) missing = changes.missing;
      if (changes.crossOrigin !== undefined) crossOrigin = changes.crossOrigin;
      if (changes.unavailable !== undefined) unavailable = changes.unavailable;
      requests.length = 0;
    },
  };
}

test("preview requires no confirmation, never downloads a candidate and compares the installed version", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.root, "apps/piko/state.json"), "utf8");
    for (const options of [{}, { confirmed: true, dryRun: true }]) {
      const result = await updateSelfFromRelease(f.root, process.pid, {
        ...options,
        metadataUrl: f.metadataUrl,
      });
      expect(result).toMatchObject({
        package: "piko",
        current: "0.3.0",
        version: VERSION,
        status: "available",
      });
    }
    expect(f.requests).toEqual(["/latest", "/latest"]);
    expect(await executableHash(join(f.root, "apps/piko/piko.exe"))).toBe(
      oldChecksum,
    );
    expect((await selfUpdateStatus(f.root)).pending).toBeNull();
    expect(await readFile(join(f.root, "apps/piko/state.json"), "utf8")).toBe(
      before,
    );
    f.set({ version: "0.3.0" });
    expect(
      (
        await updateSelfFromRelease(f.root, process.pid, {
          confirmed: true,
          metadataUrl: f.metadataUrl,
        })
      ).status,
    ).toBe("current");
    expect(f.requests).toEqual(["/latest"]);
    f.set({ version: "0.2.0" });
    expect(
      (
        await updateSelfFromRelease(f.root, process.pid, {
          confirmed: true,
          metadataUrl: f.metadataUrl,
        })
      ).status,
    ).toBe("current");
  } finally {
    f.server.stop(true);
  }
}, 30000);

test("confirmed release verifies ZIP and executable then uses journaled self update without running bundled scripts", async () => {
  const f = await fixture();
  try {
    const state = await readFile(join(f.root, "apps/piko/state.json"), "utf8");
    const dead = Bun.spawn([exe, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await dead.exited;
    const result = await updateSelfFromRelease(f.root, dead.pid, {
      confirmed: true,
      metadataUrl: f.metadataUrl,
    });
    expect(result.status).toBe("prepared");
    expect((await selfUpdateStatus(f.root)).pending.version).toBe(VERSION);
    await applySelfUpdate(f.root, false);
    expect(await executableHash(join(f.root, "apps/piko/piko.exe"))).toBe(
      executableChecksum,
    );
    expect(await executableHash(join(f.root, "apps/piko/backup.exe"))).toBe(
      oldChecksum,
    );
    expect(
      await capture(join(f.root, "shims/piko.exe"), ["--version"], {
        env: f.env,
      }),
    ).toBe(VERSION);
    expect(await readFile(join(f.root, "apps/piko/state.json"), "utf8")).toBe(
      state,
    );
    expect(
      (await readdir(join(f.root, "staging"))).some((n) =>
        n.startsWith("release-download-"),
      ),
    ).toBe(false);
  } finally {
    f.server.stop(true);
  }
}, 60000);

test("invalid or unavailable release metadata fails closed with guidance and never downloads a candidate", async () => {
  const f = await fixture();
  try {
    for (const changes of [
      { draft: true },
      { draft: false, prerelease: true },
      { prerelease: false, missing: true },
      { missing: false, crossOrigin: true },
      { crossOrigin: false, unavailable: true },
    ]) {
      f.set(changes);
      await expect(
        updateSelfFromRelease(f.root, process.pid, {
          confirmed: true,
          metadataUrl: f.metadataUrl,
        }),
      ).rejects.toThrow();
      expect(f.requests).toEqual(["/latest"]);
      expect((await selfUpdateStatus(f.root)).pending).toBeNull();
      expect(await executableHash(join(f.root, "apps/piko/piko.exe"))).toBe(
        oldChecksum,
      );
    }
    await expect(
      updateSelfFromRelease(f.root, process.pid, {
        metadataUrl: f.metadataUrl,
      }),
    ).rejects.toThrow("private repositories");
  } finally {
    f.server.stop(true);
  }
}, 30000);

for (const rejection of [
  {
    name: "tampered ZIP",
    mutation: () => ({ checksum: "0".repeat(64) }),
    error: "Release ZIP checksum mismatch",
  },
  {
    name: "tampered executable",
    mutation: () => ({ payload: archive(VERSION, Buffer.from("tampered")) }),
    error: "Release executable checksum mismatch",
  },
  {
    name: "duplicate executable",
    mutation: () => ({ payload: archive(VERSION, executable, true) }),
    error: "Invalid, duplicate or oversized release entry",
  },
  {
    name: "inconsistent executable version",
    mutation: () => ({ version: "0.5.0", payload: archive("0.5.0") }),
    error: "Candidate executable version does not match Release metadata",
  },
]) {
  test(`${rejection.name} leaves the installed binary intact and no update journal`, async () => {
    const f = await fixture();
    try {
      f.set(rejection.mutation());
      await expect(
        updateSelfFromRelease(f.root, process.pid, {
          confirmed: true,
          metadataUrl: f.metadataUrl,
        }),
      ).rejects.toThrow(rejection.error);
      expect((await selfUpdateStatus(f.root)).pending).toBeNull();
      expect(await executableHash(join(f.root, "apps/piko/piko.exe"))).toBe(
        oldChecksum,
      );
      expect(
        (await exists(join(f.root, "staging"))) &&
          (await readdir(join(f.root, "staging"))).some((n) =>
            n.startsWith("release-download-"),
          ),
      ).toBe(false);
    } finally {
      f.server.stop(true);
    }
  }, 60000);
}

test("compiled update/update piko/self update aliases share release handling while --all remains packages only", async () => {
  const f = await fixture();
  try {
    const cli = join(work, "integration.exe");
    const build = await Bun.build({
      entrypoints: ["src/cli.ts"],
      compile: {
        target: "bun-windows-x64",
        outfile: cli,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
      },
      plugins: [
        {
          name: "isolated-release-endpoint",
          setup(builder) {
            builder.onLoad(
              { filter: /self-release\.ts$/ },
              async ({ path }) => ({
                contents: (await readFile(path, "utf8")).replace(
                  "options.metadataUrl ?? latestRelease",
                  JSON.stringify(f.metadataUrl),
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    for (const args of [
      ["update"],
      ["update", "piko"],
      ["self", "update"],
      ["self", "update", "latest"],
    ]) {
      const result = JSON.parse(
        await capture(cli, [...args, "--dry-run", "--json"], { env: f.env }),
      );
      expect(result).toMatchObject({
        package: "piko",
        status: "available",
        current: "0.3.0",
        version: VERSION,
      });
    }
    expect((await selfUpdateStatus(f.root)).pending).toBeNull();
    f.requests.length = 0;
    expect(
      JSON.parse(
        await capture(cli, ["update", "--all", "--json"], { env: f.env }),
      ),
    ).toEqual([]);
    expect(f.requests).toEqual([]);
    await expect(
      capture(cli, ["update", "piko", "--all"], { env: f.env }),
    ).rejects.toThrow("without a package");
    const result = JSON.parse(
      await capture(cli, ["update", "piko", "--yes", "--json"], { env: f.env }),
    );
    expect(result.status).toBe("pending");
    const started = Date.now();
    while ((await selfUpdateStatus(f.root)).pending) {
      if (Date.now() - started > 30000)
        throw new Error("Integrated updater remained pending");
      await Bun.sleep(100);
    }
    expect(
      await capture(join(f.root, "shims/piko.exe"), ["--version"], {
        env: f.env,
      }),
    ).toBe(VERSION);
    expect(await exists(join(f.root, "apps/piko/backup.exe"))).toBe(true);
  } finally {
    f.server.stop(true);
  }
}, 60000);
