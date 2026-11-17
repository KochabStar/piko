import { lstat, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { nativeShimBase64, nativeShimSha256 } from "./generated/shim.ts";
import { helperOutput, installedHelper } from "./helpers-process.ts";
import { fail, networkUrl, sha256 } from "./util.ts";
import type { State } from "./types.ts";

async function githubCli(
  root: string,
  state: State,
): Promise<string | undefined> {
  const managed = await installedHelper(root, state, "gh", "gh");
  if (managed) return managed;
  const name = process.platform === "win32" ? "gh.exe" : "gh";
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(
    delimiter,
  )) {
    const folder = directory.replace(/^"|"$/g, "");
    if (!isAbsolute(folder)) continue;
    const path = join(folder, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      // Never recurse through a Piko shim while its caller owns a write lease.
      if (
        info.size === Buffer.byteLength(nativeShimBase64, "base64") &&
        sha256(await readFile(path)) === nativeShimSha256
      )
        continue;
      return path;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        continue;
      throw error;
    }
  }
}

/** Read only official GitHub repository metadata; gh retains its own credentials. */
export async function githubMetadata(
  root: string,
  state: State,
  value: string,
): Promise<string | undefined> {
  const url = networkUrl(value);
  if (
    url.origin !== "https://api.github.com" ||
    !/^\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/(?:releases(?:\/latest)?|tags|commits)$/.test(
      url.pathname,
    )
  )
    return;
  const executable = await githubCli(root, state);
  if (!executable) return;
  let bytes: Uint8Array;
  try {
    bytes = await helperOutput(
      executable,
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        url.pathname + url.search,
      ],
      8 * 1024 * 1024,
    );
  } catch {
    fail(
      "GitHub metadata query through gh failed; check gh auth status --hostname github.com. No anonymous fallback was attempted",
    );
  }
  return Buffer.from(bytes).toString("utf8");
}
