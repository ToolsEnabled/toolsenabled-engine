<#
.SYNOPSIS
Make the already-registered ToolsEnabled scheduled tasks agree with the
startup.services_at_logon switch.

.DESCRIPTION
THE REQUIREMENT, PARAPHRASED: the product must not start itself again next time
unless the user chose that, and which way it goes must be a SETTING rather than
a value hardcoded into a registrar.

tools/lib/StartupPolicy.ps1 fixes what a registrar WRITES. It does nothing for
the tasks already sitting in Windows Task Scheduler on a machine that was set up
before the switch existed -- and there can be sixteen of those, firing every one
to five minutes, most registered elevated. Re-running sixteen registrars to
change one boolean is not a setting either. This reconciles what is already
there.

WHY DISABLE RATHER THAN DELETE TRIGGERS. Every ToolsEnabled task also carries a
repetition trigger with -StartWhenAvailable, so removing AtStartup and AtLogOn
still leaves the service starting itself within minutes of a boot. Disabling the
task is the only state Windows honours as "do not run this until told". Nothing
is unregistered and nothing is uninstalled: register-managed-tasks.js keeps
reporting REGISTERED, which was always a durability fact and never a liveness
claim, and one -Enable run puts it all back.

THIS SCRIPT NEVER STOPS A RUNNING PROCESS. A service that is up stays up; only
its ability to be launched again by Windows changes. Stopping live work is a
separate decision and not one a policy-reconciler gets to make quietly.

.PARAMETER WhatIf
Report what would change and change nothing.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File tools\apply-startup-policy.ps1 -WhatIf

.EXAMPLE
# Most tasks here were registered elevated, so this generally needs an
# Administrator PowerShell:
powershell -NoProfile -ExecutionPolicy Bypass -File tools\apply-startup-policy.ps1
#>
[CmdletBinding()]
param(
    [switch]$WhatIf,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')

$desiredEnabled = Test-ToolsEnabledTaskShouldBeEnabled -RepoRoot $repoRoot
$settingValue = Get-ToolsEnabledSetting -Id 'startup.services_at_logon' -RepoRoot $repoRoot

# The declared list, not a 'ToolsEnabled*' wildcard: a wildcard would sweep up
# any task somebody named ToolsEnabled-something by hand, and would miss a
# declared task that happens to be named otherwise.
$declaredPath = Join-Path $repoRoot 'config\managed-processes.json'
$taskNames = @()
# Tasks the registry declares onDemand are exempt from the enable/disable sweep.
# They carry no cadence trigger and, with the switch off, no trigger at all --
# Windows can never launch them, so "enabled" means a person's ON press is
# allowed to start them rather than "starts itself with Windows". Disabling one
# would break that press while protecting against nothing. This reuses the
# registry's existing onDemand flag (uac-delegation-helper has carried it since
# before this file existed) rather than inventing a second word for it. See the
# ON-DEMAND section in tools\lib\StartupPolicy.ps1.
$onDemandTasks = @{}
if (Test-Path -LiteralPath $declaredPath) {
    $declared = Get-Content -Raw -LiteralPath $declaredPath | ConvertFrom-Json
    foreach ($property in $declared.processes.PSObject.Properties) {
        $name = $property.Value.taskName
        if ($name) { $taskNames += $name }
        if ($name -and [bool]$property.Value.onDemand) { $onDemandTasks[$name] = $true }
    }
}
$taskNames = $taskNames | Sort-Object -Unique

$results = @()
foreach ($name in $taskNames) {
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $task = $null }

    if (-not $task) {
        $results += [pscustomobject]@{ Task = $name; Was = 'NOT_REGISTERED'; Now = 'NOT_REGISTERED'; Action = 'skipped'; Detail = 'no such scheduled task on this machine' }
        continue
    }

    if ($onDemandTasks.ContainsKey($name)) {
        $state = 'Disabled'
        if ([bool]$task.Settings.Enabled) { $state = 'Enabled' }
        $state = "$state/$($task.State)"
        $triggerCount = @($task.Triggers).Count
        $results += [pscustomobject]@{
            Task = $name; Was = $state; Now = $state; Action = 'skipped'
            Detail = "on-demand: $triggerCount trigger(s); enabled means startable, not self-starting -- this switch does not govern it"
        }
        continue
    }

    # $task.State is NOT the enabled flag. A task that has been disabled while an
    # instance is still running reports State='Running', and 'Running' -ne
    # 'Disabled' would read that back as enabled -- which is exactly the state
    # every ToolsEnabled service lands in when the switch is turned off while
    # those services are up, because the requirement is that running work keeps
    # running while only its autostart is taken away.
    # Settings.Enabled is the flag Windows actually consults before launching.
    $isEnabled = [bool]$task.Settings.Enabled
    $wasWord = 'Disabled'
    if ($isEnabled) { $wasWord = 'Enabled' }
    $wasWord = "$wasWord/$($task.State)"

    if ($isEnabled -eq $desiredEnabled) {
        $results += [pscustomobject]@{ Task = $name; Was = $wasWord; Now = $wasWord; Action = 'already-correct'; Detail = '' }
        continue
    }

    if ($WhatIf) {
        $wouldBe = 'Disabled'
        if ($desiredEnabled) { $wouldBe = 'Enabled' }
        $results += [pscustomobject]@{ Task = $name; Was = $wasWord; Now = $wouldBe; Action = 'would-change'; Detail = 'WhatIf: nothing was changed' }
        continue
    }

    try {
        if ($desiredEnabled) { Enable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null }
        else { Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null }
        # Read back from Windows rather than trusting the call: verified state is
        # the only kind worth reporting.
        $refreshed = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        $nowWord = 'unknown'
        if ($refreshed) {
            $nowWord = 'Disabled'
            if ([bool]$refreshed.Settings.Enabled) { $nowWord = 'Enabled' }
            $nowWord = "$nowWord/$($refreshed.State)"
        }
        $results += [pscustomobject]@{ Task = $name; Was = $wasWord; Now = $nowWord; Action = 'changed'; Detail = '' }
    } catch {
        $results += [pscustomobject]@{ Task = $name; Was = $wasWord; Now = $wasWord; Action = 'FAILED'; Detail = $_.Exception.Message.Trim() }
    }
}

if ($Json) {
    [pscustomobject]@{
        settingId      = 'startup.services_at_logon'
        settingValue   = $settingValue
        desiredEnabled = $desiredEnabled
        whatIf         = [bool]$WhatIf
        results        = $results
    } | ConvertTo-Json -Depth 6
    return
}

$stateWord = 'DISABLED (nothing starts with Windows)'
if ($desiredEnabled) { $stateWord = 'ENABLED (services start at boot and sign-in)' }

Write-Host ''
Write-Host "startup.services_at_logon = $settingValue  ->  $stateWord"
Write-Host ''
$results | Format-Table -AutoSize Task, Was, Now, Action

$failed = @($results | Where-Object { $_.Action -eq 'FAILED' })
$denied = @($failed | Where-Object { $_.Detail -match 'Access is denied' })

if ($denied.Count -gt 0) {
    Write-Host ''
    Write-Host "$($denied.Count) task(s) refused with Access is denied. Those were registered elevated,"
    Write-Host 'so changing them needs an Administrator PowerShell. Re-run there:'
    Write-Host ''
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Write-Host ''
}

$changed = @($results | Where-Object { $_.Action -eq 'changed' }).Count
$wouldChange = @($results | Where-Object { $_.Action -eq 'would-change' }).Count
Write-Host "changed=$changed would-change=$wouldChange failed=$($failed.Count) total=$($results.Count)"
Write-Host 'Running processes were not touched. This only changes what Windows may launch.'

if ($failed.Count -gt 0) { exit 1 }
exit 0
