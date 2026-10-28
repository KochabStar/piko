#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Probe,[Parameter(Mandatory=$true)][string]$Marker)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PikoConsoleProbe {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string reserved; public string desktop; public string title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,System.Text.StringBuilder command,IntPtr process,IntPtr thread,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION info);
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint signal,uint group);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr handle,uint exit);
}
'@
$start = New-Object PikoConsoleProbe+STARTUPINFO
$start.cb = [Runtime.InteropServices.Marshal]::SizeOf($start)
$info = New-Object PikoConsoleProbe+PROCESS_INFORMATION
$command = New-Object Text.StringBuilder
$null = $command.Append('"').Append($Executable).Append('" "').Append($Probe).Append('" "').Append($Marker).Append('"')
$null = [PikoConsoleProbe]::SetConsoleCtrlHandler([IntPtr]::Zero,$false)
if (-not [PikoConsoleProbe]::CreateProcess($Executable,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,16,[IntPtr]::Zero,[IO.Path]::GetDirectoryName($Executable),[ref]$start,[ref]$info)) { throw ('Unable to create isolated test console: Win32 ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
try {
    for ($n=0; $n -lt 100 -and -not [IO.File]::Exists($Marker + '.ready'); $n++) { Start-Sleep -Milliseconds 100 }
    if (-not [IO.File]::Exists($Marker + '.ready')) { throw 'Probe child did not become ready.' }
    $null = [PikoConsoleProbe]::FreeConsole()
    if (-not [PikoConsoleProbe]::AttachConsole($info.pid)) { throw 'Could not attach isolated probe console.' }
    $null = [PikoConsoleProbe]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)
    if (-not [PikoConsoleProbe]::GenerateConsoleCtrlEvent(0,0)) { throw 'Could not deliver isolated Ctrl+C.' }
    for ($n=0; $n -lt 100 -and -not [IO.File]::Exists($Marker); $n++) { Start-Sleep -Milliseconds 100 }
    if (-not [IO.File]::Exists($Marker)) { throw 'Managed child did not receive Ctrl+C.' }
    if ([PikoConsoleProbe]::WaitForSingleObject($info.process,10000) -ne 0) { throw 'Shim did not exit after child cancellation.' }
} finally {
    $null = [PikoConsoleProbe]::FreeConsole()
    $null = [PikoConsoleProbe]::TerminateProcess($info.process,1)
    $null = [PikoConsoleProbe]::CloseHandle($info.process)
    $null = [PikoConsoleProbe]::CloseHandle($info.thread)
}
