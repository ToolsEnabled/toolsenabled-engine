param([Parameter(Mandatory = $true)][string]$FixtureTempRoot)

# Source-only prepared consumer behavior fixture. Does not call Run or Launch.
# Execute only in an approved test slot; Add-Type compiles the actual C# source.
$ErrorActionPreference = 'Stop'
$fixtureTemp = [IO.Path]::GetFullPath($FixtureTempRoot)
if (-not [IO.Path]::IsPathRooted($FixtureTempRoot) -or $fixtureTemp -ne $FixtureTempRoot) {
  throw 'Compiler temp must be an explicit canonical absolute directory.'
}
$cursor = Get-Item -LiteralPath $fixtureTemp -Force
if (-not $cursor.PSIsContainer) { throw 'Compiler temp must exist as a directory.' }
while ($null -ne $cursor) {
  if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Compiler temp ancestry must not contain reparse points.'
  }
  $cursor = $cursor.Parent
}
$env:TEMP = $fixtureTemp
$env:TMP = $fixtureTemp
$wrapperPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'tools\windows-job-wrapper.ps1'
$wrapperText = [IO.File]::ReadAllText($wrapperPath)
$opening = '$source = @' + "'" + [char]10
$start = $wrapperText.IndexOf($opening, [StringComparison]::Ordinal)
if ($start -lt 0) { throw 'Embedded wrapper source unavailable.' }
$start += $opening.Length
$end = $wrapperText.IndexOf(([char]10 + "'@"), $start, [StringComparison]::Ordinal)
if ($end -lt $start) { throw 'Embedded wrapper source is incomplete.' }
$wrapperSource = $wrapperText.Substring($start, $end - $start)
$checks = @'
public static class HandshakeConsumerChecks
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new System.Exception(message);
    }
    private static void Deadline(System.Action action)
    {
        try { action(); }
        catch (ToolsEnabledWindowsJobWrapper.HandshakeDeadlineException) { return; }
        throw new System.Exception("Expected explicit handshake deadline.");
    }
    private static void Refused(System.Action action)
    {
        try { action(); }
        catch (System.InvalidOperationException) { return; }
        throw new System.Exception("Unauthenticated OWNER was accepted.");
    }
    private static void Cancelled(System.Action action)
    {
        try { action(); }
        catch (System.OperationCanceledException) { return; }
        throw new System.Exception("Observed owner cancellation/disconnection was accepted.");
    }
    public static int RunChecks()
    {
        string token = new string('a', 64); // synthetic fixture data only
        long elapsed = 1500;
        int offered = 0;
        ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => {
            offered = remaining; elapsed = 1900; return "OWNER " + token;
        }, () => elapsed, 2000, token);
        Check(offered == 500, "Initial read restarted the budget.");

        elapsed = 2000;
        bool read = false;
        Deadline(() => ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => {
            read = true; return "OWNER " + token;
        }, () => elapsed, 2000, token));
        Check(!read, "Expired budget performed a read.");

        elapsed = 1500;
        Deadline(() => ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => {
            elapsed = 2000; return "OWNER " + token;
        }, () => elapsed, 2000, token));

        elapsed = 10;
        Refused(() => ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => "OWNER wrong",
            () => elapsed, 2000, token));
        Refused(() => ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => null,
            () => elapsed, 2000, token));

        elapsed = 1951;
        ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => {
            offered = remaining; return "OWNER " + token;
        }, () => elapsed, 2000, token);
        Check(offered == 49, "Sub100 remaining read budget was inflated.");

        Deadline(() => ToolsEnabledWindowsJobWrapper.AuthenticateOwner(remaining => {
            throw new System.TimeoutException("inert read deadline");
        }, () => elapsed, 2000, token));

        // Production repeats this check immediately before Launch, after
        // authentication/monitor preparation; clocks are not reset.
        elapsed = 2000;
        Deadline(() => ToolsEnabledWindowsJobWrapper.RemainingHandshake(2000, () => elapsed));
        ToolsEnabledWindowsJobWrapper.CheckOwnerBeforeLaunch(false, false);
        Cancelled(() => ToolsEnabledWindowsJobWrapper.CheckOwnerBeforeLaunch(true, false));
        Cancelled(() => ToolsEnabledWindowsJobWrapper.CheckOwnerBeforeLaunch(false, true));
        return 11;
    }
}
'@
# CodeDOM exposes compiler temporary-file ownership explicitly. Keep every
# compiler artifact; this fixture never invokes TempFiles.Delete or cleanup.
Add-Type -AssemblyName Microsoft.CSharp -ErrorAction Stop
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $false
$parameters.GenerateInMemory = $true
$parameters.TempFiles = New-Object System.CodeDom.Compiler.TempFileCollection($fixtureTemp, $true)
[void]$parameters.ReferencedAssemblies.Add('System.dll')
[void]$parameters.ReferencedAssemblies.Add('System.Core.dll')
$compiler = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
  $compiled = $compiler.CompileAssemblyFromSource($parameters, [string[]]@($wrapperSource + [char]10 + $checks))
  if ($compiled.Errors.HasErrors) {
    $messages = @($compiled.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { $_.ErrorText })
    throw ('Consumer fixture compilation failed: ' + ($messages -join '; '))
  }
  $count = $compiled.CompiledAssembly.GetType('HandshakeConsumerChecks').GetMethod('RunChecks').Invoke($null, @())
} finally {
  $compiler.Dispose()
}
Write-Output ("consumer handshake controlled-clock checks passed: " + $count)
