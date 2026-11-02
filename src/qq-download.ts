const ORIGIN = "https://qqdl.gtimg.cn";
const PREFIX = "/qqfile/QQNTV2/";
const SIGN_ENDPOINT =
  "https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign";
const MAX_METADATA = 64 * 1024;

/** Only this publisher-owned public channel needs dynamic authorization. */
export function isQQDownload(url: URL): boolean {
  return (
    url.origin === ORIGIN &&
    url.hostname === "qqdl.gtimg.cn" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith(PREFIX)
  );
}

/** The signature may authorize the fixed artifact, never a different host/path. */
export function validateQQDownload(identity: URL, value: string | URL): URL {
  const url = new URL(value);
  const query = (u: URL) => {
    const params = new URLSearchParams(u.search);
    params.delete("sign");
    params.delete("t");
    params.sort();
    return params.toString();
  };
  if (
    !isQQDownload(identity) ||
    !isQQDownload(url) ||
    url.pathname !== identity.pathname ||
    query(url) !== query(identity) ||
    url.searchParams.getAll("sign").length !== 1 ||
    !/^[a-f0-9]{32,128}$/i.test(url.searchParams.get("sign") ?? "") ||
    url.searchParams.getAll("t").length !== 1 ||
    !/^\d{1,16}$/.test(url.searchParams.get("t") ?? "")
  )
    throw new Error(
      "QQ download signature does not authorize the fixed official artifact",
    );
  return url;
}

/** Per-download, memory-only authorization; concurrent aria2 ranges share it. */
export class QQDownloadSession {
  readonly identity: URL;
  private pending?: Promise<URL>;
  private refreshed = false;
  private readonly fetcher: typeof fetch;

  constructor(value: string | URL, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
    this.identity = new URL(value);
    if (!isQQDownload(this.identity))
      throw new Error("Unsupported QQ download identity");
    this.identity.searchParams.delete("sign");
    this.identity.searchParams.delete("t");
  }

  async resolve(signal?: AbortSignal): Promise<URL> {
    this.pending ??= this.sign(signal);
    return new URL((await this.pending).href);
  }

  async refresh(rejected: URL, signal?: AbortSignal): Promise<URL | undefined> {
    const current = await this.resolve(signal);
    // A parallel range may have already replaced this expired authorization.
    if (current.href !== rejected.href) return current;
    if (this.refreshed) return undefined;
    this.refreshed = true;
    this.pending = this.sign(signal);
    return this.resolve(signal);
  }

  private async sign(signal?: AbortSignal): Promise<URL> {
    const timeout = AbortSignal.timeout(15000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(SIGN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-oidb": '{"uint32_command":"0x9b8e","uint32_service_type":1}',
          Origin: "https://im.qq.com",
          Referer: "https://im.qq.com/index/",
        },
        body: JSON.stringify({ url: this.identity.href }),
        redirect: "manual",
        credentials: "omit",
        signal: bounded,
      });
      if (!response.ok || response.status >= 300) {
        await response.body?.cancel();
        throw new Error("Signing endpoint rejected the request");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing signing response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_METADATA)
            throw new Error("Signing response exceeds limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data?.retcode !== 0 || typeof data.data?.url !== "string")
        throw new Error("Invalid signing response");
      return validateQQDownload(this.identity, data.data.url);
    } catch {
      // Neither upstream exceptions nor returned URLs may disclose signatures.
      throw new Error(
        "QQ official download authorization failed; no unsigned fallback",
      );
    }
  }
}
