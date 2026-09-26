# Provision local-only R0 dependencies. This script never writes a provider
# key or SearXNG secret to source files: Tavily is entered through the MCP
# credential dialog, while the SearXNG session secret is generated into the
# DPAPI vault and held only in this process environment for docker compose.
[CmdletBinding()]
param(
    [switch]$Searxng,
    [switch]$Python,
    [switch]$Models
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResearchRoot = Join-Path $RepoRoot 'research'
$SearxRoot = Join-Path $ResearchRoot 'searxng'
$ComposeFile = Join-Path $SearxRoot 'docker-compose.yml'
$SecretsScript = Join-Path $PSScriptRoot 'secrets.ps1'
. (Join-Path $PSScriptRoot 'Invoke-NativeHidden.ps1')

if (-not $Searxng -and -not $Python -and -not $Models) {
    $Searxng = $true
    $Python = $true
}

function Get-CommandPath {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw "Required executable '$Name' was not found on PATH." }
    return $command.Source
}

function Invoke-ToolsEnabledCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutMilliseconds = 0
    )
    return Invoke-ToolsEnabledNativeHidden -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $RepoRoot -TimeoutMilliseconds $TimeoutMilliseconds
}

function Test-DockerServer {
    # Docker returns a non-zero native exit code while Desktop is starting.
    # Treat that as a health result rather than allowing ErrorActionPreference
    # to abort the provisioning path before it can launch Desktop.
    $priorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = Invoke-ToolsEnabledCommand -FilePath (Get-CommandPath 'docker') -Arguments @('version', '--format', '{{.Server.Version}}')
        return $result.ExitCode -eq 0
    } finally {
        $ErrorActionPreference = $priorPreference
    }
}

function Start-DockerDesktopIfNeeded {
    if (Test-DockerServer) { return }
    $candidates = @(@(
        (Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:LOCALAPPDATA} 'Docker\Docker Desktop.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ })
    if ($candidates.Count -eq 0) { throw 'Docker Desktop is installed but its launcher was not found.' }
    Start-Process -FilePath $candidates[0] -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-DockerServer) { return }
    }
    throw 'Docker Desktop did not make its Linux engine available within 90 seconds.'
}

function Invoke-SecretGetOrCreate {
    param([string]$Key)
    $seedBytes = New-Object byte[] 32
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($seedBytes) } finally { $rng.Dispose() }
    $candidate = [Convert]::ToBase64String($seedBytes)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}" get-or-create-stdin {1}' -f $SecretsScript, $Key)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'Could not start the local DPAPI vault helper.' }
        $process.StandardInput.Write($candidate)
        $process.StandardInput.Close()
        $result = $process.StandardOutput.ReadToEnd()
        $errorText = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result)) {
            throw 'The local DPAPI vault helper could not create the SearXNG secret.'
        }
        return $result
    } finally {
        $candidate = $null
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Start-RestrictedSearxng {
    if (-not (Test-Path -LiteralPath $ComposeFile)) { throw "Missing SearXNG compose file: $ComposeFile" }
    Start-DockerDesktopIfNeeded
    $secret = Invoke-SecretGetOrCreate -Key 'searxng_secret'
    $prior = [Environment]::GetEnvironmentVariable('SEARXNG_SECRET', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('SEARXNG_SECRET', $secret, 'Process')
        $dockerResult = Invoke-ToolsEnabledCommand -FilePath (Get-CommandPath 'docker') -Arguments @('compose', '--project-name', 'toolsenabled-research', '--file', $ComposeFile, 'up', '--detach', '--remove-orphans')
        if ($dockerResult.ExitCode -ne 0) { throw 'Restricted SearXNG docker compose startup failed.' }
    } finally {
        [Environment]::SetEnvironmentVariable('SEARXNG_SECRET', $prior, 'Process')
        $secret = $null
    }
    # The container starts its web worker shortly after compose reports it as
    # started. Retry the bounded smoke rather than treating that normal race as
    # a failed deployment.
    $uri = 'http://127.0.0.1:8888/search?q=Albert%20Einstein&format=json&categories=general%2Cscience%2Cscientific%20publications'
    $payload = $null
    for ($attempt = 1; $attempt -le 15; $attempt += 1) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 15
            if ($response.StatusCode -eq 200) {
                $candidate = $response.Content | ConvertFrom-Json
                if ($null -ne $candidate -and @($candidate.results).Count -gt 0) {
                    $payload = $candidate
                    break
                }
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if ($null -eq $payload) { throw 'Restricted SearXNG did not return a non-empty JSON smoke result within 30 seconds.' }
    $allowed = @('wikipedia', 'pubmed', 'openalex', 'crossref')
    $engines = @($payload.results | ForEach-Object { @($_.engines) } | ForEach-Object { [string]$_ } | Where-Object { $_ })
    $unexpected = @($engines | Where-Object { $_ -notin $allowed } | Select-Object -Unique)
    if ($unexpected.Count -gt 0) { throw 'Restricted SearXNG reported an engine outside the approved allowlist.' }
    [PSCustomObject]@{ status = 'ready'; engines = @($engines | Select-Object -Unique); endpoint = 'http://127.0.0.1:8888/search' } | ConvertTo-Json -Compress
}

function Provision-ExtractionPython {
    $python = Get-CommandPath 'python'
    $venv = Join-Path $RepoRoot 'state\research-python'
    $requirements = Join-Path $ResearchRoot 'requirements.txt'
    $requirementsLock = Join-Path $ResearchRoot 'requirements.lock'
    if (-not (Test-Path -LiteralPath $requirements)) { throw "Missing extraction requirements: $requirements" }
    if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) {
        $venvResult = Invoke-ToolsEnabledCommand -FilePath $python -Arguments @('-m', 'venv', $venv)
        if ($venvResult.ExitCode -ne 0) { throw 'Could not create the pinned research Python environment.' }
    }
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    $installRequirements = if (Test-Path -LiteralPath $requirementsLock) { $requirementsLock } else { $requirements }
    $pipResult = Invoke-ToolsEnabledCommand -FilePath $venvPython -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '--requirement', $installRequirements)
    if ($pipResult.ExitCode -ne 0) { throw 'Could not install the pinned research extraction dependencies.' }
    $importResult = Invoke-ToolsEnabledCommand -FilePath $venvPython -Arguments @('-c', "import fitz, trafilatura; print('research-python-ready')")
    if ($importResult.ExitCode -ne 0) { throw 'The pinned research extraction environment did not import successfully.' }
}

function Provision-Models {
    $ollama = Get-CommandPath 'ollama'
    $versionResult = Invoke-ToolsEnabledCommand -FilePath $ollama -Arguments @('--version')
    $versionText = ([string]$versionResult.Stdout).Trim()
    $match = [regex]::Match($versionText, '\d+(?:\.\d+){1,3}')
    if (-not $match.Success -or ([version]$match.Value -le [version]'0.12.0')) {
        throw 'Ollama must be upgraded past 0.12.0 through its official Windows updater before Qwen3.5 models are pulled.'
    }
    $modelFile = Join-Path $ResearchRoot 'model-tags.json'
    $models = (Get-Content -LiteralPath $modelFile -Raw | ConvertFrom-Json).models
    foreach ($model in $models) {
        if ([string]::IsNullOrWhiteSpace([string]$model.sha256) -or [string]$model.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw "Pinned model '$($model.tag)' is missing a valid SHA-256 blob digest."
        }
        $pullResult = Invoke-ToolsEnabledCommand -FilePath $ollama -Arguments @('pull', [string]$model.tag)
        if ($pullResult.ExitCode -ne 0) { throw "Could not pull required local model tag '$($model.tag)'." }
        $showResult = Invoke-ToolsEnabledCommand -FilePath $ollama -Arguments @('show', [string]$model.tag, '--modelfile')
        $modelfile = [string]$showResult.Stdout
        $digest = [regex]::Match($modelfile, 'sha256-([a-f0-9]{64})').Groups[1].Value
        if ($digest -cne [string]$model.sha256) {
            throw "Local model tag '$($model.tag)' does not match its pinned SHA-256 blob digest."
        }
    }
    [PSCustomObject]@{ status = 'models-ready'; tags = @($models | ForEach-Object { $_.tag }) } | ConvertTo-Json -Compress
}

if ($Searxng) { Start-RestrictedSearxng }
if ($Python) { Provision-ExtractionPython }
if ($Models) { Provision-Models }
