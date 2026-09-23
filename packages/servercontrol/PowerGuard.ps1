# PowerGuard — enforces your chosen power settings so Windows/ASUS can't quietly revert them.
# Reads power-policy.json (minutes; 0 = never) and, if drift is detected on the CURRENTLY ACTIVE
# power scheme, re-applies the desired display-off / sleep timeouts. Idempotent and quiet: if nothing
# drifted it writes nothing. Runs every minute via the "PowerGuard" scheduled task, at logon, and
# immediately whenever you change settings in the panel's Power popup. powercfg needs no admin here.
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
$policyPath = Join-Path $dir 'power-policy.json'
$log = Join-Path $dir 'powerguard-log.txt'
function Log($m) { try { Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch {} }
function Trim-Log { try { $l = @(Get-Content -LiteralPath $log -EA Stop); if ($l.Count -gt 600) { $l[-400..-1] | Set-Content -LiteralPath $log -Encoding UTF8 } } catch {} }

function Get-ActiveScheme { $s = powercfg /getactivescheme; if ($s -match 'GUID:\s*([0-9a-fA-F-]{36})') { return $Matches[1] } return $null }
function Read-Idx($g, $sub, $set, $ac) {
    $q = powercfg /q $g $sub $set
    $pat = if ($ac) { 'Current AC Power Setting Index' } else { 'Current DC Power Setting Index' }
    $line = ($q | Select-String $pat | Select-Object -First 1).Line
    if ($line -and $line -match ':\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) }
    return $null
}

$pol = $null
try { $pol = Get-Content -LiteralPath $policyPath -Raw -EA Stop | ConvertFrom-Json } catch { }
if (-not $pol) { Log 'no power-policy.json; nothing to enforce'; return }
if (-not $pol.enforce) { return }   # enforcement toggled off

$g = Get-ActiveScheme
if (-not $g) { Log 'could not read active power scheme'; return }

# desired values (policy is in MINUTES, 0 = never; powercfg indices are in SECONDS, 0 = never)
$want = @(
    @{ Name = 'display-off AC'; Sub = 'SUB_VIDEO'; Set = 'VIDEOIDLE';   AC = $true;  Sec = ([int]$pol.displayOffAC) * 60 }
    @{ Name = 'display-off DC'; Sub = 'SUB_VIDEO'; Set = 'VIDEOIDLE';   AC = $false; Sec = ([int]$pol.displayOffDC) * 60 }
    @{ Name = 'sleep AC';       Sub = 'SUB_SLEEP'; Set = 'STANDBYIDLE'; AC = $true;  Sec = ([int]$pol.sleepAC) * 60 }
    @{ Name = 'sleep DC';       Sub = 'SUB_SLEEP'; Set = 'STANDBYIDLE'; AC = $false; Sec = ([int]$pol.sleepDC) * 60 }
)
$corr = @()
foreach ($w in $want) {
    $cur = Read-Idx $g $w.Sub $w.Set $w.AC
    if ($null -eq $cur) { continue }
    if ($cur -ne $w.Sec) {
        if ($w.AC) { powercfg /setacvalueindex $g $w.Sub $w.Set $w.Sec | Out-Null }
        else { powercfg /setdcvalueindex $g $w.Sub $w.Set $w.Sec | Out-Null }
        $corr += ('{0}: {1}s->{2}s' -f $w.Name, $cur, $w.Sec)
    }
}
if ($corr.Count) {
    powercfg /setactive $g | Out-Null
    Log ('re-applied on active scheme {0}: {1}' -f $g, ($corr -join '; '))
    Trim-Log
}
