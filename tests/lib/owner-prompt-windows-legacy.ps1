param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
$fixture = Get-Content -LiteralPath $inputFile -Raw | ConvertFrom-Json
$script:identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:fetched = 0
function Get-Process { param($Id) [pscustomobject]@{SessionId=9} }
function Get-CimInstance {
    param($ClassName, $Filter, $Property)
    if ($Property -contains 'CommandLine') {
        $script:fetched++
        if ($case.other) { throw 'Other account command line must never be requested.' }
        return [pscustomobject]@{ProcessId=544444;CreationDate=$(if($case.recycled){'replacement'}else{'original'});CommandLine=$case.command}
    }
    return [pscustomobject]@{ProcessId=$(if($case.self){$PID}else{544444});CreationDate='original'}
}
function Invoke-CimMethod {
    param($InputObject, $MethodName)
    if ($MethodName -ne 'GetOwnerSid') { throw 'Unexpected metadata call.' }
    return [pscustomobject]@{ReturnValue=0;Sid=$(if($case.other){'S-1-5-21-synthetic-other'}else{$script:identity})}
}
$matching = 'powershell.exe -NoProfile -File "C:\Fixture\engine\tools\owner-prompt-queue.ps1" wait-and-run -QueueFile "' + $fixture.target + '"'
$cases = @(
    @{name='same-account-exact-legacy-queue';command=$matching;want=1;fetches=1},
    @{name='other-queue-same-basename';command=$matching.Replace('\[review]\','\other-copy\');want=0;fetches=1},
    @{name='new-native-host';command=$matching.Replace('wait-and-run','native-ui');want=0;fetches=1},
    @{name='other-account-argv-not-read';command=$null;other=$true;want=0;fetches=0},
    @{name='changed-process-generation';command=$matching;recycled=$true;want=0;fetches=1},
    @{name='current-process-excluded';command=$matching;self=$true;want=0;fetches=0},
    @{name='own-unreadable-invocation-refused';command=$null;refused=$true;fetches=1}
)
$results=@()
foreach($case in $cases) {
    $script:fetched=0
    $capture=New-Object System.IO.StringWriter
    $real=[Console]::Out
    $refused=$false
    try {
        [Console]::SetOut($capture)
        try { Invoke-Expression $fixture.query | Out-Null } catch { $refused=$true }
    } finally { [Console]::SetOut($real) }
    try {
        if($refused -ne [bool]$case.refused -or $script:fetched -ne $case.fetches) { throw ('Wrong ownership behavior: '+$case.name) }
        if(-not $case.refused -and $capture.ToString() -ne [string]$case.want) { throw ('Wrong queue match: '+$case.name) }
        $results += [pscustomobject]@{name=$case.name;passed=$true;argvReads=$script:fetched}
    } finally { $capture.GetStringBuilder().Clear() | Out-Null; $capture.Dispose() }
}
@{ok=$true;profile=[Environment]::UserName;sourceSha256=$fixture.sourceSha256;cases=$results;limitations='Exact emitted query; fixed metadata API substitutes. No process inventory, command-line reads, forms, vault calls or runtime changes.'} | ConvertTo-Json -Depth 5 -Compress
