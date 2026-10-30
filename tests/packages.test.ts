import { persistentFolder, appFolder } from "../src/layout.ts";
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  readlink,
  symlink,
  rm,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { Store } from "../src/store.ts";
import { chooseVersion, normalizeManifest } from "../src/catalog.ts";
import {
  component,
  relativeFile,
  exists,
  sha256,
  atomicJson,
} from "../src/util.ts";
import { extractZip } from "../src/artifacts.ts";

const work = await mkdtemp(join(tmpdir(), "piko-tests-"));
const artifact = new TextEncoder().encode(
  "portable test executable placeholder",
);
let brokenIndex = false;
const manifests: Record<string, unknown> = {};
const index = {
  schemaVersion: 1,
  packages: {
    tool: {
      latest: "2.0.0",
      versions: {
        "1.0.0": "tool-1.json",
        "1.1.0": "tool-1.1.json",
        "2.0.0": "tool-2.json",
      },
    },
    other: { latest: "1.0.0", versions: { "1.0.0": "other.json" } },
  },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return brokenIndex
        ? new Response("unavailable", { status: 503 })
        : Response.json(index);
    if (path === "/file.exe") return new Response(artifact);
    const m = manifests[path.slice(1)];
    return m ? Response.json(m) : new Response("not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}/`;
function manifest(name: string, version: string, bin = "tool") {
  return {
    schemaVersion: 1,
    name,
    version,
    platforms: {
      "windows-x64": {
        url: url + "file.exe",
        sha256: sha256(artifact),
        format: "file",
        file: "tool.exe",
        bin: { [bin]: "tool.exe" },
      },
    },
  };
}
for (const [path, version] of [
  ["tool-1.json", "1.0.0"],
  ["tool-1.1.json", "1.1.0"],
  ["tool-2.json", "2.0.0"],
])
  manifests[path!] = manifest("tool", version!);
manifests["other.json"] = manifest("other", "1.0.0");
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
async function manager(name: string) {
  const root = join(work, name);
  const p = new Packages(root);
  await p.addSource("main", url);
  return p;
}

function storedZip(
  entries: { name: string; data?: string; mode?: number }[],
): Buffer {
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc(data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((entry.mode ?? 0x81a4) * 65536) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += header.length + name.length + data.length;
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

describe("version selection and hostile paths", () => {
  test("stable latest, fixed version, major/minor and explicit prerelease", () => {
    const versions = ["1.0.0", "1.2.0", "2.0.0-beta.1", "release-xyz"];
    expect(chooseVersion(versions, "latest")).toBe("1.2.0");
    expect(chooseVersion(versions, "1")).toBe("1.2.0");
    expect(chooseVersion(versions, "1.0")).toBe("1.0.0");
    expect(chooseVersion(versions, "release-xyz")).toBe("release-xyz");
    expect(chooseVersion(versions, "2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(() => chooseVersion(versions, "^1")).toThrow();
  });
  test("Windows path, device and traversal guards", () => {
    for (const p of [
      "../x",
      "C:/x",
      "a\\b",
      "x:ads",
      "CON",
      "dir/../outside",
      "dir/aux.txt",
      "a.",
      "a//b",
    ])
      expect(() => relativeFile(p)).toThrow();
    for (const p of ["con", "nul.txt", "..", "a/b", "name:ads"])
      expect(() => component(p)).toThrow();
    expect(relativeFile("folder/a.exe")).toBe("folder/a.exe");
  });
  test("unsupported executable scripts are rejected rather than run", () => {
    const m = manifest("tool", "1.0.0");
    m.platforms["windows-x64"].bin.tool = "install.cmd";
    expect(() => normalizeManifest(m, "tool", "1.0.0")).toThrow(
      "Native mappings",
    );
  });
});

describe("portable package lifecycle", () => {
  test("install never selects; use switches junction; uninstall retains safety", async () => {
    const p = await manager("lifecycle");
    const a = await p.install("main/tool@1.0.0"),
      b = await p.install("main/tool@2.0.0");
    expect(await exists(join(p.root, "apps", appFolder(a), "current"))).toBe(
      false,
    );
    expect((await p.store.read()).defaults).toEqual({});
    expect(await exists(join(p.root, "apps", "piko", "state.json"))).toBe(true);
    expect(await exists(join(p.root, "state.json"))).toBe(false);
    await p.use("main/tool@1.0.0");
    const current = join(p.root, "apps", appFolder(a), "current");
    expect((await lstat(current)).isSymbolicLink()).toBe(true);
    expect(resolve(await readlink(current)).toLowerCase()).toBe(
      resolve(join(p.root, a.dir)).toLowerCase(),
    );
    await p.use("main/tool@2.0.0");
    expect(resolve(await readlink(current)).toLowerCase()).toBe(
      resolve(join(p.root, b.dir)).toLowerCase(),
    );
    await expect(p.uninstall("main/tool@2.0.0")).rejects.toThrow(
      "default version",
    );
    await p.uninstall("main/tool@2.0.0", true);
    expect(await exists(current)).toBe(false);
    expect(await exists(join(p.root, a.dir, "tool.exe"))).toBe(true);
    expect((await p.store.read()).defaults).toEqual({});
  });
  test("major request survives update and retains old version", async () => {
    const p = await manager("update");
    await p.install("tool@1.0.0");
    await p.use("tool@1");
    const latest = await p.update("tool");
    expect(latest.version).toBe("1.1.0");
    const state = await p.store.read();
    expect(state.defaults[latest.key]?.request).toBe("1");
    expect(Object.keys(state.installs)).toHaveLength(2);
    await p.use("tool@1.0.0");
    expect((await p.update("tool")).version).toBe("1.0.0");
  });
  test("command collision leaves defaults unchanged", async () => {
    const p = await manager("conflict");
    await p.install("tool@1.0.0");
    await p.install("other@1.0.0");
    await p.use("tool@1.0.0");
    const before = await p.store.read();
    await expect(p.use("other@1.0.0")).rejects.toThrow("Command conflict");
    expect(await p.store.read()).toEqual(before);
  });
  test("source ambiguity, source ownership and forced source removal", async () => {
    const p = await manager("sources");
    await p.addSource("second", url + "?second");
    await expect(p.install("tool@1.0.0")).rejects.toThrow("Ambiguous");
    await p.install("main/tool@1.0.0");
    await p.use("main/tool@1");
    await expect(p.removeSource("main")).rejects.toThrow("referenced");
    await p.removeSource("main", true);
    expect(Object.keys((await p.store.read()).installs)).toHaveLength(1);
    await expect(p.update("main/tool")).rejects.toThrow("Original source");
  });
  test("checksum failure and single-operation bypass", async () => {
    const p = await manager("checksums");
    const old = manifests["tool-1.json"];
    const bad = manifest("tool", "1.0.0");
    bad.platforms["windows-x64"].sha256 = "0".repeat(64);
    manifests["tool-1.json"] = bad;
    try {
      await expect(p.install("tool@1.0.0")).rejects.toThrow("SHA-256");
      expect(Object.keys((await p.store.read()).installs)).toHaveLength(0);
      const i = await p.install("tool@1.0.0", true);
      expect(i.verified).toBe(false);
      await expect(p.install("tool@1.0.0")).rejects.toThrow("not verified");
    } finally {
      manifests["tool-1.json"] = old;
    }
  });
  test("source refresh failure does not silently reuse cache", async () => {
    const p = await manager("refresh");
    brokenIndex = true;
    try {
      await expect(p.install("tool@1.0.0")).rejects.toThrow("503");
    } finally {
      brokenIndex = false;
    }
  });
  test("corrupt state and external current directory are never overwritten", async () => {
    const p = await manager("corrupt");
    const i = await p.install("tool@1.0.0");
    const current = join(p.root, "apps", appFolder(i), "current");
    await mkdir(current);
    await writeFile(join(current, "keep"), "external");
    await expect(p.use("tool@1.0.0")).rejects.toThrow("not a managed junction");
    expect(await readFile(join(current, "keep"), "utf8")).toBe("external");
    const bad = join(work, "bad-state");
    await mkdir(join(bad, "apps", "piko"), { recursive: true });
    await writeFile(join(bad, "apps", "piko", "state.json"), "{");
    await expect(new Store(bad).mutate(async () => {})).rejects.toThrow();
    expect(
      await readFile(join(bad, "apps", "piko", "state.json"), "utf8"),
    ).toBe("{");
  });
  test("interrupted uninstall restores files before restoring current", async () => {
    const p = await manager("recover-uninstall"),
      i = await p.install("tool@1.0.0");
    await p.use("tool@1.0.0");
    const before = await p.store.read(),
      after = structuredClone(before);
    after.revision++;
    delete after.installs[i.id];
    delete after.defaults[i.key];
    delete after.commands.tool;
    const trash = "uninstall-" + crypto.randomUUID();
    await mkdir(join(p.root, "staging"), { recursive: true });
    await atomicJson(p.store.removalPath, { installation: i, trash });
    await rename(join(p.root, i.dir), join(p.root, "staging", trash));
    await atomicJson(p.store.journalPath, { before, after });
    await p.store.mutate(async () => {});
    expect(await exists(join(p.root, i.dir, "tool.exe"))).toBe(true);
    expect((await p.store.read()).defaults[i.key]?.id).toBe(i.id);
    expect(await exists(p.store.removalPath)).toBe(false);
  });
  test("completed uninstall journal cleans only its own trash", async () => {
    const p = await manager("cleanup-uninstall"),
      i = await p.install("tool@1.0.0");
    const before = await p.store.read(),
      after = structuredClone(before);
    after.revision++;
    delete after.installs[i.id];
    const trash = "uninstall-" + crypto.randomUUID();
    await mkdir(join(p.root, "staging"), { recursive: true });
    await atomicJson(p.store.removalPath, { installation: i, trash });
    await rename(join(p.root, i.dir), join(p.root, "staging", trash));
    await atomicJson(p.store.statePath, after);
    await p.store.mutate(async () => {});
    expect(await exists(join(p.root, "staging", trash))).toBe(false);
    expect(Object.keys((await p.store.read()).installs)).toHaveLength(0);
  });
  test("persistent directories survive uninstall and ordinary data is not followed", async () => {
    const p = await manager("persistent"),
      old = manifests["tool-1.json"];
    const m = manifest("tool", "1.0.0") as any;
    m.platforms["windows-x64"].persist = ["data/settings"];
    manifests["tool-1.json"] = m;
    try {
      const i = await p.install("tool@1.0.0"),
        data = join(
          p.root,
          "persist",
          persistentFolder(i, i.key),
          "data",
          "settings",
          "keep.txt",
        );
      await writeFile(data, "retained");
      await p.use("tool@1.0.0");
      await p.uninstall("tool@1.0.0", true);
      expect(await readFile(data, "utf8")).toBe("retained");
      expect(await exists(join(p.root, i.dir))).toBe(false);
    } finally {
      manifests["tool-1.json"] = old;
    }
  });
  test("a second writer cannot remove an active lock", async () => {
    const p = await manager("lock");
    await mkdir(join(p.root, "mutation.lock"));
    try {
      await expect(p.install("tool@1.0.0")).rejects.toThrow(
        "holds mutation.lock",
      );
      expect(await exists(join(p.root, "mutation.lock"))).toBe(true);
    } finally {
      await rm(join(p.root, "mutation.lock"), { recursive: true });
    }
  });
  test("interrupted junction switch recovers old selection from journal", async () => {
    const p = await manager("recover");
    const a = await p.install("tool@1.0.0"),
      b = await p.install("tool@2.0.0");
    await p.use("tool@1.0.0");
    const before = await p.store.read(),
      after = structuredClone(before);
    after.revision++;
    after.defaults[a.key] = { id: b.id, request: b.version };
    await atomicJson(p.store.journalPath, { before, after });
    const current = join(p.root, "apps", appFolder(a), "current");
    await rm(current);
    await symlink(resolve(join(p.root, b.dir)), current, "junction");
    await p.store.mutate(async () => {});
    expect((await p.store.read()).defaults[a.key]?.id).toBe(a.id);
    expect(resolve(await readlink(current)).toLowerCase()).toBe(
      resolve(join(p.root, a.dir)).toLowerCase(),
    );
  });
});

describe("ZIP extraction", () => {
  test("safe ZIP strips prefix and writes regular files", async () => {
    const zip = join(work, "safe.zip"),
      dest = join(work, "zip-safe");
    await writeFile(zip, storedZip([{ name: "top/file.txt", data: "safe" }]));
    await extractZip(zip, dest, "top");
    expect(await readFile(join(dest, "file.txt"), "utf8")).toBe("safe");
  });
  test("reject traversal, links, metadata collision and case aliases", async () => {
    const cases = [
      [{ name: "../escape", data: "x" }],
      [{ name: "link", mode: 0xa1ff, data: "../escape" }],
      [{ name: ".piko-install.json", data: "x" }],
      [
        { name: "A.exe", data: "x" },
        { name: "a.exe", data: "y" },
      ],
    ];
    for (let n = 0; n < cases.length; n++) {
      const zip = join(work, `bad-${n}.zip`);
      await writeFile(zip, storedZip(cases[n]!));
      await expect(
        extractZip(zip, join(work, `bad-zip-${n}`)),
      ).rejects.toThrow();
    }
  });
});
