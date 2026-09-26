param([Parameter(Mandatory = $true)][ValidateSet('activate','deactivate','status')][string]$Action)
$RepoRoot = Split-Path -Parent $PSScriptRoot
$configuredPath = [Environment]::GetEnvironmentVariable('TOOLSENABLED_KILLSWITCH_PATH')
$Path = if ([string]::IsNullOrWhiteSpace($configuredPath)) {
    Join-Path $RepoRoot 'KILLSWITCH'
} else {
    [System.IO.Path]::GetFullPath($configuredPath.Trim())
}
switch ($Action) {
    'activate' { [System.IO.File]::WriteAllText($Path, "Activated $(Get-Date -Format o)`n"); Write-Output 'KILLSWITCH_ACTIVE' }
    'deactivate' { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue; Write-Output 'KILLSWITCH_INACTIVE' }
    'status' { if (Test-Path -LiteralPath $Path) { Write-Output 'KILLSWITCH_ACTIVE' } else { Write-Output 'KILLSWITCH_INACTIVE' } }
}
