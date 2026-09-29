param(
    [ValidateRange(60, 900)]
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$firebase = Get-Command firebase.cmd -CommandType Application -ErrorAction Stop
$firebasePath = [System.IO.Path]::GetFullPath($firebase.Source)
if (-not (Test-Path -LiteralPath $firebasePath -PathType Leaf) -or
    [System.IO.Path]::GetExtension($firebasePath) -ne '.cmd') {
    throw 'The installed Firebase CLI launcher is unavailable or invalid.'
}

# Do not start the .cmd shim. Even when a caller requests a hidden window, the
# shim can briefly allocate a conhost on some Windows builds. Firebase's
# launcher is a small Node command file, so invoke its real JS entry point
# directly through node with a native, no-console process boundary.
$node = Get-Command node.exe -CommandType Application -ErrorAction Stop
$nodePath = [System.IO.Path]::GetFullPath($node.Source)
$firebaseJs = Join-Path ([System.IO.Path]::GetDirectoryName($firebasePath)) 'node_modules\firebase-tools\lib\bin\firebase.js'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $firebaseJs -PathType Leaf)) {
    throw 'The installed Firebase CLI Node entry point is unavailable.'
}

function ConvertTo-NativeArgumentString([string[]]$Values) {
    return (@($Values | ForEach-Object {
        $value = [string]$_
        if ($value.Length -eq 0) { return '""' }
        # ProcessStartInfo on Windows PowerShell 5.1 has no ArgumentList.
        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        return '"' + $escaped + '"'
    }) -join ' ')
}

$process = $null
try {
    # Firebase opens the OAuth browser itself; it does not need a visible
    # terminal. Redirecting both streams prevents the broker's JSON protocol
    # from being polluted while keeping the exact child PID accountable.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodePath
    $psi.Arguments = ConvertTo-NativeArgumentString @($firebaseJs, 'login', '--reauth')
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    if (-not $process.Start()) { throw 'The Firebase CLI process could not be started.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $completed = $process.WaitForExit($TimeoutSeconds * 1000)
    if (-not $completed) {
        # Terminate only the exact hidden Firebase child started above.
        try { $process.Kill() } catch {}
        try { $process.WaitForExit(5000) } catch {}
        [Console]::Out.Write((@{
            started = $true
            timedOut = $true
            exitCode = $null
        } | ConvertTo-Json -Compress))
        exit 0
    }

    # Complete the redirected drains after the process has exited. Their
    # contents are deliberately discarded: Firebase output can contain URLs
    # or other sign-in material and is never returned to the MCP caller.
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
