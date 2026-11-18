# QQNT official download authorization (0.4.1)

Piko 0.4.1 supports the QQNTV2 public download channel without storing short-lived signed URLs in a source manifest.

- A manifest retains the exact, unsigned `https://qqdl.gtimg.cn/qqfile/QQNTV2/...` artifact URL and expected SHA-256. Historical installs sign their recorded URL, never a newly fetched `latest` URL.
- Just before an uncached download, the built-in downloader requests a signature from the fixed official public `GetSign` endpoint on `im.qq.com`. No account, Cookie, GitHub token or third-party relay is used.
- The signing request is a bounded, 15-second POST with redirects disabled and a 64 KiB response limit. Returned URLs must retain the exact HTTPS CDN origin, resource path and non-signature query parameters; credentials, alternate ports, fragments and duplicate/missing signature fields are rejected.
- Signed values are process-memory-only. Hash-addressed artifact caching, install receipts and manifests retain their existing identities. Exact cached installs do not contact the signing API; online latest discovery may authorize a HEAD request to check freshness without downloading the payload.
- Built-in downloads and the private aria2 range relay use the same resolver. Parallel ranges share one in-flight authorization per download. A 401/403 may refresh authorization once; failure never silently uses an unsigned URL, skips checksums or falls back to another downloader.
- Existing redirect, payload-size and SHA-256 checks remain in force. QQ signed downloads additionally reject cross-host or different-artifact redirects. Error messages omit upstream response bodies and signed URLs.
- Old `QQNT/` artifacts and unrelated downloads keep their original behavior. No manifest schema, dynamic script field or arbitrary request endpoint is introduced.

The source updater has a source-owned equivalent so it can verify full official payloads without depending on adjacent client source. It records only unsigned URLs, validates the extracted native PE version, verifies the official Authenticode signature and checks the complete application resource layout.

## Validation

`tests/qq-download.test.ts` covers public-channel matching, pinned historical versions, credentials boundaries, malicious signed responses, malformed/oversized/error responses, concurrent ranges, bounded expiry refresh, redirects, cache hits, checksum failure and payload bounds. Release-related tests use `VERSION` rather than fixed 0.4.0 expectations; the many-subprocess progress test has a bounded 30-second allowance instead of Bun's five-second default.

An isolated Windows x64 installation using an empty artifact cache installed QQNT `9.9.36.53644` through the compiled 0.4.1 executable, verified the complete 330,446,512-byte download against SHA-256 `63255c70c7ff523e7eed7d52d9708ed7a77ea346ece6474c65dded406edb3155`, checked application resources, selected/resolved `qq` and `qqnt`, and completed `doctor`. QQ GUI, shell extensions, login, services and drivers were not executed. Host user PATH, profiles, accounts and existing installations were not changed. See the source repository's `verification/qqnt-native-install-20261102.json`.

## Upgrade order

Upgrade Piko to 0.4.1 or newer before using a source version that points at QQNTV2. Older clients can still install the retained unsigned legacy QQNT version, but do not know how to authorize the new channel. No third-party download service is deployed or required.

Runtime resolution clears historical SHA-256 values without changing their JSON property position. After payload verification restores the digest and reads the full PE version, an unchanged QQ download retains the exact source manifest hash used by existing installations. This avoids false same-version overwrite conflicts without rewriting installation records or relaxing payload, signature or manifest-content checks.

## Repeated online resolution

QQ and WeChat feeds may report three version components while the verified PE reports four. Piko binds the feed candidate and original URL to the verified exact manifest only after a complete download and all existing payload checks succeed. Freshness uses QQ's strong ETag or WeChat's COS object version ID, observed on both the HEAD probe and the actual download response. WeChat downloads request an explicitly bounded full Range to obtain this metadata. Both built-in downloads and the aria2 relay preserve the same checks.

An unchanged object reuses the saved exact manifest and SHA-256-verified artifact. A changed object still requires full version, layout, digest and declared signature verification; a stable URL alone is never a cache hit. Weak ETags, MD5, timestamps and size alone cannot establish freshness. Missing metadata or an old resumable prefix cannot create a binding. Existing installs without that evidence may need one complete download before subsequent online resolutions can reuse it safely. Offline and exact replay continue to use their saved manifests and trusted cache.

Regression coverage: `tests/helpers.test.ts` exercises both downloaders and identity mismatches; `tests/upstream-payload-installers.test.ts` exercises three-to-four-component versions, stable-URL patch changes, offline replay and corrupted cached payloads.

When a server ignores a nonzero resume Range and returns a complete HTTP 200 body, both downloaders replace the old partial prefix rather than appending duplicate bytes or rejecting an otherwise valid full response. HEAD metadata alone never discards that prefix. The aria2 restart does not create freshness evidence for old bytes; size limits and the caller's SHA-256 verification remain mandatory. Invalid partial-range responses still fail.

Some publishers, including the Baidu Netdisk CDN, send HTTP 200 with a Content-Range covering the complete entity. Both downloaders accept this only when the range starts at zero, ends at total minus one, fits the download ceiling, and agrees with any Content-Length. A partial or malformed HTTP 200 Content-Range is rejected; accepting a complete body never bypasses digest verification.

NSIS files with validated sizes are extracted in bounded batches of at most 128 entries, in archive order, using the existing stdout splitter. This avoids decompressing a solid stream from the beginning for every file. Explicit mappings, per-file and total quotas, empty files and exact output lengths remain enforced; sizeless entries retain individually bounded extraction. The Baidu Netdisk 8.10.3.103 package's 972 mapped files were extracted successfully in approximately 101 seconds without executing its installer.
