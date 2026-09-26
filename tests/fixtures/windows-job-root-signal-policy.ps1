param([Parameter(Mandatory = $true)][string]$WrapperPath)

$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $WrapperPath -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked wrapper fixture refused.' }
$text = [IO.File]::ReadAllText($item.FullName)
$sourceMatch = [regex]::Match($text, '(?s)\$source = @''\r?\n(.*?)\r?\n''@')
if (-not $sourceMatch.Success) { throw 'The authored wrapper C# source was not found.' }

# Compile the actual shipped source; exercise only its pure wait-observation
# policy through reflection. These assertions are not native cleanup receipts.
Add-Type -TypeDefinition $sourceMatch.Groups[1].Value -Language CSharp -ErrorAction Stop
$policyType = [ToolsEnabledWindowsJobWrapper].GetNestedType('RootSignalWait', [Reflection.BindingFlags]::NonPublic)
if ($null -eq $policyType) { throw 'The root signal policy was not found.' }
$observe = $policyType.GetMethod('Observe')
$script:assertions = 0

function New-Policy {
  return [Activator]::CreateInstance($policyType, [object[]]@([int]100))
}

function Read-Observation($policy, [uint32]$result, [uint32]$nativeError, [long]$elapsed) {
  return $observe.Invoke($policy, [object[]]@($result, $nativeError, $elapsed))
}

function Assert-Equal($actual, $expected, [string]$label) {
  if ($actual -cne $expected) { throw "Root signal policy assertion failed: $label" }
  $script:assertions += 1
}

function Assert-Error($policy, [uint32]$result, [uint32]$nativeError, [long]$elapsed, [string]$expected) {
  $caught = $null
  try { $null = Read-Observation $policy $result $nativeError $elapsed }
  catch { $caught = $_.Exception }
  if ($null -eq $caught) { throw 'Expected root signal policy failure was missing.' }
  while ($null -ne $caught.InnerException) { $caught = $caught.InnerException }
  Assert-Equal $caught.Message $expected 'precise wait failure diagnostic'
}

$delayed = New-Policy
Assert-Equal (Read-Observation $delayed 258 0 0) $false 'first nonsignaled observation returns to control loop'
Assert-Equal (Read-Observation $delayed 258 0 75) $false 'later nonsignaled observation remains pending'
Assert-Equal (Read-Observation $delayed 0 0 80) $true 'a subsequently signaled root is accepted'

$expired = New-Policy
Assert-Equal (Read-Observation $expired 258 0 30) $false 'deadline begins at first zero observation'
Assert-Equal (Read-Observation $expired 258 0 129) $false 'deadline is not prematurely expired'
Assert-Error $expired 258 0 130 'The job reached zero while its retained root handle was not signalled. [waitResult=258;win32Error=0]'
Assert-Error (New-Policy) ([uint32]::MaxValue) 6 0 'The contained root exit state could not be measured. [waitResult=4294967295;win32Error=6]'
Assert-Error (New-Policy) 128 0 0 'The retained root wait returned an unexpected result. [waitResult=128;win32Error=0]'
Assert-Equal (Read-Observation (New-Policy) 0 0 0) $true 'already signaled root needs no retry'

[PSCustomObject]@{ scope = 'authored C# root signal decision unit regression'; assertions = $script:assertions } | ConvertTo-Json -Compress
