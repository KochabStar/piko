import { format } from "prettier";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { capture, fail } from "../src/util.ts";

export async function buildShim() {
  const sdk =
    process.env.PIKO_WINDOWS_SDK ?? "C:/Program Files (x86)/Windows Kits/10";
  const versions = (await readdir(join(sdk, "Include")))
    .filter((v) => /^10\.\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const version =
    versions[0] ??
    fail("Windows SDK headers are required to build the small native shim");
  const clang =
    process.env.PIKO_SHIM_CC ??
    Bun.which("clang.exe") ??
    Bun.which("clang") ??
    fail("clang is required to build the native shim");
  const linker =
    process.env.PIKO_SHIM_LINKER ??
    Bun.which("lld-link.exe") ??
    Bun.which("lld-link") ??
    fail("lld-link is required to build the native shim");
  await mkdir(".tools/native-shim", { recursive: true });
  await mkdir("src/generated", { recursive: true });
  const object = resolve(".tools/native-shim/shim.obj"),
    binary = resolve(".tools/native-shim/shim.exe");
  await capture(clang, [
    "--target=x86_64-pc-windows-msvc",
    "-c",
    "-Oz",
    "-ffreestanding",
    "-fno-stack-protector",
    "-fno-builtin",
    "-D_WIN32_WINNT=0x0601",
    "-I" + join(sdk, "Include", version, "um"),
    "-I" + join(sdk, "Include", version, "shared"),
    "-o",
    object,
    resolve("src/native/shim.c"),
  ]);
  await capture(linker, [
    "/out:" + binary,
    "/entry:shimMain",
    "/subsystem:console,6.01",
    "/nodefaultlib",
    "/machine:x64",
    "/dynamicbase",
    "/nxcompat",
    "/opt:ref",
    "/opt:icf",
    "/Brepro",
    "/libpath:" + join(sdk, "Lib", version, "um", "x64"),
    object,
    "kernel32.lib",
  ]);
  const bytes = await Bun.file(binary).bytes();
  if (bytes.length > 65536) fail("Native shim exceeded 64 KiB");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    "src/generated/shim.ts",
    await format(
      `// Generated from src/native/shim.c by scripts/build-shim.ts.\n// Windows x64, Kernel32 only, no CRT, no shell invocation.\nexport const nativeShimSha256 = ${JSON.stringify(hash)};\nexport const nativeShimBase64 = ${JSON.stringify(Buffer.from(bytes).toString("base64"))};\n`,
      { parser: "typescript" },
    ),
  );
  console.log(`Built native shim: ${bytes.length} bytes, SHA256 ${hash}`);
}
if (import.meta.main) await buildShim();
