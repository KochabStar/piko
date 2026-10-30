import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  rename,
  lstat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { powershellExecutable } from "./windows.ts";
import { capture, exists, fail, noLinks, sha256 } from "./util.ts";
import type { EffectTarget, EffectValue } from "./types.ts";

const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIKO_NATIVE_REQUEST)) | ConvertFrom-Json
if ($p.op -eq 'elevated') {
 $id=[Security.Principal.WindowsIdentity]::GetCurrent()
 ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress
 exit
}
if ($p.op -eq 'read' -or $p.op -eq 'write') {
 if (!$p.key.StartsWith('HKCU\\')) { throw 'Only HKCU integration values are supported' }
 $sub=$p.key.Substring(5)
 $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub,$p.op -eq 'write')
 try {
  if ($p.op -eq 'read') {
   if (!$k -or !($k.GetValueNames() -contains $p.name)) { 'null' }
   else { @{type=$k.GetValueKind($p.name).ToString();value=$k.GetValue($p.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} | ConvertTo-Json -Compress -Depth 5 }
  } else {
   $now=$null
   if ($k -and ($k.GetValueNames() -contains $p.name)) { $now=@{type=$k.GetValueKind($p.name).ToString();value=$k.GetValue($p.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} }
   $actual=if ($null -eq $now) {'null'} else {$now | ConvertTo-Json -Compress -Depth 5}
   $expected=if ($null -eq $p.before) {'null'} else {$p.before | ConvertTo-Json -Compress -Depth 5}
   # Compare values independently of JSON object-key ordering.
   if ($null -eq $now -and $null -ne $p.before -or $null -ne $now -and $null -eq $p.before) { throw 'Registry changed during write' }
   if ($null -ne $now -and ($now.type -ne $p.before.type -or (ConvertTo-Json -InputObject $now.value -Compress) -cne (ConvertTo-Json -InputObject $p.before.value -Compress))) { throw 'Registry changed during write' }
   if ($null -eq $p.value) { if ($k) {$k.DeleteValue($p.name,$false)} }
   else {
    if (!$k) {$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)}
    $kind=[Microsoft.Win32.RegistryValueKind]::$($p.value.type)
    $value=if ($p.value.type -eq 'DWord') {[int]$p.value.value} elseif ($p.value.type -eq 'MultiString') {[string[]]$p.value.value} else {[string]$p.value.value}
    $k.SetValue($p.name,$value,$kind)
   }
   'null'
  }
 } finally { if ($k) {$k.Dispose()} }
} elseif ($p.op -eq 'shortcut') {
 $w=New-Object -ComObject WScript.Shell
 $s=$w.CreateShortcut($p.output)
 $s.TargetPath=$p.target
 $s.Arguments=$p.args
 $s.WorkingDirectory=[IO.Path]::GetDirectoryName($p.target)
 $s.Save()
 'null'
} elseif ($p.op -eq 'notify') {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PikoNotify {
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,UIntPtr w,string l,uint flags,uint timeout,out UIntPtr result);
 [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId,uint flags,IntPtr a,IntPtr b);
}
'@
 [UIntPtr]$result=[UIntPtr]::Zero
 $null=[PikoNotify]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,1000,[ref]$result)
 [PikoNotify]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
 'null'
} elseif ($p.op -eq 'folders') {
 @{documents=[Environment]::GetFolderPath('MyDocuments');startMenu=[Environment]::GetFolderPath('Programs');fonts=(Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts');build=[Environment]::OSVersion.Version.Build} | ConvertTo-Json -Compress
} elseif ($p.op -eq 'font') {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PikoFonts {
 [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
 [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern bool RemoveFontResourceEx(string path, uint flags, IntPtr reserved);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
}
'@
 if ($p.add) { if ([PikoFonts]::AddFontResourceEx($p.path,0,[IntPtr]::Zero) -eq 0) { throw 'Unable to load font resource' } }
 else { $null=[PikoFonts]::RemoveFontResourceEx($p.path,0,[IntPtr]::Zero) }
 [UIntPtr]$result=[UIntPtr]::Zero
 $null=[PikoFonts]::SendMessageTimeout([IntPtr]0xffff,0x1d,[UIntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$result)
 'null'
}
`;
export async function nativeRequest(value: unknown): Promise<any> {
  const out = await capture(
    powershellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        PIKO_NATIVE_REQUEST: Buffer.from(JSON.stringify(value)).toString(
          "base64",
        ),
      },
    },
  );
  return out ? JSON.parse(out.replace(/^\uFEFF/, "")) : null;
}
export function equalValue(a: EffectValue, b: EffectValue): boolean {
  if (a === null || b === null) return a === b;
  if ("hash" in a || "hash" in b)
    return "hash" in a && "hash" in b && a.hash === b.hash;
  return (
    a.type === b.type && JSON.stringify(a.value) === JSON.stringify(b.value)
  );
}
export class WindowsEffects {
  // Test-only roots are supplied by in-process tests, never CLI/environment flags.
  constructor(readonly testRoot?: string) {}
  registryKey(key: string) {
    if (
      !/^HKCU\\(?:Environment$|Software\\(?:Classes\\|Microsoft\\Windows NT\\CurrentVersion\\Fonts$))/i.test(
        key,
      )
    )
      fail("Unsupported integration registry target");
    return this.testRoot
      ? `HKCU\\Software\\PikoIntegrationTests\\${sha256(this.testRoot).slice(0, 24)}\\${key.slice(5)}`
      : key;
  }
  async folders(): Promise<{
    startMenu: string;
    fonts: string;
    build: number;
  }> {
    if (this.testRoot)
      return {
        startMenu: join(this.testRoot, "start-menu"),
        fonts: join(this.testRoot, "fonts"),
        build: 26300,
      };
    return await nativeRequest({ op: "folders" });
  }
  async read(target: EffectTarget): Promise<EffectValue> {
    if (target.kind === "registry")
      return await nativeRequest({
        op: "read",
        key: this.registryKey(target.key),
        name: target.name,
      });
    await noLinks(target.path);
    if (!(await exists(target.path))) return null;
    const info = await lstat(target.path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024)
      fail("Integration target must be an unlinked bounded regular file");
    return { hash: sha256(await readFile(target.path)) };
  }
  async write(
    target: EffectTarget,
    before: EffectValue,
    value: EffectValue,
    bytes?: Uint8Array,
  ) {
    if (!equalValue(await this.read(target), before))
      fail("Integration resource changed; inspect before retrying");
    if (equalValue(before, value)) return;
    if (target.kind === "registry") {
      await nativeRequest({
        op: "write",
        key: this.registryKey(target.key),
        name: target.name,
        before,
        value,
      });
      return;
    }
    await noLinks(target.path);
    if (target.font && before !== null && !this.testRoot)
      await nativeRequest({ op: "font", add: false, path: target.path });
    if (value === null) await rm(target.path);
    else {
      if (!("hash" in value) || !bytes || sha256(bytes) !== value.hash)
        fail("Missing integration file content");
      await mkdir(dirname(target.path), { recursive: true });
      const temp = target.path + "." + crypto.randomUUID() + ".tmp";
      try {
        await writeFile(temp, bytes, { flag: "wx" });
        if (!equalValue(await this.read(target), before))
          fail("Integration file changed during write");
        await rename(temp, target.path);
      } finally {
        await rm(temp, { force: true });
      }
      if (target.font && !this.testRoot)
        await nativeRequest({ op: "font", add: true, path: target.path });
    }
  }
  async notify() {
    if (!this.testRoot) await nativeRequest({ op: "notify" });
  }
  async shortcut(target: string, args: string): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), "piko-shortcut-"));
    try {
      const output = join(dir, "entry.lnk");
      await nativeRequest({ op: "shortcut", output, target, args });
      return await readFile(output);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
export function quoteArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return (
    '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"'
  );
}
