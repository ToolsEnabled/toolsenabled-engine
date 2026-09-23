// EXECUTABLE CHANGE
'use strict';

// Mechanical policy guard for runtime-owned PowerShell and JavaScript process
// launches. It recursively scans every runtime-owned source directory, without
// starting a helper process, so a new launch path cannot be hidden merely by
// omitting it from a hand-maintained list.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceExtensions = new Set(['.ps1', '.psm1', '.js', '.cjs', '.mjs']);
const runtimeRoots = new Set(['bin', 'packages', 'sidecars', 'src', 'tools']);
// The legacy scripts root was retired. Scan it if a checkout contains it;
// all current runtime roots remain required and unreadable roots still fail.
if (fs.existsSync(path.join(root, 'scripts'))) runtimeRoots.add('scripts');
const allowlistPattern = /VISIBLE-SHELL-ALLOWLIST\s*:\s*\S.+/;

/* THE CALLEE-NAME MATCH THIS FILE RELIES ON (see the closing comment, "sites
 * are found by CALLEE NAME") CUTS BOTH WAYS. It cannot see a spawn reached
 * through a renamed reference, and it also cannot tell a real OS-process
 * launch from an unrelated local method that happens to be spelled the same
 * -- `host.spawn(request)` is as "spawn-shaped" to a text scanner as
 * `child_process.spawn(cmd, args, opts)` is, even though the first opens no
 * window and the second might.
 *
 * MEASURED 2026-09-03: src/lib/agent-tree-spawn.js:141 calls `host.spawn`,
 * the application's own tree-command dispatch (installTreeSpawnHost's
 * `spawn` slot, wired in shell/main.cjs to `dispatchTreeSpawn` -- an
 * in-process call that asks the renderer to draw a circle, not
 * child_process.spawn). This gate reported "missing windowsHide: true"
 * against it, which cannot be repaired by editing the call: `host.spawn`
 * takes one argument, an envelope, and has no windowsHide option to set.
 * That is a false alarm from this gate, not a hidden console window.
 *
 * VISIBLE-SHELL-ALLOWLIST does not fit: it means "this really does launch a
 * visible shell, and here is why that is deliberate" (see
 * tools/launch-readiness/clean-env-launch.mjs), which is not true here --
 * nothing is launched at all. Claiming it anyway would make a future person
 * grepping VISIBLE-SHELL-ALLOWLIST for actual visible-window sites read one
 * that shows no window. A second, honestly-named marker for the OTHER kind
 * of false positive -- same callee name, not a process launch -- says what is
 * actually true at the site that carries it. Same shape as its neighbour: a
 * same-line, reason-bearing, per-site exception, not a change to the
 * callPattern regex above, so every other `spawn(`/`fork(`/`execFile(`-named
 * call in the tree is still found and still required to hide its window. */
const notAProcessSpawnPattern = /NOT-A-PROCESS-SPAWN\s*:\s*\S.+/;

const serverControlPanel = fs.readFileSync(path.join(root, 'packages', 'servercontrol', 'Server-Control-Panel.ps1'), 'utf8');
assert.match(
  serverControlPanel,
  /Start-Process -FilePath \$HostProfile\.PowerShell -Verb RunAs -WindowStyle Hidden -ArgumentList \("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \$quotedScript"\)/,
  'UAC elevation must remain owner-visible while the elevated PowerShell console is hidden'
);

function runtimeFiles() {
  const files = [];
  const skippedDirectories = new Set(['.git', 'node_modules', 'state', 'logs', 'profiles']);
  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      files.push({ relative: path.relative(root, directory), error: `directory unreadable: ${error.code || error.message}` });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) walk(path.join(directory, entry.name));
        continue;
      }
      const full = path.join(directory, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { isFile = fs.statSync(full).isFile(); } catch { isFile = false; }
      }
      if (isFile && sourceExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push({ relative: path.relative(root, full).replace(/\\/g, '/') });
      }
    }
  }
  for (const directory of runtimeRoots) walk(path.join(root, directory));
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function hasAllowlist(source, line) {
  const lines = source.split('\n');
  return allowlistPattern.test(lines[line - 1] || '');
}

// Scoped to scanJavaScript only (see notAProcessSpawnPattern above): a
// PowerShell Start-Process/Register-ScheduledTask site claiming its call is
// "not a process spawn" would be self-contradicting, so this marker is never
// consulted by scanPowerShell.
function hasNotAProcessSpawnAllowance(source, line) {
  const lines = source.split('\n');
  return notAProcessSpawnPattern.test(lines[line - 1] || '');
}

// How many consecutive `character` immediately precede index.
function precedingRun(source, index, character) {
  let run = 0;
  for (let k = index - 1; k >= 0 && source[k] === character; k -= 1) run += 1;
  return run;
}

// Is the quote at `index` escaped, and therefore NOT the end of the string?
//
// This has to follow the rules of the language actually being masked. A masker
// that loses track of where a string ends does not just mis-read one line: it
// desynchronises for the REST of the file, so real code gets blanked and real
// code gets treated as string. In a spawn-hygiene gate that is not cosmetic --
// an unhidden Start-Process sitting inside a wrongly-blanked region is never
// seen at all. This has already produced a false positive against a retired
// PowerShell launcher whose CreateNoWindow boundary was blanked while its
// later .Start() call stayed visible.
//
// PowerShell has NO backslash escape: a backslash is an ordinary character, so
// the extremely common regex literal '\\' must not be read as an escaped quote.
// Inside a DOUBLE-quoted PowerShell string the escape character is the backtick;
// inside a single-quoted string nothing escapes at all. In both, a literal quote
// is written by doubling it, which the caller consumes.
//
// JavaScript keeps the backslash rule, but counted properly, so that a string
// ending in an escaped backslash ("...\\") still closes.
function quoteIsEscaped(source, index, quote, powershell) {
  if (powershell) {
    if (quote === "'") return false;
    return precedingRun(source, index, '`') % 2 === 1;
  }
  return precedingRun(source, index, '\\') % 2 === 1;
}

function maskCode(source, powershell = false) {
  let masked = '';
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    const next = source[i + 1];
    if (state === 'code' && character === '/' && next === '/') {
      masked += '  ';
      i++;
      state = 'line-comment';
    } else if (state === 'code' && character === '/' && next === '*') {
      masked += '  ';
      i++;
      state = 'block-comment';
    } else if (state === 'code' && powershell && character === '#') {
      masked += ' ';
      state = 'line-comment';
    } else if (state === 'code' && (character === "'" || character === '"' || (!powershell && character === '`'))) {
      masked += character;
      state = character === '`' ? 'template' : `quote:${character}`;
    } else if (state.startsWith('quote:') || state === 'template') {
      const quote = state === 'template' ? '`' : state.slice('quote:'.length);
      masked += character === '\n' ? '\n' : ' ';
      if (character === quote && !quoteIsEscaped(source, i, quote, powershell)) {
        if (powershell && next === quote) {
          // A doubled quote ('' or "") is a literal quote inside the string.
          // Consume the pair and stay in the string.
          masked += ' ';
          i++;
        } else {
          masked = masked.slice(0, -1) + character;
          state = 'code';
        }
      }
    } else if (state === 'line-comment') {
      masked += character === '\n' ? '\n' : ' ';
      if (character === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        masked += '  ';
        i++;
        state = 'code';
      } else {
        masked += character === '\n' ? '\n' : ' ';
      }
    } else {
      masked += character;
    }
  }
  return masked;
}

function balanced(source, openOffset, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openOffset; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === openCharacter) depth++;
    if (character === closeCharacter && --depth === 0) return { text: source.slice(openOffset, index + 1), end: index + 1 };
  }
  return null;
}

function powerShellStatement(source, start) {
  const lines = source.slice(start).split('\n');
  const collected = [];
  let parenthesisDepth = 0;
  for (const line of lines.slice(0, 32)) {
    collected.push(line);
    parenthesisDepth += (line.match(/[({]/g) || []).length - (line.match(/[)}]/g) || []).length;
    if (!/`\s*$/.test(line) && parenthesisDepth <= 0) return collected.join('\n');
  }
  return null;
}

function hasHiddenJsOption(source, callText) {
  if (/\bwindowsHide\s*:\s*true\b/.test(callText)) return true;
  const assigned = callText.match(/\bwindowsHide\s*:\s*([A-Za-z_$][\w$]*)\b/);
  if (assigned) {
    const value = assigned[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b(?:const|let|var)\\s+${value}\\s*=\\s*[^;\\n]*!==\\s*false\\b`).test(source)) return true;
  }
  const variable = callText.match(/,\s*([A-Za-z_$][\w$]*)\s*\)$/);
  if (!variable) return false;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${variable[1]}\\s*=\\s*\\{`, 'g');
  let match;
  while ((match = declaration.exec(source))) {
    const object = balanced(source, source.indexOf('{', match.index), '{', '}');
    if (object && /\bwindowsHide\s*:\s*true\b/.test(object.text)) return true;
  }
  return false;
}

// PowerShell splatting hides the boundary from a reader of the call alone.
// `Start-Process @psi` carries every parameter in a hashtable, so the boundary
// is spelled `WindowStyle = 'Hidden'` inside `$psi` rather than `-WindowStyle
// Hidden` on the call line. Reading only the statement reported
// tools/direct-link.ps1's elevated setup relaunch as an unhidden spawn while
// the hashtable four lines above it set WindowStyle Hidden -- a false positive
// against correct code, which costs a gate its credibility just as fast as a
// miss does.
//
// This RESOLVES the splat; it does not excuse it. A splat whose hashtable
// cannot be found, or whose hashtable does not declare a boundary, still
// fails. The hashtable is read from the raw source rather than the masked
// copy because masking blanks string bodies, which would erase the very
// 'Hidden' this has to see; if brace balancing ever goes wrong the regex
// simply misses and the site is reported, which is the loud direction.
function splattedHiddenBoundary(source, statement) {
  const splat = statement.match(/(?:^|\s)@([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (!splat) return false;
  const declaration = new RegExp(`\\$${splat[1]}\\s*=\\s*@\\{`, 'gi');
  let match;
  while ((match = declaration.exec(source))) {
    const table = balanced(source, source.indexOf('{', match.index), '{', '}');
    if (!table) continue;
    if (/WindowStyle\s*=\s*(['"])Hidden\1/i.test(table.text)) return true;
    if (/CreateNoWindow\s*=\s*\$true/i.test(table.text)) return true;
  }
  return false;
}

function hasPowerShellHiddenBoundary(source, statement) {
  return /-WindowStyle\s+Hidden\b/i.test(statement) ||
    (/conhost(?:\.exe)?\b/i.test(statement) && /--headless\b/i.test(statement)) ||
    (/UseShellExecute\s*=\s*\$false/i.test(source) && /CreateNoWindow\s*=\s*\$true/i.test(source)) ||
    splattedHiddenBoundary(source, statement);
}

function isNonConsolePowerShellTarget(statement) {
  if (/Start-Process\s+(?:-FilePath\s+)?(?:https?:\/\/|\$[\w.]*Url\b|explorer(?:\.exe)?\b|\$browser\b)/i.test(statement)) return true;
  return false;
}

function scanPowerShell(relative, source, violations, unscannable, tally) {
  const masked = maskCode(source, true);
  const commandPattern = /\b(?:Start-Process|Start-Job|Register-ScheduledTask)\b/gi;
  let match;
  while ((match = commandPattern.exec(masked))) {
    const line = lineAt(source, match.index);
    const statement = powerShellStatement(source, match.index);
    tally.processSites++;
    if (!statement) {
      const finding = `${relative}:${line} [${match[0]}] unterminated spawn-shaped statement`;
      unscannable.push(finding);
      violations.push(finding);
      continue;
    }
    if (/\bRegister-ScheduledTask\b/i.test(match[0])) {
      const scheduledTaskIsNonInteractive = /(?:-LogonType\s+S4U\b|conhost(?:\.exe)?\b[^\r\n]*--headless\b)/i.test(source) ||
        /-NoProfile\b[\s\S]{0,200}-NonInteractive\b[\s\S]{0,200}-WindowStyle\s+Hidden\b/i.test(source) ||
        /New-ScheduledTaskSettingsSet[\s\S]{0,1000}\s-Hidden\b/i.test(source);
      if (!scheduledTaskIsNonInteractive && !hasAllowlist(source, line)) {
        violations.push(`${relative}:${line} [Register-ScheduledTask] missing S4U/headless boundary`);
      }
      continue;
    }
    if (!isNonConsolePowerShellTarget(statement) && !hasPowerShellHiddenBoundary(source, statement) && !hasAllowlist(source, line)) {
      violations.push(`${relative}:${line} [${match[0]}] missing hidden/noninteractive boundary`);
    }
  }

  const nativeStartPattern = /(?:\[System\.Diagnostics\.Process\]::Start\s*\(|\.Start\s*\(\s*\))/gi;
  while ((match = nativeStartPattern.exec(masked))) {
    const line = lineAt(source, match.index);
    const before = masked.slice(Math.max(0, match.index - 5000), match.index);
    tally.processSites++;
    if (!/ProcessStartInfo/i.test(before)) continue;
    if (!hasPowerShellHiddenBoundary(before, '') && !hasAllowlist(source, line)) {
      violations.push(`${relative}:${line} [native Process.Start] missing CreateNoWindow/hidden boundary`);
    }
  }
}

function scanJavaScript(relative, source, violations, unscannable, tally) {
  const masked = maskCode(source);
  const callPattern = /\b(?:spawnSync|spawn|execFileSync|execFile|fork)\s*\(/g;
  let match;
  while ((match = callPattern.exec(masked))) {
    const line = lineAt(source, match.index);
    const open = match.index + match[0].lastIndexOf('(');
    const call = balanced(masked, open, '(', ')');
    tally.processSites++;
    if (!call) {
      const finding = `${relative}:${line} [${match[0].trim()}] unbalanced spawn-shaped call`;
      unscannable.push(finding);
      violations.push(finding);
      continue;
    }
    if (!hasHiddenJsOption(masked, call.text) && !hasAllowlist(source, line) && !hasNotAProcessSpawnAllowance(source, line)) {
      violations.push(`${relative}:${line} [${match[0].trim()}] missing windowsHide: true`);
    }
  }
}

const files = runtimeFiles();
const unscannable = [];
const violations = [];
const tally = { psFiles: 0, jsFiles: 0, processSites: 0 };

for (const entry of files) {
  const relative = entry.relative;
  if (entry.error) {
    unscannable.push(`${relative} ${entry.error}`);
    violations.push(`${relative} ${entry.error}`);
    continue;
  }
  const full = path.join(root, relative);
  let bytes;
  try {
    bytes = fs.readFileSync(full);
  } catch (error) {
    const finding = `${relative} unreadable: ${error.code || error.message}`;
    unscannable.push(finding);
    violations.push(finding);
    continue;
  }
  const source = bytes.toString('utf8');
  if (source.includes('\uFFFD')) {
    const raw = bytes.toString('latin1');
    if (/\b(?:Start-Process|Start-Job|Register-ScheduledTask|Process\.Start|spawnSync|spawn|execFileSync|execFile|fork)\b/i.test(raw)) {
      const finding = `${relative} invalid UTF-8 with spawn-shaped content`;
      unscannable.push(finding);
      violations.push(finding);
    } else {
      unscannable.push(`${relative} invalid UTF-8 without spawn-shaped content`);
    }
    continue;
  }
  if (/\.psm?1$/i.test(relative)) {
    tally.psFiles++;
    scanPowerShell(relative, source, violations, unscannable, tally);
  } else {
    tally.jsFiles++;
    scanJavaScript(relative, source, violations, unscannable, tally);
  }
}

// A clean violations list is meaningful only if discovery and both scanners
// actually ran. Without these witnesses an empty runtimeRoots set made the
// entire repository scan pass vacuously.
assert.ok(files.length > 0, 'spawn hygiene must discover runtime source files');
assert.ok(tally.psFiles > 0, 'spawn hygiene must scan at least one PowerShell source file');
assert.ok(tally.jsFiles > 0, 'spawn hygiene must scan at least one JavaScript source file');
assert.ok(tally.processSites > 0, 'spawn hygiene must inspect at least one spawn-shaped site');

// Guard the guard: the exact regression fixed in Server Control must be
// caught, a reason-bearing exception must stay narrow, and a malformed
// spawn-shaped line must be a failure rather than an accidental skip.
{
  const fixtureViolations = [];
  const fixtureUnscannable = [];
  const fixtureTally = { processSites: 0 };
  scanPowerShell('fixture.ps1', 'Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList "-NoProfile -NonInteractive"', fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.deepEqual(fixtureViolations, ['fixture.ps1:1 [Start-Process] missing hidden/noninteractive boundary']);

  scanPowerShell('allowlisted.ps1', 'Start-Process powershell.exe -Verb RunAs # VISIBLE-SHELL-ALLOWLIST: owner must inspect an interactive recovery shell', fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.equal(fixtureViolations.length, 1, 'a same-line, reason-bearing allowlist is the only exception');

  // Splat resolution, in BOTH directions. Only the first of these three proves
  // the false positive is gone; the other two are what stop "follow the splat"
  // from quietly becoming "ignore any call that splats", which would blind the
  // gate to every hashtable-driven launch in the tree.
  scanPowerShell('splat-hidden.ps1',
    "$psi = @{\n  FilePath = 'powershell.exe'\n  WindowStyle = 'Hidden'\n}\nStart-Process @psi",
    fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.equal(fixtureViolations.length, 1,
    'a splat whose hashtable declares WindowStyle Hidden is a hidden launch, not a violation');

  scanPowerShell('splat-visible.ps1',
    "$psi = @{\n  FilePath = 'powershell.exe'\n  Verb = 'RunAs'\n}\nStart-Process @psi",
    fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.match(fixtureViolations.at(-1),
    /^splat-visible\.ps1:\d+ \[Start-Process\] missing hidden\/noninteractive boundary$/,
    'a splat whose hashtable omits the boundary must still be reported');

  scanPowerShell('splat-unresolvable.ps1', 'Start-Process @neverDeclaredAnywhere',
    fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.match(fixtureViolations.at(-1),
    /^splat-unresolvable\.ps1:\d+ \[Start-Process\] missing hidden\/noninteractive boundary$/,
    'a splat whose hashtable cannot be found proves nothing and must be reported');

  scanJavaScript('malformed.js', 'spawn(process.execPath, [', fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.match(fixtureViolations.at(-1), /unbalanced spawn-shaped call/);
  assert.match(fixtureUnscannable.at(-1), /unbalanced spawn-shaped call/);

  // NOT-A-PROCESS-SPAWN, in both directions -- the same proof shape as the
  // splat checks above. The first call proves a same-named, non-process
  // method call is flagged like any other spawn-shaped site by default (this
  // marker is not identity-gated on "host.spawn"; nothing here recognises
  // that receiver). The second proves the one exact line carrying the marker
  // is silenced. A third, on a DIFFERENT unmarked line right after a marked
  // one, proves the exception is per-line, not per-file or "rest of scan".
  const before = fixtureViolations.length;
  scanJavaScript('unmarked-method-spawn.js', 'host.spawn(request);', fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.equal(fixtureViolations.length, before + 1,
    'a method named spawn is still reported without the marker, same as a real child_process call');
  assert.match(fixtureViolations.at(-1), /missing windowsHide: true/);

  scanJavaScript('not-a-process.js', 'host.spawn(request); // NOT-A-PROCESS-SPAWN: test double, not a real process launch',
    fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.equal(fixtureViolations.length, before + 1,
    'a same-line, reason-bearing NOT-A-PROCESS-SPAWN exception is the only exception for a call that is not a real process launch');

  scanJavaScript('not-a-process-then-real.js',
    'host.spawn(request); // NOT-A-PROCESS-SPAWN: test double, not a real process launch\nspawn(cmd, args);',
    fixtureViolations, fixtureUnscannable, fixtureTally);
  assert.equal(fixtureViolations.length, before + 2,
    'the exception covers only the marked line; an unmarked real spawn one line later is still caught');
}

console.log(`SPAWN-HYGIENE scanned ${files.length} runtime source files (${tally.psFiles} PowerShell, ${tally.jsFiles} JavaScript); checked ${tally.processSites} spawn-shaped sites.`);
console.log(`SPAWN-HYGIENE unscannable: ${unscannable.length}${unscannable.length ? `\n${unscannable.join('\n')}` : ''}`);
assert.deepEqual(violations, [], `SPAWN-HYGIENE violations:\n${violations.join('\n')}`);
/* WHAT THIS GATE DOES NOT SEE, SAID OUT LOUD.
 *
 * Sites are found by CALLEE NAME -- spawnSync, spawn, execFileSync, execFile,
 * fork. A spawn reached through an INJECTED function is invisible to that:
 *  is called with execFileSync by its
 * caller, and the scanner sees only , which matches nothing.
 *
 * Measured 2026-08-25 by an adversary that removed windowsHide from exactly
 * such a site and watched this file stay GREEN. The launch is still hidden --
 * the option is there -- but NOTHING HERE GUARDS IT, so a later edit could
 * remove it silently.
 *
 * This is stated rather than fixed because both available fixes are worse than
 * the gap. Matching a naming convention (execImpl, spawnImpl) asserts a
 * spelling, which is the class of test this repository keeps having to undo.
 * Following the argument to the call site is inter-procedural analysis, and a
 * regex scanner that attempts it produces false positives -- and a gate that
 * cries wolf is a gate somebody disables.
 *
 * So the honest move is the one the harvester uses about its own mutation
 * sample: name the blind spot where the result is read, so nobody mistakes
 *  for . It means every site this scanner
 * RECOGNISED could be parsed -- not that it recognised every spawn. */
console.log('SPAWN-HYGIENE limit: sites are found by callee name, so a spawn reached through an injected function -- execImpl(...) and the like -- is NOT covered. An unscannable count of 0 means every RECOGNISED site parsed, not that every spawn was seen.');
console.log('SPAWN-HYGIENE passed: every scanned process launch is hidden/noninteractive or explicitly allowlisted.');

/* TEST-CAN-FAIL REPORT (testcanfail-tests-spawn-hygiene-test-js)
 * Suspect assertion: the final `assert.deepEqual(violations, [])` could pass
 * after an empty discovery result because the `for (const entry of files)`
 * body would never execute. Mutation in a detached scratch worktree:
 * `const runtimeRoots = new Set([])`. Before this change the test stayed green:
 * "SPAWN-HYGIENE scanned 0 runtime source files (0 PowerShell, 0 JavaScript);
 * checked 0 spawn-shaped sites."
 * "SPAWN-HYGIENE passed: every scanned process launch is hidden/noninteractive
 * or explicitly allowlisted."
 *
 * The four witness assertions above make that mutation RED. Observed output:
 * "AssertionError [ERR_ASSERTION]: spawn hygiene must discover runtime source files"
 *
 * Restored-source confirmation (the mutation lived only in the detached
 * scratch worktree, which was removed):
 * "SPAWN-HYGIENE scanned 920 runtime source files (95 PowerShell, 825
 * JavaScript); checked 248 spawn-shaped sites."
 * "SPAWN-HYGIENE passed: every scanned process launch is hidden/noninteractive
 * or explicitly allowlisted."
 *
 * Shape census:
 * (1) EMPTY-ITERATION: FOUND and fixed as described above.
 * (2) EXIT-STATUS/TRUTHY-RETURN-ONLY: NOT-FOUND.
 * (3) SWALLOWED FAILURE: NOT-FOUND; filesystem catches become explicit
 * findings, and `.at(-1)` mismatches throw rather than being optional.
 * (4) MOCK-OF-SUBJECT: NOT-FOUND.
 * (5) SKIP/PRECONDITION NO-OP: NOT-FOUND.
 * (6) EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND; fixture expectations are
 * independent literals and regular expressions.
 * Preconditions not met: NONE.
 */
