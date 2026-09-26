param(
    [Parameter(Mandatory = $true)][ValidateSet('tail','verify','status','flush')][string]$Action,
    [ValidateRange(1, 200)][int]$Count = 25,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AuditModule = Join-Path $RepoRoot 'src\lib\audit.js'
if (-not (Test-Path -LiteralPath $AuditModule)) { throw 'The canonical audit module is not installed.' }

$Program = @'
const audit = require(process.argv[1]);
const action = process.argv[2];
const count = Number(process.argv[3]);
const force = process.argv[4] === 'true';
let result;
if (action === 'tail') result = audit.tail(count);
else if (action === 'verify') result = audit.verify();
else if (action === 'status') result = audit.status();
else if (action === 'flush') result = audit.flush({ force });
else throw new Error('Unsupported audit action.');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (action === 'verify' && !result.valid) process.exitCode = 1;
'@

& node -e $Program $AuditModule $Action $Count ([string][bool]$Force).ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
