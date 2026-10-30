#requires -Version 5.1
<#
.SYNOPSIS
Install Piko for the current Windows user from a verified release archive.
.DESCRIPTION
Online mode downloads a GitHub release and its SHA-256 checksum. Local archives
and custom URLs require an explicit trusted archive SHA-256. No administrator,
Git, Node, Bun, execution-policy change, or downloaded PowerShell script is used.
#>
[CmdletBinding(DefaultParameterSetName = 'Release')]
param(
    [string]$PikoHome,
    [Parameter(ParameterSetName = 'Release')]
    [ValidatePattern('^(latest|v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)$')]
    [string]$Version = 'latest',
    [Parameter(ParameterSetName = 'Release')]
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'KochabStar/piko',
    [Parameter(Mandatory = $true, ParameterSetName = 'Archive')]
    [string]$ArchivePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Download')]
    [uri]$ArchiveUrl,
    [Parameter(Mandatory = $true, ParameterSetName = 'Archive')]
    [Parameter(Mandatory = $true, ParameterSetName = 'Download')]
    [Parameter(ParameterSetName = 'Release')]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$Sha256,
    [uri]$Proxy,
    [switch]$NoPath,
    [switch]$NoSource,
    [ValidatePattern('^[a-z0-9][a-z0-9._-]{0,79}$')]
    [string]$SourceName = 'main',
    [uri]$SourceUrl = 'https://raw.githubusercontent.com/KochabStar/piko-source/main/',
    [ValidateSet('http', 'git')]
    [string]$SourceType = 'http',
    [string]$SourceRef = 'main'
)
$ErrorActionPreference = 'Stop'
# Avoid inheriting PowerShell 7 native stderr policy in PowerShell 7.3+.
$PSNativeCommandUseErrorActionPreference = $false

function Get-PikoHash([string]$File) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Assert-PikoUrl([uri]$Url) {
    if (-not $Url.IsAbsoluteUri -or $Url.UserInfo -or $Url.Fragment -or
        ($Url.Scheme -ne 'https' -and -not ($Url.Scheme -eq 'http' -and $Url.IsLoopback))) {
        throw 'Only HTTPS URLs (or loopback HTTP for local testing) are allowed.'
    }
}
function Assert-PikoUnlinked([string]$ItemPath) {
    $part = [IO.Path]::GetFullPath($ItemPath)
    while ($part) {
        if ([IO.File]::Exists($part) -or [IO.Directory]::Exists($part)) {
            if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Linked installation paths are not supported: $part"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }
        $part = $parent
    }
}
function Receive-PikoFile([uri]$Url, [string]$Output, [long]$Limit) {
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    for ($redirect = 0; $redirect -le 8; $redirect++) {
        Assert-PikoUrl $Url
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 120000
        $request.ReadWriteTimeout = 120000
        $request.UserAgent = 'Piko-Installer/1.0'
        if ($Proxy) { $request.Proxy = [Net.WebProxy]::new($Proxy) }
        $response = $null
        try {
            $response = $request.GetResponse()
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                if ($redirect -eq 8 -or -not $response.Headers['Location']) { throw 'Download redirect limit exceeded.' }
                $next = [uri]::new($Url, $response.Headers['Location'])
                Assert-PikoUrl $next
                if ($Url.Scheme -eq 'https' -and $next.Scheme -ne 'https') { throw 'HTTPS downgrade refused.' }
                $Url = $next
                continue
            }
            if ($status -ne 200) { throw "Unexpected download status: $status" }
            if ($response.ContentLength -gt $Limit) { throw 'Download exceeds size limit.' }
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Open($Output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $Limit -or [DateTime]::UtcNow -gt $deadline) { throw 'Download exceeds size or time limit.' }
                    $outputStream.Write($buffer, 0, $count)
                }
                if ($total -eq 0) { throw 'Empty download refused.' }
            } finally { $inputStream.Dispose(); $outputStream.Dispose() }
            return
        } finally { if ($response) { $response.Dispose() } }
    }
}
function Invoke-Piko([string]$Executable, [string[]]$Arguments) {
    $result = & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Piko command failed ($LASTEXITCODE): $($Arguments -join ' ')" }
    return $result
}
function Read-PikoZipText($Entry) {
    if ($Entry.Length -gt 65536) { throw 'Release metadata exceeds size limit.' }
    $reader = [IO.StreamReader]::new($Entry.Open(), [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'Piko requires 64-bit Windows.'
}
$architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if (-not $architecture) { $architecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
if ($architecture -ne 'AMD64') { throw 'This installer requires an x64 Windows machine.' }
if (-not $PikoHome) { $PikoHome = $env:PIKO_HOME }
if (-not $PikoHome) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; specify -PikoHome.' }
    $PikoHome = Join-Path $env:LOCALAPPDATA 'piko'
}
$PikoHome = [IO.Path]::GetFullPath($PikoHome)
if ($PikoHome -eq [IO.Path]::GetPathRoot($PikoHome) -or $PikoHome -match '[;\r\n]') {
    throw 'Choose a dedicated Piko directory, not a drive root or PATH-unsafe name.'
}
Assert-PikoUnlinked $PikoHome
$target = Join-Path $PikoHome 'apps\piko\piko.exe'
Assert-PikoUnlinked $target
if (-not $NoSource) { Assert-PikoUrl $SourceUrl }
if ($Proxy -and ($Proxy.Scheme -notin @('http', 'https') -or $Proxy.UserInfo)) { throw 'Proxy must be an HTTP(S) URL without embedded credentials.' }
$priorHome = $env:PIKO_HOME
$priorTls = [Net.ServicePointManager]::SecurityProtocol
$temp = Join-Path ([IO.Path]::GetTempPath()) ('piko-install-' + [Guid]::NewGuid().ToString('N'))
$success = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = $priorTls -bor [Net.SecurityProtocolType]::Tls12
    $null = [IO.Directory]::CreateDirectory($temp)
    if ($PSCmdlet.ParameterSetName -eq 'Archive') {
        $archive = [IO.Path]::GetFullPath($ArchivePath)
        if (-not [IO.File]::Exists($archive)) { throw "Release archive not found: $archive" }
    } else {
        $archive = Join-Path $temp 'release.zip'
        if ($PSCmdlet.ParameterSetName -eq 'Release') {
            if ($Version -eq 'latest') {
                $metadataFile = Join-Path $temp 'github-release.json'
                try { Receive-PikoFile ([uri]"https://api.github.com/repos/$Repository/releases/latest") $metadataFile 2097152 }
                catch { throw "Cannot resolve a published Piko release. Publish a release first or use -ArchivePath with -Sha256. $($_.Exception.Message)" }
                $release = [IO.File]::ReadAllText($metadataFile) | ConvertFrom-Json
                if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Latest release metadata is not a stable version.' }
                $Version = [string]$release.tag_name
            }
            $number = $Version -replace '^v', ''
            $tag = if ($Version.StartsWith('v')) { $Version } else { 'v' + $Version }
            $asset = "piko-$number-windows-x64.zip"
            $ArchiveUrl = [uri]"https://github.com/$Repository/releases/download/$tag/$asset"
            if (-not $Sha256) {
                $checksumFile = Join-Path $temp 'release.sha256'
                Receive-PikoFile ([uri]($ArchiveUrl.AbsoluteUri + '.sha256')) $checksumFile 4096
                $checksumText = [IO.File]::ReadAllText($checksumFile).Trim()
                if ($checksumText -notmatch ('^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($asset) + '$')) { throw 'Invalid archive checksum file.' }
                $Sha256 = $Matches[1]
            }
        }
        Write-Host "Downloading $ArchiveUrl"
        Receive-PikoFile $ArchiveUrl $archive 536870912
    }
    if (([IO.FileInfo]$archive).Length -gt 536870912 -or (Get-PikoHash $archive) -ine $Sha256) {
        throw 'Archive checksum mismatch or size limit exceeded. Nothing was executed.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $executables = @($zip.Entries | Where-Object { $_.FullName -match '^piko-[A-Za-z0-9.+-]+-windows-x64/piko\.exe$' })
        if ($executables.Count -ne 1 -or $zip.Entries.Count -gt 20000) { throw 'Invalid release archive layout.' }
        $entry = $executables[0]
        $prefix = $entry.FullName.Substring(0, $entry.FullName.Length - 'piko.exe'.Length)
        $metadataEntries = @($zip.Entries | Where-Object { $_.FullName -ceq ($prefix + 'release.json') })
        $checksumEntries = @($zip.Entries | Where-Object { $_.FullName -ceq ($prefix + 'SHA256SUMS.txt') })
        if ($metadataEntries.Count -ne 1 -or $checksumEntries.Count -ne 1) { throw 'Release metadata missing or duplicated.' }
        $metadata = (Read-PikoZipText $metadataEntries[0]) | ConvertFrom-Json
        $exeSums = (Read-PikoZipText $checksumEntries[0]).Trim()
        if ($metadata.platform -ne 'windows-x64' -or $metadata.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$' -or
            $metadata.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
            $prefix -cne "piko-$($metadata.version)-windows-x64/" -or
            $exeSums -notmatch '^([a-fA-F0-9]{64})\s+\*?piko\.exe$') { throw 'Invalid release identity or executable checksum metadata.' }
        if ($Matches[1] -ine $metadata.sha256) { throw 'Release executable checksums disagree.' }
        if ($PSCmdlet.ParameterSetName -eq 'Release' -and $metadata.version -cne $number) { throw 'Downloaded release version does not match request.' }
        if ($entry.Length -le 0 -or $entry.Length -gt 536870912) { throw 'Executable exceeds size limit.' }
        # Extract only this exact verified entry. Never extract or run bundled scripts,
        # and never use untrusted ZIP entry paths as local extraction destinations.
        $candidate = Join-Path $temp 'piko.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $candidate, $false)
    } finally { $zip.Dispose() }
    if ((Get-PikoHash $candidate) -ine $metadata.sha256) { throw 'Executable checksum mismatch. Nothing was executed.' }
    $env:PIKO_HOME = $PikoHome
    if ([IO.File]::Exists($target)) {
        if ((Get-PikoHash $target) -ine $metadata.sha256) { throw 'Another Piko build is already installed. Use piko self update with a trusted checksum; this installer never overwrites it.' }
        Write-Host 'Matching Piko build already installed; keeping existing state and packages.'
    } else {
        $null = Invoke-Piko $candidate @('setup')
    }
    $installedVersion = (Invoke-Piko $target @('--version') | Out-String).Trim()
    if ($installedVersion -cne $metadata.version) { throw 'Installed Piko version does not match release metadata.' }
    if (-not $NoSource) {
        $sources = (Invoke-Piko $target @('source', 'list') | Out-String) | ConvertFrom-Json
        $existing = @($sources | Where-Object { $_.alias -eq $SourceName })
        if ($existing.Count) {
            if ($existing.Count -ne 1 -or $existing[0].type -ne $SourceType -or
                ([uri]$existing[0].url).AbsoluteUri.TrimEnd('/') -cne $SourceUrl.AbsoluteUri.TrimEnd('/') -or
                ($SourceType -eq 'git' -and $existing[0].ref -cne $SourceRef)) {
                throw 'Existing source alias has a different configuration; nothing was replaced. Choose another -SourceName or use -NoSource.'
            }
        } else {
            $sourceArgs = @('source', 'add', $SourceName, $SourceUrl.AbsoluteUri, '--type', $SourceType)
            if ($SourceType -eq 'git') { $sourceArgs += @('--ref', $SourceRef) }
            $null = Invoke-Piko $target $sourceArgs
        }
    }
    if (-not $NoPath) {
        $null = Invoke-Piko $target @('setup', '--path')
        $shims = Join-Path $PikoHome 'shims'
        if (-not @($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $shims.TrimEnd('\') }).Count) { $env:Path = $shims + ';' + $env:Path }
    }
    $success = $true
    Write-Host "Piko $installedVersion installed: $target"
    if (-not $NoPath) { Write-Host 'User PATH and this PowerShell session updated. Restart other terminals and IDEs.' }
    if (-not $NoSource) { Write-Host "Source ready: $SourceName ($SourceUrl)" }
    Write-Host 'No packages, profiles, services, fonts, file associations or system PATH were changed.'
    Write-Host "Next: piko install $SourceName/node; piko use $SourceName/node"
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $priorTls
    if (-not $success) {
        if ($null -eq $priorHome) { Remove-Item Env:PIKO_HOME -ErrorAction SilentlyContinue } else { $env:PIKO_HOME = $priorHome }
    }
    if ([IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp, $true) }
}
