#requires -Version 5.1
# Host-safe tests: no Sandbox launch, user PATH changes, downloads or elevation.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('piko-sandbox-script-tests-' + [guid]::NewGuid().ToString('N'))
$session = $null
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    foreach ($relative in @('tests\ctrl-c.test.ps1', 'scripts\install.ps1', 'scripts\prepare-sandbox.ps1', 'scripts\sandbox-run.ps1', 'scripts\sandbox-network.ps1', 'scripts\sandbox-rerun.ps1', 'scripts\sandbox-bun-network.ps1', 'scripts\sandbox-report.ps1')) {
        $tokens = $null; $errors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo $relative), [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw ($errors | Out-String) }
    }
    # A deliberately non-runnable fixture proves preparation never executes the input binary.
    $dummy = Join-Path $temporary 'fixture.exe'
    [IO.File]::WriteAllText($dummy, 'not an executable: configuration-generation fixture')
    $session = & (Join-Path $repo 'scripts\prepare-sandbox.ps1') -Executable $dummy -IncludePi
    $xml = [xml](Get-Content -LiteralPath $session.Configuration -Raw)
    $folders = @($xml.Configuration.MappedFolders.MappedFolder)
    if ($folders.Count -ne 2) { throw 'Expected exactly two mappings.' }
    if ($folders[0].ReadOnly -ne 'true' -or $folders[1].ReadOnly -ne 'false') { throw 'Mapping permissions are unsafe.' }
    if ($folders[0].HostFolder -ne $session.Input -or $folders[1].HostFolder -ne $session.Results) { throw 'Unexpected host mappings.' }
    if ($xml.Configuration.ClipboardRedirection -ne 'Disable') { throw 'Clipboard must be disabled.' }
    if ($xml.Configuration.Networking -ne 'Enable') { throw 'Network is required for the documented smoke test.' }
    if (@(Get-ChildItem -LiteralPath $session.Results).Count -ne 0) { throw 'Preparation wrote unexpected results.' }
    $config = Get-Content -LiteralPath (Join-Path $session.Input 'config.json') -Raw | ConvertFrom-Json
    if (-not $config.includePi -or $config.schemaVersion -ne 1) { throw 'Options were not serialized correctly.' }
    if ($config.executableSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Missing binary fingerprint.' }
    $metadata = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
    if ($config.pikoVersion -ne $metadata.version -or -not $config.nextStage) { throw 'Next-stage version/options were not serialized correctly.' }
    $fixtureIndex = [IO.File]::ReadAllText((Join-Path $session.Input 'source\index.json')) | ConvertFrom-Json
    foreach ($fixture in @('rg-alternative', 'saved-fixture')) {
        if (-not $fixtureIndex.packages.PSObject.Properties[$fixture]) { throw "Missing next-stage fixture: $fixture" }
        $manifestFile = Join-Path $session.Input ('source\' + $fixture + '.json')
        $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
        if ($manifest.name -ne $fixture -or $manifest.version -ne '1.0.0') { throw 'Next-stage fixture identity mismatch.' }
        $bytes = [IO.File]::ReadAllBytes($manifestFile)
        if ($bytes.Length -gt 2 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { throw 'Source JSON must not contain a PowerShell UTF-8 BOM.' }
    }
    if (-not $config.maintenanceStage -or -not (Test-Path -LiteralPath (Join-Path $session.Input 'ctrl-c.test.ps1'))) { throw 'Maintenance stage or Ctrl+C fixture missing.' }
    if (-not $config.scriptStage) { throw 'Missing script approval stage flag.' }
    $registry = [IO.File]::ReadAllText((Join-Path $session.Input 'source\registry\metadata.json')) | ConvertFrom-Json
    if (-not $registry.PSObject.Properties['@piko-fixture/scripts'] -or -not (Test-Path -LiteralPath (Join-Path $session.Input 'source\registry\archives\scripts-1.0.0.tgz'))) { throw 'Script fixture registry was not packaged.' }
    if (-not (Test-Path -LiteralPath (Join-Path $session.Input 'source\index.json'))) { throw 'Source fixtures were not copied.' }
    foreach ($file in @('sandbox-report.ps1', 'network.ps1', 'rerun.ps1', '1-check-network.cmd', '2-rerun-tests.cmd', 'bun-network.ps1', '3-check-bun-network.cmd', 'rerun-fixed.ps1', '4-rerun-fixed-tests.cmd')) {
        if (-not (Test-Path -LiteralPath (Join-Path $session.Input $file))) { throw "Missing double-click helper: $file" }
    }

    $guarded = $false
    try { & (Join-Path $repo 'scripts\sandbox-run.ps1') }
    catch { $guarded = $_.Exception.Message -like 'Safety guard:*' }
    if (-not $guarded) { throw 'Sandbox runner must refuse host execution before modifying any paths.' }

    foreach ($helper in @('sandbox-network.ps1', 'sandbox-rerun.ps1', 'sandbox-bun-network.ps1')) {
        $guarded = $false
        try { & (Join-Path $repo ('scripts\' + $helper)) }
        catch { $guarded = $_.Exception.Message -like 'Safety guard:*' }
        if (-not $guarded) { throw "$helper must refuse host execution before any side effects." }
    }
    . (Join-Path $repo 'scripts\sandbox-report.ps1')
    # Extract only the quoting helper for a deterministic native-argv roundtrip.
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\sandbox-run.ps1'), [ref]$tokens, [ref]$errors)
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Quote-Argument' }, $true)
    . ([scriptblock]::Create($function.Extent.Text))
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        $probe = Join-Path $temporary 'argv.cjs'
        [IO.File]::WriteAllText($probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        $expected = @('space argument', 'a"b', '', 'trailing slash\', 'backslash\"quote', '&|<>^%!*')
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $node.Source
        $info.Arguments = ((@($probe) + $expected | ForEach-Object { Quote-Argument $_ }) -join ' ')
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $info
        try {
            $null = $process.Start()
            $text = $process.StandardOutput.ReadToEnd()
            if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'argv probe failed.' }
            $actual = ConvertFrom-Json -InputObject $text
            if ($actual.Count -ne $expected.Count) { throw ('argv count mismatch. command=' + $info.Arguments + '; output=' + $text) }
            for ($i = 0; $i -lt $expected.Count; $i++) {
                if ($actual[$i] -cne $expected[$i]) { throw "argv mismatch at index $i" }
            }
        } finally { $process.Dispose() }
        Write-Output 'PASS: Windows native argument quoting, including empty and special-character arguments.'

        # Exercise the actual command runner outside Sandbox using isolated logs and
        # a harmless developer Node probe, not the Sandbox installation workflow.
        foreach ($name in @('Invoke-Check')) {
            $definition = $ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
            . ([scriptblock]::Create($definition.Extent.Text))
        }
        $work = $temporary
        $logDir = Join-Path $temporary 'logs'
        New-Item -ItemType Directory -Path $logDir | Out-Null
        $reportPath = Join-Path $temporary 'runner-report.json'
        $report = [ordered]@{ status = 'running'; checks = @() }
        $steps = New-Object 'System.Collections.Generic.List[object]'
        [IO.File]::WriteAllText($probe, 'process.stdout.write("stdout-value");process.stderr.write("stderr-value");process.exit(7)')
        $output = Invoke-Check 'expected nonzero exit' $node.Source @($probe) -ExpectedExit 7
        if ($output -notmatch 'stdout-value' -or $output -notmatch 'stderr-value') { throw 'Runner lost output streams.' }
        $failedAsExpected = $false
        try { $null = Invoke-Check 'unexpected nonzero exit' $node.Source @($probe) }
        catch { $failedAsExpected = $_.Exception.Message -like 'Check failed:*' }
        if (-not $failedAsExpected) { throw 'Runner did not reject unexpected exit status.' }
        $saved = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
        if ($saved.checks.Count -ne 2 -or -not $saved.checks[0].passed -or $saved.checks[1].passed) { throw 'Runner report verdicts are incorrect.' }
        Write-Output 'PASS: command runner captures both streams, handles expected failures and persists failing verdicts.'
    } else { Write-Output 'SKIP: native argument roundtrip (development Node not found).' }
    # Exercise the actual HTTP job's idle cancellation without running the installer.
    $serverCommand = $ast.Find({ param($item) $item -is [Management.Automation.Language.CommandAst] -and $item.GetCommandName() -eq 'Start-Job' }, $true)
    $serverBlock = @($serverCommand.CommandElements | Where-Object { $_ -is [Management.Automation.Language.ScriptBlockExpressionAst] })[0].ScriptBlock.GetScriptBlock()
    $portProbe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $portProbe.Start(); $port = $portProbe.LocalEndpoint.Port; $portProbe.Stop()
    $fixtureServer = Start-Job -ArgumentList (Join-Path $session.Input 'source'), $port -ScriptBlock $serverBlock
    try {
        $served = $false
        for ($n=0; $n -lt 20; $n++) {
            try { $null = Invoke-WebRequest -Uri ('http://localhost:' + $port + '/index.json') -UseBasicParsing -TimeoutSec 1; $served = $true; break }
            catch { if ($fixtureServer.State -eq 'Failed') { break }; Start-Sleep -Milliseconds 100 }
        }
        if ($served) {
            $timer = [Diagnostics.Stopwatch]::StartNew(); Stop-Job $fixtureServer; $timer.Stop()
            if ($timer.ElapsedMilliseconds -gt 5000) { throw 'Idle HTTP fixture server shutdown blocked final report publication.' }
            Write-Output 'PASS: idle fixture server cancels promptly before final report publication.'
        } elseif ($fixtureServer.State -eq 'Failed') { Write-Output 'SKIP: host HTTP listener unavailable; Sandbox teardown still needs runtime confirmation.' }
        else { throw 'Fixture HTTP server did not become ready.' }
    } finally { Stop-Job $fixtureServer -ErrorAction SilentlyContinue; Remove-Job $fixtureServer -Force -ErrorAction SilentlyContinue }
    Write-Output 'PASS: PowerShell syntax, WSB permissions/options, fixture packaging, and host-execution safety guard. Sandbox was not launched.'
} finally {
    if ($session) { Remove-Item -LiteralPath $session.Session -Recurse -Force }
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
