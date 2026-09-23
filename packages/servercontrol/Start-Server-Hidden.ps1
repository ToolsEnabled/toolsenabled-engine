[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$FilePath,

  [string[]]$ArgumentList = @(),
  [string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'

function ConvertTo-NativeArgumentString([string[]]$Values){
  return (@($Values | ForEach-Object {
    $value = [string]$_
    if($value.IndexOf([char]0) -ge 0 -or $value -match '[\r\n]'){
      throw 'Native argument contains an invalid NUL/newline.'
    }
    if($value.Length -eq 0){ return '""' }
    return '"' + $value.Replace('"','\"') + '"'
  }) -join ' ')
}

$executable = $FilePath
$arguments = ConvertTo-NativeArgumentString $ArgumentList
if($executable -match '\.(cmd|bat)$'){
  $batchTarget = '"' + $executable.Replace('"','\"') + '"'
  $executable = $env:ComSpec
  $arguments = '/d /s /c call ' + $batchTarget + $(if($arguments){ ' ' + $arguments } else { '' })
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $executable
$psi.Arguments = $arguments
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
if(-not [string]::IsNullOrWhiteSpace($WorkingDirectory)){ $psi.WorkingDirectory = $WorkingDirectory }
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
if(-not $process.Start()){ throw "Could not start '$FilePath'." }
[pscustomobject]@{ pid = $process.Id; file = $FilePath }
$process.Dispose()
