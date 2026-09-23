// EXECUTABLE CHANGE
// testcanfail-tests-measurement-honesty-js
//
// Mutation report (2026-08-26): the empty-input mutation temporarily renamed
// `src`. Before this change the scan silently ignored that missing root; after
// this change it is rejected with:
//   AssertionError [ERR_ASSERTION]: scan root must exist: src
// The swallowed-read mutation added a broken `tools/*.js` symlink; it is now
// rejected rather than skipped:
//   Error: ENOENT: no such file or directory, open 'tools/__measurement_broken.js'
// A second scratch corpus retained a PowerShell file but omitted every
// `.CommandLine` assignment. The formerly vacuous Rule 3b loop is now rejected:
//   AssertionError [ERR_ASSERTION]: expected real .CommandLine-derived variables
// The source mutations were restored byte-for-byte (the tracked-source diff
// SHA-256 remained the empty-diff digest before and after mutation).
// The restored test could not be confirmed green because the unmodified tree
// already violates Rule 3 at src/lib/providers/owner-prompt-queue.js:341:
//   AssertionError [ERR_ASSERTION]: An unelevated read returns an EMPTY CommandLine
// This precondition failure predates and is independent of these assertions.
// NOT-FOUND: exit-status/truthy-return assertions; mocks of the scanner under
// test; platform skip/file-wide precondition guards; expected values computed
// by the same implementation being checked.

'use strict';
// REPO-WIDE GUARD AGAINST THE MOST EXPENSIVE BUG CLASS IN THIS PROJECT:
// a measurement that could not see something reporting that it is ABSENT.
//
// On 2026-08-03 that one mistake produced SEVEN incidents across two machines
// and two agents in a single night:
//   1. Get-PeerReceiptReadiness: a pipeline binding looser than -or made a gate
//      that no receipt could ever pass. FRA read "not operational" for 19 hours
//      while the credential, digests and sessions were all correct.
//   2. Install-LifecycleTask compared a qualified account name against the bare
//      one Windows stores, so a correctly registered task reported failure.
//   3. Test-ExactProperties read PSObject.Properties.Name on an OrderedDictionary
//      and got Count/Keys/Values, so a freshly defaulted state failed its own
//      shape test and the lifecycle could never write its state file.
//   4. isAlive() caught EPERM as "dead", so a reconcile started duplicates and
//      three durable workers raced on one queue.
//   5. File.Replace(a, b, $null) passed "" because PowerShell binds a bare $null
//      to a String parameter as [string]::Empty; the state file could be created
//      once and never updated.
//   6. A process search matched on the name 'telegram', missed a poller running
//      as node.exe, and reported "no poller on B" -- wrong, about the owner's
//      only inbound channel.
//   7. An S4U-owned listener returned an empty CommandLine to an unelevated
//      read, so the control script reported owned:false healthy:false
//      operational:false about a listener that was serving traffic.
//
// Documentation cannot prevent this. Every one of those was written by someone
// competent who believed the check was correct, and two of them were written by
// an agent who had ALREADY documented the rule earlier the same night. So this
// is a test rather than a paragraph.
//
// Each rule allows a reviewed exception via a MEASUREMENT-HONESTY-OK comment on
// the line or the line above, with a reason. An exception you can justify in
// writing is fine; the failure mode this guards is the one nobody noticed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'tools', 'sidecars', 'packages'];
const EXTENSIONS = new Set(['.js', '.ps1']);
const SKIP_SEGMENTS = new Set(['node_modules', '.git', 'logs', 'state', 'artifacts', 'reports']);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

process.stdout.write('measurement-honesty\n');

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

for (const dir of SCAN_DIRS) {
  const scanRoot = path.join(ROOT, dir);
  assert.ok(fs.existsSync(scanRoot) && fs.statSync(scanRoot).isDirectory(),
    `scan root must exist: ${dir}`);
}
const FILES = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));
assert.ok(FILES.length > 100, `expected to scan a real tree, found ${FILES.length} files`);

// A line is exempt if the marker appears on it or in the comment block
// immediately above it.
//
// The window is 10 lines rather than 1 because a reviewed exemption is supposed
// to carry its REASONING, and reasoning does not fit on one line. A one-line
// window silently ignored every properly-written exemption and demanded changes
// to code that was already correct -- which teaches the next reader to delete
// the guard rather than argue with it.
//
// The marker may appear on the line or anywhere in the preceding 10 lines, and
// the walk does NOT stop at code. It used to, which broke on the common case of
// a multi-line condition: the marker sits above the `if (`, and the flagged
// operand is a continuation line two rows further down with real code between
// them. Requiring contiguity meant a correctly-documented exemption was ignored
// precisely where conditions are complex enough to need explaining.
//
// A ten-line window with an explicit, greppable marker is the right trade. It
// is deliberately not silent: `grep MEASUREMENT-HONESTY-OK` lists every
// exemption in the repo for review.
function exempt(lines, index) {
  for (let i = index; i >= 0 && i >= index - 10; i -= 1) {
    if (/MEASUREMENT-HONESTY-OK/.test(lines[i] || '')) return true;
  }
  return false;
}

function scan(predicate) {
  const hits = [];
  for (const file of FILES) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (exempt(lines, i)) continue;
      if (predicate(lines[i], lines, i, file)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}  ${lines[i].trim().slice(0, 120)}`);
      }
    }
  }
  return hits;
}

// --- RULE 1: a bare $null as a .NET string argument --------------------------
check('no bare $null is passed to a .NET method expecting a string', () => {
  const hits = scan(line => /\[(IO\.File|System\.IO\.File)\]::\w+\([^)]*,\s*\$null\s*\)/.test(line));
  assert.equal(hits.length, 0,
    'PowerShell binds a bare $null to a String parameter as [string]::Empty, not null. ' +
    'Use [NullString]::Value.\n  ' + hits.join('\n  '));
});

// --- RULE 2: process liveness must distinguish EPERM from ESRCH ---------------
check('process.kill liveness checks distinguish EPERM from ESRCH', () => {
  const hits = scan((line, lines, i) => {
    if (!/\.kill\(\s*[^,)]+,\s*0\s*\)/.test(line)) return false;
    // Look at the surrounding handler for evidence the author considered EPERM.
    const window = lines.slice(Math.max(0, i - 3), i + 8).join('\n');
    return !/EPERM|ESRCH|observeProcess|unverifiable/i.test(window);
  });
  assert.equal(hits.length, 0,
    'kill(pid, 0) has three outcomes. EPERM means the process EXISTS and you may not signal it -- ' +
    'catching it as "dead" starts duplicates. Use src/lib/measurement.js#observeProcess.\n  ' + hits.join('\n  '));
});

// --- RULE 3: CommandLine identity must treat empty as unverifiable ------------
check('CommandLine identity checks guard against an empty read', () => {
  const hits = scan((line, lines, i) => {
    if (!/CommandLine/.test(line)) return false;
    if (!/-match|-like|IndexOf|\.includes\(|-eq/.test(line)) return false;
    const window = lines.slice(Math.max(0, i - 6), i + 6).join('\n');
    return !/IsNullOrEmpty|IsNullOrWhiteSpace|observeCommandLine|unverifiable|-ne\s*''|length\s*===?\s*0/i.test(window);
  });
  assert.equal(hits.length, 0,
    'An unelevated read returns an EMPTY CommandLine for a process in another session (any S4U task). ' +
    'Matching on it yields "wrong process", which is indistinguishable from "not running". ' +
    'Guard emptiness first, or use src/lib/measurement.js#observeCommandLine.\n  ' + hits.join('\n  '));
});

// --- RULE 3b: the same check, reached through a variable ---------------------
// Rule 3 only sees a single line, so it misses the far more common shape where
// the value is captured first and compared later:
//     $commandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
//     ...
//     $commandLine.IndexOf($entry, ...) -ge 0
// That is the exact code that reported a healthy task-owned FRA listener as
// owned:false healthy:false operational:false.
//
// Note the `else { '' }` in it. Coalescing null to an empty string LOOKS
// defensive and is the opposite: it converts "I could not read this" into "this
// definitely does not match", which is precisely the collapse this whole file
// exists to prevent. An emptiness COMPARISON is required, not an emptiness
// default.
check('CommandLine values captured into a variable are still guarded', () => {
  const hits = [];
  let powershellFiles = 0;
  let derivedVariables = 0;
  for (const file of FILES) {
    if (path.extname(file) !== '.ps1') continue;
    powershellFiles += 1;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);

    // Variables that take their value from a .CommandLine read.
    const derived = new Set();
    for (const line of lines) {
      const m = line.match(/\$(\w+)\s*=\s*[^=].*\.CommandLine/);
      if (m) {
        derived.add(m[1]);
        derivedVariables += 1;
      }
    }
    if (!derived.size) continue;

    // A real guard is a COMPARISON against emptiness, not a default value.
    const guarded = new Set();
    for (const line of lines) {
      const g = line.match(/IsNullOrWhiteSpace\(\s*\$(\w+)|IsNullOrEmpty\(\s*\$(\w+)/);
      if (g) guarded.add(g[1] || g[2]);
    }

    for (let i = 0; i < lines.length; i += 1) {
      if (exempt(lines, i)) continue;
      for (const name of derived) {
        if (guarded.has(name)) continue;
        const used = new RegExp(`\\$${name}\\s*(\\.IndexOf|-match|-like|-eq|\\.Contains)`);
        if (used.test(lines[i])) {
          hits.push(`${path.relative(ROOT, file)}:${i + 1}  ${lines[i].trim().slice(0, 110)}`);
        }
      }
    }
  }
  assert.ok(powershellFiles > 0, 'expected PowerShell files for the Rule 3b scan');
  assert.ok(derivedVariables > 0, 'expected real .CommandLine-derived variables');
  assert.equal(hits.length, 0,
    'A variable holding a .CommandLine value is compared with no emptiness CHECK anywhere in the file. ' +
    'Defaulting it to \'\' is not a guard -- it turns "unreadable" into "does not match", which reports a ' +
    'healthy task-owned service as unowned.\n  ' + hits.join('\n  '));
});

// --- RULE 4: the -or chain ending in a piped array ---------------------------
check('no -or chain ends in an array literal piped into Where-Object', () => {
  const hits = scan((line, lines, i) => {
    const window = lines.slice(i, i + 4).join('\n');
    return /-or\s*\r?\n?\s*@\([^)]*\)\s*\|\s*\r?\n?\s*Where-Object/.test(window);
  });
  assert.equal(hits.length, 0,
    'A pipeline binds LOOSER than -or, so the whole boolean chain is evaluated first, yields $true from ' +
    'the non-empty array, and that $true is piped into Where-Object. The gate can then never pass for any ' +
    'input. Parenthesise the piped expression.\n  ' + hits.join('\n  '));
});

// --- RULE 5: process searches must not match on a bare display name -----------
check('process searches do not identify a service by a bare product name', () => {
  const hits = scan(line => {
    if (!/Get-CimInstance\s+Win32_Process|Get-Process\b/.test(line)) return false;
    // Matching a bare word against process NAME finds the desktop app, not the
    // node script that actually implements the service.
    return /-Filter\s+"Name='?(telegram|slack|chrome)/i.test(line);
  });
  assert.equal(hits.length, 0,
    'Matching a service by product name finds the desktop client and misses a node/python implementation ' +
    'entirely, then reports absence. Identify by entry point or scheduled task.\n  ' + hits.join('\n  '));
});

// --- RULE 6: the helper itself must keep its three states --------------------
check('the measurement helper still refuses to collapse unverifiable into a boolean', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'measurement.js'), 'utf8');
  assert.match(helper, /UNVERIFIABLE\s*=\s*'unverifiable'/);
  assert.doesNotMatch(helper, /function\s+isAlive\s*\(/,
    'a boolean isAlive() cannot express "I could not tell", which is the whole defect this module exists for');
  const measurement = require(path.join(ROOT, 'src', 'lib', 'measurement.js'));
  // EPERM must never read as absent -- the single assertion that would have
  // prevented the three racing workers.
  const eperm = measurement.observeProcess(1234, { kill: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; } });
  assert.equal(eperm.state, 'unverifiable', 'EPERM must be unverifiable, never absent');
  const esrch = measurement.observeProcess(1234, { kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } });
  assert.equal(esrch.state, 'absent', 'ESRCH is the only error that proves absence');
  assert.equal(measurement.observeProcess(1234, { kill: () => undefined }).state, 'alive');
  // An empty command line is the task-owned case, not a mismatch.
  assert.equal(measurement.observeCommandLine('', 'bridge.js').state, 'unverifiable');
  assert.equal(measurement.observeCommandLine('node bridge.js --serve', 'bridge.js').state, 'alive');
  assert.equal(measurement.observeCommandLine('node other.js', 'bridge.js').state, 'absent');
});

process.stdout.write(`\nmeasurement-honesty: ${passed} checks passed over ${FILES.length} files\n`);

// --- RULE 7: identity digests must not include mutable timestamps ------------
// rootIdentityDigest hashed ctimeNs, so the "is this the same machine" answer
// became a function of the root directory's MUTATION HISTORY. Measured on
// 2026-08-03: adding a file to the root changed the digest, and removing it
// again produced a THIRD value rather than restoring the first. Ordinary
// development therefore broke device continuity permanently, and every FRA
// reconnect failed REMOTE_BRIDGE_DEVICE_CONTINUITY_MISMATCH.
//
// Same coupling that started the incident one layer down: something edited
// during ordinary use wired into something that must stay fixed. dev/ino/nlink
// are the directory's identity; times are state.
check('identity digests are built from stable fields, not timestamps', () => {
  const binding = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'fra-transport-binding.js'), 'utf8');
  const block = binding.match(/digest\('ToolsEnabled\/FRA\/root-identity\/v1',\s*\{[\s\S]*?\}\)/);
  assert.ok(block, 'the root-identity digest must remain locatable');
  assert.doesNotMatch(block[0], /ctimeNs|mtimeNs|atimeNs|birthtime/,
    'a timestamp inside an IDENTITY digest makes continuity a function of mutation history: ' +
    'the same directory stops matching itself after any ordinary write');

  // Behavioural, because reading the field list is what missed it the first time.
  const transport = require(path.join(ROOT, 'src', 'lib', 'fra-transport-binding.js'));
  const probe = path.join(ROOT, `.__identity_probe_${process.pid}`);
  const before = transport.rootIdentityReport({ root: ROOT }).rootIdentityDigest;
  fs.writeFileSync(probe, 'x');
  const during = transport.rootIdentityReport({ root: ROOT }).rootIdentityDigest;
  fs.rmSync(probe, { force: true });
  const after = transport.rootIdentityReport({ root: ROOT }).rootIdentityDigest;
  assert.equal(during, before, 'creating a file in the root must not change the machine identity');
  assert.equal(after, before, 'removing it must not change it either');
  // It must still tell two directories apart, or it would be stable and useless.
  assert.notEqual(transport.rootIdentityReport({ root: path.join(ROOT, 'tools') }).rootIdentityDigest, before,
    'a different directory must still produce a different identity');
});

process.stdout.write(`  (rule 7 verified behaviourally)\n`);
