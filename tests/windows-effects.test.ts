import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WindowsEffects,
  nativeRequest,
  quoteArgument,
} from "../src/windows-effects.ts";
import { powershellExecutable } from "../src/windows.ts";
import { capture } from "../src/util.ts";
import type { EffectTarget } from "../src/types.ts";
const root = await mkdtemp(join(tmpdir(), "piko-real-windows-effects-")),
  backend = new WindowsEffects(root);
afterAll(async () => {
  const key = `Software\\PikoIntegrationTests\\${(await import("../src/util.ts")).sha256(root).slice(0, 24)}`;
  await capture(
    powershellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:PIKO_TEST_KEY,$false)",
    ],
    { env: { ...process.env, PIKO_TEST_KEY: key } },
  );
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 15,
    retryDelay: 100,
  });
});
test("Windows registry read/write compare-and-swap preserves original types in a dedicated test namespace", async () => {
  const target: EffectTarget = {
    kind: "registry",
    key: "HKCU\\Environment",
    name: "PikoTest",
  };
  expect(await backend.read(target)).toBeNull();
  await backend.write(target, null, {
    type: "ExpandString",
    value: "%USERPROFILE%\\Piko 测试",
  });
  expect(await backend.read(target)).toEqual({
    type: "ExpandString",
    value: "%USERPROFILE%\\Piko 测试",
  });
  await expect(
    backend.write(target, null, { type: "String", value: "bad" }),
  ).rejects.toThrow("changed");
  await backend.write(
    target,
    { type: "ExpandString", value: "%USERPROFILE%\\Piko 测试" },
    null,
  );
  expect(await backend.read(target)).toBeNull();
}, 15000);
test("real .lnk generation preserves executable and literal special-character arguments without launching target", async () => {
  const target = join(root, "not-run.exe"),
    file = join(root, "shortcut.lnk"),
    args = ["space argument", 'quote"value', "ends\\", "&;literal"];
  await writeFile(
    file,
    await backend.shortcut(target, args.map(quoteArgument).join(" ")),
  );
  const out = await capture(
    powershellExecutable(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:PIKO_TEST_LINK); @{target=$s.TargetPath;args=$s.Arguments}|ConvertTo-Json -Compress",
    ],
    { env: { ...process.env, PIKO_TEST_LINK: file } },
  );
  const value = JSON.parse(out);
  expect(value.target.toLowerCase()).toBe(target.toLowerCase());
  expect(value.args).toBe(args.map(quoteArgument).join(" "));
});
test("Restart Manager reports a real loaded DLL without unloading it or killing the owning process", async () => {
  const dll = join(root, "loaded-version.dll"),
    ready = join(root, "loaded-ready");
  await copyFile(join(process.env.SystemRoot!, "System32/version.dll"), dll);
  const body = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class NativeLoad {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr LoadLibrary(string path);[DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr handle);}';$h=[NativeLoad]::LoadLibrary($env:PIKO_TEST_DLL);if($h -eq [IntPtr]::Zero){throw 'DLL load failed'};try{[IO.File]::WriteAllText($env:PIKO_TEST_READY,'ready');[Console]::ReadLine()|Out-Null}finally{[void][NativeLoad]::FreeLibrary($h)}`;
  const child = Bun.spawn(
    [
      powershellExecutable(),
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(body, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, PIKO_TEST_DLL: dll, PIKO_TEST_READY: ready },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    for (let n = 0; !(await Bun.file(ready).exists()); n++) {
      if (n > 100 || child.exitCode !== null)
        throw Error("DLL owner did not become ready");
      await Bun.sleep(100);
    }
    const real = new WindowsEffects();
    expect((await real.fileUsers([dll])).some((p) => p.pid === child.pid)).toBe(
      true,
    );
    expect(child.exitCode).toBeNull();
  } finally {
    child.stdin.write("release\n");
    child.stdin.end();
    await child.exited;
  }
  expect((await new WindowsEffects().fileUsers([dll])).length).toBe(0);
}, 30000);

test("font and shortcut files only write isolated target roots and detect drift before removal", async () => {
  const path = join(root, "font-test.ttf"),
    target: EffectTarget = { kind: "file", path, font: true },
    bytes = Buffer.from("fixture-not-loaded"),
    { sha256 } = await import("../src/util.ts");
  await backend.write(target, null, { hash: sha256(bytes) }, bytes);
  expect(await readFile(path)).toEqual(bytes);
  await writeFile(path, "edited");
  await expect(
    backend.write(target, { hash: sha256(bytes) }, null),
  ).rejects.toThrow("changed");
  expect(typeof (await nativeRequest({ op: "elevated" }))).toBe("boolean");
});
