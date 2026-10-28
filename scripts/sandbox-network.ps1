#requires -Version 5.1
# Read-only network diagnostics; run inside the mapped Windows Sandbox input folder.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PikoSandboxInput') {
    throw 'Safety guard: run this script only from C:\PikoSandboxInput inside Windows Sandbox.'
}
$outputDir = 'C:\PikoSandboxResults'
if (-not (Test-Path -LiteralPath $outputDir -PathType Container)) { throw 'Mapped results directory is missing.' }
$results = New-Object 'System.Collections.Generic.List[object]'
$report = [ordered]@{
    status = 'running'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    checks = @()
    notes = @(
        'This diagnostic does not change proxy, firewall, certificates, PATH or system settings.',
        'The local source server normally stops after the main test finishes; a closed local port then is not an upstream connectivity failure.',
        'PowerShell HTTP success does not prove that Bun uses the same proxy or trust configuration.',
        'No credentials or proxy URLs are exported.'
    )
}
$transcript = $false
$failed = $false
try {
    Start-Transcript -LiteralPath (Join-Path $outputDir 'network-transcript.txt') -Force | Out-Null
    $transcript = $true
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputDir 'network-report.json') -Encoding UTF8
    $targets = @(
        'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip',
        'https://nodejs.org/dist/v26.12.1/SHASUMS256.txt',
        'https://registry.npmjs.org/prettier'
    )
    foreach ($target in $targets) {
        $uri = [Uri]$target
        Write-Host "[NETWORK] $($uri.Host)" -ForegroundColor Cyan
        $check = [ordered]@{ url = $target; dns = $false; tcp443 = $false; http = $false; statusCode = $null; redirectsToHost = $null; systemProxySelected = $false; proxyEnvironmentPresent = $false; stage = 'dns'; errorType = $null }
        $client = $null
        $response = $null
        $request = $null
        try {
            $addresses = [Net.Dns]::GetHostAddresses($uri.Host)
            $check.dns = $addresses.Count -gt 0
            Write-Host "  DNS: $($check.dns)"
            $check.stage = 'tcp'
            $client = New-Object Net.Sockets.TcpClient
            $connect = $client.ConnectAsync($uri.Host, 443)
            if ($connect.Wait(10000)) { $null = $connect.GetAwaiter().GetResult(); $check.tcp443 = $client.Connected }
            Write-Host "  Direct TCP 443: $($check.tcp443) (HTTP may instead use a system proxy)"
        } catch {
            $check.errorType = $_.Exception.GetType().FullName
            Write-Host "  $($check.stage) probe failed: $($check.errorType)" -ForegroundColor Yellow
        } finally { if ($client) { $client.Dispose() } }
        # HTTP still runs if direct DNS/TCP failed: a system proxy may resolve the remote host.
        $check.stage = 'http'
        try {
            $proxy = [Net.WebRequest]::DefaultWebProxy
            if ($proxy) { $check.systemProxySelected = -not $proxy.IsBypassed($uri) }
            foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
                if ([Environment]::GetEnvironmentVariable($name)) { $check.proxyEnvironmentPresent = $true }
            }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.Method = 'HEAD'
            $request.AllowAutoRedirect = $true
            $request.MaximumAutomaticRedirections = 8
            $request.Timeout = 30000
            $request.ReadWriteTimeout = 30000
            $request.UserAgent = 'Piko-Sandbox-Network-Check/1'
            $response = $request.GetResponse()
            $check.statusCode = [int]$response.StatusCode
            $check.redirectsToHost = $response.ResponseUri.Host
            $check.http = $check.statusCode -ge 200 -and $check.statusCode -lt 400
            Write-Host "  HTTP: $($check.statusCode); final host: $($check.redirectsToHost)" -ForegroundColor Green
        } catch {
            $check.errorType = $_.Exception.GetType().FullName
            $httpError = $_.Exception
            if ($httpError -is [Net.WebException] -and $httpError.Response) {
                $check.statusCode = [int]$httpError.Response.StatusCode
                $httpError.Response.Close()
            }
            Write-Host "  HTTP failed: $($check.errorType); status: $($check.statusCode)" -ForegroundColor Red
        } finally {
            if ($response) { $response.Close() }
            if ($request) { $request.Abort() }
        }
        $check.stage = 'completed'
        if (-not $check.http) { $failed = $true }
        $results.Add([pscustomobject]$check)
        $report.checks = @($results.ToArray())
        $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputDir 'network-report.json') -Encoding UTF8
    }
    $report.status = if ($failed) { 'failed' } else { 'passed' }
} catch {
    $failed = $true
    $report.status = 'failed'
    Write-Host ('Diagnostic error: ' + $_.Exception.GetType().FullName) -ForegroundColor Red
} finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $report.checks = @($results.ToArray())
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputDir 'network-report.json') -Encoding UTF8
    Write-Host "Network diagnostic: $($report.status)"
    Write-Host 'Report: C:\PikoSandboxResults\network-report.json'
    Write-Host 'If HTTP passed, double-click 2-rerun-tests.cmd. If it failed, keep this Sandbox open and inspect/share the report.'
    if ($transcript) { Stop-Transcript | Out-Null }
}
if ($failed) { exit 1 }
