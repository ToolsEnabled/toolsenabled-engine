// NOTHING FOUND
//
// Test-can-fail report (testcanfail-tests-provider-name-presentation-test-js):
//
// * EMPTY ITERATION — NOT-FOUND.  The only assertion-bearing loop iterates a
//   seven-element local literal.  The customer-surface loop is preceded by an
//   independent `SURFACE.length > 500` assertion, so it cannot pass vacuously.
// * EXIT STATUS / TRUTHY RETURN — NOT-FOUND.  This file neither spawns a
//   process nor treats a non-zero status or an unqualified truthy return as
//   evidence.
// * SWALLOWED FAILURE — NOT-FOUND.  The sole catch ignores only EISDIR, after
//   `customerSurface` has selected regular files; every other read error is
//   rethrown.  There is no optional chaining.
// * SUBJECT MOCK — NOT-FOUND.  The scanner, manifest loader, and filesystem
//   reads used by the rule are real.  The planted strings are input fixtures,
//   not mocks of the scanner.
// * SKIP / PLATFORM GUARD — NOT-FOUND.  There is no skip or platform
//   precondition in this file.
// * SELF-COMPUTED EXPECTATION — NOT-FOUND.  Scanner expectations are literal
//   counts/line numbers, exemption expectations are literal lists, and surface
//   expectations are a literal required-file list plus an independent floor.
//
// Mutation observation: in a scratch copy, README.md was given the shipped
// line `Temporary Claude Code mutation.` and the test exited 1.  The relevant
// RED output was:
//
//   AssertionError [ERR_ASSERTION]: TE-L-0006: 1 user-visible occurrence(s)
//   of the provider's product name:
//
// Precondition not met: the requested restored-tree GREEN confirmation is not
// available in this checkout.  The unmodified test also exits 1 because the
// current open surface already contains a forbidden occurrence at
// src/lib/mission-bridge/actions.js:1130.  Its RED output begins:
//
//   AssertionError [ERR_ASSERTION]: TE-L-0006: 1 user-visible occurrence(s)
//   of the provider's product name:
//   src/lib/mission-bridge/actions.js:1130
//
// No assertion was deleted, weakened, or changed.  No product file in this
// checkout was edited; the mutation was confined to /tmp/provider-name-mutation.

'use strict';

// THE PROVIDER'S PRODUCT NAME MAY NOT APPEAR ON OUR USER-VISIBLE SURFACE.
//
// THE RULE, and it is not this file's to decide. legal/docket.md TE-L-0006 and
// legal/positions/PROVIDER-SUBSCRIPTION-AGENTS.md: strip every "Claude Code"
// NAME and every piece of visual mimicry; the product may not PRESENT AS Claude
// Code. The sanctioned forms are "Powered by Claude" and "Claude Agent". Both
// operative phrases -- "present as", "visual mimicry" -- are PRESENTATION tests,
// which is exactly why this guard scans presentation and nothing else.
//
// WHY A GUARD AND NOT JUST A CLEANUP. The cleanup that preceded this file
// touched fourteen strings across nine files. Every one of them was written by
// somebody being helpful and accurate about which program the reader had to
// open. That instinct does not go away when the strings do, so the name comes
// back one honest sentence at a time -- and nobody notices, because each
// individual sentence looks reasonable in review. A cleanup without a guard is
// a cleanup with an expiry date.
//
// ---------------------------------------------------------------------------
// WHAT "USER-VISIBLE CUSTOMER SURFACE" MEANS HERE
//
// The unit is config/payload-boundary.json's `open` set: customer-distributable,
// open-licensed source. It is read directly from the manifest. The classification
// does not authorize a public repository or public-source export. Files
// classified paid, excluded or pending are not scanned: they do not ship, so
// they cannot present as anything.
//
// The open set is read from the manifest rather than from `git ls-files`, on
// purpose. A file classified open but not yet committed can still enter a
// customer distribution; catching it now costs nothing, and it keeps this
// guard runnable in a checkout without git.
//
// ---------------------------------------------------------------------------
// THE FOUR EXEMPTIONS, AND WHY EACH ONE EXISTS
//
// READ THIS BEFORE YOU "FIX" ONE. Every exemption below covers text that was
// examined and DELIBERATELY KEPT. Removing an exemption does not tighten the
// rule; it breaks a working product or contradicts a legal instruction.
//
//   1. IDENTIFIERS -- `claudeCode.*` editor settings keys, and JS identifiers
//      with ClaudeCode inside them (hasClaudeCodeOauthToken and friends).
//      These are ANTHROPIC'S OWN INTERFACE NAMES, and our code must spell them
//      exactly or it stops working. src/lib/providers/workstation.js writes
//      `claudeCode.initialPermissionMode` into an editor's settings file: a
//      renamed key is a key the editor ignores. Related and worth knowing:
//      the CLAUDE_CODE_* environment variable names never reach this guard at
//      all, because the underscore in CLAUDE_CODE means /claude\s*code/i does
//      not match them -- \s does not match `_`. That is luck rather than
//      design, so it is written down here: if the pattern is ever loosened to
//      /claude[\s_-]*code/i, this exemption has to grow to cover those names,
//      and src/lib/agent-engine/claude-process.js is the reason. Its
//      credential fence works by scrubbing exactly those variables by name. It
//      cannot scrub what it cannot name.
//
//   2. COMMENTS -- a comment is not a presentation. A source comment stating a
//      fact about the third-party program the user already installed is
//      addressed to the next maintainer, never to a customer, and TE-L-0006 is
//      a test of what the product PRESENTS. Fifty-one of the occurrences the
//      original survey found were comments, and most of them carry hard-won
//      operational facts (which program gives ANTHROPIC_API_KEY precedence,
//      where a transcript lands on disk). Laundering those into "the CLI"
//      would cost real accuracy and buy no compliance.
//
//   3. THE TWO LEGAL DOCUMENTS -- PRIVACY-POLICY.md and TERMS-OF-SERVICE.md.
//      These use the name to IDENTIFY the CLI the reader already has installed,
//      which is disclosure accuracy: a privacy policy that will not say which
//      program it is describing has failed at the one job a privacy policy has.
//      Legal was asked to confirm and the instruction was to leave them exactly
//      as they are.
//
//   4. tests/ -- INCLUDING tests/agent-engine/claude-subscription-credential-
//      fence.test.js, which legal named specifically: its rationale text has to
//      say which product's subscription credentials the fence exists to keep
//      out, and legal told us to preserve that wording. The wider rule is the
//      same one that makes this guard coherent at all -- a test file presents
//      nothing to a user. Its fixtures, its assertion messages and its test
//      names are read by developers. This exemption is also what lets THIS file
//      quote the forbidden string in its own fixtures without indicting itself.
//
// ---------------------------------------------------------------------------
// KNOWN LIMIT OF THE SCANNER, stated rather than hidden: it decides "is this a
// comment?" with a per-line walk that tracks quotes and block-comment state,
// not with a parser. A JS regex literal containing a quote character, or a
// PowerShell here-string, can confuse the quote tracking on that one line. The
// failure mode is always the same direction -- the scanner may treat a live
// string as a comment and stay quiet -- so a green run is weaker evidence than
// a red one. That is the right way round for a guard whose false positives
// would get it deleted, but it means a reviewer still has to read new copy.
//
// Run: node tests/provider-name-presentation.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BOUNDARY_MANIFEST = path.join(ROOT, 'config', 'payload-boundary.json');

function loadOpenSet() {
  const manifest = JSON.parse(fs.readFileSync(BOUNDARY_MANIFEST, 'utf8'));
  const open = manifest.open || {};
  return {
    paths: new Set(Array.isArray(open.paths) ? open.paths : Object.keys(open.paths || {})),
    prefixes: Array.isArray(open.prefixes) ? open.prefixes : []
  };
}

// The pattern the app lane already uses at
// C:\lanes\research-app\tools\test\account-panel-copy.test.mjs:106, kept
// character-for-character so the two guards are read as one rule rather than
// two similar ones. `\s*` and not `\s+`: "ClaudeCode" jammed together is the
// same name, and the identifier exemption below is what keeps that from
// indicting real code.
const FORBIDDEN = /claude\s*code/gi;

const EXEMPT_FILES = new Set([
  'PRIVACY-POLICY.md',      // exemption 3
  'TERMS-OF-SERVICE.md'     // exemption 3
]);

const EXEMPT_PREFIXES = [
  'tests/'                  // exemption 4
];

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

/* ---- the scanner ----------------------------------------------------------- */

function languageOf(file) {
  if (/\.(js|cjs|mjs|jsx|ts|tsx)$/i.test(file)) return 'js';
  if (/\.(ps1|psm1|psd1)$/i.test(file)) return 'ps';
  return 'data'; // .md, .json, .txt: no comment syntax, so every match is copy
}

/**
 * Mark which characters of one line are inside a comment.
 *
 * `state.inBlock` is the only thing carried between lines. Quote state is
 * deliberately NOT carried: a JS template literal or a PowerShell here-string
 * spanning lines would otherwise poison every line after it, and an
 * over-eager quote tracker silences the guard far more thoroughly than an
 * under-eager one.
 */
function commentMask(line, kind, state) {
  const mask = new Array(line.length).fill(false);
  if (kind === 'data') return mask;

  const blockOpen = kind === 'ps' ? '<#' : '/*';
  const blockClose = kind === 'ps' ? '#>' : '*/';
  const lineOpen = kind === 'ps' ? '#' : '//';

  let quote = null;
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      mask[i] = true;
      if (line.startsWith(blockClose, i)) {
        mask[i + 1] = true;
        state.inBlock = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    const ch = line[i];
    if (quote) {
      // JS escapes with a backslash; PowerShell escapes with a backtick.
      if ((kind === 'js' && ch === '\\') || (kind === 'ps' && ch === '`')) { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || (kind === 'js' && ch === '`')) { quote = ch; i += 1; continue; }
    if (line.startsWith(blockOpen, i)) {
      state.inBlock = true;
      mask[i] = true;
      mask[i + 1] = true;
      i += 2;
      continue;
    }
    if (line.startsWith(lineOpen, i)) {
      for (let j = i; j < line.length; j += 1) mask[j] = true;
      break;
    }
    i += 1;
  }
  return mask;
}

/**
 * Exemption 1. An identifier, not prose.
 *
 * TWO conditions, and both are load-bearing. First, the match carries no
 * whitespace -- prose writes "Claude Code" with a space between the words and
 * code writes claudeCode without one, which is the cleanest discriminator
 * available and needs no list of known keys. Second, the match is welded to a
 * larger token: an identifier character on either side, or a dot FOLLOWED BY
 * one, which is the `claudeCode.someKey` settings-key shape.
 *
 * The dot rule is written that narrowly for a specific reason. Accepting a
 * bare trailing dot would exempt a marketing sentence ending "...Powered by
 * ClaudeCode." -- a real presentation of the name, waved through because a
 * full stop and a property access look identical one character at a time.
 * Neither condition is sufficient alone: without the whitespace test, "not
 * just Claude Code." would be exempt; without the token test, any spaceless
 * spelling of the name would be.
 */
function isIdentifierForm(line, index, text) {
  if (/\s/.test(text)) return false;
  const IDENT = /[A-Za-z0-9_$]/;
  const before = line[index - 1] || '';
  const after = line[index + text.length] || '';
  if (IDENT.test(before)) return true;
  if (IDENT.test(after)) return true;
  if (before === '.' && IDENT.test(line[index - 2] || '')) return true;
  return after === '.' && IDENT.test(line[index + text.length + 1] || '');
}

function scanText(file, text) {
  const findings = [];
  const kind = languageOf(file);
  const state = { inBlock: false };
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n].replace(/\r$/, '');
    const mask = commentMask(line, kind, state);
    FORBIDDEN.lastIndex = 0;
    let match;
    while ((match = FORBIDDEN.exec(line)) !== null) {
      if (mask[match.index]) continue;                              // exemption 2
      if (isIdentifierForm(line, match.index, match[0])) continue;  // exemption 1
      findings.push({ file, line: n + 1, text: line.trim().slice(0, 160) });
    }
  }
  return findings;
}

function customerSurface() {
  const allowlist = loadOpenSet();
  const prefixes = allowlist.prefixes || [];
  const files = [...allowlist.paths];
  for (const prefix of prefixes) {
    // The manifest carries no prefixes today. If one is ever added, refusing to
    // walk it is better than pretending the surface was scanned.
    assert.fail(`config/payload-boundary.json grew an open prefix (${prefix}); this guard only understands explicit paths.`);
  }
  return files
    .filter(file => !EXEMPT_FILES.has(file))                                  // exemption 3
    .filter(file => !EXEMPT_PREFIXES.some(prefix => file.startsWith(prefix))) // exemption 4
    .filter(file => fs.existsSync(path.join(ROOT, file)))
    .filter(file => fs.statSync(path.join(ROOT, file)).isFile());
}

/* ---- 1. the guard itself works ---------------------------------------------
   A drift guard that passes because its scanner is broken is worse than no
   guard: it is a green check standing where a person used to look. These run
   first, against planted text, so a silent scanner is caught before the real
   scan reports all-clear. ------------------------------------------------- */

check('a planted name is caught in prose, config text and a shipped string', () => {
  assert.equal(scanText('README.md', 'Install Claude Code to begin.').length, 1);
  assert.equal(scanText('registry.json', '{"description": "Works with Claude Code."}').length, 1);
  assert.equal(scanText('src/x.js', "const hint = 'Install Claude Code first.';").length, 1);
  assert.equal(scanText('tools/x.ps1', "Write-Host 'Open Claude Code now'").length, 1);
  // The spaceless spelling is the same name and must not be a way around it.
  assert.equal(scanText('README.md', 'Powered by ClaudeCode.').length, 1);
});

check('a comment is not caught, in every comment form the tree actually uses', () => {
  assert.equal(scanText('src/x.js', '// Claude Code gives ANTHROPIC_API_KEY precedence.').length, 0);
  assert.equal(scanText('src/x.js', '/* Claude Code writes a BOM on stdin. */').length, 0);
  assert.equal(scanText('src/x.js', ['/**', ' * Claude Code names it this.', ' */'].join('\n')).length, 0);
  assert.equal(scanText('tools/x.ps1', '# Step 6: copy the Claude Code state dirs').length, 0);
  assert.equal(scanText('tools/x.ps1', ['<#', '  Runs without a live Claude Code session.', '#>'].join('\n')).length, 0);
});

check('a block comment closes, so code after it is scanned again', () => {
  // The failure this catches: an unterminated-looking block that swallows the
  // rest of the file would turn this guard into a no-op for that file.
  const source = ['/* Claude Code note */', "const hint = 'Install Claude Code.';"].join('\n');
  const found = scanText('src/x.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

check('the interface names our code must spell exactly are exempt', () => {
  assert.equal(scanText('src/x.js', 'delete env.CLAUDECODE;').length, 0);
  assert.equal(scanText('src/x.js', "settings['claudeCode.initialPermissionMode'] = 'bypassPermissions';").length, 0);
  assert.equal(scanText('src/x.js', "hasClaudeCodeOauthToken: Object.hasOwn(process.env, 'CLAUDE_CODE_OAUTH_TOKEN'),").length, 0);
  // ...and the exemption must not stretch to cover prose that merely ends in a
  // full stop, which is what a naive adjacency test would do.
  assert.equal(scanText('README.md', 'not just Claude Code.').length, 1);
});

check('the exemptions are the four that were argued, and no fifth crept in', () => {
  // A new entry here is a change to a legal position's enforcement. It belongs
  // in the docket first and in this list second.
  assert.deepEqual([...EXEMPT_FILES].sort(), ['PRIVACY-POLICY.md', 'TERMS-OF-SERVICE.md']);
  assert.deepEqual(EXEMPT_PREFIXES, ['tests/']);
});

/* ---- 2. the surface is really being scanned --------------------------------
   The quiet way this guard dies is not a bug in the scanner. It is somebody
   reclassifying a file out of `open`, at which point the scan still passes and
   scans less. ------------------------------------------------------------ */

const SURFACE = customerSurface();

check('the scan covers the files that actually carry product copy', () => {
  const required = [
    'README.md',
    'registry.json',
    'config/settings-registry.json',
    'src/lib/tool-registry.js',
    'src/lib/providers/cli-provider-gateway.js',
    'src/lib/setup/provider-auth.js',
    'src/lib/usage/adapters/claude-cached-utilization.js'
  ];
  for (const file of required) {
    assert.ok(SURFACE.includes(file), `${file} left the scanned surface; either it stopped shipping or this guard stopped covering it`);
  }
  // A floor, not a count: an exact number is a number somebody re-pins without
  // thinking. A surface that collapsed by an order of magnitude is a mistake.
  assert.ok(SURFACE.length > 500, `only ${SURFACE.length} customer-distributable files were scanned; the open set looks truncated`);
});

/* ---- 3. the rule ----------------------------------------------------------- */

check('no customer-distributable, user-visible file presents the provider\'s product name', () => {
  const findings = [];
  for (const file of SURFACE) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch (error) {
      if (error.code === 'EISDIR') continue;
      throw error;
    }
    findings.push(...scanText(file, text));
  }
  if (findings.length) {
    const report = findings.map(f => `    ${f.file}:${f.line}  ${f.text}`).join('\n');
    assert.fail(
      `TE-L-0006: ${findings.length} user-visible occurrence(s) of the provider's product name:\n${report}\n`
      + '\n  The product may not present as Claude Code. Say "Powered by Claude" or'
      + '\n  "Claude Agent" when describing what THIS product does. When the string tells'
      + '\n  somebody to install or open the third-party program, name it accurately --'
      + '\n  "the Claude CLI (`claude`)" -- and keep the command intact. If you believe an'
      + '\n  occurrence is legitimately exempt, argue it in legal/docket.md TE-L-0006'
      + '\n  before adding it to the exemptions at the top of this file.'
    );
  }
});

process.stdout.write(`provider-name-presentation: ${checks} checks passed (${SURFACE.length} customer-distributable files scanned)\n`);
