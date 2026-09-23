[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$VaultPath,
    [Parameter(Mandatory = $true)][string]$ReadyPath
)

$ErrorActionPreference = 'Stop'
$resolvedVault = [System.IO.Path]::GetFullPath($VaultPath)
$lockPath = $resolvedVault + '.lock'
$lockDirectory = Split-Path -Parent $lockPath
New-Item -ItemType Directory -Force -Path $lockDirectory | Out-Null

$stream = New-Object System.IO.FileStream(
    $lockPath,
    [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
)
try {
    [System.IO.File]::WriteAllText($ReadyPath, 'ready')
    while ($true) { Start-Sleep -Seconds 60 }
} finally {
    $stream.Dispose()
}
