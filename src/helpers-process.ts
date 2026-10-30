import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { fail, noLinks } from "./util.ts";
import type { State } from "./types.ts";

export async function installedHelper(
  root: string,
  state: State,
  name: string,
  command: string,
): Promise<string | undefined> {
  const candidates = Object.values(state.installs).filter(
    (i) =>
      i.name === name &&
      i.kind === "portable" &&
      i.bins[command]?.kind === "native" &&
      !i.bins[command]?.data,
  );
  const selected = candidates.filter((i) => state.defaults[i.key]?.id === i.id);
  const choices = selected.length ? selected : candidates;
  if (!choices.length) return;
  if (new Set(choices.map((i) => i.key)).size !== 1)
    fail(`Ambiguous ${name} helper; select exactly one trusted provider`);
  const choice = choices
    .sort((a, b) =>
      a.version.localeCompare(b.version, undefined, { numeric: true }),
    )
    .at(-1)!;
  if (!choice.verified)
    fail(`${name} helper must be checksum-verified; reinstall explicitly`);
  const path = join(root, choice.dir, choice.bins[command]!.path);
  await noLinks(path);
  if (!(await lstat(path)).isFile())
    fail(`${name} helper executable is missing`);
  return path;
}

export async function helperFile(
  executable: string,
  args: string[],
  target: string,
  limit: number,
): Promise<void> {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  });
  const output = pipeline(
    child.stdout,
    async function* (source) {
      let size = 0;
      for await (const chunk of source) {
        size += chunk.length;
        if (size > limit) fail("Helper output exceeds size limit");
        yield chunk;
      }
    },
    createWriteStream(target, { flags: "wx" }),
  );
  const errors = (async () => {
    let size = 0;
    for await (const chunk of child.stderr) {
      size += chunk.length;
      if (size > 65536) fail("Helper diagnostics exceed size limit");
    }
    return size;
  })();
  try {
    const [, diagnostics, code] = await Promise.all([
      output,
      errors,
      child.exited,
    ]);
    if (code !== 0 || diagnostics)
      fail(
        `Helper failed (exit ${code}); corrupt, unsupported or timed-out input`,
      );
  } catch (error) {
    child.kill();
    await Promise.allSettled([output, errors, child.exited]);
    throw error;
  }
}

// Never use a shell or include raw helper output/arguments in errors (URLs may contain secrets).
export async function helperOutput(
  executable: string,
  args: string[],
  limit: number,
): Promise<Uint8Array> {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  });
  const read = async (stream: AsyncIterable<Uint8Array>, max: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > max) fail("Helper output exceeds size limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  };
  const out = read(child.stdout, limit),
    err = read(child.stderr, 65536);
  try {
    const [bytes, diagnostics, code] = await Promise.all([
      out,
      err,
      child.exited,
    ]);
    if (code !== 0 || diagnostics.length)
      fail(
        `Helper failed (exit ${code}); corrupt, unsupported or timed-out input`,
      );
    return bytes;
  } catch (error) {
    child.kill();
    await Promise.allSettled([out, err, child.exited]);
    throw error;
  }
}

// Concatenated stdout is divided using the validated archive order and lengths.
// The external tool never receives output paths. Batches bound Windows argv size.
export async function helperFiles(
  executable: string,
  args: string[],
  files: { path: string; size: number }[],
): Promise<void> {
  const child = Bun.spawn([executable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  });
  const consume = async () => {
    let index = 0,
      written = 0;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    const next = async () => {
      while (index < files.length && !file) {
        const entry = files[index]!;
        if (!Number.isSafeInteger(entry.size) || entry.size < 0)
          fail("Invalid batched helper size");
        await noLinks(entry.path);
        file = await open(entry.path, "wx");
        if (entry.size !== 0) break;
        await file.close();
        file = undefined;
        index++;
      }
    };
    try {
      await next();
      for await (const chunk of child.stdout) {
        let offset = 0;
        while (offset < chunk.length) {
          if (!file || index >= files.length)
            fail("Helper output exceeds declared batch size");
          const length = Math.min(
            chunk.length - offset,
            files[index]!.size - written,
          );
          let consumed = 0;
          while (consumed < length) {
            const result = await file.write(
              chunk,
              offset + consumed,
              length - consumed,
            );
            if (!result.bytesWritten) fail("Unable to write helper output");
            consumed += result.bytesWritten;
          }
          offset += length;
          written += length;
          if (written === files[index]!.size) {
            await file.close();
            file = undefined;
            written = 0;
            index++;
            await next();
          }
        }
      }
      if (index !== files.length)
        fail("Helper output is shorter than declared batch size");
    } finally {
      await file?.close();
    }
  };
  const output = consume(),
    errors = (async () => {
      let size = 0;
      for await (const chunk of child.stderr) {
        size += chunk.length;
        if (size > 65536) fail("Helper diagnostics exceed size limit");
      }
      return size;
    })();
  try {
    const [, diagnostics, code] = await Promise.all([
      output,
      errors,
      child.exited,
    ]);
    if (code !== 0 || diagnostics)
      fail("Helper batch failed; corrupt, unsupported or timed-out input");
  } catch (error) {
    child.kill();
    await Promise.allSettled([output, errors, child.exited]);
    throw error;
  }
}
