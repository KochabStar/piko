import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download } from "../src/util.ts";
import {
  cleanText,
  formatBytes,
  ProgressRenderer,
  report,
  TransferRanges,
  withProgress,
  type ProgressEvent,
} from "../src/progress.ts";
import { updateTable } from "../src/display.ts";

const work = await mkdtemp(join(tmpdir(), "piko-progress-"));
const native = await readFile(
  join(process.env.SystemRoot!, "System32/cmd.exe"),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          tool: { latest: "1.0.0", versions: { "1.0.0": "tool.json" } },
        },
      });
    if (path === "/tool.json")
      return Response.json({
        schemaVersion: 1,
        name: "tool",
        version: "1.0.0",
        platforms: {
          "windows-x64": {
            url: `http://127.0.0.1:${server.port}/native`,
            sha256: new Bun.CryptoHasher("sha256").update(native).digest("hex"),
            format: "file",
            file: "tool.exe",
            bin: { tool: "tool.exe" },
          },
        },
      });
    if (path === "/native") return new Response(native);
    if (path === "/error") return new Response("secret", { status: 403 });
    const bytes = Buffer.alloc(4096, 42);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(5);
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 1024));
        offset += 1024;
      },
    });
    return path === "/known" ? new Response(bytes) : new Response(body);
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
});

test("progress rendering is bounded, sanitized, throttled and explicitly completes or fails", () => {
  let now = 0;
  const output: string[] = [];
  const ui = new ProgressRenderer({
    write: (s) => {
      output.push(s);
    },
    tty: true,
    color: false,
    columns: 140,
    now: () => now,
  });
  try {
    ui.event({
      kind: "stage",
      label: "Download",
      detail: "untrusted\x1b[2J\ntext",
    });
    expect(output.join("")).toContain("untrusted?[2J?text");
    const count = output.length;
    for (let i = 0; i < 100; i++)
      ui.event({ kind: "download", received: i, total: 100 });
    expect(output.length).toBe(count);
    now = 1000;
    ui.event({ kind: "download", received: 50, total: 100 });
    expect(output.at(-1)).toContain("50%");
    expect(output.at(-1)).toContain("50 B/s");
    now = 2000;
    ui.event({ kind: "download", received: 100, total: 100 });
    expect(output.at(-1)).toContain("99%");
    ui.event({ kind: "download", received: 100, total: 100, complete: true });
    expect(output.at(-1)).toContain("100%");
    ui.close(true);
    const closed = output.length;
    ui.close(false);
    ui.event({ kind: "stage", label: "ignored" });
    expect(output.length).toBe(closed);
    expect(output.at(-1)).toContain("Completed");
  } finally {
    ui.close(false);
  }
  let plain = "";
  const logs = new ProgressRenderer({
    write: (s) => {
      plain += s;
    },
    tty: false,
    color: false,
    now: () => now,
  });
  logs.event({ kind: "item", package: "main/tool", index: 1, total: 3 });
  logs.event({ kind: "stage", label: "Download" });
  logs.event({ kind: "download", received: 512 });
  logs.close(false);
  expect(plain).toContain("[1/3] main/tool");
  expect(plain).toContain("512 B");
  expect(plain).not.toContain("%");
  expect(plain).not.toContain("ETA");
  expect(plain).not.toMatch(/[\x1b\r]/);
  expect(plain).not.toContain("Completed");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
  expect(cleanText("x\u202ey")).toBe("x?y");
});

test("range progress deduplicates out-of-order overlapping transfers and retries", () => {
  const ranges = new TransferRanges();
  expect(ranges.add(100, 100)).toBe(100);
  expect(ranges.add(0, 50)).toBe(150);
  expect(ranges.add(25, 100)).toBe(200);
  expect(ranges.add(0, 200)).toBe(200);
  expect(ranges.add(250, 50)).toBe(250);
  expect(ranges.add(200, 50)).toBe(300);
});

test("progress contexts are isolated and built-in fetch reports known and unknown byte totals", async () => {
  const a: ProgressEvent[] = [],
    b: ProgressEvent[] = [];
  await Promise.all([
    withProgress(
      (e) => a.push(e),
      async () => {
        await Bun.sleep(10);
        report({ kind: "stage", label: "a" });
      },
    ),
    withProgress(
      (e) => b.push(e),
      async () => {
        report({ kind: "stage", label: "b" });
      },
    ),
  ]);
  expect(a).toEqual([{ kind: "stage", label: "a" }]);
  expect(b).toEqual([{ kind: "stage", label: "b" }]);
  for (const path of ["known", "unknown"]) {
    const events: { received: number; total?: number; complete?: boolean }[] =
      [];
    const bytes = await download(
      `http://127.0.0.1:${server.port}/${path}`,
      8192,
      (received, total, complete) => events.push({ received, total, complete }),
    );
    expect(bytes.length).toBe(4096);
    expect(events.length).toBeGreaterThan(path === "known" ? 1 : 3);
    expect(events.at(-1)).toMatchObject({ received: 4096, complete: true });
    expect(events.at(-1)?.total).toBe(path === "known" ? 4096 : undefined);
  }
  let completed = false;
  await expect(
    download(`http://127.0.0.1:${server.port}/known`, 10, (_n, _t, done) => {
      completed ||= !!done;
    }),
  ).rejects.toThrow("size limit");
  expect(completed).toBe(false);
});

test("compiled CLI progress stays on stderr; JSON, pipes, CI and no-progress remain clean", async () => {
  const home = join(work, "home"),
    exe = join(import.meta.dir, "../dist/piko.exe");
  const run = async (args: string[], expected = 0) => {
    const child = Bun.spawn([exe, ...args], {
      env: { ...process.env, PIKO_HOME: home, NO_COLOR: "1", CI: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== expected)
      throw new Error(
        `${args.join(" ")}: expected ${expected}, got ${code}\n${err}\n${out}`,
      );
    expect(code).toBe(expected);
    return { out, err };
  };
  expect(
    (await run(["source", "add", "main", `http://127.0.0.1:${server.port}/`]))
      .err,
  ).toBe("");
  const installed = await run([
    "install",
    "main/tool@1",
    "--progress",
    "always",
  ]);
  expect(installed.err).toContain("Resolve package");
  expect(installed.err).toContain("Download");
  expect(installed.err).toContain("Verify");
  expect(installed.err).toContain("Commit installation");
  expect(installed.err).not.toMatch(/[\r\x1b]/);
  expect(installed.out).toContain("Installed main/tool@1.0.0");
  const json = await run([
    "install",
    "main/tool@1",
    "--json",
    "--progress",
    "always",
  ]);
  expect(JSON.parse(json.out)).toMatchObject({
    package: "main/tool",
    version: "1.0.0",
    defaultUnchanged: true,
  });
  expect(json.err).toBe("");
  expect((await run(["install", "main/tool@1", "--no-progress"])).err).toBe("");
  expect((await run(["install", "main/tool@1"])).err).toBe("");
  await run(["use", "main/tool@1.0.0"]);
  const update = await run(["update", "--all", "--progress", "always"]);
  expect(update.err).toContain("[1/1] main/tool");
  expect(update.err).toContain("Keep pinned version");
  expect(update.out).toContain("unchanged");
  const updateJson = await run(["update", "--all", "--json"]);
  expect(JSON.parse(updateJson.out)[0].status).toBe("unchanged");
  expect(updateJson.err).toBe("");
  const failure = await run(
    ["install", "main/absent", "--progress", "always"],
    1,
  );
  expect(failure.err).toContain("Failed");
  expect(failure.err).not.toContain("Completed");
  expect((await run(["list", "--progress", "bad"], 1)).err).toContain(
    "auto, always or never",
  );
});

test("update summary preserves failed/blocked reasons and pins without color injection", () => {
  const out = updateTable([
    {
      package: "main/tool",
      current: "1",
      candidate: "2",
      status: "blocked",
      reason: "approval required\nnext",
      request: "latest",
    },
    { package: "main/other", version: "3", status: "unchanged", request: "3" },
  ]);
  expect(out).toContain("1 -> 2");
  expect(out).toContain("approval required?next");
  expect(out).toContain("1 blocked; 1 unchanged");
});
