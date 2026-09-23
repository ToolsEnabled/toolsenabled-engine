// EXECUTABLE CHANGE
'use strict';
// Tests for tools/direct-link.ps1 -- the single control for the direct cable
// between two of the owner's computers, and for the two properties it exists to
// deliver: one press turns it on, and it stays on until the owner turns it off.
//
// Everything here is READ-ONLY or runs against a temporary tree. Nothing in this
// file registers a task, opens a port, binds a socket, or touches the live
// rendezvous state -- a test that switched the owner's link off while proving
// the link can be switched off would be its own kind of failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'tools', 'direct-link.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let passed = 0;
const failures = [];
const skipped = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
// A check this platform cannot run says so by name. It is never counted as a
// pass, and the summary line carries the count, so "ran and was fine" and
// "was never attempted here" cannot be confused for one another.
function skip(name, why) {
  skipped.push({ name, why });
  console.log(`  -   ${name} (SKIPPED: ${why})`);
}

const scriptText = fs.readFileSync(SCRIPT, 'utf8');

// --------------------------------------------------------------------------

// The parse gate is the one check in this file that needs a real PowerShell:
// System.Management.Automation.Language.Parser is the Windows PowerShell 5.1
// parser, and there is no cross-platform stand-in that would prove the same
// thing. Every other check here reads the .ps1 text and is fully portable, so
// the gate names itself off Windows instead of taking the file down with it.
const PARSE_CHECK = 'every touched script parses with zero parser errors';
const parseCheck = () => {
  const files = [
    'tools/direct-link.ps1',
    'tools/fra-rendezvous-firewall.ps1',
    'tools/fra-keeper-task.ps1',
    'tools/apply-startup-policy.ps1',
    'tools/lib/StartupPolicy.ps1',
    'packages/servercontrol/Mechanical-Connect.ps1'
  ].map(rel => path.join(ROOT, rel));
  const script = files.map(f =>
    `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$null,[ref]$e);"${path.basename(f)}=$(@($e).Count)"`
  ).join(';');
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 120000, windowsHide: true });
  const lines = String(out).trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, files.length,
    `PowerShell parser reported on ${lines.length} of ${files.length} scripts`);
  const reportedNames = new Set();
  for (const line of lines) {
    const [name, count] = line.split('=');
    assert.ok(files.some(file => path.basename(file) === name), `parser reported an unexpected script: ${name}`);
    assert.ok(!reportedNames.has(name), `parser reported ${name} more than once`);
    reportedNames.add(name);
    assert.strictEqual(count, '0', `${name} has ${count} parser error(s)`);
  }
};
if (process.platform === 'win32') check(PARSE_CHECK, parseCheck);
else {
  skip(PARSE_CHECK,
    'needs Windows PowerShell 5.1 (System.Management.Automation.Language.Parser); no other parser can decide whether these .ps1 files parse');
}

check('nothing in the direct-link path hardcodes this desk\'s addresses', () => {
  // "we cant hardcode anything this is production code it needs to work on
  // other machines". The address pair belongs in config/service-registry.json
  // and is resolved through tools/lib/service-registry.ps1, which fails closed.
  // Comments may DISCUSS the old literals; code may not contain them.
  const files = ['tools/direct-link.ps1', 'tools/fra-rendezvous-firewall.ps1', 'tools/fra-keeper-task.ps1'];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
    assert.ok(!/192\.168\.214/.test(code), `${rel} still carries a hardcoded direct-link address`);
    assert.ok(!/\b10\.\d+\.\d+\.\d+\b/.test(code), `${rel} carries a hardcoded RFC1918 address`);
  }
  // And the firewall script must resolve the pair the way its seven siblings do.
  const firewall = fs.readFileSync(path.join(ROOT, 'tools', 'fra-rendezvous-firewall.ps1'), 'utf8');
  assert.match(firewall, /Resolve-ServiceRegistryTopology/);
});

check('the node interpreter is chosen by version, from the approved candidates, never from PATH', () => {
  // A scheduled task runs with a different PATH than the owner's shell, so a
  // bare 'node' is a different program or none at all. The keeper registrar used
  // to pin one absolute path, which threw on any machine that installed Node
  // normally -- including the machine the packet ships to.
  const directLink = fs.readFileSync(path.join(ROOT, 'tools', 'direct-link.ps1'), 'utf8');
  assert.match(directLink, /agent-apps\\node-v22\.19\.0\\node\.exe/,
    'tools/direct-link.ps1 must keep the owned pin as first candidate');
  assert.match(directLink, /Program Files\\nodejs\\node\.exe/,
    'tools/direct-link.ps1 must also accept a normal Node install');
  assert.match(directLink, /22\.19\.0/, 'tools/direct-link.ps1 must state the version floor');

  // The scheduled keeper consumes the shared, functionally-qualified resolver
  // instead of maintaining a second candidate list that can drift.
  const registrar = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper-task.ps1'), 'utf8');
  assert.match(registrar, /lib\\resolve-node\.ps1/,
    'tools/fra-keeper-task.ps1 must load the shared Node resolver');
  assert.match(registrar, /^\. \$resolveNodeHelper$/m,
    'tools/fra-keeper-task.ps1 must dot-source the shared Node resolver');
  assert.match(registrar, /Resolve-ToolsEnabledNode -Root \$repoRoot/,
    'tools/fra-keeper-task.ps1 must resolve a qualifying Node from this repository');

  const resolver = fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'resolve-node.ps1'), 'utf8');
  assert.match(resolver, /agent-apps\\node-v22\.19\.0\\node\.exe/,
    'the shared resolver must keep the owned pin as a bounded bootstrap candidate');
  assert.match(resolver, /ProgramFiles[\s\S]{0,180}nodejs\\node\.exe/,
    'the shared resolver must also accept a normal Node install');
  assert.match(resolver, /tools\\resolve-node\.js/,
    'the shared PowerShell helper must delegate qualification to resolve-node.js');
  assert.match(resolver, /NODE_22_19_OR_NEWER_MISSING/,
    'the shared resolver must fail closed when no qualifying runtime exists');
});

check('-Status is read-only: it starts nothing, registers nothing, and opens nothing', () => {
  // The status verb has to be safe to run from an ordinary shell at any time,
  // including while the link is off. If it could start something, "what is the
  // state?" would change the state.
  const report = scriptText.slice(scriptText.indexOf('function Get-LinkFacts'), scriptText.indexOf('function Test-SetupComplete'));
  for (const forbidden of ['Start-ScheduledTask', 'Register-ScheduledTask', 'New-NetFirewallRule', 'Remove-Item', '-Enable', 'RunAs']) {
    assert.ok(!report.includes(forbidden), `Get-LinkFacts must not use ${forbidden}`);
  }
});

check('firewall rules are read without elevation, or the status would lie on every ordinary shell', () => {
  // Get-NetFirewallRule returns an EMPTY SET to an unelevated caller, so using it
  // here would report "no rule" on a machine whose rules are fine -- and the
  // person would be told to redo setup that was already done. netsh reports to
  // any caller.
  const fn = scriptText.slice(scriptText.indexOf('function Test-FirewallRulePresent'), scriptText.indexOf('function Get-TaskFacts'));
  assert.match(fn, /netsh advfirewall firewall show rule/);
  assert.ok(!/Get-NetFirewallRule/.test(fn), 'Get-NetFirewallRule is blind unelevated and must not decide this');
});

check('a task registered by an older version counts as setup NOT done', () => {
  // Checking only that a task EXISTS makes an upgrade silently do nothing: both
  // tasks are already present, so -On skips its elevated phase and leaves the old
  // definitions -- a keeper still on a cadence trigger, a rendezvous still capped
  // at three minutes -- while reporting the setup as complete.
  assert.match(scriptText, /RequiredArgument '--resident'/);
  assert.match(scriptText, /RequiredArgument '-Serve'/);
  const complete = scriptText.slice(scriptText.indexOf('function Test-SetupComplete'), scriptText.indexOf('function Write-Line'));
  assert.match(complete, /keeperTask\.current/);
  assert.match(complete, /rendezvousTask\.current/);
});

check('there is exactly one elevated phase, and every step inside it is attempted', () => {
  // The packet's CONNECT.ps1 wrapped only the first privileged call in a
  // try/catch, so a failure opening 8790 meant 8795 was never opened either and
  // the person saw one error about the wrong thing.
  const phase = scriptText.slice(scriptText.indexOf('function Invoke-ElevatedPhase'), scriptText.indexOf('# ------------------------------------------------------------------- verbs --'));
  for (const step of ['harden-install-folder', 'allow-port-8790', 'allow-port-8795', 'install-keeper', 'install-rendezvous']) {
    assert.ok(phase.includes(step), `the elevated phase must attempt ${step}`);
  }
  assert.strictEqual((scriptText.match(/Verb\s+=\s+'RunAs'/g) || []).length, 1, 'exactly one elevation point');
  // -Verb RunAs forces UseShellExecute, which makes the child's stdout
  // physically uncapturable -- so results have to come back through a file.
  assert.match(phase, /SetupResultFile/);
});

check('ON is a latch made of files, so it survives a restart without this script running', () => {
  const on = scriptText.slice(scriptText.indexOf('function Invoke-On'), scriptText.indexOf('function Invoke-Off'));
  // The stop sentinel must be cleared BEFORE arming: the keeper reads it first
  // and exits on it, so arming with it present starts a loop that stops itself.
  assert.ok(on.indexOf('Remove-Item -LiteralPath $StopFile') < on.indexOf('$Engine -Enable'),
    'the stop sentinel must be cleared before arming, or the keeper exits immediately');
  const off = scriptText.slice(scriptText.indexOf('function Invoke-Off'));
  assert.match(off, /\$Engine -Disable/);
  assert.match(off, /-Action Stop/, 'OFF must write the durable sentinel, not just kill a process');
});

check('OFF needs no administrator, so turning it off can never be blocked by a refused prompt', () => {
  // An off switch that needs permission is an off switch that fails exactly when
  // someone is in a hurry to use it.
  // Bounded at the dispatch block: that block legitimately routes -ElevatedPhase,
  // and an unbounded slice would read the whole rest of the file as "OFF".
  const off = scriptText.slice(
    scriptText.indexOf('function Invoke-Off'),
    scriptText.indexOf('# --------------------------------------------------------------- dispatch --'));
  assert.ok(!/RunAs/.test(off), 'OFF must not elevate');
  assert.ok(!/Invoke-ElevatedPhase/.test(off), 'OFF must not run the elevated phase');
});

check('-On reports "on and waiting" rather than failing when the other computer is off', () => {
  // Either machine may be turned on first. The one-shot must not sit blocking or
  // report failure because the peer has not appeared -- the two resident tasks
  // finish the job whenever it does, in either order.
  const on = scriptText.slice(scriptText.indexOf('function Invoke-On'), scriptText.indexOf('function Invoke-Off'));
  assert.match(on, /if \(\$report\.on\) \{/);
  assert.match(on, /waiting/i);
  assert.match(on, /\$script:ExitCode = 0; return/, 'waiting for the peer is a success, not a failure');
});

check('the verbs report through the pipeline and the exit code travels separately', () => {
  // `exit (Invoke-On)` makes PowerShell collect everything the function WROTE as
  // that expression's value, so every report line is consumed as part of the
  // return value and the person sees an empty screen. Observed live on
  // 2026-08-19: -On succeeded in 13 seconds and printed nothing at all.
  // Comments stripped: the note explaining this fix necessarily quotes the
  // broken form it replaced.
  const code = scriptText.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
  assert.ok(!/exit \(Invoke-On\)/.test(code), 'exit(Invoke-On) swallows the report');
  assert.ok(!/exit \(Invoke-Off\)/.test(code), 'exit(Invoke-Off) swallows the report');
  assert.match(scriptText, /'On'\s+\{ Invoke-On;\s+exit \$script:ExitCode \}/);
  assert.match(scriptText, /'Off'\s+\{ Invoke-Off; exit \$script:ExitCode \}/);
});

// --------------------------------------------------------------------------
// Reading a loop out of JavaScript source, so a check below can assert what a
// loop DOES rather than how one line of it happens to be spelled.
//
// Every assertion built on these helpers is EXISTENTIAL -- "some loop leaves on
// the off switch" -- which is the safe direction for a scanner this crude: a
// brace it mis-pairs can add a loop that is not really there, but it cannot
// invent the exit property inside one. Comments and string literals are removed
// first, because a brace or paren inside either is exactly what mis-pairs the
// scan. Comments go before strings: comments here are English and full of
// apostrophes ("the owner's stop switch"), so a string pass run first would
// swallow them.
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// Index of the delimiter that closes the one at `at`, or -1.
function matchDelimiter(source, at, open, close) {
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// Every braced `while (...) { }` / `for (...) { }` in `source`, as its condition
// text and its body text. Nested loops appear twice, once on their own and once
// inside the enclosing body; that is wanted, since either one may be the loop
// that carries the property.
function loopsIn(source) {
  const found = [];
  const header = /\b(?:while|for)\s*\(/g;
  let match;
  while ((match = header.exec(source))) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchDelimiter(source, openParen, '(', ')');
    if (closeParen < 0) continue;
    const openBrace = source.indexOf('{', closeParen);
    // A single-statement loop body, or no body at all, is not one we can read.
    if (openBrace < 0 || /\S/.test(source.slice(closeParen + 1, openBrace))) continue;
    const closeBrace = matchDelimiter(source, openBrace, '{', '}');
    if (closeBrace < 0) continue;
    found.push({
      condition: source.slice(openParen + 1, closeParen),
      body: source.slice(openBrace + 1, closeBrace)
    });
  }
  return found;
}

// Does this loop LEAVE when `subject` says so -- because its own condition asks,
// or because a guard inside it asks and then breaks or returns? A subject that
// is merely mentioned, logged or counted is NOT an exit, and must not read as
// one: "the loop noticed" and "the loop stopped" are the whole difference
// between an off switch and a light that blinks while the service keeps running.
function leavesOn(loop, subject) {
  if (subject.test(loop.condition)) return true;
  const guard = /\b(?:if|while)\s*\(/g;
  let match;
  while ((match = guard.exec(loop.body))) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchDelimiter(loop.body, openParen, '(', ')');
    if (closeParen < 0) continue;
    if (!subject.test(loop.body.slice(openParen + 1, closeParen))) continue;
    const rest = loop.body.slice(closeParen + 1);
    const consequent = /^\s*\{/.test(rest)
      ? rest.slice(0, matchDelimiter(rest, rest.indexOf('{'), '{', '}') + 1)
      : rest.slice(0, rest.indexOf(';') + 1);
    if (/\b(?:break|return)\b/.test(consequent)) return true;
  }
  return false;
}

check('OFF is checked against what is still listening, not against what was asked', () => {
  // The FRA listener is identified by reading its command line, and an
  // unelevated caller reads an empty one for a process an S4U task started -- so
  // the control script answers blocked_conflict rather than killing something it
  // cannot identify. Correct, but it means OFF can succeed at asking and fail at
  // stopping. Observed live: OFF printed "the direct link is OFF" with 8790 up.
  const off = scriptText.slice(
    scriptText.indexOf('function Invoke-Off'),
    scriptText.indexOf('# --------------------------------------------------------------- dispatch --'));
  assert.match(off, /\$facts\.fraListening -or \$facts\.rendezvousServing/);
  assert.match(off, /still listening/i);

  // And the keeper -- which runs as that same S4U task, so ownership IS
  // verifiable there -- is what actually performs the stop.
  const keeperSource = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), 'utf8');
  assert.match(keeperSource, /'-Action', 'Stop'/);
  assert.match(keeperSource, /stop_failed_detail/);
  // The off switch must be noticed in seconds, not at the next reconcile: a flat
  // two-minute sleep leaves someone watching a service that should have stopped.
  // So the property is that the keeper's WAIT LOOP LEAVES ON THE STOP SENTINEL.
  //
  // This assertion used to be the literal `if (fs.existsSync(STOP_FILE)) break;`,
  // and it failed against a keeper that had got STRICTLY BETTER: the sentinel is
  // now read through stopSentinelPresent(), which uses statSync precisely
  // BECAUSE existsSync collapses every filesystem error into false, and an
  // unreadable state directory must not be mistaken for permission to keep the
  // listener running. Pinning the spelling made the safer call look like a
  // regression. Nothing is given up by dropping the pin: the old line satisfies
  // the form below too (a guard naming the sentinel, whose consequent breaks),
  // as would `while (Date.now() < wakeAt && !stopSentinelPresent())`. What is
  // not satisfied by any of it is a loop that sleeps out the full reconcile
  // interval, or one that notices the sentinel without leaving.
  const STOP_SENTINEL = /stop[_a-z]{0,4}(?:sentinel|file)/i;
  const sleepLoops = loopsIn(stripCommentsAndStrings(keeperSource))
    .filter(loop => /\b(?:setTimeout|setInterval|sleep|delay)/i.test(loop.body));
  // Absence is data: if no waiting loop can be read at all, that is a failure to
  // report, never a check that quietly passes over nothing.
  assert.ok(sleepLoops.length > 0,
    'no waiting loop could be read out of fra-keeper.js, so nothing here watches the off switch');
  assert.ok(sleepLoops.some(loop => leavesOn(loop, STOP_SENTINEL)),
    'the keeper waits without watching the stop sentinel: OFF would not be honoured until the next reconcile');
});

check('the status report names ONE thing to fix, in the order a person would fix it', () => {
  // A list of eight booleans is not an answer. The first unmet precondition is.
  // The PROBLEM CHAIN only. Several of these fields are also read above it to
  // compute `on` and `working`, so slicing the whole function would compare the
  // wrong occurrences and pass or fail for the wrong reason.
  const fn = scriptText.slice(scriptText.indexOf('function Get-Report'), scriptText.indexOf('function Show-Report'));
  const report = fn.slice(fn.indexOf('$problem = $null'), fn.indexOf('return [pscustomobject]'));
  assert.ok(report.length > 200, 'the problem chain slice must not be empty');
  const order = ['$Facts.node', '$Facts.host', 'Test-SetupComplete', '$Facts.stopSentinel', '$Facts.armed', '$Facts.rendezvousServing', '$Facts.generation', '$Facts.fraListening'];
  let last = -1;
  for (const token of order) {
    const at = report.indexOf(token);
    assert.ok(at > last, `problem ordering broken at ${token}: a person cannot fix a key exchange before the cable`);
    last = at;
  }
});

// --------------------------------------------------------------------------
// The keeper's own new behaviour, exercised against a TEMPORARY state file so
// the live rendezvous document is never touched.

check('the keeper waits instead of starting FRA while the rendezvous owes a credential', () => {
  // Starting FRA before the rendezvous has minted is not merely early: on the
  // machine the registry calls machine-b it falls through to the legacy 8794
  // enrollment lane, so two credential mechanisms race for one key. On machine-a
  // it throws FRA_ENROLLMENT_RECEIVER_B_ONLY every tick for a condition that is
  // not a fault -- the other computer is simply not on yet.
  const keeperSource = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), 'utf8');
  assert.match(keeperSource, /rendezvous-credential-not-yet-agreed/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-directlink-'));
  try {
    // Load the shipped implementation from a scratch tree. Its state path is
    // consequently temporary too, without redirecting or touching live state.
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), path.join(dir, 'tools', 'fra-keeper.js'));
    /* fra-keeper eagerly requires this sibling INSIDE A win32-ONLY BRANCH
     * (tools/fra-keeper.js, the `if (process.platform === 'win32')` guard), so a
     * one-file scratch tree loads fine on Linux and cannot load on the Windows
     * desk this check exists to protect. That is why the wave that rewrote this
     * check never saw it: its own note recorded that Windows was unavailable to
     * it. A stand-in is used rather than copying the real module, because the
     * real one reads the machine roster at module scope and the shipped registry
     * declares only "this-machine" -- copying the whole tools/ directory fails
     * one layer deeper. Nothing here asserts on the heartbeat; it must merely
     * load. */
    fs.writeFileSync(
      path.join(dir, 'tools', 'fra-peer-heartbeat.js'),
      'module.exports = {\n'
      + '  heartbeat: () => { throw new Error("fra-peer-heartbeat is not exercised by this check"); },\n'
      + '  sanitizeHeartbeatTelemetry: value => value\n'
      + '};\n'
    );
    fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
    const stateFile = path.join(dir, 'state', 'mechanical-connect-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const { rendezvousCredentialPending } = require(path.join(dir, 'tools', 'fra-keeper.js'));
    const evaluate = document => {
      fs.writeFileSync(stateFile, document, 'utf8');
      return rendezvousCredentialPending();
    };
    assert.ok(evaluate('{"armed":true,"generation":0,"connected":false,"status":"waiting-for-peer"}'), 'armed with no key yet must WAIT');
    assert.strictEqual(evaluate('{"armed":true,"generation":14,"connected":true,"status":"connected"}'), null, 'an agreed key must not block the start');
    assert.strictEqual(evaluate('{"armed":false,"generation":0,"connected":false,"status":"off"}'), null, 'when the rendezvous is not in charge the keeper proceeds as before');
    // A UTF-8 BOM is what PowerShell writes; JSON.parse rejects it, and a keeper
    // that silently treated "unreadable" as "not armed" would start FRA into the
    // exact race this avoids.
    assert.ok(evaluate('\uFEFF{"armed":true,"generation":0,"connected":false,"status":"waiting-for-peer"}'), 'a BOM must not defeat the check');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('the keeper records why it could not load, instead of dying before it can log', () => {
  // The risky requires (vault, service registry) used to run above every
  // function, so a malformed registry or an unavailable vault produced a bare
  // stack trace that Task Scheduler discards, a non-zero result, and NOT ONE
  // line in the keeper log -- every two minutes, forever.
  const keeperSource = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), 'utf8');
  const logAt = keeperSource.indexOf('function log(record)');
  const requireAt = keeperSource.indexOf("require('./fra-peer-heartbeat')");
  assert.ok(logAt > 0 && requireAt > logAt, 'the risky requires must load AFTER log() exists');
  assert.match(keeperSource, /reason: 'module_load'/);
  // An importer must get the throw rather than have its process killed.
  assert.match(keeperSource, /if \(require\.main === module\) \{[\s\S]{0,200}process\.exit\(1\)/);
});

check('the keeper heals BOTH lanes, because restart-on-failure does not cover an on-demand start', () => {
  // Measured 2026-08-19, not assumed: both loops were killed. 8790 came back in
  // 93s via the resident keeper; 8795 never returned -- its task went to Ready
  // and RestartCount 999 never fired, because Task Scheduler's
  // restart-on-failure does not apply to an instance started on demand rather
  // than by a trigger. An on-demand task is exactly what the startup switch
  // leaves us with, so the restart setting alone cannot carry "stays on".
  //
  // The fix is not a cadence trigger -- that is a startup trigger in disguise and
  // would put the product back to starting itself with Windows. It is the
  // keeper, which is already resident and already in the right context.
  // Re-measured after the fix: 8795 back in 104s with a new pid.
  const keeperSource = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), 'utf8');
  assert.match(keeperSource, /function reconcileRendezvous/);
  assert.match(keeperSource, /rendezvous_restarted/);
  // It must start the TASK, never a bare process: a loop started outside the
  // task is owned by nothing, which is how the hand-started orphan existed.
  assert.match(keeperSource, /Start-ScheduledTask -TaskName 'ServerControl Mechanical Connect'/);
  assert.ok(!/-File.*Mechanical-Connect\.ps1.*-Serve/.test(keeperSource), 'the keeper must not spawn a bare serve loop');
  // Armed is the owner's switch: the keeper may restart a loop, never arm one.
  const fn = keeperSource.slice(keeperSource.indexOf('function reconcileRendezvous'), keeperSource.indexOf('function readRendezvousState'));
  assert.match(fn, /pending\.armed !== true\) return null/, 'an unarmed machine must be left alone');
  // And it is called before the FRA probe: an armed-but-dead rendezvous means
  // the credential can never converge, so FRA has nothing to wait for.
  //
  // ORDER IS THE PROPERTY; THE PARAMETER LIST IS NOT. This used to slice on the
  // literals 'async function tick()' and look for 'reconcileRendezvous()' and
  // 'await probe(host)'. Both callees since took an injected-dependency object
  // -- `async function tick({ platform, spawnSyncApi, ... })` calling
  // `reconcileRendezvous({ platform, spawnSyncApi, listenerProbe })` -- which is
  // the more testable shape, and every one of those literals stopped matching.
  // indexOf then returned -1 for the opening literal, String.slice(-1, n)
  // returned the empty string, and the ordering compared -1 against -1: the
  // check failed on Windows and on Linux against a keeper that still heals the
  // rendezvous first. Anchor on the call, not on how its arguments are spelled.
  const tickStart = keeperSource.search(/async function tick\s*\(/);
  assert.notStrictEqual(tickStart, -1, 'fra-keeper.js must define an async tick()');
  const afterTick = keeperSource.slice(tickStart);
  const nextFunction = afterTick.slice(1).search(/\n(?:async )?function \w+\s*\(/);
  const tickBody = nextFunction === -1 ? afterTick : afterTick.slice(0, nextFunction + 1);
  const healsAt = tickBody.search(/reconcileRendezvous\s*\(/);
  const probesAt = tickBody.search(/await\s+probe\s*\(/);
  assert.notStrictEqual(healsAt, -1, 'tick() must call reconcileRendezvous');
  assert.notStrictEqual(probesAt, -1, 'tick() must probe the FRA listener');
  assert.ok(healsAt < probesAt,
    'the rendezvous must be healed before the FRA lane is judged');
});

check('the resident loop stops on the owner\'s off switch and only on that', () => {
  const keeperSource = fs.readFileSync(path.join(ROOT, 'tools', 'fra-keeper.js'), 'utf8');
  assert.match(keeperSource, /const resident = process\.argv\.includes\('--resident'\)/);
  assert.match(keeperSource,
    /if \(outcome\.done === true\)[\s\S]{0,220}action: 'stop'[\s\S]{0,220}reason: 'stop sentinel present'/,
    'the pure resident decision must stop only after the stop sentinel is observed');
  assert.match(keeperSource, /log\(\{ action: 'resident_stop', reason: decision\.reason \}\)/,
    'the resident loop must report the stop decision without replacing its reason');
  // A fault exits non-zero so Task Scheduler restarts a fresh process rather
  // than leaving a wedged one holding the pid file.
  assert.match(keeperSource, /action: 'resident_fault'/);
  assert.match(keeperSource, /shutdown\(1\)/);
  // The one-shot default has to stay byte-for-byte in behaviour: tests and
  // manual diagnosis both rely on its exit codes.
  assert.match(keeperSource, /if \(!resident\) \{[\s\S]{0,200}process\.exit\(outcome\.exitCode\)/);
});

// --------------------------------------------------------------------------

console.log(`\ndirect-link: ${passed} checks passed, ${failures.length} failed, ${skipped.length} skipped`);
for (const entry of skipped) console.log(`SKIPPED: ${entry.name} -- ${entry.why}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAILED: ${failure.name}\n${failure.error.stack}`);
  process.exit(1);
}

/*
testcanfail-tests-direct-link-test-js

MUTATION EVIDENCE
- 'OFF is checked against what is still listening' formerly pinned the literal
  `if (fs.existsSync(STOP_FILE)) break;`. a343529 rewrote the keeper to ask
  through stopSentinelPresent() -- statSync, so an unreadable state directory
  cannot read as "no stop switch" -- and the pinned check went RED against the
  BETTER implementation. It now asserts the property: some sleeping loop in
  fra-keeper.js leaves on the stop sentinel. Proof that the replacement bites --
  deleting the one line `if (stopSentinelPresent()) break;` from the keeper's
  sleep loop produces
  `FAIL  OFF is checked against what is still listening, not against what was asked`
  `the keeper waits without watching the stop sentinel: OFF would not be
  honoured until the next reconcile`, and `direct-link: 16 checks passed, 1
  failed`. Restored by sha256 (d67d732d...bc392d before and after): `17 checks
  passed, 0 failed`. Worth recording that under that same mutation the check
  below it, 'the resident loop stops on the owner's off switch and only on
  that', stayed GREEN -- it pins the stop's log line, not the wait, so this is
  the only instrument covering the seconds-not-minutes property.
- The rendezvous wait assertions formerly called a local `evaluate` clone, so
  mutating the scratch product's rendezvousCredentialPending() to immediately
  `return null` left the check GREEN: `direct-link: 16 checks passed, 0 failed,
  1 skipped`. They now invoke the scratch-loaded shipped implementation. The
  same mutation produces RED output:
  `FAIL  the keeper waits instead of starting FRA while the rendezvous owes a credential`
  `armed with no key yet must WAIT`. The unmutated repository was never edited;
  after deleting the mutated scratch tree, its restored-source confirmation was:
  `direct-link: 16 checks passed, 0 failed, 1 skipped`.

PRECONDITION-NOT-MET
- Windows PowerShell 5.1 is unavailable on this Linux host, so the parser-output
  mutation could not be executed here. Its output loop was nevertheless made
  non-vacuous: it now requires one unique, known result for every requested file.

NOT-FOUND
- No exit-status/truthy-return assertion used in place of checking subject output.
- No try/catch or optional chain swallows a tested failure.
- No remaining assertion measures a mock of its subject.
- No guard silently skips the whole file; the single platform skip is named and
  counted while all portable checks continue.
- No remaining expected value is computed by the same code it checks.
- All other assertion loops iterate fixed, non-empty literals or are preceded by
  an explicit non-empty/boundary assertion.
*/
