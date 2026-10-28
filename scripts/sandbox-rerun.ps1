#requires -Version 5.1
# Back up existing evidence, then rerun the existing verifier without clipboard commands.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PikoSandboxInput') {
    throw 'Safety guard: run this script only from C:\PikoSandboxInput inside Windows Sandbox.'
}
$results = 'C:\PikoSandboxResults'
if (-not (Test-Path -LiteralPath $results -PathType Container)) { throw 'Mapped results directory is missing.' }
$mutex = New-Object Threading.Mutex($false, 'Local\PikoSandboxRerun')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'A rerun is already in progress. Inspect its window instead of starting another.' }
    $runner = Join-Path $PSScriptRoot 'run.ps1'
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'run-fixed.ps1')) { $runner = Join-Path $PSScriptRoot 'run-fixed.ps1' }
    # The original auto-started runner does not own this mutex. Detect it separately.
    $active = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -match '(?i)-File\s+"?C:\\PikoSandboxInput\\run(?:-fixed)?\.ps1(?:"|\s|$)'
    })
    if ($active.Count -gt 0) {
        $previousPath = Join-Path $results 'report.json'
        $finished = $null
        if (Test-Path -LiteralPath $previousPath) {
            $previous = Get-Content -LiteralPath $previousPath -Raw | ConvertFrom-Json
            if ($previous.status -in @('passed', 'failed') -and $previous.PSObject.Properties['finishedAt']) {
                $finished = [DateTimeOffset]::Parse($previous.finishedAt).UtcDateTime
            }
        }
        # -NoExit leaves an idle console after verification. It is safe to keep
        # that old console open only when its run has a completed report.
        foreach ($process in $active) {
            if (-not $finished -or $process.CreationDate.ToUniversalTime() -gt $finished) {
                throw 'An earlier test may still be running. Wait for its report or inspect its window before retrying.'
            }
        }
    }
    $backup = Join-Path $results ('previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($name in @('report.json', 'transcript.txt', 'commands', 'network-report.json', 'network-transcript.txt')) {
        $path = Join-Path $results $name
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $backup -Recurse }
    }
    Write-Host "Previous logs backed up to: $backup"
    Write-Host 'Starting a fresh verifier installation inside Sandbox. The local fixture server is started by run.ps1.'
    $shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $oldPath = $env:Path
    try {
        # A previous test wrote its own shims to this Sandbox user's PATH.
        # Exclude only that known test layout from the child process environment
        # so run.ps1 can check the no-preinstalled-runtime condition again.
        # Do not remove registry entries or hide arbitrary external Node installs.
        $testShim = '^' + [regex]::Escape($env:LOCALAPPDATA.TrimEnd('\')) + '\\PikoSandboxTest-[0-9a-f]{32}\\installation\\shims\\?$'
        $env:Path = (($oldPath -split ';' | Where-Object { $_ -notmatch $testShim }) -join ';')
        & $shell -NoProfile -ExecutionPolicy Bypass -File $runner
    } finally { $env:Path = $oldPath }
    $reportPath = Join-Path $results 'report.json'
    if (-not (Test-Path -LiteralPath $reportPath)) { throw 'Verifier did not produce report.json.' }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    Write-Host "Verifier status: $($report.status)"
    if ($report.status -ne 'passed') { throw 'Verification did not pass. Inspect C:\PikoSandboxResults\report.json and commands/.' }
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
