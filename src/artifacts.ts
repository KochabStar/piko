import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { fail, inside, noLinks, relativeFile } from "./util.ts";

export async function extractZip(
  zipPath: string,
  destination: string,
  stripPrefix?: string,
): Promise<void> {
  await noLinks(destination);
  await mkdir(destination, { recursive: true });
  const archive = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (e, z) => (e ? reject(e) : resolve(z!)),
    ),
  );
  const seen = new Set<string>();
  let count = 0,
    total = 0;
  await new Promise<void>((done, reject) => {
    let settled = false;
    const error = (e: unknown) => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(e);
    };
    archive.on("error", error);
    archive.on("end", () => {
      if (!settled) {
        settled = true;
        done();
      }
    });
    archive.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        if (++count > 100000) fail("ZIP entry count limit exceeded");
        const raw = entry.fileName,
          isDir = raw.endsWith("/");
        relativeFile(isDir ? raw.slice(0, -1) : raw);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode && mode !== 0x8000 && mode !== 0x4000)
          fail("Archive links and special files are not supported");
        if (entry.generalPurposeBitFlag & 1)
          fail("Encrypted ZIP entries are not supported");
        let path = isDir ? raw.slice(0, -1) : raw;
        if (stripPrefix) {
          if (path === stripPrefix && isDir) {
            archive.readEntry();
            return;
          }
          if (!path.startsWith(stripPrefix + "/"))
            fail("ZIP entry is outside stripPrefix");
          path = path.slice(stripPrefix.length + 1);
        }
        relativeFile(path);
        if (path.toLowerCase().startsWith(".piko-install.json/"))
          fail("Archive conflicts with reserved installation receipt");
        if (path.toLowerCase() === ".piko-install.json")
          fail("Archive conflicts with reserved installation receipt");
        const normalized = path.toLowerCase();
        if (seen.has(normalized))
          fail("Duplicate or case-colliding ZIP entry: " + path);
        seen.add(normalized);
        const target = inside(destination, join(destination, path));
        await noLinks(target);
        if (isDir) {
          await mkdir(target, { recursive: true });
        } else {
          total += entry.uncompressedSize;
          if (
            entry.uncompressedSize > 512 * 1024 * 1024 ||
            total > 2 * 1024 * 1024 * 1024
          )
            fail("ZIP expanded size limit exceeded");
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>(
            (resolve, reject) =>
              archive.openReadStream(entry, (e, s) =>
                e ? reject(e) : resolve(s!),
              ),
          );
          let bytes = 0;
          await pipeline(
            stream,
            async function* (source) {
              for await (const chunk of source) {
                bytes += chunk.length;
                if (bytes > entry.uncompressedSize || bytes > 512 * 1024 * 1024)
                  fail("ZIP entry exceeds declared size or extraction limit");
                yield chunk;
              }
            },
            createWriteStream(target, { flags: "wx" }),
          );
          if (bytes !== entry.uncompressedSize) fail("ZIP entry size mismatch");
        }
        if (!settled) archive.readEntry();
      })().catch(error);
    });
    archive.readEntry();
  });
}
