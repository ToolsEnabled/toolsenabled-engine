param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Candidate PowerShell has parse errors.' }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NativeOwnerCapture' }, $true)
if ($null -eq $function) { throw 'Candidate capture function is missing.' }
Invoke-Expression $function.Extent.Text
$request = [pscustomobject]@{kind='credential';key='custom.fixture';label='Fixture credential';message='Public fixed metadata'}
$cases = @(
    @{name='credential-created-named-binding-utf8';kind='credential';valid=$true;status='created';body='{"key":"custom.fixture","status":"created"}';encoding=$true},
    @{name='credential-updated';kind='credential';valid=$true;status='updated';body='{"key":"custom.fixture","status":"updated"}'},
    @{name='payment-created-named-binding';kind='payment_card';valid=$true;status='created';body='{"key":"custom.fixture","status":"created"}'},
    @{name='cancelled';kind='credential';valid=$true;status='cancelled';body='{"status":"cancelled"}'},
    @{name='in-progress';kind='credential';valid=$true;status='in_progress';body='{"key":"custom.fixture","status":"in_progress"}'},
    @{name='extra-field-refused';kind='credential';valid=$false;body='{"key":"custom.fixture","status":"created","value":"synthetic-only"}'},
    @{name='wrong-key-refused';kind='credential';valid=$false;body='{"key":"custom.other","status":"created"}'},
    @{name='bad-json-refused';kind='credential';valid=$false;body='synthetic-invalid-output'},
    @{name='throw-restores-console';kind='credential';valid=$false;body='synthetic-before-throw';throws=$true}
)
$results = @()
foreach ($case in $cases) {
    $request.kind = $case.kind
    $guard = New-Object System.IO.StringWriter
    $real = [Console]::Out
    $got = $null; $failed = $false
    try {
        [Console]::SetOut($guard)
        $guardOut = [Console]::Out
        $got = Invoke-NativeOwnerCapture $request {
            [CmdletBinding(PositionalBinding=$false)]
            param([Parameter(Position=0)][string]$Action, [Parameter(Position=1)][string]$Key, [string]$PromptLabel, [string]$PromptHint)
            $wanted = if ($case.kind -eq 'payment_card') { 'prompt-payment-card' } else { 'prompt-set' }
            if ($Action -ne $wanted -or $Key -ne 'custom.fixture' -or $PromptLabel -ne 'Fixture credential') { throw 'Named binding did not preserve the public request.' }
            if ($case.kind -eq 'credential' -and $PromptHint -ne 'Public fixed metadata') { throw 'Public hint binding failed.' }
            if ($case.kind -eq 'payment_card' -and $PSBoundParameters.ContainsKey('PromptHint')) { throw 'Payment should not receive the credential hint.' }
            if ($case.encoding) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true) }
            Write-Output 'synthetic-pipeline-junk'
            [Console]::Out.Write([string]$case.body)
            if ($case.throws) { throw 'Synthetic invocation failure.' }
        }
    } catch { $failed = $true }
    finally {
        if (-not [object]::ReferenceEquals([Console]::Out, $guardOut)) { throw 'Candidate did not restore caller Console.Out.' }
        [Console]::SetOut($real)
    }
    try {
        if ($guard.ToString() -ne '') { throw ('Unframed output escaped: ' + $case.name) }
        if ($failed -eq [bool]$case.valid) { throw ('Wrong result for case ' + $case.name) }
        if ($case.valid -and ($got -is [array] -or $got.status -ne $case.status)) { throw ('Wrong metadata for case ' + $case.name) }
        $results += [pscustomobject]@{name=$case.name;passed=$true}
    } finally { $guard.GetStringBuilder().Clear() | Out-Null; $guard.Dispose() }
}
@{ok=$true;profile=[Environment]::UserName;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();cases=$results;limitations='Extracted actual capture function only; no native forms, vault calls or runtime changes.'} | ConvertTo-Json -Depth 5 -Compress
