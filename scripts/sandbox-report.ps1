# Shared by Sandbox runners and host-safe tests. Defining these functions has no side effects.
function Write-SandboxText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Text,
        [ValidateRange(1, 100)][int]$Attempts = 40,
        [ValidateRange(1, 1000)][int]$DelayMilliseconds = 125
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $temporary = $fullPath + '.' + [guid]::NewGuid().ToString('N') + '.pending'
    # Serialize once into a sibling file. A failed replace must never truncate
    # the last complete report. Do not delete the destination to work around locks.
    [IO.File]::WriteAllText($temporary, $Text, (New-Object Text.UTF8Encoding($true)))
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if ([IO.File]::Exists($fullPath)) {
                [IO.File]::Replace($temporary, $fullPath, [NullString]::Value)
            } else {
                [IO.File]::Move($temporary, $fullPath)
            }
            return
        } catch [IO.IOException] {
            if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
        } catch [UnauthorizedAccessException] {
            if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
        }
    }
    throw "Unable to publish $fullPath after bounded retries. The previous file was preserved; the complete new content is saved at $temporary. Close viewers holding the file and retry."
}
function Save-Report {
    $report.checks = @($steps.ToArray())
    Write-SandboxText -Path $reportPath -Text ($report | ConvertTo-Json -Depth 14)
}
