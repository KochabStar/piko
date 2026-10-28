#requires -Version 5.1
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PikoSandboxInput') {
    throw 'Safety guard: run only inside C:\PikoSandboxInput in Windows Sandbox.'
}
$exe = Join-Path $PSScriptRoot 'network-probe.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'network-probe.exe is missing; build and package it on the host first.' }
$results = 'C:\PikoSandboxResults'
$exitCode = 1
try {
    Start-Transcript -LiteralPath (Join-Path $results 'bun-network-transcript.txt') -Force | Out-Null
    & $exe (Join-Path $results 'bun-network-report.json')
    $exitCode = $LASTEXITCODE
} finally { Stop-Transcript | Out-Null }
exit $exitCode
