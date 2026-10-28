#requires -Version 5.1
# Host-safe regression tests for transient Windows read locks on report.json.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'scripts\sandbox-report.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('piko-report-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $reportPath = Join-Path $temp 'report.json'
    $report = [ordered]@{ status = 'running'; checks = @() }
    $steps = New-Object 'System.Collections.Generic.List[object]'
    Save-Report
    $initial = [IO.File]::ReadAllText($reportPath)
    $held = [IO.File]::Open($reportPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $failed = $false
        try { Write-SandboxText -Path $reportPath -Text '{"status":"passed"}' -Attempts 2 -DelayMilliseconds 10 }
        catch { $failed = $_.Exception.Message -like 'Unable to publish*'; if (-not $failed) { throw } }
        if (-not $failed) { throw 'Writer must not bypass a persistent read lock.' }
        if ([IO.File]::ReadAllText($reportPath) -cne $initial) { throw 'Failed publication damaged the previous complete report.' }
        $pending = @(Get-ChildItem -LiteralPath $temp -Filter '*.pending')
        if ($pending.Count -ne 1 -or [IO.File]::ReadAllText($pending[0].FullName) -notmatch 'passed') { throw 'Unpublished complete report was not retained.' }
    } finally { $held.Dispose() }
    Write-Output 'PASS: persistent lock preserves the previous report and complete pending content.'

    # Release an actual Windows read lock on a background CLR thread while
    # Save-Report retries on this PowerShell thread. No child Shell or real data.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class PikoTransientReportLock {
    public static Thread Hold(string path, int milliseconds) {
        var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var thread = new Thread(() => { try { Thread.Sleep(milliseconds); } finally { stream.Dispose(); } });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
'@
    $thread = [PikoTransientReportLock]::Hold($reportPath, 500)
    $steps.Add([pscustomobject]@{ name = 'completed'; passed = $true })
    $report.status = 'passed'
    try { Save-Report } finally { $thread.Join() }
    $saved = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($saved.status -ne 'passed' -or $saved.checks.Count -ne 1 -or -not $saved.checks[0].passed) { throw 'Retry did not publish the complete report.' }
    Write-Output 'PASS: actual Save-Report survives a transient read lock and publishes the final verdict.'
    $textPath = Join-Path $temp 'empty.stderr.txt'
    Write-SandboxText -Path $textPath -Text ''
    if (-not [IO.File]::Exists($textPath) -or [IO.File]::ReadAllText($textPath) -ne '') { throw 'Empty command stream was not preserved.' }
    Write-Output 'PASS: empty stderr files can be published.'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
