import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactBytes } from "../src/cache.ts";
import { download, downloadResponse, sha256 } from "../src/util.ts";
import { isQQDownload, QQDownloadSession } from "../src/qq-download.ts";

const origin = "https://qqdl.gtimg.cn";
const identity =
  origin + "/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe";
const endpoint =
  "https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign";
const signed = (secret = "a".repeat(32), path = identity) =>
  path + "?sign=" + secret + "&t=1793580150";
const authorize = (url = signed()) =>
  Response.json({ retcode: 0, data: { url } });
const urlOf = (input: string | URL | Request) =>
  String(input instanceof Request ? input.url : input);
async function mocked<T>(
  handler: (url: string, options: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    options: RequestInit = {},
  ) => Promise.resolve(handler(urlOf(input), options))) as typeof fetch);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

test("QQ resolver activates only on the exact HTTPS QQNTV2 public download channel", () => {
  expect(isQQDownload(new URL(identity))).toBe(true);
  for (const url of [
    identity.replace("https:", "http:"),
    identity.replace("qqdl.gtimg.cn", "qqdl.gtimg.cn.evil.example"),
    identity.replace("qqdl.gtimg.cn", "qqdl.gtimg.cn."),
    identity.replace("qqdl.gtimg.cn", "qqdl.gtimg.cn:444"),
    identity.replace("qqdl.gtimg.cn", "user:secret@qqdl.gtimg.cn"),
    identity.replace("QQNTV2", "QQNT"),
    identity + "#fragment",
    identity.replace("/qqfile/", "/unrelated/"),
  ])
    expect(isQQDownload(new URL(url))).toBe(false);
});

test("downloads sign the immutable historical URL, omit credentials, and do not fetch latest", async () => {
  const urls: string[] = [];
  const old = identity.replaceAll("9.9.36", "9.9.35");
  await mocked(
    (url, options) => {
      urls.push(url);
      if (url === endpoint) {
        expect(options.method).toBe("POST");
        expect(options.redirect).toBe("manual");
        expect(options.credentials).toBe("omit");
        expect(JSON.parse(String(options.body))).toEqual({ url: old });
        const headers = new Headers(options.headers);
        expect(headers.get("x-oidb")).toBe(
          '{"uint32_command":"0x9b8e","uint32_service_type":1}',
        );
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("cookie")).toBeNull();
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return authorize(signed("a".repeat(32), old));
      }
      expect(url).toBe(signed("a".repeat(32), old));
      return new Response("MZverified old artifact");
    },
    async () =>
      expect(Buffer.from(await download(old)).toString()).toBe(
        "MZverified old artifact",
      ),
  );
  expect(urls).toEqual([endpoint, signed("a".repeat(32), old)]);
});

test("old QQNT and unrelated HTTPS downloads retain the original network behavior", async () => {
  for (const url of [
    identity.replace("QQNTV2", "QQNT"),
    "https://example.com/file.zip",
  ])
    await mocked(
      (target) => {
        expect(target).toBe(url);
        return new Response("original");
      },
      async () =>
        expect(Buffer.from(await download(url)).toString()).toBe("original"),
    );
});

for (const [label, response] of [
  ["different host", signed().replace("qqdl.gtimg.cn", "evil.example")],
  [
    "suffix host",
    signed().replace("qqdl.gtimg.cn", "qqdl.gtimg.cn.evil.example"),
  ],
  ["trailing dot", signed().replace("qqdl.gtimg.cn", "qqdl.gtimg.cn.")],
  ["HTTP", signed().replace("https:", "http:")],
  [
    "credentials",
    signed().replace("qqdl.gtimg.cn", "user:secret@qqdl.gtimg.cn"),
  ],
  ["nonstandard port", signed().replace("qqdl.gtimg.cn", "qqdl.gtimg.cn:444")],
  ["different artifact", signed().replace("e8e54bbb", "other")],
  ["different version", signed().replaceAll("9.9.36", "9.9.35")],
  ["changed query", signed() + "&channel=other"],
  ["fragment", signed() + "#secret"],
  ["missing sign", identity + "?t=1793580150"],
  ["missing timestamp", identity + "?sign=" + "a".repeat(32)],
  ["duplicate sign", signed() + "&sign=" + "b".repeat(32)],
  ["duplicate timestamp", signed() + "&t=1"],
])
  test(
    "QQ signing refuses " +
      label +
      " without fetching that resource or leaking authorization",
    async () => {
      let calls = 0;
      await mocked(
        (url) => {
          calls++;
          expect(url).toBe(endpoint);
          return authorize(response);
        },
        async () => {
          await expect(download(identity)).rejects.toThrow(
            "authorization failed",
          );
        },
      );
      expect(calls).toBe(1);
    },
  );

for (const [name, getResponse] of [
  ["HTTP error", () => new Response("PRIVATE", { status: 403 })],
  [
    "redirect",
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/?secret=PRIVATE" },
      }),
  ],
  [
    "retcode",
    () =>
      Response.json({
        retcode: 1,
        data: { url: signed() },
        error: { message: "PRIVATE" },
      }),
  ],
  ["missing URL", () => Response.json({ retcode: 0, data: {} })],
  ["invalid JSON", () => new Response("PRIVATE")],
  ["oversized metadata", () => new Response("PRIVATE".repeat(10000))],
  [
    "network exception",
    () => {
      throw new Error("PRIVATE " + signed());
    },
  ],
] as const)
  test(
    "QQ signing fails closed for " + name + " with sanitized diagnostics",
    async () => {
      await mocked(
        (url) => {
          expect(url).toBe(endpoint);
          return getResponse();
        },
        async () => {
          let error = "";
          try {
            await download(identity);
          } catch (e) {
            error = String(e);
          }
          expect(error).toContain("authorization failed");
          expect(error).not.toContain("PRIVATE");
          expect(error).not.toContain("sign=");
        },
      );
    },
  );

test("concurrent aria2-style range requests share one authorization and preserve ranges", async () => {
  let signatures = 0,
    downloads = 0;
  await mocked(
    (url, options) => {
      if (url === endpoint) {
        signatures++;
        return authorize();
      }
      downloads++;
      expect(url).toBe(signed());
      expect(new Headers(options.headers).get("range")).toMatch(
        /^bytes=\d+-\d+$/,
      );
      return new Response("MZ", {
        status: 206,
        headers: { "Content-Range": "bytes 0-1/2" },
      });
    },
    async () => {
      const session = new QQDownloadSession(identity);
      const responses = await Promise.all(
        [0, 2, 4, 6, 8].map((n) =>
          downloadResponse(identity, {
            qqSession: session,
            headers: new Headers({ Range: `bytes=${n}-${n + 1}` }),
          }),
        ),
      );
      await Promise.all(responses.map((r) => r.body?.cancel()));
    },
  );
  expect(signatures).toBe(1);
  expect(downloads).toBe(5);
});

test("expired authorization refreshes once without unsigned fallback or query disclosure", async () => {
  let signatures = 0,
    downloads = 0;
  await mocked(
    (url) => {
      if (url === endpoint)
        return authorize(signed((++signatures === 1 ? "a" : "b").repeat(32)));
      downloads++;
      return downloads === 1
        ? new Response(null, { status: 403 })
        : new Response("MZ");
    },
    async () =>
      expect(Buffer.from(await download(identity)).toString()).toBe("MZ"),
  );
  expect(signatures).toBe(2);
  expect(downloads).toBe(2);
  signatures = downloads = 0;
  await mocked(
    (url) => {
      if (url === endpoint) {
        signatures++;
        return authorize();
      }
      downloads++;
      return new Response("PRIVATE", { status: 403 });
    },
    async () => {
      let message = "";
      try {
        await download(identity);
      } catch (e) {
        message = String(e);
      }
      expect(message).toContain("HTTP 403");
      expect(message).not.toContain("sign=");
      expect(message).not.toContain("PRIVATE");
    },
  );
  expect(signatures).toBe(2);
  expect(downloads).toBe(2);
});

test("QQ signed downloads refuse redirects to another host or artifact", async () => {
  for (const location of [
    "https://evil.example/file?secret=PRIVATE",
    signed().replace("e8e54bbb", "other"),
    "http://qqdl.gtimg.cn/file",
  ]) {
    let calls = 0;
    await mocked(
      (url) => {
        calls++;
        if (url === endpoint) return authorize();
        expect(url).toBe(signed());
        return new Response(null, {
          status: 302,
          headers: { Location: location },
        });
      },
      async () => await expect(download(identity)).rejects.toThrow(),
    );
    expect(calls).toBe(2);
  }
});

test("QQ cached bytes avoid signing, tampering fails closed, and signatures never persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "piko-qq-cache-"));
  const bytes = Buffer.from("MZverified QQ artifact"),
    hash = sha256(bytes);
  const savedPath = process.env.PATH,
    savedPath2 = process.env.Path;
  delete process.env.PATH;
  delete process.env.Path;
  try {
    await mkdir(join(root, "cache/artifacts"), { recursive: true });
    await writeFile(join(root, "cache/artifacts", hash), bytes);
    await mocked(
      () => {
        throw new Error("cache hit must not access the network");
      },
      async () =>
        expect(await artifactBytes(root, identity, hash)).toEqual(bytes),
    );
    await rm(join(root, "cache/artifacts", hash));
    await mocked(
      (url) => (url === endpoint ? authorize() : new Response(bytes)),
      async () =>
        expect(await artifactBytes(root, identity, hash)).toEqual(bytes),
    );
    expect(await readFile(join(root, "cache/artifacts", hash))).toEqual(bytes);
    await rm(join(root, "cache/artifacts", hash));
    await mocked(
      (url) => (url === endpoint ? authorize() : new Response("tampered")),
      async () =>
        await expect(artifactBytes(root, identity, hash)).rejects.toThrow(
          "SHA-256 mismatch",
        ),
    );
    expect(await Bun.file(join(root, "cache/artifacts", hash)).exists()).toBe(
      false,
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPath2 === undefined) delete process.env.Path;
    else process.env.Path = savedPath2;
    await rm(root, { recursive: true, force: true });
  }
});

test("QQ downloads retain the existing payload size bound", async () => {
  await mocked(
    (url) =>
      url === endpoint
        ? authorize()
        : new Response("MZtoo large", { headers: { "Content-Length": "11" } }),
    async () =>
      await expect(download(identity, 2)).rejects.toThrow("size limit"),
  );
});
