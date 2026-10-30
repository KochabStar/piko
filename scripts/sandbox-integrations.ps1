#requires -Version 5.1
# Dot-source only from the guarded Sandbox runner after setup and source startup.
$ErrorActionPreference = 'Stop'
if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PikoSandboxInput') {
    throw 'Safety guard: integration acceptance only runs inside the prepared Windows Sandbox.'
}
function Write-IntegrationJson([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 64), (New-Object Text.UTF8Encoding($false)))
}
function Read-IntegrationValue([string]$Key, [string]$Name) {
    Assert-Check ($Key.StartsWith('HKCU\')) 'Integration fixture attempted a non-user registry read.'
    $handle = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key.Substring(5))
    try {
        if (-not $handle -or -not ($handle.GetValueNames() -contains $Name)) { return $null }
        return [pscustomobject]@{type=$handle.GetValueKind($Name).ToString();value=$handle.GetValue($Name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
    } finally { if ($handle) { $handle.Dispose() } }
}

$integrationSpec = 'main/sandbox-integration'
$profile = Join-Path $work ("Profile '" + [char]0x4e2d + [char]0x6587 + '.ps1')
[IO.File]::WriteAllText($profile, "# unrelated user configuration`r`n", [Text.Encoding]::Unicode)
$originalProfile = [IO.File]::ReadAllBytes($profile)
$null = Invoke-Check 'Install integration fixture without external effects' $installedExe @('install', "$integrationSpec@1.0.0")
$integration = Find-Install 'sandbox-integration'
Assert-Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -eq [Convert]::ToBase64String($originalProfile)) 'Installation changed a Profile.'
Assert-Check ($null -eq (Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME')) 'Installation changed the user environment.'
$shellArgs = @($integrationSpec, '--shell', 'powershell', '--profile', $profile)
$profilePlan = Invoke-Check 'Preview PowerShell initialization without editing Profile' $installedExe (@('integrate') + $shellArgs + @('--dry-run')) | ConvertFrom-Json
$null = Invoke-Check 'Shell initialization rejects --yes without code approval' $installedExe (@('integrate') + $shellArgs + @('--yes', '--binding', $profilePlan.binding)) -ExpectedExit 1
Assert-Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -eq [Convert]::ToBase64String($originalProfile)) 'Preview or rejected approval changed the Profile.'
$null = Invoke-Check 'Approve the exact fixture Profile content' $installedExe (@('integrate') + $shellArgs + @('--approve-shell', '--binding', $profilePlan.binding))
$quotedProfile = "'" + $profile.Replace("'", "''") + "'"
$inactiveProbe = ". $quotedProfile; if (Get-Command PikoSandboxIntegration -ErrorAction SilentlyContinue) { throw 'Unselected package initialized' }; [Console]::WriteLine('inactive-ok')"
Assert-Check ((Invoke-Check 'Unselected approved package stays inactive in a fresh shell' $shell @('-NoProfile','-NonInteractive','-Command',$inactiveProbe)) -match 'inactive-ok') 'Unselected shell initialization ran.'
$null = Invoke-Check 'Select the approved integration fixture' $installedExe @('use', "$integrationSpec@1.0.0")
$ambientHome = Join-Path $work 'unrelated-home'
$originalHome = $env:PIKO_HOME
try {
    $env:PIKO_HOME = $ambientHome
    $probe = ". $quotedProfile; PikoSandboxIntegration; if (`$env:PIKO_HOME -ne '" + $ambientHome.Replace("'", "''") + "') { throw 'PIKO_HOME leaked' }"
    Assert-Check ((Invoke-Check 'Unicode UTF-16 Profile loads the approved root and restores ambient PIKO_HOME' $shell @('-NoProfile','-NonInteractive','-Command',$probe)) -eq 'shell-1.0.0') 'Approved initialization failed.'
} finally { $env:PIKO_HOME = $originalHome }
$approvedProfile = [IO.File]::ReadAllBytes($profile)
Assert-Check ($approvedProfile[0] -eq 255 -and $approvedProfile[1] -eq 254) 'Profile BOM was lost.'
try {
    [IO.File]::WriteAllText($profile, ([IO.File]::ReadAllText($profile).Replace('try {', 'try { # user edit')), [Text.Encoding]::Unicode)
    $null = Invoke-Check 'Edited managed Profile block blocks revocation' $installedExe (@('unintegrate') + $shellArgs + @('--dry-run')) -ExpectedExit 1
} finally { [IO.File]::WriteAllBytes($profile, $approvedProfile) }
$null = Invoke-Check 'Install a new shell declaration without inheriting approval' $installedExe @('install', "$integrationSpec@2.0.0")
$null = Invoke-Check 'Select the unapproved fixture version' $installedExe @('use', "$integrationSpec@2.0.0")
Assert-Check ((Invoke-Check 'A fresh shell skips the unapproved version' $shell @('-NoProfile','-NonInteractive','-Command',$inactiveProbe)) -match 'inactive-ok') 'New version inherited initialization approval.'
$null = Invoke-Check 'Switch back to the approved fixture version' $installedExe @('use', "$integrationSpec@1.0.0")

# Exercise actual CLI journal validation and rollback without executing journal code.
$profileState = Read-State
$profileOwner = @($profileState.profiles.PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { $_.path -eq $profile })[0]
$removedProfile = [byte[]]([Text.Encoding]::Unicode.GetPreamble() + [Text.Encoding]::Unicode.GetBytes(([IO.File]::ReadAllText($profile).Replace($profileOwner.block, ''))))
$profileJournal = Join-Path $env:PIKO_HOME 'operations\profile.json'
Assert-Check (-not (Test-Path -LiteralPath $profileJournal)) 'Unexpected pending Profile journal.'
$change = [ordered]@{path=$profile;beforeRevision=$profileState.revision;before=[Convert]::ToBase64String($approvedProfile);after=[Convert]::ToBase64String($removedProfile);beforeProfile=$profileOwner;afterProfile=$null}
$invalidChange = $change | ConvertTo-Json -Depth 64 | ConvertFrom-Json
$invalidChange.after = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('unrelated replacement'))
Write-IntegrationJson $profileJournal ([ordered]@{changes=@($invalidChange)})
$null = Invoke-Check 'Recover refuses forged Profile replacement bytes' $installedExe @('recover') -ExpectedExit 1
Assert-Check ((Test-Path -LiteralPath $profileJournal) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -eq [Convert]::ToBase64String($approvedProfile)) 'Rejected recovery changed Profile bytes or removed evidence.'
Write-IntegrationJson $profileJournal ([ordered]@{changes=@($change)})
[IO.File]::WriteAllBytes($profile, $removedProfile)
$null = Invoke-Check 'Recover rolls back interrupted Profile removal' $installedExe @('recover')
Assert-Check ((-not (Test-Path -LiteralPath $profileJournal)) -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -eq [Convert]::ToBase64String($approvedProfile)) 'Profile recovery did not restore the exact bytes.'

$initialUserPath = Read-IntegrationValue 'HKCU\Environment' 'Path'
$desktopPlan = Invoke-Check 'Preview environment shortcut font and Open With integration' $installedExe @('integrate',$integrationSpec,'--desktop','--dry-run') | ConvertFrom-Json
Assert-Check ($null -eq (Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME')) 'Desktop preview wrote the environment.'
foreach ($effect in @($desktopPlan.effects | Where-Object { $_.target.kind -eq 'file' })) { Assert-Check (-not (Test-Path -LiteralPath $effect.target.path)) 'Desktop preview wrote an external file.' }
$null = Invoke-Check 'Desktop changes require confirmation' $installedExe @('integrate',$integrationSpec,'--desktop','--binding',$desktopPlan.binding) -ExpectedExit 1
$null = Invoke-Check 'Desktop changes reject a stale binding' $installedExe @('integrate',$integrationSpec,'--desktop','--yes','--binding',('0' * 64)) -ExpectedExit 1
$null = Invoke-Check 'Apply bound current-user desktop integration including a real font' $installedExe @('integrate',$integrationSpec,'--desktop','--yes','--binding',$desktopPlan.binding)
$desktop = (Read-State).desktop.PSObject.Properties[$integration.key].Value
foreach ($effect in $desktop.effects) {
    if ($effect.target.kind -eq 'file') { Assert-Check (Test-Path -LiteralPath $effect.target.path -PathType Leaf) 'Owned desktop file is missing.' }
    else {
        $actual = Read-IntegrationValue $effect.target.key $effect.target.name
        Assert-Check ($actual -and $actual.type -eq $effect.after.type -and [string]$actual.value -ceq [string]$effect.after.value) 'Owned registry value differs from its receipt.'
    }
}
$linkPath = @($desktop.effects | Where-Object { $_.target.kind -eq 'file' -and $_.target.path -like '*.lnk' })[0].target.path
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
Assert-Check ($link.TargetPath -ieq (Join-Path $env:PIKO_HOME ('apps\' + $integration.key + '\current\fixture.exe')) -and $link.Arguments -eq '--version') 'Real shortcut target or arguments differ.'
$fontPath = @($desktop.effects | Where-Object { $_.target.kind -eq 'file' -and $_.target.PSObject.Properties['font'] -and $_.target.font })[0].target.path
Assert-Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($fontPath)) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $env:PIKO_HOME ($integration.dir + '/fixture.ttf'))))) 'Registered font copy differs from the verified payload.'
Assert-Check ($null -eq (Read-IntegrationValue 'HKCU\Software\Classes\.piko-check' '')) 'Open With replaced the extension default.'
Assert-Check (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.piko-check\UserChoice')) 'Open With wrote UserChoice.'
Assert-Check (-not (Test-Path Env:SANDBOX_INTEGRATION_HOME)) 'Desktop integration changed its parent process environment.'
$null = Invoke-Check 'Pinned desktop integration blocks version switching' $installedExe @('use',"$integrationSpec@2.0.0") -ExpectedExit 1
$null = Invoke-Check 'Pinned desktop integration blocks unuse' $installedExe @('unuse',$integrationSpec) -ExpectedExit 1
$null = Invoke-Check 'Pinned desktop integration blocks forced uninstall' $installedExe @('uninstall',"$integrationSpec@1.0.0",'--force') -ExpectedExit 1
$userPath = Read-IntegrationValue 'HKCU\Environment' 'Path'
$extraPath = 'C:\PikoSandboxExtra'
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $userKey.SetValue('Path',($userPath.value + ';' + $extraPath),[Microsoft.Win32.RegistryValueKind]::$($userPath.type)) }
finally { $userKey.Dispose() }
$pathAfterUserEdit = (Read-IntegrationValue 'HKCU\Environment' 'Path').value
$desktopPlan = Invoke-Check 'Preview reapproval after an unrelated user PATH addition' $installedExe @('integrate',$integrationSpec,'--desktop','--dry-run') | ConvertFrom-Json
$null = Invoke-Check 'Reapprove without absorbing or reordering unrelated PATH entries' $installedExe @('integrate',$integrationSpec,'--desktop','--yes','--binding',$desktopPlan.binding)
Assert-Check ((Read-IntegrationValue 'HKCU\Environment' 'Path').value -ceq $pathAfterUserEdit) 'Reapproval reordered user PATH.'
$desktopState = Read-State
$desktop = $desktopState.desktop.PSObject.Properties[$integration.key].Value
$ownedEnvironment = Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME'
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $userKey.SetValue('SANDBOX_INTEGRATION_HOME','external-drift',[Microsoft.Win32.RegistryValueKind]::String) }
finally { $userKey.Dispose() }
$null = Invoke-Check 'External registry edits block desktop revocation' $installedExe @('unintegrate',$integrationSpec,'--desktop','--dry-run') -ExpectedExit 1
Assert-Check ((Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME').value -eq 'external-drift' -and (Test-Path -LiteralPath $fontPath) -and (Test-Path -LiteralPath $linkPath)) 'Conflict detection changed external resources.'
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $userKey.SetValue('SANDBOX_INTEGRATION_HOME',$ownedEnvironment.value,[Microsoft.Win32.RegistryValueKind]::String) }
finally { $userKey.Dispose() }
$removePlan = Invoke-Check 'Preview owned desktop removal after user PATH changes' $installedExe @('unintegrate',$integrationSpec,'--desktop','--dry-run') | ConvertFrom-Json
$desktopJournal = Join-Path $env:PIKO_HOME 'operations\desktop.json'
Assert-Check (-not (Test-Path -LiteralPath $desktopJournal)) 'Unexpected pending desktop journal.'
$desktopChange = [ordered]@{key=$integration.key;beforeRevision=$desktopState.revision;before=$desktop;after=$null;effects=$removePlan.effects}
$invalidDesktop = $desktopChange | ConvertTo-Json -Depth 64 | ConvertFrom-Json
$envEffect = @($invalidDesktop.effects | Where-Object { $_.target.kind -eq 'registry' -and $_.target.key -eq 'HKCU\Environment' -and $_.target.name -eq 'SANDBOX_INTEGRATION_HOME' })[0]
$envEffect.target.name = 'UNDECLARED_SANDBOX_VALUE'
Write-IntegrationJson $desktopJournal $invalidDesktop
$null = Invoke-Check 'Recover refuses undeclared desktop journal targets before writing' $installedExe @('recover') -ExpectedExit 1
Assert-Check ((Test-Path -LiteralPath $desktopJournal) -and (Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME').value -eq $ownedEnvironment.value) 'Rejected desktop recovery changed resources or removed evidence.'
Write-IntegrationJson $desktopJournal $desktopChange
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)
try { $userKey.DeleteValue('SANDBOX_INTEGRATION_HOME',$false) } finally { $userKey.Dispose() }
$null = Invoke-Check 'Recover restores a partially removed desktop environment value' $installedExe @('recover')
Assert-Check ((-not (Test-Path -LiteralPath $desktopJournal)) -and (Read-IntegrationValue 'HKCU\Environment' 'SANDBOX_INTEGRATION_HOME').value -eq $ownedEnvironment.value) 'Desktop recovery did not restore the owned value.'
$removePlan = Invoke-Check 'Preview final desktop revocation' $installedExe @('unintegrate',$integrationSpec,'--desktop','--dry-run') | ConvertFrom-Json
$null = Invoke-Check 'Revoke environment shortcuts font menus and Open With' $installedExe @('unintegrate',$integrationSpec,'--desktop','--yes','--binding',$removePlan.binding)
foreach ($effect in $desktop.effects) {
    if ($effect.target.kind -eq 'file') { Assert-Check (-not (Test-Path -LiteralPath $effect.target.path)) 'Desktop revocation left an owned file.' }
    elseif (-not $effect.PSObject.Properties['pathEntries']) { Assert-Check ($null -eq (Read-IntegrationValue $effect.target.key $effect.target.name)) 'Desktop revocation left an owned registry value.' }
}
$finalPath = Read-IntegrationValue 'HKCU\Environment' 'Path'
Assert-Check ($finalPath.type -eq $initialUserPath.type -and $finalPath.value -ceq ($initialUserPath.value + ';' + $extraPath)) 'Revocation changed unrelated PATH entries or registry type.'
$revokeProfile = Invoke-Check 'Preview Profile revocation' $installedExe (@('unintegrate') + $shellArgs + @('--dry-run')) | ConvertFrom-Json
$null = Invoke-Check 'Revoke Profile initialization while preserving BOM and user code' $installedExe (@('unintegrate') + $shellArgs + @('--yes','--binding',$revokeProfile.binding))
Assert-Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($profile)) -eq [Convert]::ToBase64String($originalProfile)) 'Profile revocation did not preserve the original bytes.'
$null = Invoke-Check 'Unselect the integration fixture before bulk maintenance' $installedExe @('unuse',$integrationSpec)

$bootstrapSpec = 'main/sandbox-bootstrap'
$null = Invoke-Check 'Install bootstrap fixture without executing its script' $installedExe @('install',"$bootstrapSpec@1.0.0")
$bootstrapInstall = Find-Install 'sandbox-bootstrap'
$bootstrapDir = Join-Path $env:PIKO_HOME ('persist\' + $bootstrapInstall.key + '\data')
$marker = Join-Path $bootstrapDir 'result.txt'
Assert-Check (-not (Test-Path -LiteralPath $marker)) 'Installation executed bootstrap code.'
$null = Invoke-Check 'Generated native commands cannot be selected before bootstrap' $installedExe @('use',"$bootstrapSpec@1.0.0") -ExpectedExit 1
$bootstrapPlan = Invoke-Check 'Preview exact bootstrap code arguments and outputs' $installedExe @('bootstrap',$bootstrapSpec,'--dry-run') | ConvertFrom-Json
Assert-Check ($bootstrapPlan.script -match 'sandbox-bootstrap-ok') 'Bootstrap preview omitted the script.'
$null = Invoke-Check 'Bootstrap rejects --yes without code execution approval' $installedExe @('bootstrap',$bootstrapSpec,'--yes','--binding',$bootstrapPlan.binding) -ExpectedExit 1
$null = Invoke-Check 'Bootstrap rejects stale content approval' $installedExe @('bootstrap',$bootstrapSpec,'--approve-exec','--binding',('0' * 64)) -ExpectedExit 1
Assert-Check (-not (Test-Path -LiteralPath $marker)) 'Rejected bootstrap approval executed code.'
$null = Invoke-Check 'Execute only the explicitly approved bootstrap' $installedExe @('bootstrap',$bootstrapSpec,'--approve-exec','--binding',$bootstrapPlan.binding)
$bootstrapState = Read-State
Assert-Check ([IO.File]::ReadAllText($marker) -eq 'sandbox-bootstrap-ok') 'Approved bootstrap did not generate its output.'
Assert-Check (-not $bootstrapState.defaults.PSObject.Properties[$bootstrapInstall.key]) 'Bootstrap implicitly selected commands.'
Assert-Check ($bootstrapState.bootstraps.PSObject.Properties[$bootstrapInstall.id].Value.status -eq 'completed') 'Bootstrap completion was not recorded.'
$null = Invoke-Check 'Select explicitly bootstrapped native commands' $installedExe @('use',"$bootstrapSpec@1.0.0")
$null = Invoke-Check 'Generated native shim forwards its exit code' (Join-Path $shimDir 'piko-bootstrapped.exe') @('/d','/c','exit 7') -ExpectedExit 7
$adminPlan = Invoke-Check 'Preview administrator recipe without executing it' $installedExe @('system',$bootstrapSpec,'--dry-run') | ConvertFrom-Json
$null = Invoke-Check 'Administrator recipe rejects ordinary confirmation' $installedExe @('system',$bootstrapSpec,'--yes','--binding',$adminPlan.binding) -ExpectedExit 1
Assert-Check (-not (Test-Path -LiteralPath (Join-Path $bootstrapDir 'admin.txt'))) 'Administrator preview executed code.'
Assert-Check (-not (Read-State).PSObject.Properties['admin']) 'Administrator preview created an execution receipt.'
$null = Invoke-Check 'Unselect the bootstrap fixture before bulk maintenance' $installedExe @('unuse',$bootstrapSpec)
$report.limitations = @('Does not certify a clean Windows 10 VM.', 'PowerShell 5.1 only; PowerShell 7 is not installed in this image.', 'Private system-file fixtures; not full third-party GUI or Rust toolchain acceptance.', 'Administrator recipes were previewed and rejected, never executed.')
$report['integrationScope'] = 'PowerShell 5.1 explicit Profile, user desktop environment/PATH, real shortcut/font/menu/Open With, recovery journals, bootstrap approval/generated command, administrator preview/denial only.'
Write-Host 'PASS: user integration and bootstrap acceptance completed; no administrator recipe was executed.' -ForegroundColor Green
