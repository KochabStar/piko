#requires -Version 5.1
[CmdletBinding()]
param([string]$PikoHome, [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256, [switch]$Path)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'piko.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Extract the complete release archive first.' }
$hash = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($exe)
try { $actual = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $hash.Dispose() }
if ($actual -ine $Sha256) { throw 'Release checksum mismatch. Nothing was executed.' }
$prior = $env:PIKO_HOME
try {
    if ($PikoHome) { $env:PIKO_HOME = [IO.Path]::GetFullPath($PikoHome) }
    $setupArgs = @('setup')
    if ($Path) { $setupArgs += '--path' }
    & $exe @setupArgs
    if ($LASTEXITCODE -ne 0) { throw 'Piko setup failed; see error above.' }
} finally {
    if ($null -eq $prior) { Remove-Item Env:PIKO_HOME -ErrorAction SilentlyContinue } else { $env:PIKO_HOME = $prior }
}
Write-Host 'Restart existing terminals and IDEs after PATH setup. No system PATH or external software was changed.'
