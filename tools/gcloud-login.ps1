param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,125}[A-Za-z0-9])?$')]
    [string]$AccountEmail,

    [ValidateRange(60, 900)]
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gcloud = Get-Command gcloud.cmd -CommandType Application -ErrorAction Stop
$gcloudPath = [System.IO.Path]::GetFullPath($gcloud.Source)
if (-not (Test-Path -LiteralPath $gcloudPath -PathType Leaf) -or
    [System.IO.Path]::GetExtension($gcloudPath) -ne '.cmd') {
    throw 'The installed Google Cloud CLI launcher is unavailable or invalid.'
}

# Bypass gcloud.cmd. The batch shim can allocate a console host even when a
# parent asks for a hidden window. The bundled Python entry point is the same
# CLI and still opens the normal OAuth browser flow.
$sdkRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetDirectoryName($gcloudPath)) '..'))
$gcloudPython = Join-Path $sdkRoot 'platform\bundledpython\python.exe'
$gcloudScript = Join-Path $sdkRoot 'lib\gcloud.py'
if (-not (Test-Path -LiteralPath $gcloudPython -PathType Leaf) -or
    -not (Test-Path -LiteralPath $gcloudScript -PathType Leaf)) {
    throw 'The bundled Google Cloud CLI Python entry point is unavailable.'
}

function ConvertTo-NativeArgumentString([string[]]$Values) {
    return (@($Values | ForEach-Object {
        $value = [string]$_
        if ($value.Length -eq 0) { return '""' }
        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        return '"' + $escaped + '"'
    }) -join ' ')
}

$process = $null
try {
    # gcloud opens the OAuth browser itself; no terminal is needed. Redirect
    # both streams so no CLI output leaks into the broker's JSON protocol.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $gcloudPython
    $psi.Arguments = ConvertTo-NativeArgumentString @('-S', $gcloudScript, 'auth', 'login', $AccountEmail, '--no-activate', '--brief')
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['CLOUDSDK_ROOT_DIR'] = $sdkRoot
    $psi.EnvironmentVariables['CLOUDSDK_PYTHON'] = $gcloudPython
    $psi.EnvironmentVariables['CLOUDSDK_PYTHON_ARGS'] = '-S'
    $psi.EnvironmentVariables['CLOUDSDK_GSUTIL_PYTHON'] = $gcloudPython
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $process.Start()) { throw 'The Google Cloud CLI process could not be started.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        try { $process.Kill() } catch {}
        try { $process.WaitForExit(5000) } catch {}
        [Console]::Out.Write((@{
            started = $true
            timedOut = $true
            exitCode = $null
        } | ConvertTo-Json -Compress))
        exit 0
    }

    try { [void]$stdoutTask.Result } catch {}
    try { [void]$stderrTask.Result } catch {}

    [Console]::Out.Write((@{
        started = $true
        timedOut = $false
        exitCode = $process.ExitCode
    } | ConvertTo-Json -Compress))
} finally {
    if ($null -ne $process) {
        $process.Dispose()
    }
}
