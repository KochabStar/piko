import type { Download, Manifest } from "./types.ts";

// This module is deliberately pure: the source updater uses an ESM build of
// exactly this code. Only the injected, bounded network client performs I/O.
export type UpstreamRule = {
  provider:
    | "github-release"
    | "github-tags"
    | "github-file"
    | "node"
    | "go"
    | "claude-code"
    | "qqnt"
    | "nuget"
    | "regex"
    | "json"
    | "redirect"
    | "tabbit"
    | "rustup"
    | "steam"
    | "manual";
  trust: "publisher" | "https";
  repo?: string;
  url?: string;
  path?: string;
  versionRegex?: string;
  assetRegex?: string;
  urlRegex?: string;
  urlTemplate?: string;
  versionTemplate?: string;
  versionPath?: string;
  versionPrefix?: string;
  sha256Path?: string;
  sha512Path?: string;
  md5Path?: string;
  versionFrom?: "asset" | "aria2";
  stripPrefixFromAsset?: boolean;
  versionFromPE?: boolean;
  verifyPEVersion?: boolean;
  signature?: true | string;
  layout?: "lua" | "apptree" | "wecom" | "tabbit" | "qqnt" | "baidu" | "epic";
  required?: string[];
  reason?: string;
  maxBytes?: number;
  maxExpandedBytes?: number;
};
export type UpstreamCandidate = {
  version: string;
  url: string;
  sha256?: string;
  sha512?: string;
  md5?: string;
  provenance: string;
  assetBytes?: number;
  stripPrefix?: string;
  commitChanged?: boolean;
  versionFromPE?: boolean;
};
export type UpstreamNetwork = {
  json(url: string): Promise<unknown>;
  text(url: string): Promise<string>;
  redirect(url: string): Promise<string>;
};
export type UpstreamRequest = string | { version?: string; channel?: string };
type Json = Record<string, any>;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const object = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function component(value: unknown): asserts value is string {
  requireThat(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(value) &&
      !value.includes("..") &&
      !["constructor", "prototype", "__proto__"].includes(value),
    "Unsafe upstream version",
  );
}
function pathName(value: unknown): asserts value is string {
  requireThat(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\\\x00-\x1f:*?"<>|]/.test(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part),
        ),
    "Unsafe upstream payload path",
  );
}
function endpoint(value: unknown): URL {
  requireThat(
    typeof value === "string" &&
      value.length <= 8192 &&
      !/[\x00-\x20\\]/.test(value),
    "Invalid upstream URL",
  );
  const u = new URL(value);
  requireThat(
    !u.username &&
      !u.password &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))),
    "Only HTTPS or loopback HTTP upstream URLs are allowed",
  );
  return u;
}
function safeRegex(value: unknown): asserts value is string {
  requireThat(
    typeof value === "string" && value.length > 0 && value.length <= 1024,
    "Invalid upstream regex length",
  );
  // Reject lookarounds and ambiguous nested repetition. Repeated dotted version
  // groups are permitted because the literal separator makes each iteration
  // unambiguous. Input length and result count are independently bounded below.
  requireThat(
    !/\(\?[=!]|\(\?<([=!])/.test(value),
    "Upstream regex lookarounds are not allowed",
  );
  const groups: { start: number; repeated: boolean; alternation: boolean }[] =
    [];
  let inClass = false;
  for (let n = 0; n < value.length; n++) {
    const c = value[n];
    if (c === "\\") {
      n++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "]") {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (c === "(")
      groups.push({ start: n, repeated: false, alternation: false });
    if (c === "|") for (const g of groups) g.alternation = true;
    requireThat(
      c !== "." || !["*", "+"].includes(value[n + 1]),
      "Unbounded upstream regex wildcards are not allowed",
    );
    if (
      c === "+" ||
      c === "*" ||
      c === "{" ||
      (c === "?" && value[n - 1] !== "(")
    )
      for (const g of groups) g.repeated = true;
    if (c === ")") {
      const g = groups.pop();
      requireThat(g, "Unbalanced upstream regex");
      if (/^[+*{]/.test(value.slice(n + 1))) {
        const body = value.slice(g.start + 1, n).replace(/^\?:/, "");
        requireThat(
          !g.alternation &&
            (!g.repeated ||
              ["\\.[0-9]+", "\\.\\d+", "[.][0-9]+", "[.]\\d+"].includes(body)),
          "Ambiguous nested upstream regex repetition",
        );
      }
    }
  }
  for (const match of value.matchAll(/\{(\d+)(?:,(\d*))?\}/g))
    requireThat(
      Number(match[1]) <= 10000 &&
        (match[2] === undefined ||
          match[2] === "" ||
          Number(match[2]) <= 10000),
      "Upstream regex repetition limit exceeded",
    );
  new RegExp(value);
}
const providerFields: Record<UpstreamRule["provider"], string[]> = {
  "github-release": [
    "repo",
    "versionRegex",
    "assetRegex",
    "versionFrom",
    "stripPrefixFromAsset",
  ],
  "github-tags": ["repo", "versionRegex"],
  "github-file": ["repo", "path"],
  node: [],
  go: [],
  "claude-code": ["url"],
  qqnt: [],
  nuget: ["url", "urlTemplate"],
  rustup: ["url", "urlTemplate"],
  regex: ["url", "versionRegex", "urlTemplate", "versionTemplate"],
  json: [
    "url",
    "versionPath",
    "versionPrefix",
    "sha256Path",
    "sha512Path",
    "md5Path",
    "urlTemplate",
  ],
  redirect: ["url", "versionRegex", "urlTemplate"],
  tabbit: ["url", "urlTemplate"],
  steam: ["url"],
  manual: ["reason"],
};
export function validateUpstreamRule(value: unknown): UpstreamRule {
  requireThat(
    object(value) &&
      typeof value.provider === "string" &&
      Object.hasOwn(providerFields, value.provider),
    "Unknown upstream provider",
  );
  const allowed = new Set([
    "provider",
    "trust",
    "urlRegex",
    "layout",
    "required",
    "signature",
    "versionFromPE",
    "verifyPEVersion",
    "maxBytes",
    "maxExpandedBytes",
    ...providerFields[value.provider as UpstreamRule["provider"]],
  ]);
  for (const key of Object.keys(value))
    requireThat(allowed.has(key), "Unknown upstream rule key: " + key);
  requireThat(
    value.trust === "publisher" || value.trust === "https",
    "Upstream rules require explicit publisher or https trust",
  );
  for (const key of [
    "url",
    "urlTemplate",
    "versionRegex",
    "assetRegex",
    "urlRegex",
    "versionTemplate",
    "versionPath",
    "versionPrefix",
    "sha256Path",
    "sha512Path",
    "md5Path",
    "repo",
    "path",
    "reason",
  ])
    if (value[key] !== undefined)
      requireThat(
        typeof value[key] === "string" && value[key].length <= 8192,
        "Invalid upstream " + key,
      );
  const needed = value.provider.startsWith("github-")
    ? [
        "repo",
        ...(value.provider === "github-file" ? ["path"] : ["versionRegex"]),
        ...(value.provider === "github-release" ? ["assetRegex"] : []),
      ]
    : ["regex", "json", "nuget", "rustup", "tabbit"].includes(value.provider)
      ? [
          "url",
          "urlTemplate",
          ...(value.provider === "regex"
            ? ["versionRegex"]
            : value.provider === "json"
              ? ["versionPath"]
              : []),
        ]
      : value.provider === "redirect"
        ? ["url", "versionRegex"]
        : value.provider === "steam"
          ? ["url"]
          : value.provider === "manual"
            ? ["reason"]
            : [];
  for (const key of needed)
    requireThat(
      typeof value[key] === "string" && value[key].length > 0,
      "Missing upstream " + key,
    );
  if (value.repo !== undefined)
    requireThat(
      /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/.test(
        value.repo,
      ) && !value.repo.includes(".."),
      "Invalid upstream repository",
    );
  if (value.path !== undefined) pathName(value.path);
  if (value.provider === "github-file")
    requireThat(
      value.path
        .split("/")
        .every((part: string) => /^[a-zA-Z0-9_.-]+$/.test(part)),
      "Unsafe upstream repository file path",
    );
  if (value.url !== undefined) endpoint(value.url);
  if (value.urlTemplate !== undefined) {
    const authority = value.urlTemplate.match(/^https?:\/\/([^/]+)/)?.[1];
    requireThat(
      authority && !/[{}]/.test(authority),
      "Upstream URL template must have a literal origin",
    );
    endpoint(value.urlTemplate.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, "1"));
  }
  for (const key of ["versionRegex", "assetRegex", "urlRegex"])
    if (value[key] !== undefined) safeRegex(value[key]);
  const captures = new Set<string>([
    "version",
    "version3",
    "compact",
    "major",
    "minor",
    "patch",
    "build",
  ]);
  for (const key of ["versionRegex", "assetRegex"])
    for (const m of (value[key] ?? "").matchAll(
      /\(\?<([a-zA-Z][a-zA-Z0-9]*)>/g,
    ))
      captures.add(m[1]);
  for (const key of ["urlTemplate", "versionTemplate"])
    if (value[key] !== undefined) {
      const rest = value[key].replace(
        /\{([a-zA-Z][a-zA-Z0-9]*)\}/g,
        (_: string, name: string) => {
          requireThat(
            captures.has(name),
            "Unknown upstream template field: " + name,
          );
          return "1";
        },
      );
      requireThat(!/[{}]/.test(rest), "Malformed upstream template");
      if (key === "versionTemplate") component(rest);
      if (key === "versionTemplate")
        requireThat(
          /\{[a-zA-Z][a-zA-Z0-9]*\}/.test(value[key]),
          "Upstream version template requires a captured field",
        );
    }
  for (const key of ["versionPath", "sha256Path", "sha512Path", "md5Path"])
    if (value[key] !== undefined)
      requireThat(
        value[key].length <= 256 &&
          value[key]
            .split(".")
            .every(
              (p: string) =>
                /^[a-zA-Z0-9_-]+$/.test(p) &&
                !["__proto__", "prototype", "constructor"].includes(p),
            ),
        "Invalid upstream JSON path",
      );
  if (value.versionPrefix !== undefined)
    requireThat(
      /^[a-zA-Z0-9._+-]{0,40}$/.test(value.versionPrefix) &&
        !value.versionPrefix.includes(".."),
      "Invalid upstream version prefix",
    );
  if (value.versionFrom !== undefined)
    requireThat(
      ["asset", "aria2"].includes(value.versionFrom),
      "Invalid upstream versionFrom",
    );
  if (value.versionFrom) {
    requireThat(
      value.assetRegex.includes("(?<version>"),
      "Asset version capture missing",
    );
    if (value.versionFrom === "aria2")
      requireThat(
        value.assetRegex.includes("(?<build>"),
        "Asset build capture missing",
      );
  }
  for (const key of [
    "stripPrefixFromAsset",
    "versionFromPE",
    "verifyPEVersion",
  ])
    if (value[key] !== undefined)
      requireThat(typeof value[key] === "boolean", "Invalid upstream " + key);
  requireThat(
    value.signature === undefined ||
      value.signature === true ||
      typeof value.signature === "string",
    "Invalid upstream signature policy",
  );
  if (typeof value.signature === "string") pathName(value.signature);
  if (value.required !== undefined) {
    requireThat(
      Array.isArray(value.required) &&
        value.required.length > 0 &&
        value.required.length <= 256,
      "Invalid upstream required paths",
    );
    value.required.forEach(pathName);
    requireThat(
      new Set(value.required.map((p: string) => p.toLowerCase())).size ===
        value.required.length,
      "Duplicate upstream required path",
    );
  }
  if (value.layout !== undefined)
    requireThat(
      ["lua", "apptree", "wecom", "tabbit", "qqnt", "baidu", "epic"].includes(
        value.layout,
      ),
      "Invalid upstream layout",
    );
  for (const [key, limit] of [
    ["maxBytes", 2 * GiB],
    ["maxExpandedBytes", 8 * GiB],
  ] as const)
    if (value[key] !== undefined)
      requireThat(
        Number.isSafeInteger(value[key]) &&
          value[key] > 0 &&
          value[key] <= limit,
        "Invalid upstream quota " + key,
      );
  return structuredClone(value) as UpstreamRule;
}

// Numeric comparison does not round long build identifiers through Number.
function numeric(a: string, b: string): number {
  a = a.replace(/^0+(?=\d)/, "");
  b = b.replace(/^0+(?=\d)/, "");
  return a.length !== b.length
    ? Math.sign(a.length - b.length)
    : a < b
      ? -1
      : a > b
        ? 1
        : 0;
}
function preRelease(version: string): string | undefined {
  // Date-and-commit identities are stable snapshots, not prerelease labels.
  if (/^0[.][0-9]{4}[.][0-9]{2}[.][0-9]{2}-[a-f0-9]{8}$/.test(version))
    return undefined;
  return (
    version
      .match(
        /(?:^|[-.])((?:alpha|beta|rc|pre|preview|canary|nightly|dev|next)[a-z0-9.-]*)/i,
      )?.[1]
      .toLowerCase() ??
    (/-piko\.[0-9]+$/.test(version)
      ? undefined
      : version
          .match(/^\d+(?:\.\d+)*-([a-zA-Z][a-zA-Z0-9.-]*)/)?.[1]
          .toLowerCase())
  );
}
export function compareVersions(a: string, b: string): number {
  const strip = (s: string) => s.replace(/^v(?=\d)/, "").replace(/\+.*/, "");
  const x = strip(String(a)),
    y = strip(String(b));
  const xp = preRelease(x),
    yp = preRelease(y);
  const main = (s: string, p?: string) =>
    (p ? s.slice(0, s.toLowerCase().indexOf(p)).replace(/[-.]$/, "") : s).match(
      /\d+/g,
    ) ?? [];
  const xs = main(x, xp),
    ys = main(y, yp);
  for (let n = 0; n < Math.max(xs.length, ys.length); n++) {
    const result = numeric(xs[n] ?? "0", ys[n] ?? "0");
    if (result) return result;
  }
  if (!!xp !== !!yp) return xp ? -1 : 1;
  if (xp && yp) {
    const xx = xp.match(/\d+|[^\d]+/g)!,
      yy = yp.match(/\d+|[^\d]+/g)!;
    for (let n = 0; n < Math.max(xx.length, yy.length); n++) {
      if (xx[n] === undefined) return -1;
      if (yy[n] === undefined) return 1;
      const result =
        /^\d+$/.test(xx[n]) && /^\d+$/.test(yy[n])
          ? numeric(xx[n], yy[n])
          : xx[n] < yy[n]
            ? -1
            : xx[n] > yy[n]
              ? 1
              : 0;
      if (result) return result;
    }
  }
  return 0;
}
export function render(
  template: string,
  values: Record<string, unknown>,
): string {
  const version = String(values.version ?? ""),
    parts = version.split(".");
  const v: Record<string, unknown> = {
    ...values,
    compact: version.replaceAll(".", ""),
    version3: parts.slice(0, 3).join("."),
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    build: version.split("-").at(-1),
  };
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => {
    requireThat(
      v[key] !== undefined &&
        /^(?:[a-zA-Z0-9._+-]+)$/.test(String(v[key])) &&
        !String(v[key]).includes(".."),
      "Unresolved or unsafe upstream template " + key,
    );
    return String(v[key]);
  });
}
const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        object(v) || Array.isArray(v)
          ? Object.hasOwn(v, key)
            ? (v as Json)[key]
            : undefined
          : undefined,
      value,
    );
const fromMatch = (match: RegExpMatchArray): string | undefined =>
  match.groups?.version ?? match[1];
function list(value: unknown, label: string): Json[] {
  requireThat(
    Array.isArray(value) && value.length <= 10000 && value.every(object),
    "Invalid upstream " + label,
  );
  return value;
}
function digest(value: unknown, bits: 128 | 256 | 512): string {
  requireThat(typeof value === "string", "Invalid upstream digest");
  if (bits === 512 && /^[a-zA-Z0-9+/]{85}[AQgw]==$/.test(value)) {
    requireThat(!/^A+==$/.test(value), "Zero upstream digest is forbidden");
    return value;
  }
  requireThat(
    new RegExp("^[a-f0-9]{" + bits / 4 + "}$", "i").test(value) &&
      !/^0+$/.test(value),
    "Invalid or zero upstream digest",
  );
  return value.toLowerCase();
}
function selection(
  request?: UpstreamRequest,
): (version: string, prerelease?: boolean) => boolean {
  const raw = typeof request === "string" ? request : request?.version;
  const channel = typeof request === "object" ? request.channel : undefined;
  const aliases = [
    "latest",
    "stable",
    "prerelease",
    "next",
    "beta",
    "alpha",
    "rc",
    "nightly",
    "canary",
    "dev",
  ];
  if (raw !== undefined) component(raw);
  if (channel !== undefined)
    requireThat(
      aliases.includes(channel),
      "Unsupported upstream channel: " + channel,
    );
  const wanted = raw && !aliases.includes(raw) ? raw : undefined;
  const mode =
    channel ??
    (raw && aliases.includes(raw)
      ? raw
      : wanted && preRelease(wanted)
        ? "prerelease"
        : "stable");
  return (version, prerelease = !!preRelease(version)) => {
    component(version);
    if (["stable", "latest"].includes(mode) && prerelease) return false;
    if (["next", "prerelease"].includes(mode) && !prerelease) return false;
    if (
      !["stable", "latest", "next", "prerelease"].includes(mode) &&
      !new RegExp("(?:^|[-.])" + mode + "(?:[0-9.-]|$)", "i").test(version)
    )
      return false;
    if (!wanted) return true;
    return /^\d+(?:\.\d+)?$/.test(wanted)
      ? version === wanted || version.startsWith(wanted + ".")
      : version === wanted;
  };
}
function steamKV(text: string) {
  type KV = { values: Map<string, string>; blocks: Map<string, KV> };
  let pos = 0;
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const string = () => {
    requireThat(text[pos] === '"', "Steam manifest string expected");
    const end = text.indexOf('"', pos + 1);
    requireThat(end > pos, "Steam manifest string is truncated");
    const value = text.slice(pos + 1, end);
    pos = end + 1;
    return value;
  };
  const body = (depth: number): KV => {
    requireThat(depth < 32, "Steam manifest nesting limit exceeded");
    const values = new Map<string, string>(),
      blocks = new Map<string, KV>();
    for (;;) {
      skip();
      if (pos >= text.length) {
        requireThat(depth === 0, "Steam manifest KV is truncated");
        return { values, blocks };
      }
      if (text[pos] === "}") {
        requireThat(depth > 0, "Steam manifest KV has stray closing braces");
        pos++;
        return { values, blocks };
      }
      const key = string();
      skip();
      requireThat(
        !values.has(key) && !blocks.has(key),
        "Duplicate Steam manifest key: " + key,
      );
      if (text[pos] === "{") {
        pos++;
        blocks.set(key, body(depth + 1));
      } else values.set(key, string());
    }
  };
  return body(0);
}

export async function discover(
  input: UpstreamRule,
  current: Manifest,
  network: UpstreamNetwork,
  request?: UpstreamRequest,
): Promise<UpstreamCandidate> {
  const rule = validateUpstreamRule(input),
    accepts = selection(request);
  requireThat(
    rule.provider !== "manual",
    "Manual upstream policy: " + rule.reason,
  );
  const net = {
    async json(url: string): Promise<any> {
      endpoint(url);
      const value = await network.json(url),
        pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
      let nodes = 0,
        chars = 0;
      while (pending.length) {
        const item = pending.pop()!;
        requireThat(
          ++nodes <= 200000 && item.depth <= 32,
          "Upstream JSON structure exceeds discovery quota",
        );
        if (typeof item.value === "string") {
          chars += item.value.length;
          requireThat(
            item.value.length <= 4 * MiB && chars <= 16 * MiB,
            "Upstream JSON text exceeds discovery quota",
          );
        } else if (item.value !== null && typeof item.value === "object") {
          const values = Array.isArray(item.value)
            ? item.value
            : Object.values(item.value);
          requireThat(
            values.length <= 10000,
            "Upstream JSON collection exceeds discovery quota",
          );
          for (const child of values)
            pending.push({ value: child, depth: item.depth + 1 });
        } else
          requireThat(
            item.value === null ||
              typeof item.value === "number" ||
              typeof item.value === "boolean",
            "Invalid upstream JSON value",
          );
      }
      return value;
    },
    async text(url: string): Promise<string> {
      endpoint(url);
      const text = await network.text(url);
      requireThat(
        typeof text === "string" && text.length <= 4 * MiB,
        "Upstream text exceeds discovery quota",
      );
      return text;
    },
    async redirect(url: string): Promise<string> {
      endpoint(url);
      const result = await network.redirect(url);
      endpoint(result);
      return result;
    },
  };
  const choose = <T extends { version: string; prerelease?: boolean }>(
    values: T[],
  ): T => {
    const found = values.filter((v) =>
      accepts(v.version, v.prerelease ?? !!preRelease(v.version)),
    );
    requireThat(
      found.length > 0,
      "No upstream release satisfies the requested version/channel",
    );
    found.sort((a, b) => compareVersions(b.version, a.version));
    return found[0];
  };
  const api = "https://api.github.com/repos/";
  let version: string | undefined,
    url: string | undefined,
    sha256: string | undefined,
    sha512: string | undefined,
    md5: string | undefined,
    provenance = rule.url;
  const extra: Partial<UpstreamCandidate> = {};
  let selectedPrerelease: boolean | undefined;
  if (rule.provider === "github-release") {
    // Unconstrained stable discovery follows the publisher's latest channel.
    // Constraints require enumeration and never substitute an invented URL.
    const releases: Json[] = [];
    const requestedVersion =
      typeof request === "string" ? request : request?.version;
    const requestedChannel =
      typeof request === "object" ? request.channel : undefined;
    if (
      (!requestedVersion || ["latest", "stable"].includes(requestedVersion)) &&
      (!requestedChannel || ["latest", "stable"].includes(requestedChannel))
    ) {
      try {
        const latest = await net.json(api + rule.repo + "/releases/latest");
        if (
          object(latest) &&
          !latest.draft &&
          !latest.prerelease &&
          typeof latest.tag_name === "string" &&
          new RegExp(rule.versionRegex!).test(latest.tag_name)
        )
          releases.push(latest);
      } catch {
        // Some repositories publish releases but do not expose /latest. Only
        // the bounded official release listing can replace that channel.
      }
    }
    if (!releases.length)
      for (let page = 1; page <= 10; page++) {
        const batch = list(
          await net.json(
            api + rule.repo + "/releases?per_page=100&page=" + page,
          ),
          "GitHub releases",
        );
        releases.push(...batch);
        if (batch.length < 100) break;
        requireThat(page < 10, "GitHub release enumeration exceeded quota");
      }
    if (!rule.versionFrom) {
      const eligible = releases
        .flatMap((release) => {
          const match =
            !release.draft && typeof release.tag_name === "string"
              ? new RegExp(rule.versionRegex!).exec(release.tag_name)
              : null;
          const version = match && fromMatch(match)?.replaceAll("_", ".");
          return version &&
            accepts(version, !!release.prerelease || !!preRelease(version))
            ? [{ version, release }]
            : [];
        })
        .sort((a, b) => compareVersions(b.version, a.version));
      requireThat(
        eligible.length > 0,
        "No upstream release satisfies the requested version/channel",
      );
      requireThat(
        eligible.length === 1 || eligible[0].version !== eligible[1].version,
        "Ambiguous GitHub release version",
      );
      releases.splice(0, releases.length, eligible[0].release);
    }
    const found: {
      version: string;
      prerelease: boolean;
      release: Json;
      assets: Json[];
      asset?: Json;
    }[] = [];
    for (const release of releases) {
      if (release.draft || typeof release.tag_name !== "string") continue;
      const tag = new RegExp(rule.versionRegex!).exec(release.tag_name);
      if (!tag) continue;
      const tagVersion = fromMatch(tag)?.replaceAll("_", ".");
      requireThat(tagVersion, "GitHub tag has no version capture");
      // Apply tag constraints early except where the asset declares the actual version.
      if (
        !rule.versionFrom &&
        !accepts(tagVersion, !!release.prerelease || !!preRelease(tagVersion))
      )
        continue;
      if (rule.versionFrom && release.prerelease && !accepts(tagVersion, true))
        continue;
      const assets = list(release.assets, "GitHub assets").filter(
        (a) =>
          typeof a.name === "string" &&
          new RegExp(rule.assetRegex!).test(a.name),
      );
      if (assets.length === 0) {
        // Retain the missing release in ordering: a newer broken channel must
        // never silently fall back to an older indexed or downloadable version.
        found.push({
          version: tagVersion,
          prerelease: !!release.prerelease,
          release,
          assets,
        });
        continue;
      }
      for (const asset of assets) {
        const match = new RegExp(rule.assetRegex!).exec(asset.name)!;
        const assetVersion =
          rule.versionFrom === "aria2"
            ? match.groups?.version + "-" + match.groups?.build
            : rule.versionFrom === "asset"
              ? match.groups?.version
              : tagVersion;
        component(assetVersion);
        found.push({
          version: assetVersion,
          prerelease: !!release.prerelease || !!preRelease(assetVersion),
          release,
          asset,
          assets,
        });
      }
    }
    const selected = choose(found),
      { release, asset } = selected;
    requireThat(
      selected.assets.length === 1 && asset,
      "Missing or ambiguous Windows release asset",
    );
    requireThat(
      found.filter(
        (item) =>
          item.version === selected.version &&
          item.release !== selected.release,
      ).length === 0,
      "Ambiguous GitHub release version",
    );
    version = selected.version;
    selectedPrerelease = selected.prerelease;
    url = asset.browser_download_url;
    const u = endpoint(url);
    requireThat(
      u.origin === "https://github.com" &&
        u.pathname.startsWith("/" + rule.repo + "/releases/download/") &&
        !u.search,
      "Release asset escaped its official repository",
    );
    if (
      asset.digest !== undefined &&
      asset.digest !== null &&
      asset.digest !== ""
    ) {
      requireThat(
        typeof asset.digest === "string" && asset.digest.startsWith("sha256:"),
        "Unsupported GitHub asset digest",
      );
      sha256 = digest(asset.digest.slice(7), 256);
    }
    requireThat(
      Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= (rule.maxBytes ?? 2 * GiB),
      "Invalid GitHub asset size",
    );
    extra.assetBytes = asset.size;
    if (rule.stripPrefixFromAsset)
      extra.stripPrefix = asset.name.replace(/\.zip$/i, "");
    provenance =
      "https://github.com/" +
      rule.repo +
      "/releases/tag/" +
      encodeURIComponent(release.tag_name);
  } else if (rule.provider === "github-tags") {
    const tags: Json[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = list(
        await net.json(api + rule.repo + "/tags?per_page=100&page=" + page),
        "GitHub tags",
      );
      tags.push(...batch);
      if (batch.length < 100) break;
      requireThat(page < 10, "GitHub tag enumeration exceeded quota");
    }
    const found = tags.flatMap((tag) => {
      const match =
        typeof tag.name === "string"
          ? new RegExp(rule.versionRegex!).exec(tag.name)
          : null;
      const version = match && fromMatch(match);
      return version ? [{ version, tag }] : [];
    });
    const chosen = choose(found),
      commit = chosen.tag.commit?.sha;
    requireThat(
      typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit),
      "Invalid tag commit",
    );
    version = chosen.version;
    url = "https://github.com/" + rule.repo + "/archive/" + commit + ".zip";
    extra.stripPrefix = rule.repo!.split("/")[1] + "-" + commit;
    provenance = "https://github.com/" + rule.repo + "/tree/" + commit;
  } else if (rule.provider === "github-file") {
    const commits = list(
      await net.json(
        api +
          rule.repo +
          "/commits?path=" +
          encodeURIComponent(rule.path!) +
          "&per_page=1",
      ),
      "GitHub commits",
    );
    const c = commits[0];
    requireThat(
      c && typeof c.sha === "string" && /^[a-f0-9]{40}$/.test(c.sha),
      "Invalid file commit",
    );
    const date = c.commit?.committer?.date?.slice(0, 10);
    requireThat(
      typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date),
      "Invalid commit date",
    );
    const pinned = current.platforms["windows-x64"];
    const old = pinned.downloads?.[0]?.url ?? pinned.url;
    url =
      "https://raw.githubusercontent.com/" +
      rule.repo +
      "/" +
      c.sha +
      "/" +
      rule.path;
    version =
      old === url
        ? current.version
        : "0." + date.replaceAll("-", ".") + "-" + c.sha.slice(0, 8);
    extra.commitChanged = old !== url;
    provenance = "https://github.com/" + rule.repo + "/commit/" + c.sha;
  } else if (rule.provider === "claude-code") {
    const base = "https://downloads.claude.ai/claude-code-releases";
    requireThat(
      !rule.url || rule.url === base + "/latest",
      "Claude Code feed escaped official channel",
    );
    version = (await net.text(base + "/latest")).trim();
    requireThat(
      /^\d+\.\d+\.\d+$/.test(version),
      "Invalid Claude Code stable version",
    );
    const manifestURL = base + "/" + version + "/manifest.json",
      manifest = await net.json(manifestURL),
      platform = manifest?.platforms?.["win32-x64"];
    requireThat(
      manifest?.version === version &&
        platform?.binary === "claude.exe" &&
        Number.isSafeInteger(platform.size) &&
        platform.size > 0 &&
        platform.size <= 2 * GiB,
      "Invalid Claude Code Windows x64 manifest",
    );
    sha256 = digest(platform.checksum, 256);
    url = base + "/" + version + "/win32-x64/claude.exe";
    extra.assetBytes = platform.size;
    provenance = manifestURL;
  } else if (rule.provider === "node") {
    const releases = list(
      await net.json("https://nodejs.org/dist/index.json"),
      "Node releases",
    );
    const r = choose(
      releases
        .filter(
          (r) =>
            /^v\d+\.\d+\.\d+$/.test(r.version) &&
            Array.isArray(r.files) &&
            r.files.includes("win-x64-zip"),
        )
        .map((r) => ({ version: r.version.slice(1) })),
    );
    version = r.version;
    const file = "node-v" + version + "-win-x64.zip";
    url = "https://nodejs.org/dist/v" + version + "/" + file;
    const sums = (
      await net.text("https://nodejs.org/dist/v" + version + "/SHASUMS256.txt")
    )
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[1] === file);
    requireThat(sums.length === 1, "Official Node SHA256 missing or ambiguous");
    sha256 = digest(sums[0][0], 256);
    provenance = "https://nodejs.org/dist/index.json";
  } else if (rule.provider === "go") {
    const releases = list(
      await net.json("https://go.dev/dl/?mode=json&include=all"),
      "Go releases",
    );
    const r = choose(
      releases
        .filter((r) => r.stable && /^go\d+\.\d+\.\d+$/.test(r.version))
        .map((r) => ({ version: r.version.slice(2), release: r })),
    );
    const files = list(r.release.files, "Go files").filter(
      (f) =>
        f.os === "windows" &&
        f.arch === "amd64" &&
        f.kind === "archive" &&
        typeof f.filename === "string" &&
        /^go[a-zA-Z0-9.-]+\.windows-amd64\.zip$/.test(f.filename),
    );
    requireThat(files.length === 1, "Missing or ambiguous Windows Go release");
    version = r.version;
    sha256 = digest(files[0].sha256, 256);
    url = "https://dl.google.com/go/" + files[0].filename;
    provenance = "https://go.dev/dl/?mode=json&include=all";
  } else if (rule.provider === "nuget") {
    let page: string | undefined = rule.url;
    const pages = new Set<string>(),
      entries: string[] = [];
    while (page) {
      requireThat(
        !pages.has(page) && pages.size < 10,
        "Gallery pagination exceeded limit",
      );
      const origin = endpoint(rule.url!),
        next = endpoint(page);
      requireThat(
        next.origin === origin.origin && next.pathname === origin.pathname,
        "Gallery pagination escaped publisher API",
      );
      pages.add(page);
      const xml = await net.text(page);
      entries.push(
        ...[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]),
      );
      requireThat(entries.length <= 10000, "Gallery entry quota exceeded");
      page = xml
        .match(/<link[^>]*rel="next"[^>]*href="([^"]+)"/)?.[1]
        .replaceAll("&amp;", "&");
    }
    const selected = choose(
      entries.flatMap((entry) => {
        const version = entry.match(
          /<d:Version>([0-9]+(?:\.[0-9]+)+(?:-[a-zA-Z0-9.-]+)?)<\/d:Version>/,
        )?.[1];
        return version ? [{ version, entry }] : [];
      }),
    );
    version = selected.version;
    const algorithm = selected.entry.match(
      /<d:PackageHashAlgorithm>([^<]+)<\/d:PackageHashAlgorithm>/,
    )?.[1];
    if (algorithm === "SHA512")
      sha512 = digest(
        selected.entry.match(/<d:PackageHash>([^<]+)<\/d:PackageHash>/)?.[1],
        512,
      );
    url = render(rule.urlTemplate!, { version });
  } else if (rule.provider === "rustup") {
    const toml = await net.text(rule.url!);
    version = toml.match(/^version\s*=\s*['"]([0-9.]+)['"]/m)?.[1];
    requireThat(version, "Rustup stable version missing");
    url = render(rule.urlTemplate!, { version });
    sha256 = digest(
      (await net.text(url + ".sha256")).match(/^[a-f0-9]{64}/i)?.[0],
      256,
    );
  } else if (rule.provider === "regex") {
    const text = (await net.text(rule.url!))
      .replaceAll("&amp;", "&")
      .replaceAll("\\u002F", "/")
      .replaceAll("\\/", "/");
    const matches: { version: string; groups: Record<string, string> }[] = [];
    for (const match of text.matchAll(new RegExp(rule.versionRegex!, "g"))) {
      requireThat(
        matches.length < 10000,
        "Upstream regex match quota exceeded",
      );
      const captured = fromMatch(match),
        groups = { ...match.groups };
      const version = rule.versionTemplate
        ? render(rule.versionTemplate, { ...groups, version: captured })
        : captured;
      component(version);
      matches.push({ version, groups });
    }
    const chosen = choose(matches);
    version = chosen.version;
    const urls = new Set(
      matches
        .filter((m) => m.version === version)
        .map((m) => render(rule.urlTemplate!, { ...m.groups, version })),
    );
    requireThat(urls.size === 1, "Ambiguous upstream payload for version");
    url = [...urls][0];
  } else if (rule.provider === "qqnt") {
    const configURL =
        "https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json",
      data = await net.json(configURL),
      windows = data?.Windows;
    const official = endpoint(windows?.ntDownloadX64Url);
    const match =
      /^\/qqfile\/QQNTV2\/(?<version>\d+\.\d+\.\d+)\/release\/[a-f0-9]+\/QQ_\k<version>_\d{6}_x64_\d+\.exe$/.exec(
        official.pathname,
      );
    requireThat(
      official.origin === "https://qqdl.gtimg.cn" &&
        !official.search &&
        match &&
        windows.version === match.groups?.version,
      "QQ download escaped the official version-bound Windows x64 channel",
    );
    version = windows.version;
    url = official.href;
    provenance = configURL;
  } else if (rule.provider === "json") {
    const data = await net.json(rule.url!),
      raw = at(data, rule.versionPath!);
    requireThat(
      typeof raw === "string" ||
        (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0),
      "Invalid upstream version field",
    );
    version = (rule.versionPrefix ?? "") + raw;
    if (rule.sha256Path) sha256 = digest(at(data, rule.sha256Path), 256);
    if (rule.sha512Path) sha512 = digest(at(data, rule.sha512Path), 512);
    if (rule.md5Path) md5 = digest(at(data, rule.md5Path), 128);
    url = render(rule.urlTemplate!, { version });
  } else if (rule.provider === "redirect") {
    const resolved = await net.redirect(rule.url!),
      match = new RegExp(rule.versionRegex!).exec(resolved);
    requireThat(match, "Upstream redirect does not identify an exact release");
    version = fromMatch(match);
    component(version);
    url = rule.urlTemplate ? render(rule.urlTemplate, { version }) : resolved;
    if (rule.urlTemplate)
      requireThat(
        endpoint(resolved).origin === endpoint(url).origin,
        "Upstream redirect escaped delegated payload origin",
      );
    else
      requireThat(
        endpoint(resolved).origin === endpoint(rule.url!).origin,
        "Cross-origin upstream redirect requires an explicit URL template",
      );
  } else if (rule.provider === "tabbit") {
    const data = await net.json(rule.url!),
      releases = list(
        Array.isArray(data) ? data : data?.versions,
        "Tabbit releases",
      );
    version = choose(
      releases
        .filter(
          (r) =>
            r.platform === "windows" &&
            typeof r.arch === "string" &&
            ["x86_64", "amd64", "x64"].includes(r.arch.toLowerCase()) &&
            /^\d+(?:\.\d+){3}$/.test(r.version ?? r.short_version_string),
        )
        .map((r) => ({ version: r.version ?? r.short_version_string })),
    ).version;
    url = render(rule.urlTemplate!, { version });
  } else if (rule.provider === "steam") {
    const channel = steamKV(await net.text(rule.url!)).blocks.get("win32");
    requireThat(channel, "Steam win32 bootstrap channel missing");
    const stamp = channel.values.get("version");
    requireThat(
      stamp &&
        /^\d+$/.test(stamp) &&
        Number(stamp) > 1600000000 &&
        Number.isSafeInteger(Number(stamp)) &&
        Number(stamp) * 1000 < Date.now() + 86400000,
      "Steam bootstrap channel version is not a current timestamp",
    );
    const bootstrapper = channel.blocks.get("steam_win32"),
      file = bootstrapper?.values.get("file"),
      row = bootstrapper?.blocks.get("steamrow");
    sha256 = digest(bootstrapper?.values.get("sha2"), 256);
    requireThat(
      file &&
        /^steam_win32\.zip\.[0-9a-f]{40}$/.test(file) &&
        bootstrapper?.values.get("IsBootstrapperPackage") === "1" &&
        row?.values.get("IsBootstrapperPackage") === "1" &&
        row.values.get("file")?.split(".").at(-1) === file.split(".").at(-1) &&
        row.values.get("sha2")?.toLowerCase() === sha256,
      "Steam bootstrapper is not the pinned international row payload",
    );
    url = new URL(file, rule.url!).href;
    const p = current.platforms["windows-x64"],
      pinned = p.downloads?.[0]?.url ?? p.url;
    version = pinned === url ? current.version : stamp;
  }
  component(version);
  requireThat(
    url &&
      provenance &&
      accepts(version, selectedPrerelease ?? !!preRelease(version)),
    "Upstream release does not satisfy requested version/channel",
  );
  endpoint(url);
  endpoint(provenance);
  if (rule.urlTemplate)
    requireThat(
      endpoint(url).origin ===
        endpoint(rule.urlTemplate.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, "1"))
          .origin,
      "Upstream payload escaped delegated origin",
    );
  if (rule.urlRegex)
    requireThat(
      new RegExp(rule.urlRegex).test(url),
      "Upstream payload URL violates source constraint",
    );
  if (extra.stripPrefix) pathName(extra.stripPrefix);
  const candidate: UpstreamCandidate = {
    version,
    url,
    provenance,
    ...extra,
    versionFromPE: !!rule.versionFromPE,
  };
  if (sha256 !== undefined) candidate.sha256 = sha256;
  if (sha512 !== undefined) candidate.sha512 = sha512;
  if (md5 !== undefined) candidate.md5 = md5;
  assertImmutable(current, candidate);
  return candidate;
}

function assertImmutable(
  current: Manifest,
  candidate: UpstreamCandidate,
): void {
  if (candidate.version !== current.version) return;
  const platform = current.platforms["windows-x64"],
    downloads = platform.downloads ?? [platform];
  const first = downloads[0];
  requireThat(
    first.url === candidate.url,
    "Same-version upstream payload URL is immutable",
  );
  if (candidate.sha256 && first.sha256)
    requireThat(
      first.sha256.toLowerCase() === candidate.sha256.toLowerCase(),
      "Same-version upstream payload digest is immutable",
    );
}

export function nextManifest(
  current: Manifest,
  candidate: UpstreamCandidate,
  input: UpstreamRule,
): Manifest {
  const rule = validateUpstreamRule(input);
  component(candidate.version);
  endpoint(candidate.url);
  if (candidate.sha256 !== undefined) digest(candidate.sha256, 256);
  assertImmutable(current, candidate);
  const next = structuredClone(current),
    p = next.platforms["windows-x64"];
  requireThat(p, "Upstream recipe is missing Windows x64 distribution");
  next.version = candidate.version;
  const upstream = current.version.replace(/-piko\.[0-9]+$/, "");
  const updatePath = (s: string): string => {
    if (upstream === current.version)
      return s.replaceAll(current.version, candidate.version);
    // Match the longer repack spelling first; replacing the base first would
    // leave an obsolete -piko.N suffix attached to the next release.
    return s
      .split(current.version)
      .map((part) => part.replaceAll(upstream, candidate.version))
      .join(candidate.version);
  };
  const oldPlatform = current.platforms["windows-x64"],
    oldDownloads = oldPlatform.downloads ?? [oldPlatform];
  const ds = p.downloads ?? [p];
  ds.forEach((d: Download, n: number) => {
    const old = oldDownloads[n];
    if (old.url === oldDownloads[0].url) {
      d.url = candidate.url;
      if (candidate.sha256) d.sha256 = candidate.sha256;
      // Clear the stale digest without moving its slot when payload verification
      // restores it: installed manifest hashes bind JSON property order.
      else if (candidate.version !== current.version) d.sha256 = undefined;
      if (rule.maxBytes !== undefined) d.maxBytes = rule.maxBytes;
    } else
      requireThat(
        updatePath(d.url) === d.url,
        "Independent version-bound downloads require an explicit upstream recipe",
      );
    for (const cabinet of Object.values(d.cabinets ?? {}))
      requireThat(
        updatePath(cabinet.url) === cabinet.url,
        "Version-bound cabinet requires an explicit upstream recipe",
      );
    for (const key of ["file", "into", "stripPrefix"] as const)
      if (d[key] !== undefined) d[key] = updatePath(d[key]!);
    if (
      old.url === oldDownloads[0].url &&
      candidate.stripPrefix !== undefined
    ) {
      pathName(candidate.stripPrefix);
      d.stripPrefix = candidate.stripPrefix;
    }
    for (const step of d.nested ?? []) {
      step.path = updatePath(step.path);
      if (step.stripPrefix !== undefined)
        step.stripPrefix = updatePath(step.stripPrefix);
    }
    if (rule.layout === "apptree") delete d.files;
    else if (d.files)
      d.files = Object.fromEntries(
        Object.entries(d.files).map(([from, to]) => [
          updatePath(from),
          updatePath(to),
        ]),
      );
  });
  for (const [name, bin] of Object.entries(p.bin)) {
    if (typeof bin === "string") p.bin[name] = updatePath(bin);
    else bin.path = updatePath(bin.path);
  }
  for (const service of p.services ?? [])
    service.binPath = updatePath(service.binPath);
  if (rule.layout === "lua") {
    const old = current.version.split(".").slice(0, 2).join(""),
      version = candidate.version.split(".").slice(0, 2).join("");
    for (const [name, bin] of Object.entries(p.bin))
      if (
        typeof bin === "string" &&
        new RegExp("^(?:lua|luac|wlua)" + old + "\\.exe$").test(bin)
      )
        p.bin[name] = bin.replace(old + ".exe", version + ".exe");
  }
  const desktop = p.desktop;
  if (desktop) {
    if (desktop.fonts) desktop.fonts = desktop.fonts.map(updatePath);
    for (const kind of ["shortcuts", "associations", "menus"] as const)
      for (const item of desktop[kind] ?? []) item.path = updatePath(item.path);
  }
  if (rule.maxExpandedBytes !== undefined)
    p.maxExpandedBytes = rule.maxExpandedBytes;
  // Configuration, persistence, arguments, environment and executable snippets
  // are literal source declarations, never a search-and-replace surface.
  const sensitive = JSON.stringify({
    persist: p.persist,
    configFiles: p.configFiles,
    configTemplates: p.configTemplates,
    env: p.env,
    shell: p.shell,
    bootstrap: p.bootstrap,
    admin: p.admin,
  });
  requireThat(
    current.version === candidate.version ||
      !sensitive.includes(current.version),
    "Version-bound configuration/execution code requires manual recipe review",
  );
  return next;
}
