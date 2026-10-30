import {
  mkdir,
  readFile,
  writeFile,
  stat,
  unlink,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { nativeShimBase64, nativeShimSha256 } from "./generated/shim.ts";
import { exists, fail, noLinks, sha256, commandName } from "./util.ts";

const launcher = Buffer.from(nativeShimBase64, "base64");
if (sha256(launcher) !== nativeShimSha256)
  fail("Embedded native shim checksum differs");
function validateName(name: string) {
  if (name !== "piko") commandName(name);
}
export function shimConfiguration(name: string) {
  validateName(name);
  return `path = "..\\apps\\piko\\piko.exe"\r\nargs = ${name === "piko" ? "" : "__shim " + name}\r\n`;
}
export async function inspectShim(
  root: string,
  name: string,
  legacy: string[] = [],
) {
  validateName(name);
  const file = join(root, "shims", name + ".exe"),
    config = join(root, "shims", name + ".shim");
  await noLinks(file);
  await noLinks(config);
  const hasFile = await exists(file),
    hasConfig = await exists(config);
  if (hasConfig && (await readFile(config, "utf8")) !== shimConfiguration(name))
    fail("Unrecognized .shim configuration; preserving external command entry");
  if (!hasFile)
    return { kind: hasConfig ? "configuration-only" : "missing", file, config };
  const info = await stat(file);
  if (
    info.size === launcher.length &&
    sha256(await readFile(file)) === nativeShimSha256
  )
    return {
      kind: hasConfig ? "native" : "native-without-config",
      file,
      config,
    };
  for (const original of legacy) {
    await noLinks(original);
    if (await exists(original)) {
      const old = await stat(original);
      if (info.dev === old.dev && info.ino === old.ino)
        return { kind: "legacy", file, config };
    }
  }
  fail("Refusing to overwrite or remove external shim: " + file);
}
export async function writeNativeShim(
  root: string,
  name: string,
  legacy: string[] = [],
) {
  const entry = await inspectShim(root, name, legacy);
  if (entry.kind === "native") return;
  await mkdir(join(root, "shims"), { recursive: true });
  if (!(await exists(entry.config)))
    await writeFile(entry.config, shimConfiguration(name), { flag: "wx" });
  if (entry.kind === "native-without-config") return;
  const pending = entry.file + "." + crypto.randomUUID() + ".tmp";
  try {
    await writeFile(pending, launcher, { flag: "wx" });
    // Renaming onto a file replaces the directory entry, not the data of a
    // legacy hardlink. In particular, NEVER truncate the Piko executable.
    await inspectShim(root, name, legacy);
    await rename(pending, entry.file);
  } finally {
    if (await exists(pending)) await unlink(pending);
  }
  const verified = await inspectShim(root, name, legacy);
  if (verified.kind !== "native") fail("Native shim publish incomplete");
}
export async function removeManagedShim(
  root: string,
  name: string,
  legacy: string[] = [],
) {
  const entry = await inspectShim(root, name, legacy);
  if (await exists(entry.file)) await unlink(entry.file);
  if (await exists(entry.config)) await unlink(entry.config);
}
