# QQNT official download authorization (0.4.1)

Piko 0.4.1 supports the QQNTV2 public download channel without storing short-lived signed URLs in a source manifest.

- A manifest retains the exact, unsigned `https://qqdl.gtimg.cn/qqfile/QQNTV2/...` artifact URL and expected SHA-256. Historical installs sign their recorded URL, never a newly fetched `latest` URL.
- Just before an uncached download, the built-in downloader requests a signature from the fixed official public `GetSign` endpoint on `im.qq.com`. No account, Cookie, GitHub token or third-party relay is used.
- The signing request is a bounded, 15-second POST with redirects disabled and a 64 KiB response limit. Returned URLs must retain the exact HTTPS CDN origin, resource path and non-signature query parameters; credentials, alternate ports, fragments and duplicate/missing signature fields are rejected.
- Signed values are process-memory-only. Hash-addressed artifact caching, install receipts and manifests retain their existing identities. Cache hits do not contact the signing API.
- Built-in downloads and the private aria2 range relay use the same resolver. Parallel ranges share one in-flight authorization per download. A 401/403 may refresh authorization once; failure never silently uses an unsigned URL, skips checksums or falls back to another downloader.
- Existing redirect, payload-size and SHA-256 checks remain in force. QQ signed downloads additionally reject cross-host or different-artifact redirects. Error messages omit upstream response bodies and signed URLs.
- Old `QQNT/` artifacts and unrelated downloads keep their original behavior. No manifest schema, dynamic script field or arbitrary request endpoint is introduced.

The source updater has a source-owned equivalent so it can verify full official payloads without depending on adjacent client source. It records only unsigned URLs, validates the extracted native PE version, verifies the official Authenticode signature and checks the complete application resource layout.

## Validation

`tests/qq-download.test.ts` covers public-channel matching, pinned historical versions, credentials boundaries, malicious signed responses, malformed/oversized/error responses, concurrent ranges, bounded expiry refresh, redirects, cache hits, checksum failure and payload bounds. Release-related tests use `VERSION` rather than fixed 0.4.0 expectations; the many-subprocess progress test has a bounded 30-second allowance instead of Bun's five-second default.

An isolated Windows x64 installation using an empty artifact cache installed QQNT `9.9.36.53644` through the compiled 0.4.1 executable, verified the complete 330,446,512-byte download against SHA-256 `63255c70c7ff523e7eed7d52d9708ed7a77ea346ece6474c65dded406edb3155`, checked application resources, selected/resolved `qq` and `qqnt`, and completed `doctor`. QQ GUI, shell extensions, login, services and drivers were not executed. Host user PATH, profiles, accounts and existing installations were not changed. See the source repository's `verification/qqnt-native-install-20261102.json`.

## Upgrade order

Upgrade Piko to 0.4.1 or newer before using a source version that points at QQNTV2. Older clients can still install the retained unsigned legacy QQNT version, but do not know how to authorize the new channel. No third-party download service is deployed or required.
