import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  cp,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ensureSevenZip, sevenZipRelease } from "../src/helpers.ts";
import { emptyState } from "../src/store.ts";
import { extractArchive } from "../src/artifacts.ts";
import { artifactBytes } from "../src/cache.ts";
import {
  downloadArtifact,
  downloadWithAria2,
  findAria2,
} from "../src/downloader.ts";
import { capture, exists, sha256 } from "../src/util.ts";
import { seedSevenZip, aria2Fixture } from "./helper-fixtures.ts";
import type { Install, State } from "../src/types.ts";
import { writeNativeShim } from "../src/shims.ts";

const work = await mkdtemp(join(tmpdir(), "piko-helpers-"));
const aria2 = await aria2Fixture(join(work, "aria2"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
);

async function managedTool(
  root: string,
  state: State,
  name: string,
  command: string,
  executable: string,
) {
  const key = name + "-fixture",
    id = name + "-id",
    dir = join("apps", key, "1.0.0");
  await mkdir(join(root, dir), { recursive: true });
  await cp(executable, join(root, dir, "tool.exe"));
  const installation: Install = {
    id,
    key,
    name,
    version: "1.0.0",
    request: "1",
    dir,
    source: {
      alias: "main",
      type: "http",
      url: "https://example.invalid/",
      identity: "fixture",
    },
    bins: { [command]: { path: "tool.exe", kind: "native" } },
    persist: [],
    verified: true,
    checksum: "fixture",
    manifestHash: "fixture",
    kind: "portable",
  };
  state.installs[id] = installation;
  return installation;
}

test("7-Zip automatically bootstraps from pinned verified assets, reuses its private copy and detects tampering", async () => {
  const root = join(work, "bootstrap"),
    state = emptyState();
  await seedSevenZip(root);
  const before = structuredClone(state),
    executable = await ensureSevenZip(root, state);
  expect(sha256(await readFile(executable))).toBe(
    sevenZipRelease.executableSha256,
  );
  expect(state).toEqual(before);
  expect(executable).toContain(join("apps", "piko", "helpers", "7zip"));
  expect(await ensureSevenZip(root, state)).toBe(executable);
  expect(
    await readFile(join(dirname(executable), "License.txt"), "utf8"),
  ).toContain("7-Zip");
  await writeFile(executable, "tampered");
  await expect(ensureSevenZip(root, state)).rejects.toThrow(
    "checksum mismatch",
  );
  expect(await readdir(join(root, "staging"))).toEqual([]);
});

test("corrupt bootstrap cache is rejected before execution and no helper is published", async () => {
  const root = join(work, "bad-bootstrap");
  await seedSevenZip(root);
  await writeFile(
    join(root, "cache/artifacts", sevenZipRelease.bootstrap.sha256),
    "not an executable",
  );
  await expect(ensureSevenZip(root, emptyState())).rejects.toThrow(
    "checksum mismatch",
  );
  expect(
    await exists(join(root, "apps/piko/helpers/7zip", sevenZipRelease.version)),
  ).toBe(false);
});

test("an installed verified managed 7zip is reused without selecting its default or using an external PATH 7z", async () => {
  const root = join(work, "managed-seven"),
    state = emptyState();
  const bootstrapRoot = join(work, "managed-bootstrap");
  await seedSevenZip(bootstrapRoot);
  const executable = await ensureSevenZip(bootstrapRoot, emptyState());
  const i = await managedTool(root, state, "7zip", "7z", executable);
  expect(await ensureSevenZip(root, state)).toBe(join(root, i.dir, "tool.exe"));
  expect(state.defaults).toEqual({});
  i.verified = false;
  await expect(ensureSevenZip(root, state)).rejects.toThrow(
    "must be checksum-verified",
  );
});

test("real 7-Zip handles directory entries and rejects encrypted archives", async () => {
  const root = join(work, "archive-real");
  await seedSevenZip(root);
  const executable = await ensureSevenZip(root, emptyState()),
    input = join(root, "input");
  await mkdir(join(input, "dir"), { recursive: true });
  await writeFile(join(input, "dir/tool.exe"), "real fixture");
  const archive = join(root, "real.7z");
  await capture(executable, ["a", "-t7z", archive, "dir"], { cwd: input });
  await extractArchive(
    archive,
    "7z",
    join(root, "out"),
    undefined,
    undefined,
    undefined,
    executable,
  );
  expect(await readFile(join(root, "out/dir/tool.exe"), "utf8")).toBe(
    "real fixture",
  );
  const encrypted = join(root, "encrypted.7z");
  await capture(executable, ["a", "-t7z", "-psecret", encrypted, "dir"], {
    cwd: input,
  });
  await expect(
    extractArchive(
      encrypted,
      "7z",
      join(root, "encrypted-out"),
      undefined,
      undefined,
      undefined,
      executable,
    ),
  ).rejects.toThrow("encrypted");
});

test("bounded archive stdout batches preserve file identity across solid blocks, extensions, empty files and Unicode paths", async () => {
  const root = join(work, "solid-batches");
  await seedSevenZip(root);
  const executable = await ensureSevenZip(root, emptyState()),
    input = join(root, "input"),
    files = new Map<string, Buffer>();
  for (let n = 0; n < 270; n++) {
    const path = `folder ${n % 3}/文件-${String(270 - n).padStart(3, "0")}.${["exe", "txt", "dll"][n % 3]}`;
    const bytes = n % 19 === 0 ? Buffer.alloc(0) : Buffer.alloc(256, n % 251);
    files.set(path, bytes);
    await mkdir(dirname(join(input, path)), { recursive: true });
    await writeFile(join(input, path), bytes);
  }
  for (const format of ["7z", "tar"] as const) {
    const archive = join(root, "batch." + format),
      output = join(root, "out-" + format);
    await capture(
      executable,
      [
        "a",
        "-t" + format,
        ...(format === "7z" ? ["-ms=on"] : []),
        archive,
        ".",
      ],
      { cwd: input },
    );
    await extractArchive(
      archive,
      format,
      output,
      undefined,
      undefined,
      undefined,
      executable,
    );
    for (const [path, bytes] of files)
      expect(sha256(await readFile(join(output, path)))).toBe(sha256(bytes));
  }
}, 30000);

test("7-Zip listing validation rejects hostile paths, links, duplicate names, metadata ambiguity and expanded-size bombs", async () => {
  const root = join(work, "hostile-seven");
  await mkdir(root, { recursive: true });
  const source = join(root, "fake.ts"),
    fake = join(root, "fake.exe");
  await writeFile(
    source,
    'import {readFileSync} from "node:fs";import {join,dirname} from "node:path";process.stdout.write(readFileSync(join(dirname(process.execPath),"metadata.txt")));',
  );
  const result = await Bun.build({
    entrypoints: [source],
    compile: { target: "bun-windows-x64", outfile: fake },
  });
  if (!result.success) throw new Error("Fixture executable build failed");
  const block = (path: string, rest = "") =>
    `Path = ${path}\nSize = 1\nAttributes = A\nEncrypted = -\n${rest}`;
  const cases = [
    block("../escape"),
    block("C:/escape"),
    block("file:stream"),
    block(".piko-install.json"),
    block("link", "Symbolic Link = ../outside\n"),
    block("path", "Path = second\n"),
    block("path", "injected newline\n"),
    block("first") + "\n" + block("FIRST"),
    block("file") + "\n" + block("file/child"),
    "Path = tool.exe\nSize = 536870913\nAttributes = A\nEncrypted = -\n",
    "Path = tool.exe\nSize = 1\nAttributes = A\nEncrypted = +\n",
    "Path = link\nSize = 1\nAttributes = A_ lrwxrwxrwx\nEncrypted = -\n",
  ];
  for (const [n, listing] of cases.entries()) {
    await writeFile(join(root, "metadata.txt"), listing);
    await expect(
      extractArchive(
        join(root, "input.7z"),
        "7z",
        join(root, "out-" + n),
        undefined,
        undefined,
        undefined,
        fake,
      ),
    ).rejects.toThrow();
    expect(await exists(join(root, "out-" + n))).toBe(false);
  }
}, 30000);

test("aria2 downloads through validated redirects and cleans temporary files", async () => {
  const root = join(work, "ranges"),
    bytes = Buffer.alloc(16 * 1024 * 1024, 42);
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      if (new URL(request.url).pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "/file?token=private" },
        });
      const range = request.headers.get("range");
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": String(bytes.length),
      };
      if (!range) {
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await Bun.sleep(8);
              if (offset === bytes.length) {
                controller.close();
                return;
              }
              const end = Math.min(offset + 65536, bytes.length);
              controller.enqueue(bytes.subarray(offset, end));
              offset = end;
            },
          }),
          { headers },
        );
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)!;
      const start = Number(match[1]),
        end = match[2] ? Number(match[2]) : bytes.length - 1;
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    },
  });
  try {
    expect(
      sha256(
        await downloadWithAria2(
          root,
          `http://127.0.0.1:${server.port}/redirect?token=private`,
          aria2,
        ),
      ),
    ).toBe(sha256(bytes));
    expect(requests).toBeGreaterThan(1);
    expect(await readdir(join(root, "staging"))).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("aria2 relay tolerates upstream headers delayed beyond Bun default idle timeout", async () => {
  const root = join(work, "slow-headers"),
    bytes = Buffer.from("slow-official-distribution");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch() {
      await Bun.sleep(11000);
      return new Response(bytes, {
        headers: { "Content-Length": String(bytes.length) },
      });
    },
  });
  try {
    expect(
      sha256(
        await downloadWithAria2(
          root,
          `http://127.0.0.1:${server.port}/file`,
          aria2,
        ),
      ),
    ).toBe(sha256(bytes));
    expect(await readdir(join(root, "staging"))).toEqual([]);
  } finally {
    server.stop(true);
  }
}, 60000);

test("aria2 refuses size violations, invalid redirect protocols and raw error secret disclosure", async () => {
  const root = join(work, "aria-errors");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "http://example.com/plain?secret=PRIVATE" },
        });
      if (path === "/size")
        return new Response("long payload", {
          headers: { "Content-Length": "12" },
        });
      return new Response("server error with PRIVATE", { status: 403 });
    },
  });
  try {
    await expect(
      downloadWithAria2(root, `http://127.0.0.1:${server.port}/size`, aria2, 4),
    ).rejects.toThrow("size limit");
    await expect(
      downloadWithAria2(
        root,
        `http://127.0.0.1:${server.port}/redirect`,
        aria2,
      ),
    ).rejects.toThrow("Only HTTPS");
    try {
      await downloadWithAria2(
        root,
        `http://127.0.0.1:${server.port}/error?token=PRIVATE`,
        aria2,
      );
      throw new Error("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("HTTP 403");
      expect(String(error)).not.toContain("PRIVATE");
    }
    expect(await readdir(join(root, "staging"))).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("managed aria2 wins over PATH, cache hits avoid downloads and checksum failure never commits", async () => {
  const root = join(work, "aria-cache"),
    state = emptyState();
  const i = await managedTool(root, state, "aria2", "aria2c", aria2);
  expect(await findAria2(root, state)).toBe(join(root, i.dir, "tool.exe"));
  let requests = 0;
  const bytes = Buffer.from("cached fixture"),
    hash = sha256(bytes);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response(bytes);
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/file`;
    expect(await artifactBytes(root, url, hash, false, state)).toEqual(bytes);
    const count = requests;
    expect(await artifactBytes(root, url, hash, false, state)).toEqual(bytes);
    expect(requests).toBe(count);
    await expect(
      artifactBytes(root, url, "0".repeat(64), false, state),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(await exists(join(root, "cache/artifacts", "0".repeat(64)))).toBe(
      false,
    );
  } finally {
    server.stop(true);
  }
});

test("PATH aria2 is optional and absence retains the built-in downloader", async () => {
  const root = join(work, "path"),
    saved = process.env.PATH,
    savedPath = process.env.Path;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("builtin"),
  });
  try {
    process.env.PATH = "";
    delete process.env.Path;
    expect(await findAria2(root, emptyState())).toBeUndefined();
    expect(
      Buffer.from(
        await downloadArtifact(root, `http://127.0.0.1:${server.port}/file`),
      ).toString(),
    ).toBe("builtin");
    const otherRoot = join(work, "other-piko-root");
    await writeNativeShim(otherRoot, "aria2c");
    process.env.PATH = join(otherRoot, "shims");
    expect(await findAria2(root, emptyState())).toBeUndefined();
    expect(
      Buffer.from(
        await downloadArtifact(root, `http://127.0.0.1:${server.port}/file`),
      ).toString(),
    ).toBe("builtin");
    process.env.PATH = join(otherRoot, "shims") + ";" + dirname(aria2);
    expect(await findAria2(root)).toBe(aria2);
    expect(
      Buffer.from(
        await downloadArtifact(root, `http://127.0.0.1:${server.port}/file`),
      ).toString(),
    ).toBe("builtin");
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    server.stop(true);
  }
});
