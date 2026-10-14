# Shared Node interpreter resolution for PowerShell launchers that start a
# long-lived server process (FRA lifecycle, remote-agent bridge, link bus,
# tunnel/bridge supervisor and control surface).
#
# WHY THIS EXISTS. Five of these scripts each independently picked between
# 'C:\agent-apps\node-v22.19.0\node.exe' and 'C:\Program Files\nodejs\node.exe'
# with nothing but Test-Path -- no check that the Program Files fallback is
# actually new enough. Two of the five (bridge-session-supervisor.ps1,
# tunnel-bridge-control.ps1) had no fallback logic at all: a single hardcoded
# literal. On a machine where the only Node install is at the Program Files
# default but predates 22.19.0, every one of these would silently launch a
# server on an interpreter where node:sqlite's DatabaseSync throws mid-write
# (_open -> _migrate -> transaction -> _open) with "Maximum call stack size
# exceeded" -- which reads like database corruption, not a version mismatch.
# See tools/dashboard-task.ps1's header comment and AGENT-GUIDE.md section 7,
# landmine 0, for the incident this pattern is named after.
#
# tools/resolve-node.js is this tree's one proven source of truth for "which
# node.exe really has a working node:sqlite" -- a functional
# DatabaseSync.isOpen probe per candidate in a child process, not a version
# string comparison. tools/dashboard-task.ps1 already established the
# PowerShell-calls-node-calls-resolve-node.js pattern for its own -DryRun /
# -Status path; this extracts that same pattern once so five call sites (and
# any future one) share it instead of a sixth independently-drifting copy of
# "what counts as a qualifying node" -- the exact defect class
# src/lib/tree-identity.js and src/lib/open-gates-freshness.js were already
# extracted to prevent today.
#
# A launcher that starts a real server process cannot safely fall back to an
# unqualified interpreter the way tools/dashboard-task.ps1's read-only
# -Status path can -- that would start a broken server instead of reporting a
# gap. So Resolve-ToolsEnabledNode always either returns a proven-qualifying
# node.exe or throws 'NODE_22_19_OR_NEWER_MISSING'; there is no soft mode here.

function Resolve-ToolsEnabledNode {
    param([Parameter(Mandatory)][string]$Root)

    if (-not [IO.Path]::IsPathRooted($Root)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
    $resolvedRoot = [IO.Path]::GetFullPath($Root)
    $resolveNodeScript = Join-Path $resolvedRoot 'tools\resolve-node.js'
    if (-not (Test-Path -LiteralPath $resolveNodeScript -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }

    # A bootstrap interpreter only has to run resolve-node.js; it is NEVER the
    # returned answer merely because it exists. Keep this list bounded to safe
    # absolute candidates, then let resolve-node.js functionally qualify the
    # final runtime. The old product path is intentionally one shared candidate
    # here, not a registrar pin.
    $bootstrapCandidates = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    function Add-BootstrapCandidate([string]$Candidate) {
        if ([string]::IsNullOrWhiteSpace($Candidate) -or -not [IO.Path]::IsPathRooted($Candidate)) { return }
        try { $full = [IO.Path]::GetFullPath($Candidate) } catch { return }
        if ($seen.Add($full) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
            $bootstrapCandidates.Add($full)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($env:TOOLSENABLED_NODE)) {
        if (-not [IO.Path]::IsPathRooted($env:TOOLSENABLED_NODE)) {
            throw 'NODE_22_19_OR_NEWER_MISSING'
        }
        Add-BootstrapCandidate $env:TOOLSENABLED_NODE
    }
    Add-BootstrapCandidate (Join-Path $resolvedRoot 'node.exe')
    Add-BootstrapCandidate 'C:\agent-apps\node-v22.19.0\node.exe'
    if ([IO.Path]::IsPathRooted([string]$env:ProgramFiles)) {
        Add-BootstrapCandidate (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ([IO.Path]::IsPathRooted([string]$programFilesX86)) {
        Add-BootstrapCandidate (Join-Path $programFilesX86 'nodejs\node.exe')
    }
    if ([IO.Path]::IsPathRooted([string]$env:LOCALAPPDATA)) {
        Add-BootstrapCandidate (Join-Path $env:LOCALAPPDATA 'Programs\node\node.exe')
    }
    foreach ($nvmRoot in @($env:NVM_SYMLINK, $env:NVM_HOME)) {
        if ([IO.Path]::IsPathRooted([string]$nvmRoot)) {
            Add-BootstrapCandidate (Join-Path $nvmRoot 'node.exe')
        }
    }
    $pathNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source -First 1
    Add-BootstrapCandidate $pathNode

    # No quote characters inside this JS on purpose: PowerShell 5.1's native
    # argv quoting mangles an embedded "" (empty-string literal) when this
    # string crosses into node.exe's argument list -- see
    # tools/dashboard-task.ps1's header comment for the fuller account.
    # stderr is deliberately left unredirected: redirecting a native command's
    # stderr under $ErrorActionPreference = 'Stop' turns every line into a
    # terminating NativeCommandError even on a clean non-zero exit.
    $probeExpr = 'const{resolveQualifyingNode}=require(process.argv[1]);' +
                 'const r=resolveQualifyingNode();' +
                 'if(r.node){process.stdout.write(r.node);process.exit(0);}' +
                 'process.exit(1);'
    foreach ($bootstrapNode in $bootstrapCandidates) {
        $priorPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $probeOutput = & $bootstrapNode '-e' $probeExpr $resolveNodeScript 2>$null
            $probeExitCode = $LASTEXITCODE
        } catch {
            $probeOutput = $null
            $probeExitCode = 1
        } finally {
            $ErrorActionPreference = $priorPreference
        }
        if ($probeExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($probeOutput)) {
            $qualified = ($probeOutput | Select-Object -Last 1).ToString().Trim()
            if ([IO.Path]::IsPathRooted($qualified) -and (Test-Path -LiteralPath $qualified -PathType Leaf)) {
                return [IO.Path]::GetFullPath($qualified)
            }
        }
    }
    throw 'NODE_22_19_OR_NEWER_MISSING'
}
