#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Executable,
    [switch]$IncludePi,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Executable) { $Executable = Join-Path $repo 'dist\piko.exe' }
$exe = (Resolve-Path -LiteralPath $Executable).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build dist/piko.exe first.' }
if ([IO.Path]::GetExtension($exe) -ine '.exe') { throw 'Executable must be an .exe file.' }
$source = Join-Path $repo 'examples\source'
if (-not (Test-Path -LiteralPath (Join-Path $source 'index.json'))) { throw 'Example source is missing.' }

# One directory per run: never overwrite a directory mapped into a running Sandbox.
$session = Join-Path $repo ('.sandbox\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$inputDir = Join-Path $session 'input'
$outputDir = Join-Path $session 'results'
New-Item -ItemType Directory -Path $inputDir, $outputDir -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $inputDir 'piko.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'sandbox-run.ps1') -Destination (Join-Path $inputDir 'run.ps1')
# These helpers can also be added to an existing mapped input folder without
# replacing its immutable piko.exe/config.json/run.ps1 snapshot.
foreach ($entry in @(
    @('sandbox-report.ps1', 'sandbox-report.ps1'),
    @('sandbox-network.ps1', 'network.ps1'),
    @('sandbox-network.cmd', '1-check-network.cmd'),
    @('sandbox-rerun.ps1', 'rerun.ps1'),
    @('sandbox-rerun.cmd', '2-rerun-tests.cmd'),
    @('sandbox-rerun.ps1', 'rerun-fixed.ps1'),
    @('sandbox-rerun-fixed.cmd', '4-rerun-fixed-tests.cmd'),
    @('sandbox-bun-network.ps1', 'bun-network.ps1'),
    @('sandbox-bun-network.cmd', '3-check-bun-network.cmd')
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry[0]) -Destination (Join-Path $inputDir $entry[1])
}
$probe = Join-Path $repo 'dist\network-probe.exe'
if (Test-Path -LiteralPath $probe) { Copy-Item -LiteralPath $probe -Destination (Join-Path $inputDir 'network-probe.exe') }
Copy-Item -LiteralPath $source -Destination (Join-Path $inputDir 'source') -Recurse
$stream = [IO.File]::OpenRead((Join-Path $inputDir 'piko.exe'))
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
$config = [ordered]@{
    schemaVersion = 1
    executableSha256 = $hash
    pikoVersion = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    includePi = [bool]$IncludePi
    maintenanceStage = ([version](Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version -ge [version]'0.4.0')
    scriptStage = ([version](Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version -ge [version]'0.3.0')
    nextStage = ([version](Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version -ge [version]'0.2.0')
    preparedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $inputDir 'config.json') -Encoding UTF8
if ($config.nextStage) {
    # Sandbox-only fixture packages reuse a verified upstream ZIP; no extra binary
    # or arbitrary install script is introduced into the test source.
    $fixtureSource = Join-Path $inputDir 'source'
    $indexFile = Join-Path $fixtureSource 'index.json'
    $index = Get-Content -LiteralPath $indexFile -Raw | ConvertFrom-Json
    $jsonEncoding = New-Object Text.UTF8Encoding($false)
    foreach ($fixture in @('rg-alternative', 'saved-fixture')) {
        $manifest = Get-Content -LiteralPath (Join-Path $fixtureSource 'packages\ripgrep\15.2.0.json') -Raw | ConvertFrom-Json
        $manifest.name = $fixture
        $manifest.version = '1.0.0'
        if ($fixture -eq 'rg-alternative' -and $config.maintenanceStage) {
            $manifest.platforms.'windows-x64' | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{ TOOL_FIXTURE_VERSION='{version}' })
        }
        if ($fixture -eq 'saved-fixture') {
            $manifest.platforms.'windows-x64'.bin = [pscustomobject]@{ saved = 'rg.exe' }
            $manifest.platforms.'windows-x64' | Add-Member -NotePropertyName persist -NotePropertyValue @('settings')
        }
        [IO.File]::WriteAllText((Join-Path $fixtureSource ($fixture + '.json')), ($manifest | ConvertTo-Json -Depth 12), $jsonEncoding)
        $index.packages | Add-Member -NotePropertyName $fixture -NotePropertyValue ([pscustomobject]@{latest='1.0.0';versions=[pscustomobject]@{'1.0.0'=($fixture + '.json')}})
    }
    [IO.File]::WriteAllText($indexFile, ($index | ConvertTo-Json -Depth 12), $jsonEncoding)
}

if ($config.maintenanceStage) {
    Copy-Item -LiteralPath (Join-Path $repo 'tests\ctrl-c.test.ps1') -Destination (Join-Path $inputDir 'ctrl-c.test.ps1')
}
if ($config.scriptStage) {
    $registry = Join-Path $repo 'dist\sandbox-registry'
    if (-not (Test-Path -LiteralPath (Join-Path $registry 'metadata.json'))) { throw 'Build dist/piko.exe and its Sandbox registry fixtures first.' }
    Copy-Item -LiteralPath $registry -Destination (Join-Path $inputDir 'source\registry') -Recurse
}

$escapedInput = [Security.SecurityElement]::Escape($inputDir)
$escapedOutput = [Security.SecurityElement]::Escape($outputDir)
$wsb = @"
<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>Enable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escapedInput</HostFolder>
      <SandboxFolder>C:\PikoSandboxInput</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$escapedOutput</HostFolder>
      <SandboxFolder>C:\PikoSandboxResults</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File C:\PikoSandboxInput\run.ps1</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $session 'piko.wsb'
$wsb | Set-Content -LiteralPath $wsbPath -Encoding UTF8
# XML parse is a validation step, not a launch.
$null = [xml](Get-Content -LiteralPath $wsbPath -Raw)
Write-Host "Prepared: $wsbPath"
Write-Host "Results:  $outputDir"
Write-Host "EXE SHA256: $hash"
Write-Host 'Network is enabled for downloads. Only the dedicated results folder is writable from Sandbox.'
Write-Host 'No host PATH changes, feature enablement, elevation or restart is performed.'
if ($Launch) {
    $sandbox = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
    if (-not (Test-Path -LiteralPath $sandbox)) { throw "Windows Sandbox is not available. Configuration was saved to $wsbPath" }
    Start-Process -FilePath $sandbox -ArgumentList ('"' + $wsbPath + '"') | Out-Null
} else {
    Write-Host 'Sandbox was not launched. Open the .wsb file when ready, or prepare again with -Launch.'
}
# Return paths for automation without asking callers to parse human-readable messages.
[pscustomobject]@{ Session = $session; Configuration = $wsbPath; Input = $inputDir; Results = $outputDir }
