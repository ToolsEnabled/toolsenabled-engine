[CmdletBinding()]
param()

# Shared Windows helper for non-interactive provider/CLI work.  Calling a .exe
# with the PowerShell call operator inherits a console allocation on some
# interactive Windows hosts; that is especially noisy for short Docker probes.
# CreateNoWindow + redirected stdio keeps the work in the broker process while
# preserving the exit code and bounded diagnostics for the caller.
function Invoke-ToolsEnabledNativeHidden {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FilePath,

    [string[]]$ArgumentList = @(),

    [string]$WorkingDirectory,

    [int]$TimeoutMilliseconds = 0
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $psi.WorkingDirectory = $WorkingDirectory
  }

  # Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList collection.
  # These callers pass fixed, validated native arguments; quote only values
  # that need it and reject embedded NUL/newline characters.
  $quoted = foreach ($raw in @($ArgumentList)) {
    $value = [string]$raw
    if ($value.IndexOf([char]0) -ge 0 -or $value -match '[\r\n]') {
      throw 'Native argument contains an invalid NUL/newline.'
    }
    if ($value -match '[\s"]') {
      '"' + $value.Replace('"', '\"') + '"'
    } else {
      $value
    }
  }
  $psi.Arguments = ($quoted -join ' ')

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    if (-not $process.Start()) { throw "Could not start native executable '$FilePath'." }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($TimeoutMilliseconds -gt 0) {
      if (-not $process.WaitForExit($TimeoutMilliseconds)) {
        try { $process.Kill() } catch {}
        [void]$process.WaitForExit()
        throw "Native executable '$FilePath' exceeded its bounded timeout."
      }
    } else {
      $process.WaitForExit()
    }
    [pscustomobject]@{
      ExitCode = [int]$process.ExitCode
      Stdout = [string]$stdoutTask.Result
      Stderr = [string]$stderrTask.Result
    }
  } finally {
    $process.Dispose()
  }
}
