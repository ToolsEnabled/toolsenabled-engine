// EXECUTABLE CHANGE
//
// Discrimination audit (2026-08-26): the scan's aggregate `files.length > 50`
// precondition stayed GREEN when the `src` root was mutated to `src-missing`:
//   pipe-redirection: 16 checks passed
// That meant walk()'s swallowed readdir failure could silently remove an entire
// configured root while unrelated roots supplied enough files to pass the gate.
// After adding the per-root precondition below, the same mutation went RED:
//   AssertionError [ERR_ASSERTION]: scan root does not exist or is not a directory: src-missing
// The mutation was restored byte-for-byte (SHA-256 recorded before and after),
// and the final run was GREEN:
//   pipe-redirection: 17 checks passed
//
// Shape census: (1) NOT-FOUND after guarding the only corpus collection before
// its loops; fixed fixture/sample loops are statically non-empty. (2) NOT-FOUND:
// no exit-status or truthy process-return assertions. (3) FOUND and fixed: the
// catch in walk() hid a missing scan root. (4) NOT-FOUND: no subject mock.
// (5) FOUND and fixed: a missing configured root was a silent partial-file skip.
// (6) NOT-FOUND: expected values are independent literals/invariants, not values
// computed by the scanner. Preconditions not met: none.

'use strict';

// Phase 2b (R93, incident #6): a long-lived child process may never inherit an
// undrained pipe for stdout/stderr.
//
// Why this exists: the fleet supervisor was started twice with its stdout and
// stderr redirected to pipes that nobody read. An OS pipe buffer is finite
// (~64KB on Windows). Once it fills, the child BLOCKS FOREVER on its next
// write and then dies. Both times the supervisor wedged and went down, and
// both times it looked like a mysterious crash rather than a plumbing mistake.
//
// Every one of the three competing designs cited tests/terminal-suppression.js
// as "the pattern to copy" and then none of them applied it to the invariant
// that actually killed the supervisor. This is that scanner.
//
// The rule: if a spawn outlives its parent (detached: true) or is a service
// launch (--serve), stdout/stderr must go to 'ignore', 'inherit', or a real
// file descriptor -- never 'pipe'.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const scanRoots = ['src', 'sidecars', 'tools', 'bin', 'adapters'];
// No current source lives in the retired scripts/ root. A restored tree is
// automatically included, without making any existing source root optional.
if (fs.existsSync(path.join(root, 'scripts'))) scanRoots.push('scripts');
const excludeDirNames = new Set(['node_modules', 'tests', 'scratch', '.git']);
const scannableExt = new Set(['.js', '.mjs', '.cjs']);
const callNames = ['spawnSync', 'execFileSync', 'spawnImpl', 'execFile', 'spawn', 'fork'];
const callRe = new RegExp(`\\b(${callNames.slice().sort((a, b) => b.length - a.length).join('|')})\\s*\\(`, 'g');
const ALLOWLIST_MARKER = 'PIPE-ALLOWLIST';

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (excludeDirNames.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (scannableExt.has(path.extname(entry.name))) out.push(full);
  }
}

// Blank comments to spaces, preserving offsets and newlines.
//
// THIS MUST FOLLOW THE LANGUAGE, NOT JUST THE TWO CHARACTERS. The previous
// version recognised `//` and `/*` anywhere, with no idea that a string exists.
// An ordinary glob in a string -- `'stdio, or the tools/*.js CLIs.'`, real code
// at tools/agent-preflight.js:393 -- therefore opened block-comment mode and
// blanked every line until the next `*/`, 182 lines later. Measured across the
// roots this gate scans, that desync blanked 1490 lines of live code in 22
// files and hid a real spawn site at
// tools/launch-readiness/toolchain-independence-audit.selftest.mjs:59.
//
// That is the same failure as the spawn-hygiene maskCode bug: a scanner that
// silently deletes the code it is auditing reports green because it saw
// nothing, and "no violations" then means "no vision". Offsets are preserved
// exactly, because lineOf() and the PIPE-ALLOWLIST context slice both index the
// ORIGINAL source with positions taken from the masked copy.
//
// Where a construct is ambiguous the masker leaves the text ALONE. Failing to
// blank a comment costs a false positive, which is loud and gets fixed; blanking
// code costs a false negative, which is silent and is the bug above.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function stripComments(src) {
  const out = new Array(src.length);
  const blank = ch => (ch === '\n' ? '\n' : ' ');
  let i = 0;
  let lastSignificant = '';
  let lastWord = '';

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }

    if (ch === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = blank(src[i]); i++; }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }

    // Quoted strings. A comment introducer inside one is ordinary text.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ch; i++;
      while (i < src.length) {
        if (src[i] === '\\') {                       // JS escape: consume the pair
          out[i] = src[i];
          if (i + 1 < src.length) out[i + 1] = src[i + 1];
          i += 2;
          continue;
        }
        out[i] = src[i];
        if (src[i] === quote) { i++; break; }
        if (src[i] === '\n') { i++; break; }         // unterminated: do not run away
        i++;
      }
      lastSignificant = quote; lastWord = '';
      continue;
    }

    // Template literals may span lines and may contain anything.
    if (ch === '`') {
      out[i] = ch; i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out[i] = src[i];
          if (i + 1 < src.length) out[i + 1] = src[i + 1];
          i += 2;
          continue;
        }
        out[i] = src[i];
        if (src[i] === '`') { i++; break; }
        i++;
      }
      lastSignificant = '`'; lastWord = '';
      continue;
    }

    // A regex literal, distinguished from division by what precedes it. Its body
    // may hold quotes and escaped slashes that would otherwise desync the masker.
    if (ch === '/' && (!/[A-Za-z0-9_$)\]]/.test(lastSignificant) || REGEX_PRECEDING_KEYWORDS.has(lastWord))) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                        // not a regex after all
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        for (let k = start; k < j; k++) out[k] = src[k];
        i = j;
        lastSignificant = '/'; lastWord = '';
        continue;
      }
      // Ambiguous: leave it as ordinary code rather than guess.
    }

    out[i] = ch;
    if (!/\s/.test(ch)) {
      lastSignificant = ch;
      lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : '';
    }
    i++;
  }

  for (let k = 0; k < src.length; k++) if (out[k] === undefined) out[k] = blank(src[k]);
  return out.join('');
}

function matchBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0, i = openIdx;
  for (; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(openIdx, i);
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Does this options text put a pipe on stdout or stderr?
function usesUndrainedPipe(optionsText) {
  // stdio: 'pipe'  (all three streams piped)
  if (/stdio\s*:\s*['"]pipe['"]/.test(optionsText)) return true;
  // stdio: [..., 'pipe', ...] -- check slots 1 and 2 only; stdin piping is fine.
  const arrayMatch = /stdio\s*:\s*\[([^\]]*)\]/.exec(optionsText);
  if (arrayMatch) {
    const slots = arrayMatch[1].split(',').map(slot => slot.trim());
    for (const slotIndex of [1, 2]) {
      if (slots[slotIndex] && /^['"]pipe['"]$/.test(slots[slotIndex])) return true;
    }
  }
  return false;
}

// A spawn that outlives its parent, or launches a service.
function isLongLived(optionsText, callText) {
  if (/detached\s*:\s*true/.test(optionsText)) return true;
  if (/['"]--serve['"]/.test(callText)) return true;
  return false;
}

function scanSource(src, file) {
  const stripped = stripComments(src);
  const findings = [];
  callRe.lastIndex = 0;
  let match;
  while ((match = callRe.exec(stripped))) {
    const openIdx = stripped.indexOf('(', match.index);
    if (openIdx === -1) continue;
    const callText = matchBalanced(stripped, openIdx, '(', ')');

    // The options object is the last brace literal inside the call.
    const lastBrace = callText.lastIndexOf('{');
    const optionsText = lastBrace === -1 ? '' : matchBalanced(callText, lastBrace, '{', '}');
    if (!isLongLived(optionsText, callText)) continue;
    if (!usesUndrainedPipe(optionsText)) continue;

    const line = lineOf(stripped, match.index);
    // An explicit, justified exception must name itself on a nearby line.
    const contextStart = Math.max(0, match.index - 400);
    const context = src.slice(contextStart, match.index + callText.length);
    if (context.includes(ALLOWLIST_MARKER)) continue;

    findings.push({ file, line, call: match[1] });
  }
  return findings;
}

process.stdout.write('pipe-redirection\n');

// --- The masker is audited BEFORE anything it masks -------------------------
// Every check below this point is worth exactly as much as the masker's
// fidelity. A masker that eats code makes the whole gate report green for the
// one reason a gate must never report green: it could not see.

check('MASKER: a comment introducer inside a string is not a comment', () => {
  // The exact live construct that blanked 182 lines of tools/agent-preflight.js.
  const glob = "const help = 'stdio, or the tools/*.js CLIs.';\nspawn(node, [e], { detached: true, stdio: 'pipe' });\n";
  assert.ok(stripComments(glob).includes("tools/*.js"), 'a glob in a string must survive');
  assert.ok(stripComments(glob).includes("stdio: 'pipe'"), 'code after a string glob must survive');

  const url = "const u = 'https://example.com/x'; spawn(a, { detached: true });\n";
  assert.ok(stripComments(url).includes('spawn(a, { detached: true })'), 'code after a URL must survive');

  const tpl = 'const t = `pattern **/*.js`;\nspawn(node, { detached: true });\n';
  assert.ok(stripComments(tpl).includes('spawn(node, { detached: true })'), 'code after a template glob must survive');
});

check('MASKER: real comments are still removed', () => {
  assert.ok(!stripComments('// spawn(x, { detached: true })\nconst a = 1;\n').includes('spawn'),
    'a line comment must be blanked');
  assert.ok(!stripComments('/* spawn(x, { detached: true }) */\nconst a = 1;\n').includes('spawn'),
    'a block comment must be blanked');
  assert.ok(stripComments('spawn(x); // trailing\n').includes('spawn(x);'),
    'code before a trailing comment must survive');
});

check('MASKER: quotes, escapes and regex literals do not desync it', () => {
  const escaped = 'const p = "C:\\\\dir\\\\";\nspawn(node, { detached: true });\n';
  assert.ok(stripComments(escaped).includes('spawn(node, { detached: true })'),
    'a string ending in an escaped backslash must close');

  const re = "const re = /['\"]/g;\nspawn(node, { detached: true });\n";
  assert.ok(stripComments(re).includes('spawn(node, { detached: true })'),
    'a regex holding quote characters must not open a string');

  const slashy = 'const re = /a\\/*b/;\nspawn(node, { detached: true });\n';
  assert.ok(stripComments(slashy).includes('spawn(node, { detached: true })'),
    'a regex holding an escaped slash must not open a block comment');

  const apostrophe = "// it's fine\nspawn(node, { detached: true });\n";
  assert.ok(stripComments(apostrophe).includes('spawn(node, { detached: true })'),
    "an apostrophe in a comment must not open a string");

  const crlf = "const g = 'a/*b';\r\nspawn(node, { detached: true });\r\n";
  assert.ok(stripComments(crlf).includes('spawn(node, { detached: true })'),
    'CRLF input must behave the same');
});

check('MASKER: offsets are preserved exactly', () => {
  const samples = [
    "const g = 'tools/*.js'; spawn(a);\n",
    '/* block */ const a = 1;\n',
    'const re = /[\'"]/g; // note\n',
    'const t = `x ${ y } /* z */`;\n',
  ];
  for (const sample of samples) {
    assert.equal(stripComments(sample).length, sample.length,
      `masking changed the length of ${JSON.stringify(sample)}; lineOf() and the ` +
      'PIPE-ALLOWLIST context slice both index the ORIGINAL source with masked offsets');
  }
});

const files = [];
check('every configured scan root exists', () => {
  for (const dir of scanRoots) {
    const scanRoot = path.join(root, dir);
    assert.ok(fs.existsSync(scanRoot) && fs.statSync(scanRoot).isDirectory(),
      `scan root does not exist or is not a directory: ${dir}`);
  }
});

for (const dir of scanRoots) {
  walk(path.join(root, dir), files);
}

check('scan roots resolved to a real set of files', () => {
  assert.ok(files.length > 50, `suspiciously few files scanned (${files.length}); scanRoots may be broken`);
});

check('MASKER: masking destroys no code in the real corpus', () => {
  // The corpus-wide form of the bug: a desync blanks whole regions of live
  // files. A line that held code before masking and is empty after it, without
  // being a comment, is the signature. The broken masker scored 1490 here.
  const damaged = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const masked = stripComments(src);
    assert.equal(masked.length, src.length,
      `the masker DESYNCHRONISED on ${path.relative(root, file)}: it returned ${masked.length} ` +
      `characters for a ${src.length}-character file. Offsets no longer line up, so lineOf() ` +
      'reports the wrong line and the PIPE-ALLOWLIST context slice reads the wrong region of the\n' +
      'original source. A masker that loses its place stops seeing the code it is auditing, and\n' +
      'this gate then reports "no violations" when what it means is "no vision".');
    const before = src.split('\n');
    const after = masked.split('\n');
    let inBlock = false;
    for (let i = 0; i < before.length; i++) {
      const original = (before[i] || '').trim();
      const wasInBlock = inBlock;
      // Track block-comment runs so a continuation line inside a genuine
      // /* ... */ is not mistaken for code the masker lost.
      const opens = (original.match(/\/\*/g) || []).length;
      const closes = (original.match(/\*\//g) || []).length;
      if (!inBlock && opens > closes) inBlock = true;
      else if (inBlock && closes >= opens && closes > 0) inBlock = false;
      if (!original) continue;
      if (wasInBlock || original.startsWith('//') || original.startsWith('*') || original.startsWith('/*')) continue;
      if ((after[i] || '').trim() === '') {
        damaged.push(`    ${path.relative(root, file)}:${i + 1}  ${original.slice(0, 72)}`);
      }
    }
  }
  assert.equal(damaged.length, 0,
    'the masker BLANKED LIVE CODE. Every check in this file is blind over these lines,\n' +
    'and "no violations" then only means "no vision". Blanked code:\n' +
    damaged.slice(0, 20).join('\n'));
});

check('no long-lived spawn sends stdout/stderr to an undrained pipe', () => {
  const violations = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const finding of scanSource(src, path.relative(root, file))) {
      violations.push(`    ${finding.file}:${finding.line} (${finding.call})`);
    }
  }
  assert.equal(violations.length, 0,
    'a detached or --serve child with stdio "pipe" on stdout/stderr will WEDGE and DIE once the\n' +
    '~64KB OS pipe buffer fills and nobody drains it. This took the fleet supervisor down twice.\n' +
    `Use 'ignore', 'inherit', or a file descriptor. Violations:\n${violations.join('\n')}`);
});

check(`every detached spawn site is accounted for`, () => {
  // Positive control: the scanner must actually be finding detached sites,
  // otherwise "0 violations" is meaningless.
  let detachedSites = 0;
  for (const file of files) {
    const stripped = stripComments(fs.readFileSync(file, 'utf8'));
    detachedSites += [...stripped.matchAll(/detached\s*:\s*true/g)].length;
  }
  assert.ok(detachedSites >= 3,
    `expected the repo to contain detached spawn sites to check; found ${detachedSites}. ` +
    'If this dropped to zero the scan above proves nothing.');
  process.stdout.write(`      ${detachedSites} detached spawn sites present and clean\n`);
});

// --- Fixtures: the scanner must actually catch the bug ----------------------

function scanFixture(source) {
  return scanSource(source, 'fixture.js');
}

check('FIXTURE: detached spawn with stdio "pipe" is flagged', () => {
  const findings = scanFixture(
    "spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: 'pipe' });\n"
  );
  assert.equal(findings.length, 1, 'the exact incident #6 shape must be caught');
});

check('FIXTURE: detached spawn with array pipe on stderr is flagged', () => {
  const findings = scanFixture(
    "spawn(node, [entry], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });\n"
  );
  assert.equal(findings.length, 1, 'a pipe on stderr alone still wedges the child');
});

check('FIXTURE: --serve launch with stdio "pipe" is flagged', () => {
  const findings = scanFixture(
    "spawn(node, [entry, '--serve'], { stdio: 'pipe' });\n"
  );
  assert.equal(findings.length, 1, 'a service launch is long-lived even without detached:true');
});

check('FIXTURE: detached spawn with stdio "ignore" is clean', () => {
  const findings = scanFixture(
    "spawn(node, [entry], { detached: true, windowsHide: true, stdio: 'ignore' });\n"
  );
  assert.deepEqual(findings, []);
});

check('FIXTURE: detached spawn writing to file descriptors is clean', () => {
  const findings = scanFixture(
    "spawn(node, [entry], { detached: true, stdio: ['ignore', outFd, errFd] });\n"
  );
  assert.deepEqual(findings, []);
});

check('FIXTURE: a SHORT-lived piped spawn is not flagged', () => {
  // Draining a short command's output is normal and correct.
  const findings = scanFixture(
    "spawnSync('git', ['status'], { encoding: 'utf8', stdio: 'pipe' });\n"
  );
  assert.deepEqual(findings, [], 'only long-lived children are at risk');
});

check('FIXTURE: piping stdin only is not flagged', () => {
  const findings = scanFixture(
    "spawn(node, [entry], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });\n"
  );
  assert.deepEqual(findings, [], 'a piped stdin does not wedge the child');
});

check('FIXTURE: an explicit PIPE-ALLOWLIST exception is honoured', () => {
  const findings = scanFixture(
    "// PIPE-ALLOWLIST: parent drains both streams for the child's whole life.\n" +
    "spawn(node, [entry], { detached: true, stdio: 'pipe' });\n"
  );
  assert.deepEqual(findings, [], 'a justified, marked exception must be allowed');
});

process.stdout.write(`\npipe-redirection: ${passed} checks passed\n`);
