[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ConsoleProcessId,

    [Parameter(Mandatory = $true)]
    [Int64]$ConsoleStartKey,

    [ValidateRange(15, 1800)]
    [int]$IdleWaitSeconds = 900
)

# One bounded repair for the pre-quiet-launcher LocalFallback console.  It does
# not install a scheduled task or touch arbitrary terminals: each destructive
# action is fenced by the original cmd.exe PID and Windows creation-time key.
# The script starts no visible console itself and exits after one successful
# handoff, a safe no-op, or the bounded idle wait.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$LocalModelPort = 11434

function Get-ExactProcess {
    param([int]$ProcessId, [Int64]$StartKey)
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        if ([Int64]$process.StartTime.ToFileTimeUtc() -ne $StartKey) { return $null }
        return $process
    } catch {
        return $null
    }
}

function Get-ExactLocalModelChild {
    param([int]$ParentProcessId)
    $candidates = @(
        Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object { [int]$_.ParentProcessId -eq $ParentProcessId -and $_.Name -ieq 'ollama.exe' }
    )
    if ($candidates.Count -ne 1) { return $null }
    try {
        $process = Get-Process -Id ([int]$candidates[0].ProcessId) -ErrorAction Stop
        return [pscustomobject]@{
            Process = $process
            StartKey = [Int64]$process.StartTime.ToFileTimeUtc()
        }
    } catch {
        return $null
    }
}

function Has-ActiveLocalModelClients {
    param([int]$ProcessId)
    return @(
        Get-NetTCPConnection -OwningProcess $ProcessId -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq 'Established' }
    ).Count -gt 0
}

function Wait-ForNoListener {
    param([int]$Port, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-ForExactListener {
    param([int]$Port, [int]$ProcessId, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $listeners = @(
            Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
                Where-Object { [int]$_.OwningProcess -eq $ProcessId }
        )
        if ($listeners.Count -eq 1) { return $true }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

$deadline = [DateTime]::UtcNow.AddSeconds($IdleWaitSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    $console = Get-ExactProcess -ProcessId $ConsoleProcessId -StartKey $ConsoleStartKey
    if ($null -eq $console) { exit 0 } # The owner already closed/replaced it.

    $oldModel = Get-ExactLocalModelChild -ParentProcessId $ConsoleProcessId
    if ($null -eq $oldModel) { exit 0 } # Never guess a different process tree.

    if (Has-ActiveLocalModelClients -ProcessId $oldModel.Process.Id) {
        Start-Sleep -Seconds 1
        continue
    }

    # Debounce the idle observation and prove both identities again before any
    # stop. This prevents a just-started model request or PID reuse from being
    # mistaken for an idle, original LocalFallback tree.
    Start-Sleep -Milliseconds 500
    $console = Get-ExactProcess -ProcessId $ConsoleProcessId -StartKey $ConsoleStartKey
    $recheckedModel = Get-ExactLocalModelChild -ParentProcessId $ConsoleProcessId
    if ($null -eq $console -or $null -eq $recheckedModel -or $recheckedModel.StartKey -ne $oldModel.StartKey) { exit 0 }
    if (Has-ActiveLocalModelClients -ProcessId $recheckedModel.Process.Id) { continue }

    $ollama = Get-Command ollama -CommandType Application -ErrorAction Stop

    # Stop the parent first so its old script cannot recreate the child.  The
    # exact child is then stopped only when its creation-time key is unchanged.
    Stop-Process -Id $ConsoleProcessId -Force -ErrorAction Stop
    $exactOldModel = Get-ExactProcess -ProcessId $recheckedModel.Process.Id -StartKey $recheckedModel.StartKey
    if ($null -ne $exactOldModel) {
        Stop-Process -Id $exactOldModel.Id -Force -ErrorAction Stop
    }

    if (-not (Wait-ForNoListener -Port $LocalModelPort -TimeoutSeconds 12)) { exit 1 }

    $replacement = Start-Process -FilePath $ollama.Source -ArgumentList @('serve') -WindowStyle Hidden -PassThru -ErrorAction Stop
    if (Wait-ForExactListener -Port $LocalModelPort -ProcessId ([int]$replacement.Id) -TimeoutSeconds 15) {
        exit 0
    }

    # The old process is already gone; do not leave an unverified replacement
    # running. A later explicit ToolsEnabled launch can recover normally.
    try {
        $exactReplacement = Get-ExactProcess -ProcessId ([int]$replacement.Id) -StartKey ([Int64]$replacement.StartTime.ToFileTimeUtc())
        if ($null -ne $exactReplacement) { Stop-Process -Id $exactReplacement.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    exit 1
}

exit 0
