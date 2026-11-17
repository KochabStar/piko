import { createHash } from "node:crypto";
import { fail, relativeFile } from "./util.ts";

export type PublishedDigests = {
  sha256?: string;
  sha512?: string;
  md5?: string;
};

/** MD5 remains an enforced feed consistency check, never publisher authentication. */
export function verifyPublishedDigests(
  bytes: Uint8Array,
  expected: PublishedDigests,
): string {
  let sha256: string | undefined;
  for (const algorithm of ["sha256", "sha512", "md5"] as const) {
    const value = expected[algorithm];
    if (value === undefined) continue;
    const length = { sha256: 64, sha512: 128, md5: 32 }[algorithm];
    if (
      typeof value !== "string" ||
      value.length !== length ||
      !/^[0-9a-f]+$/i.test(value) ||
      /^0+$/.test(value)
    )
      fail("Invalid advertised " + algorithm.toUpperCase() + " digest");
    const actual = createHash(algorithm).update(bytes).digest("hex");
    if (actual !== value.toLowerCase())
      fail(
        algorithm.toUpperCase() +
          " mismatch; upstream payload was not accepted",
      );
    if (algorithm === "sha256") sha256 = actual;
  }
  return sha256 ?? createHash("sha256").update(bytes).digest("hex");
}

function identityFiles(paths: string[]): Record<string, string> {
  if (!paths.length) fail("Application tree is empty");
  const seen = new Set<string>();
  for (const path of paths) {
    relativeFile(path);
    const key = path.toLowerCase();
    if (seen.has(key)) fail("Duplicate or case-colliding application file");
    seen.add(key);
  }
  return Object.fromEntries(paths.map((path) => [path, path]));
}

/** Derive the entire application tree, including moving embedded runtimes. */
export function applicationFiles(
  plan: { files: { path: string }[] },
  prefix: string | undefined,
): Record<string, string> {
  if (!prefix) fail("Application tree requires an explicit stripPrefix");
  relativeFile(prefix);
  return identityFiles(
    plan.files
      .filter((file) => file.path.startsWith(prefix + "/"))
      .map((file) => file.path.slice(prefix.length + 1)),
  );
}

export function epicApplicationFiles(plan: {
  files: { path: string }[];
}): Record<string, string> {
  return identityFiles(
    plan.files
      .filter(
        (file) =>
          !/^(?:Epic Games\/(?:DirectXRedist|GameInputRedist)\/|Epic\/EpicGamesLauncher\/|Win\/System(?:64)?\/|System(?:64)?\/)/.test(
            file.path,
          ),
      )
      .map((file) => file.path),
  );
}

export function nsisApplicationFiles(
  entries: { path: string; directory: boolean }[],
  layout: "wecom" | "baidu",
): Record<string, string> {
  return identityFiles(
    entries
      .filter(
        (entry) =>
          !entry.directory &&
          !entry.path.startsWith("$") &&
          !(layout === "wecom" ? /^uninstall\.exe$/i : /^uninst\.exe$/i).test(
            entry.path,
          ),
      )
      .map((entry) => entry.path),
  );
}

export function tabbitMiniInstallerPath(paths: string[]): string {
  const choices = paths.filter((path) =>
    /^bin\/Offline\/\{[a-f0-9-]{36}\}\/\{[a-f0-9-]{36}\}\/mini_installer\.exe$/i.test(
      path,
    ),
  );
  if (choices.length !== 1)
    fail("Tabbit offline installer GUID path is ambiguous or missing");
  return choices[0]!;
}

export function peFileVersion(info: string, expected?: string): string {
  const versions = [
    ...new Set(
      [...info.matchAll(/^FileVersion:\s*([0-9]+(?:\.[0-9]+)+)\s*$/gm)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  if (!versions.length) fail("Application PE file version missing");
  if (expected) {
    if (!versions.includes(expected))
      fail("Application PE version differs from upstream release hint");
    return expected;
  }
  if (versions.length !== 1)
    fail(
      "Ambiguous application PE versions; explicit upstream version required",
    );
  return versions[0]!;
}
