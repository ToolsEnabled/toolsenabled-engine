[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1000, 30000)]
  [int]$TimeoutMilliseconds
)

# This script is intentionally invoked only by src/lib/providers/
# duo-desktop-approval.js, which itself is not registered as an MCP tool.
# It exposes no element text, window title, process ID, account material, or
# request content.  Its sole possible UI mutation is InvokePattern on exactly
# one visible, enabled button whose accessible name is literally "Approve" in
# the vendor-signed Duo Desktop process, while a fixed UCR browser flow is
# waiting for that same provider-owned handoff.

$ErrorActionPreference = 'Stop'
$duoPath = 'C:\Program Files (x86)\Duo Desktop\Duo Desktop.exe'

function Write-Result([string]$Status) {
  [pscustomobject]@{ status = $Status } | ConvertTo-Json -Compress
  exit 0
}

function Test-TrustedDuoExecutable {
  if (-not (Test-Path -LiteralPath $duoPath -PathType Leaf)) { return $false }
  try {
    $signature = Get-AuthenticodeSignature -LiteralPath $duoPath
    return $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid `
      -and $null -ne $signature.SignerCertificate `
      -and $signature.SignerCertificate.Subject -match '(^|,\s*)CN=Duo Security LLC(,|$)'
  } catch {
    return $false
  }
}

function Get-TrustedDuoProcess {
  $matches = @()
  foreach ($candidate in @(Get-Process -Name 'Duo Desktop' -ErrorAction SilentlyContinue)) {
    try {
      if ($candidate.Path -eq $duoPath) { $matches += $candidate }
    } catch {
      # An inaccessible/recycled process is not eligible for UI actuation.
    }
  }
  return @($matches)
}

if (-not (Test-TrustedDuoExecutable)) { Write-Result 'unavailable' }

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Write-Result 'unavailable'
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
while ([DateTime]::UtcNow -lt $deadline) {
  $processes = @(Get-TrustedDuoProcess)
  if ($processes.Count -gt 1) { Write-Result 'ambiguous' }
  if ($processes.Count -eq 1) {
    $candidates = @()
    try {
      $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$processes[0].Id))
      )
      foreach ($window in @($windows)) {
        foreach ($element in @($window.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        ))) {
          try {
            if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
            if ($element.Current.Name -cne 'Approve') { continue }
            if (-not $element.Current.IsEnabled -or $element.Current.IsOffscreen) { continue }
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $pattern) { $candidates += [pscustomobject]@{ Element = $element; Pattern = $pattern } }
          } catch {
            # Stale elements do not qualify and are never retried blindly.
          }
        }
      }
    } catch {
      Write-Result 'unavailable'
    }
    if ($candidates.Count -gt 1) { Write-Result 'ambiguous' }
    if ($candidates.Count -eq 1) {
      try {
        ([System.Windows.Automation.InvokePattern]$candidates[0].Pattern).Invoke()
        Write-Result 'invoked'
      } catch {
        Write-Result 'invoke_failed'
      }
    }
  }
  Start-Sleep -Milliseconds 250
}

Write-Result 'not_found'
