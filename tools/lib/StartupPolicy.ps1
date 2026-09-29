# StartupPolicy.ps1 -- whether ToolsEnabled services start when the computer does.
#
# THE REQUIREMENT, PARAPHRASED: ToolsEnabled should start with Windows if the
# user chose that, and not otherwise -- and which way it goes must be a SETTING
# read at registration time, never a value hardcoded into each registrar.
#
# WHAT WAS WRONG. Sixteen registrars under tools/*-task.ps1 each built their own
# trigger list and every one of them contained the same two literals:
#
#     (New-ScheduledTaskTrigger -AtStartup),
#     (New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)),
#
# so "does this product start with Windows" was not a decision anybody could
# make -- it was sixteen copies of an answer already given. Turning it off meant
# hand-editing sixteen files, and any new registrar re-introduced it by copying
# its neighbour. That is the difference between a setting and a habit.
#
# THE REPEATING TRIGGER IS ALSO A STARTUP TRIGGER, which is the part that makes
# a naive fix wrong. Every registrar also registers
#
#     New-ScheduledTaskTrigger -Once -At <anchor> -RepetitionInterval <n minutes>
#                              -RepetitionDuration (New-TimeSpan -Days 9999)
#
# combined with -StartWhenAvailable. Delete AtStartup and AtLogOn and that
# repetition STILL fires within n minutes of a boot, so the service still starts
# itself after a restart and the setting would read as a lie. So when the switch
# is off this module also reports the task must be registered DISABLED: the
# durability record stays (register-managed-tasks.js keeps reporting REGISTERED,
# which is a registration fact and never a liveness claim) while Windows is told
# not to run it. Nothing self-starts, and nothing was uninstalled.
#
# THIS FILE READS THE SETTING AND NOTHING ELSE. It does not register, enable,
# disable, elevate, or start anything. tools/apply-startup-policy.ps1 is what
# reconciles already-registered tasks to the switch.

# NO Set-StrictMode HERE. This file is dot-sourced into sixteen registrars, and
# Set-StrictMode is scoped to the CALLER, not to this file -- switching it on
# here silently changes the strictness of every script that includes us, which
# is how a library breaks a caller it never saw.

$script:StartupSettingId = 'startup.services_at_logon'

function Get-ToolsEnabledRepoRoot {
    param([string]$RepoRoot)
    if ($RepoRoot -and (Test-Path -LiteralPath $RepoRoot)) { return (Resolve-Path -LiteralPath $RepoRoot).Path }
    # tools/lib/StartupPolicy.ps1 -> tools/lib -> tools -> repo root
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

# Mirrors resolveValuesPath() in src/lib/settings.js. Kept deliberately
# identical: two readers of one switch that disagree about WHERE it lives is the
# same bug as not having the switch.
function Get-ToolsEnabledSettingsValuesPath {
    $custom = $env:TOOLSENABLED_SETTINGS_PATH
    if ($custom -and [System.IO.Path]::IsPathRooted($custom)) { return $custom }
    if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'ToolsEnabled\settings.json') }
    return (Join-Path $HOME '.toolsenabled\settings.json')
}

function Get-ToolsEnabledSettingDefault {
    param([Parameter(Mandatory = $true)][string]$Id, [string]$RepoRoot)
    $root = Get-ToolsEnabledRepoRoot -RepoRoot $RepoRoot
    $registryPath = Join-Path $root 'config\settings-registry.json'
    if (-not (Test-Path -LiteralPath $registryPath)) { return $null }
    try {
        $registry = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
        foreach ($entry in $registry.entries) {
            if ($entry.id -eq $Id) { return $entry.default }
        }
    } catch { }
    return $null
}

# Honours the SAME acceptance rule as src/lib/settings.js loadSettings(): a
# stored value counts only when the document is well-formed AND the id carries
# provenance with a known source. A value with no provenance is rejected there
# and must be rejected here too, or the switch means one thing to the product
# and another to the registrars.
function Get-ToolsEnabledSetting {
    param([Parameter(Mandatory = $true)][string]$Id, [string]$RepoRoot)

    $value = Get-ToolsEnabledSettingDefault -Id $Id -RepoRoot $RepoRoot
    $valuesPath = Get-ToolsEnabledSettingsValuesPath
    if (-not (Test-Path -LiteralPath $valuesPath)) { return $value }

    try {
        $document = Get-Content -Raw -LiteralPath $valuesPath | ConvertFrom-Json
    } catch { return $value }

    if ($null -eq $document) { return $value }
    if (-not ($document.PSObject.Properties.Name -contains 'values')) { return $value }
    if (-not ($document.PSObject.Properties.Name -contains 'revision')) { return $value }

    $values = $document.values
    if ($null -eq $values -or -not ($values.PSObject.Properties.Name -contains $Id)) { return $value }

    $provenance = $null
    if ($document.PSObject.Properties.Name -contains 'provenance') { $provenance = $document.provenance }
    if ($null -eq $provenance -or -not ($provenance.PSObject.Properties.Name -contains $Id)) { return $value }
    $source = $provenance.$Id.source
    if ($source -notin @('default', 'installer', 'user')) { return $value }

    $raw = $values.$Id
    if ($raw -isnot [bool]) { return $value }   # control is a toggle; anything else is rejected, as in settings.js
    return $raw
}

function Test-ToolsEnabledStartsAtLogon {
    param([string]$RepoRoot)
    $value = Get-ToolsEnabledSetting -Id $script:StartupSettingId -RepoRoot $RepoRoot
    if ($value -is [bool]) { return $value }
    return $false      # unreadable setting means DO NOT start with Windows
}

# ON-DEMAND TASKS -- the second kind of task.
#
# Everything above answers one question: does this product start ITSELF when
# Windows starts. The default answer is no, and for a task that carries
# a cadence trigger the only way to honour that is to register it disabled,
# because -StartWhenAvailable plus a repetition fires within n minutes of a boot
# regardless of which triggers were dropped.
#
# An ON-DEMAND task is different in kind, not in degree. It carries NO cadence
# trigger and, with the switch off, no trigger at all. Windows cannot start it;
# only an explicit Start-ScheduledTask can, and that only ever happens because a
# person pressed the feature's own ON control. So for this shape "enabled" means
# STARTABLE, not SELF-STARTING, and leaving it enabled does not contradict the
# switch -- there is nothing for Windows to fire.
#
# This is what makes "the direct link stays on until the user turns it off"
# implementable WITHOUT an exemption from the switch: while the machine is up
# the task keeps its process alive (RestartOnFailure), and across a restart the
# switch decides, exactly as it does for everything else. With the switch on,
# the task gets AtLogOn like its neighbours and the link returns by itself.
#
# A triggerless registered task is valid and is precisely what the Task
# Scheduler UI calls an "On demand" task -- so the "MUST HAVE AT LEAST ONE
# TRIGGER" note below applies to the cadence-driven shape only, and the fallback
# it describes is skipped here on purpose. Nothing else may use -OnDemand
# casually: a task with no trigger that nobody starts never runs at all, which
# is a silent no-op rather than a visible failure.

<#
.SYNOPSIS
Build a registrar's trigger list from the switch instead of from a literal.

.PARAMETER Repeating
The registrar's own cadence trigger. Always included: it is what makes the task
do its job while the machine is up, and it is not a startup trigger by intent.

.PARAMETER IncludeStartup
Pass for tasks that want -AtStartup (boot, before sign-in).

.PARAMETER IncludeLogon
Pass for tasks that want -AtLogOn. BOTH are explicit on purpose: they are not
interchangeable and not every registrar had both. logs-retention-task.ps1
registers AtStartup with no sign-in trigger, and a helper that always added
-AtLogOn would hand that task a trigger it never had -- turning the switch ON
would then change more than the switch claims to change. What each registrar
asks for here is exactly what it registered before this file existed.

.PARAMETER OnDemand
The task is started by a person pressing a feature's ON control, never by a
cadence. Suppresses the empty-set fallback, so with the switch off this returns
NO triggers and the caller must omit -Trigger entirely. See the ON-DEMAND
section above.
#>
function New-ToolsEnabledTaskTriggers {
    param(
        $Repeating,
        [string]$OwnerUser = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name),
        [switch]$IncludeStartup,
        [switch]$IncludeLogon,
        [switch]$OnDemand,
        [string]$RepoRoot
    )
    $triggers = @()
    if (Test-ToolsEnabledStartsAtLogon -RepoRoot $RepoRoot) {
        if ($IncludeStartup) { $triggers += (New-ScheduledTaskTrigger -AtStartup) }
        if ($IncludeLogon) { $triggers += (New-ScheduledTaskTrigger -AtLogOn -User $OwnerUser) }
    }
    if ($null -ne $Repeating) { $triggers += $Repeating }

    # A REGISTERED TASK MUST HAVE AT LEAST ONE TRIGGER -- Register-ScheduledTask
    # rejects an empty set. Not every registrar has a cadence trigger to fall
    # back on: agent-digest-task.ps1 registers AtStartup + AtLogOn and nothing
    # else, so gating both away would leave it with none and the registrar would
    # throw where it used to succeed. Emit the sign-in trigger to keep the task
    # DEFINITION valid; it does not start anything, because with the switch off
    # the registrar also registers the task disabled
    # (Test-ToolsEnabledTaskShouldBeEnabled) and Windows does not fire triggers
    # on a disabled task. The definition stays honest and one -Enable brings it
    # back exactly as designed.
    #
    # -OnDemand opts out: that shape WANTS the empty set, and handing it a
    # sign-in trigger would make it self-start with the switch off -- the exact
    # thing this file exists to prevent.
    if ($triggers.Count -eq 0 -and -not $OnDemand) {
        $triggers += (New-ScheduledTaskTrigger -AtLogOn -User $OwnerUser)
    }
    # Comma-wrap: with the switch off this list holds exactly one trigger, and a
    # bare `return` would unwrap it to a scalar. Register-ScheduledTask happens
    # to accept that, but every caller doing @($triggers).Count -- including the
    # test for this file -- would read 1 as "no array at all". An -OnDemand
    # caller with the switch off gets an empty array back and must omit
    # -Trigger; the same wrap keeps THAT from collapsing to $null.
    return ,$triggers
}

<#
.SYNOPSIS
$true when a newly registered task should be left runnable by Windows.

Registrars pass the negation to New-ScheduledTaskSettingsSet -Disable. See the
header: with the switch off, dropping AtStartup/AtLogOn is not enough on its own
because the repetition trigger restarts the service after a reboot anyway.

.PARAMETER OnDemand
Always $true. An on-demand task has no cadence trigger and, with the switch off,
no trigger at all, so Windows will never launch it -- "enabled" here means a
person's ON press is allowed to start it, and disabling it instead would break
that press while protecting against nothing.
#>
function Test-ToolsEnabledTaskShouldBeEnabled {
    param([string]$RepoRoot, [switch]$OnDemand)
    if ($OnDemand) { return $true }
    return (Test-ToolsEnabledStartsAtLogon -RepoRoot $RepoRoot)
}
