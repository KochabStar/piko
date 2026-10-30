import { lstat, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { helperFile, helperOutput } from "./helpers-process.ts";
import { fail, noLinks, relativeFile, removeTree } from "./util.ts";

export type ContainerEntry = {
  raw: string;
  path: string;
  size?: number;
  directory: boolean;
};
export async function listContainer(
  executable: string,
  archive: string,
  type: "Compound" | "Cab" | "nsis" | "PE",
): Promise<ContainerEntry[]> {
  const listing = Buffer.from(
    await helperOutput(
      executable,
      [
        "l",
        "-t" + type,
        "-slt",
        "-ba",
        "-sccUTF-8",
        "-pPIKO_NO_PASSWORD",
        "--",
        resolve(archive),
      ],
      32 * 1024 * 1024,
    ),
  ).toString("utf8");
  const entries: ContainerEntry[] = [],
    seen = new Set<string>();
  for (const block of listing
    .replace(/[\r\n]+$/, "")
    .split(/\r?\n\r?\n/)
    .filter(Boolean)) {
    if (entries.length >= 100000) fail("Container entry limit exceeded");
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(" = ");
      if (at < 0 || fields.has(line.slice(0, at)))
        fail("Ambiguous container metadata");
      fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const raw = fields.get("Path") ?? "",
      path = raw.replaceAll("\\", "/"),
      attributes = fields.get("Attributes") ?? "";
    relativeFile(path);
    if (seen.has(path.toLowerCase()))
      fail("Duplicate or case-colliding container entry");
    seen.add(path.toLowerCase());
    if (
      /[Ll]/.test(attributes) ||
      (fields.has("Encrypted") && fields.get("Encrypted") !== "-") ||
      [...fields].some(
        ([key, value]) =>
          /link|reparse|alternate|stream/i.test(key) && value !== "",
      ) ||
      (attributes.includes("_") && !/_(d|-)r/.test(attributes))
    )
      fail(
        "Container links, special files, streams or encryption are unsupported",
      );
    const sizeText = fields.get("Size"),
      size = sizeText ? Number(sizeText) : undefined;
    if (
      size !== undefined &&
      (!/^\d+$/.test(sizeText!) || !Number.isSafeInteger(size) || size < 0)
    )
      fail("Invalid container entry size");
    // NSIS may omit sizes for plugins; only explicit, sized regular payloads may be read.
    if (type !== "nsis" && size === undefined)
      fail("Missing container entry size");
    entries.push({
      raw,
      path,
      size,
      directory: attributes.startsWith("D") || fields.get("Folder") === "+",
    });
  }
  if (type !== "nsis" && entries.length === 0)
    fail("Container contains no entries");
  return entries;
}
export async function containerFile(
  executable: string,
  archive: string,
  type: "Compound" | "Cab" | "nsis" | "PE",
  entry: ContainerEntry,
  target: string,
  limit: number,
) {
  if (
    entry.directory ||
    (entry.size === undefined && type !== "nsis") ||
    (entry.size !== undefined && entry.size > limit)
  )
    fail("Selected container payload is not a bounded regular file");
  await noLinks(target);
  await helperFile(
    executable,
    [
      "x",
      "-t" + type,
      "-so",
      "-spd",
      "-y",
      "-bd",
      "-bb0",
      "-pPIKO_NO_PASSWORD",
      "--",
      resolve(archive),
      entry.raw,
    ],
    target,
    Math.min(entry.size ?? limit, limit),
  );
  const info = await lstat(target);
  if (
    !info.isFile() ||
    (entry.size !== undefined && info.size !== entry.size) ||
    info.size > limit
  )
    fail("Container payload size/type mismatch");
}
export async function withScratch<T>(
  archive: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(dirname(resolve(archive)), "container-extract-"),
  );
  try {
    return await fn(directory);
  } finally {
    await removeTree(directory);
  }
}
