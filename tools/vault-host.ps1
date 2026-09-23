# ONE VAULT PROCESS, KEPT ALIVE, SERVING MANY REQUESTS -- INSTEAD OF ONE
# powershell.exe PER VAULT RECORD.
#
# Measured 2026-09-04 against a private scratch vault (never the installation's):
# a per-call `powershell.exe -File tools/secrets.ps1 get <key>` averaged
# 727 ms across 10 sequential reads (7,274 ms total), almost all of it
# powershell.exe's own startup, not DPAPI decryption -- the same fixed cost
# RESTART-STATE/CONTROLLER-BRIEF.md measures for host.exec (5.5 s median, ~2.0 s
# floor). This script pays that startup once and then answers requests over
# stdin/stdout for as long as it stays running.
#
# THE SECRECY RULES ARE UNCHANGED. A secret value still travels only on
# stdin -- here as a base64 field inside one JSON line, still never a process
# argument, an environment variable, a log line, or an error string. The
# response envelope carries the verb's own stdout back the same way: base64
# inside JSON, so a value with embedded newlines can never be mistaken for a
# protocol line. The vault's cross-process file lock
# (tools/secrets.ps1 Invoke-WithVaultLock) is not touched by this file -- every
# request still takes it, exactly as a per-call spawn did, so a hosted request
# and a one-shot fallback spawn from another process are still serialized
# against each other correctly.
#
# ONLY THE VERBS THAT RETURN RATHER THAN `exit` ARE SERVED HERE. 'exists',
# 'present' and 'verify' call `exit <code>` from inside Invoke-VaultAction,
# which would kill this whole process on the first request rather than the
# one-shot process a caller expects -- they are not in $HostAllowedActions,
# and a caller that needs them keeps using the per-call spawn. The GUI verbs
# ('prompt-set', 'prompt-payment-card') open a window on THIS process's
# desktop session and must never be served by a background host either.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Library mode: dot-sourcing secrets.ps1 below defines Invoke-VaultAction and
# every helper it calls, but skips the immediate dispatch a normal per-call
# invocation runs at the bottom of that file. 'list' is an inert placeholder
# action here -- it satisfies -Action's Mandatory binding and is never
# dispatched, because TOOLSENABLED_VAULT_HOST_LIBRARY is set before the
# dot-source runs.
$env:TOOLSENABLED_VAULT_HOST_LIBRARY = '1'
. (Join-Path $PSScriptRoot 'secrets.ps1') -Action 'list'

# The only actions this host will run. Anything else is refused before
# Invoke-VaultAction is ever called, by name, not by trying it and catching
# whatever 'exit' does.
$HostAllowedActions = @('get', 'get-many', 'get-or-create-stdin', 'set-monotonic-stdin')

function Write-HostResponse {
    param([Nullable[long]]$Id, [bool]$Ok, [hashtable]$Body)
    $envelope = [ordered]@{ id = $Id; ok = $Ok }
    foreach ($entryKey in $Body.Keys) { $envelope[$entryKey] = $Body[$entryKey] }
    $realOut = [Console]::Out
    $realOut.WriteLine(($envelope | ConvertTo-Json -Compress -Depth 6))
    $realOut.Flush()
}

# The parent process waits for this exact line on stderr before sending any
# request, so it never races a request against a host that has not finished
# dot-sourcing secrets.ps1 yet.
[Console]::Error.WriteLine('vault-host-ready')
[Console]::Error.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }

    $requestId = $null
    $capture = $null
    try {
        $request = $line | ConvertFrom-Json
        if ($null -ne $request.id) { $requestId = [long]$request.id }
        $requestAction = [string]$request.action
        if ($HostAllowedActions -notcontains $requestAction) {
            throw "Action '$requestAction' is not served by the vault host."
        }

        $script:Action = $requestAction
        $script:Key = if ($null -ne $request.key) { [string]$request.key } else { $null }
        $script:Keys = if ($null -ne $request.keys) { [string]$request.keys } else { $null }
        if ($requestAction -eq 'set-monotonic-stdin') {
            $script:VaultHostSequenceProvided = $true
            $script:Sequence = [long]$request.sequence
        } else {
            $script:VaultHostSequenceProvided = $false
            $script:Sequence = 0
        }
        $script:VaultHostPendingValue = if ($null -ne $request.valueBase64) {
            [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.valueBase64))
        } else { $null }

        # Invoke-VaultAction writes its answer straight to [Console]::Out, one
        # verb's worth of plain text or JSON with no framing of its own -- that
        # is correct for a one-shot process and wrong here, where many answers
        # share one stdout stream. Swap Out for a capture buffer for exactly
        # the duration of this call, the same technique
        # tests/vault-spawn-cost.test.js's PROBE already uses to keep a verb's
        # own output away from a process's stdout, then restore it before
        # this file writes its own response line.
        $capture = New-Object System.IO.StringWriter
        $realOut = [Console]::Out
        [Console]::SetOut($capture)
        try {
            Invoke-VaultAction
        } finally {
            [Console]::SetOut($realOut)
            $script:VaultHostPendingValue = $null
        }
        $outputBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($capture.ToString()))
        Write-HostResponse -Id $requestId -Ok $true -Body @{ outputBase64 = $outputBase64 }
    } catch {
        # Never let the raw exception object cross this boundary -- only its
        # message, which is exactly what a per-call spawn's stderr already
        # carried. A key-not-found or ACCESS_DENIED_ORACLE_SCOPE message is
        # data about the REQUEST, not about a secret value; a secret value is
        # never interpolated into any exception thrown above.
        $message = if ($_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message } else { 'vault host request failed' }
        Write-HostResponse -Id $requestId -Ok $false -Body @{ error = $message }
    } finally {
        # Keep the process, not the previous request's plaintext capture or
        # encoded value. Removing references is not secure erasure of immutable
        # .NET strings; the existing caller still owns the returned value.
        if ($null -ne $capture) { $capture.GetStringBuilder().Clear() | Out-Null; $capture.Dispose() }
        $capture = $line = $request = $outputBase64 = $message = $null
        $script:VaultHostPendingValue = $script:Key = $script:Keys = $null
    }
}
