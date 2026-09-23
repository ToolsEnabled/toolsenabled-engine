#!/usr/bin/env node
'use strict';

/* BUILD GATE: no child process may inherit the ambient environment.
 *
 * WHY THIS IS A GATE AND NOT FIVE MORE EDITS
 * ------------------------------------------
 * Spawning a child with the parent's environment hands it the owner's billing
 * credentials and any endpoint redirector. That is the R1186 outage shape: the
 * sweeps "billed a drained API account for hours while reporting logged in",
 * because callers resolved a provider executable and hand-rolled the spawn.
 *
 * By 2026-08-10 this class had been found and fixed SIX separate times --
 * claude-process.js, cli-provider-gateway.js, subscription-launch-env.js,
 * shell/agent-host.cjs, src/lib/agent-lane.js and
 * sidecars/native-agent/src/native-agent-launcher.js. Six point fixes is not a
 * defence; it is the same defect being rediscovered. A point fix is correct
 * where someone remembered and absent where they did not, and the absence is
 * invisible. This file makes the absence loud.
 *
 * WHAT IT CHECKS
 * --------------
 * Every child_process call (spawn/spawnSync/exec/execSync/execFile/
 * execFileSync/fork) reachable by static reading, and what its child's `env`
 * is built from:
 *
 *   INHERITS_AMBIENT  no `env` option at all. NOT SAFE: node falls back to the
 *                     full process.env. This exact fallback was the real leak
 *                     in shell/agent-host.cjs -- the option looked absent
 *                     rather than wrong, which is why it survived review.
 *   SPREADS_AMBIENT   `env: process.env` or `env: { ...process.env }`.
 *   SCRUBBED          built through a shared scrub helper (see SCRUB_HELPERS).
 *   CONSTRUCTED       an explicit object that never touches process.env.
 *   UNRESOLVED        the env is behind a variable this reader cannot follow.
 *
 * INHERITS_AMBIENT, SPREADS_AMBIENT and UNRESOLVED fail the build unless the
 * call site is in the reviewed allowlist, and every allowlist entry must carry
 * a reason -- an allowlist without reasons rots into a bypass, so a reasonless
 * entry is itself a failure.
 *
 * CASE-INSENSITIVITY IS PART OF THE CONTRACT
 * ------------------------------------------
 * Windows resolves environment names case-INSENSITIVELY; a plain JS object does
 * not. `delete env.ANTHROPIC_API_KEY` leaves `anthropic_api_key` for the child,
 * and measurement on 2026-08-10 showed 2 of 3 casings reaching a real child.
 * So a hand-rolled `delete env.X` / `env.X = undefined` is NOT accepted here as
 * a scrub, no matter how long the list is: only the shared helpers, which
 * compare lowercased on BOTH the removal and the detection half, count.
 *
 * WHAT IT CANNOT SEE -- read this before trusting a green run
 * ----------------------------------------------------------
 *  - A spawn behind a variable: `const fn = cond ? spawn : spawnSync; fn(...)`.
 *    Aliases through a direct `const { spawn: x }` are followed; a runtime
 *    choice is not.
 *  - A helper that spawns on a caller's behalf. The helper's own call site is
 *    checked, but if it takes an `env` from its caller this file cannot tell
 *    whose environment that was. Such helpers are listed by --list-indirect.
 *  - Non-JS spawns. PowerShell `Start-Process`, .cmd, and scheduled-task XML
 *    are out of scope entirely.
 *  - A scrub helper that is itself wrong. This gate proves a helper was CALLED,
 *    not that it works; tests/spawn-env-scrub-gate.test.js covers the latter
 *    against a real spawned child.
 *  - Environment reaching a child by a route other than the env block --
 *    argv, a config file on disk, an inherited handle.
 *
 * USAGE
 *   node tools/check-spawn-env-scrub.js              # gate: exit 1 on failure
 *   node tools/check-spawn-env-scrub.js --json       # machine-readable
 *   node tools/check-spawn-env-scrub.js --all        # include EXEMPT/SCRUBBED
 *   node tools/check-spawn-env-scrub.js --list-indirect
 *   node tools/check-spawn-env-scrub.js --root <dir> # check another tree
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/* The directories a spawn can hide in. tests/ is scanned but never gates:
 * a leaking test is worth reporting and is not worth blocking a release. */
/* `capability` is the app tree's (desktop-app) mirrored provider library --
 * 233 source files including its own copy of cli-provider-gateway.js. It is
 * listed here because the gate is meant to be run over BOTH trees with --root,
 * and a directory absent from one tree simply yields nothing there. */
const SCAN_DIRECTORIES = Object.freeze(['src', 'tools', 'shell', 'sidecars', 'adapters', 'bin', 'capability']);
const ADVISORY_DIRECTORIES = Object.freeze(['tests']);
const SKIP_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', '.shots', 'artifacts', 'captures']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const SPAWN_FUNCTIONS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

/* The ONLY accepted scrubs. Deliberately a short, named list: a second
 * vocabulary of hand-rolled delete lists is precisely how this class drifted to
 * six instances. If a helper does not fit a call site, that is a conversation,
 * not a local reimplementation. */
const SCRUB_HELPERS = Object.freeze([
  'safeLaunchEnvironment',        // scrub across every provider + refuse if one survived
  'subscriptionLaunchEnvironment', // the scrub half of the above
  'providerEnvironment',          // per-provider scrub (gateway-internal)
  'deleteEnvironmentNames',       // the gateway's delegation to the primitive
  'deleteEnvNames',               // src/lib/env-scrub.js -- THE removal primitive
  'scrubbedAmbientEnvironment',   // claude-process.js's scrubbed ambient default
  'sanitizedEnvironment',
  'safeChildEnvironment'
]);

/* ---------------------------------------------------------------------------
 * ROUND 2 (2026-08-11). THREE SHAPES THIS GATE COULD NOT SEE.
 *
 * The gate above proves a scrub helper was CALLED at a spawn site. An
 * adversarial review then found fifteen real defects that all sit in its blind
 * spot, because each one is correct at the spawn site and wrong somewhere else:
 *
 *  A. THE SCRUB IS UNDONE AFTER IT RUNS. claude-process.js removed every casing
 *     of ANTHROPIC_API_KEY and then re-set it from `process.env.ANTHROPIC_API_KEY`,
 *     which was the default value of the public wrapper's own parameter. The
 *     spawn site was textbook-correct; the environment it received was not.
 *
 *  B. AN EXACT-CASE DELETE LIST INSTEAD OF, OR AFTER, THE SHARED HELPER. Six
 *     call sites did this -- two of them AFTER calling the shared scrub, which
 *     reads as maximally careful and reopened the hole the scrub had closed.
 *     The old reader recorded these as `handRolledDeletes` and explicitly
 *     "never upgrades a verdict", so they were printed and ignored.
 *
 *  C. A DETECTOR THAT FAILS OPEN. Both tripwires answered "nothing is present"
 *     for a non-object environment -- and `spawn(cmd, args, { env: null })` is
 *     node's spelling of INHERIT EVERYTHING. The input that leaks the most got
 *     the most reassuring answer.
 *
 * Each is now a build failure with its own verdict, subject to the same
 * allowlist (a reviewed claim, with a reason) and baseline (recorded debt,
 * asserting nothing) as the spawn verdicts. Detection runs on the BLANKED text,
 * so a comment explaining an old `delete env.X` is not mistaken for the line.
 * ------------------------------------------------------------------------- */

/* Credential and endpoint-redirector names. Kept in sync with
 * BILLING_TRIPWIRE (subscription-launch-env.js) and the gateway's per-provider
 * lists; tests/spawn-env-scrub-gate.test.js fails if this drifts below the
 * tripwire, because a gate that guards fewer names than the tripwire trusts is
 * the same silent gap one level up. */
const CREDENTIAL_NAMES = Object.freeze([
  'XAI_API_KEY', 'GROK_API_KEY', 'GROK_API_BASE_URL',
  'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_BEDROCK_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'STRIPE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'
]);
const CREDENTIAL_NAME_SET = new Set(CREDENTIAL_NAMES.map(n => n.toLowerCase()));

/* The one module allowed to implement the case fold and the tombstone, and the
 * gate's own source (which necessarily names every credential it guards). */
const SCRUB_OWNER_FILES = new Set(['src/lib/env-scrub.js', 'tools/check-spawn-env-scrub.js']);

const VERDICTS = Object.freeze({
  INHERITS: 'INHERITS_AMBIENT',
  SPREADS: 'SPREADS_AMBIENT',
  SCRUBBED: 'SCRUBBED',
  CONSTRUCTED: 'CONSTRUCTED',
  UNRESOLVED: 'UNRESOLVED',
  EXEMPT: 'EXEMPT',
  HAND_ROLLED_DELETE: 'HAND_ROLLED_CREDENTIAL_DELETE',
  AMBIENT_READ: 'AMBIENT_CREDENTIAL_READ',
  FAIL_OPEN: 'FAIL_OPEN_ENV_DETECTOR'
});
const FAILING_VERDICTS = new Set([
  VERDICTS.INHERITS, VERDICTS.SPREADS, VERDICTS.UNRESOLVED,
  VERDICTS.HAND_ROLLED_DELETE, VERDICTS.AMBIENT_READ, VERDICTS.FAIL_OPEN
]);

/* ---------------------------------------------------------------------------
 * Blanking pass.
 *
 * Comments and literals are replaced with spaces, preserving every byte offset
 * so reported line:col stay true. This is what stops `/["']/` inside a regex
 * literal from being read as the start of a string and swallowing the rest of
 * the file -- a scanner that gets this wrong reports a confident all-clear on
 * the files it silently stopped reading.
 * ------------------------------------------------------------------------- */
function blankLiterals(source) {
  const out = source.split('');
  const blank = (start, end) => {
    for (let i = start; i < end && i < out.length; i += 1) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };
  let i = 0;
  let previousSignificant = '';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      let end = source.indexOf('*/', i + 2);
      end = end === -1 ? source.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) break;
        if (source[j] === '\n') break; // unterminated; do not run away
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      previousSignificant = 'literal';
      continue;
    }
    if (c === '`') {
      // Template literals may nest ${ ... } containing more code. Blank only
      // the literal chunks so a spawn inside an interpolation is still seen.
      let j = i + 1;
      let chunkStart = j;
      let depth = 0;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (depth === 0 && source[j] === '$' && source[j + 1] === '{') {
          blank(chunkStart, j);
          depth = 1; j += 2;
          let braces = 1;
          while (j < source.length && braces > 0) {
            if (source[j] === '{') braces += 1;
            else if (source[j] === '}') braces -= 1;
            j += 1;
          }
          depth = 0; chunkStart = j;
          continue;
        }
        if (source[j] === '`') break;
        j += 1;
      }
      blank(chunkStart, j);
      i = j + 1;
      previousSignificant = 'literal';
      continue;
    }
    if (c === '/') {
      // Regex literal vs division. A `/` begins a regex unless the previous
      // significant token could end an expression.
      const isRegex = previousSignificant !== 'value';
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        let terminated = false;
        while (j < source.length) {
          const d = source[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { terminated = true; break; }
          j += 1;
        }
        if (terminated) {
          blank(i + 1, j);
          i = j + 1;
          previousSignificant = 'value';
          continue;
        }
      }
      i += 1;
      previousSignificant = 'op';
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[A-Za-z0-9_$)\]]/.test(c)) previousSignificant = 'value';
    else previousSignificant = 'op';
    i += 1;
  }
  return out.join('');
}

function lineColumnFor(source, index) {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') { line += 1; lastBreak = i; }
  }
  return { line, column: index - lastBreak };
}

/* Match a bracket that opens at `open`, honouring nesting. Runs on the blanked
 * text, so brackets inside strings and comments cannot unbalance it. */
function matchBracket(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const closer = pairs[text[open]];
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArguments(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  if (text.slice(start).trim().length > 0) parts.push([start, text.length]);
  return parts;
}

/* ---------------------------------------------------------------------------
 * Which local names refer to child_process in this file.
 * Follows `const { spawn } = require('child_process')`, aliases
 * (`{ spawn: launch }`), namespace imports (`const cp = require(...)` then
 * `cp.spawn`), and the ESM equivalents.
 * ------------------------------------------------------------------------- */
function childProcessBindings(blanked, raw) {
  const direct = new Map();     // localName -> child_process function name
  const namespaces = new Set(); // localName used as ns.spawn(...)

  const moduleRe = /require\s*\(\s*\)|from\s+|require\s*\(/g;
  // Work from the RAW text for module names (they were blanked out), but use
  // the blanked text for structure.
  const requireRe = /(?:const|let|var)\s*(\{[^}]*\}|[A-Za-z0-9_$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(raw)) !== null) {
    if (!CHILD_PROCESS_MODULES.has(m[2])) continue;
    registerBinding(m[1]);
  }
  const importRe = /import\s+(\{[^}]*\}|[A-Za-z0-9_$*\s]+)\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(raw)) !== null) {
    if (!CHILD_PROCESS_MODULES.has(m[2])) continue;
    registerBinding(m[1].replace(/^\*\s+as\s+/, ''));
  }

  /* THE INJECTABLE-SPAWN IDIOM.
   *
   *     const spawnImpl = deps.spawnImpl || spawn;
   *     spawnImpl(command, args, { ... });
   *
   * This is how nine call sites in this repo spawn, including agent-lane.js and
   * agent-wake.js -- the exact chain the R1186 hunt was following. A reader that
   * only recognises a literal `spawn(` call sees NONE of them and reports a
   * confident all-clear over the most dangerous spawns in the tree.
   *
   * The default operand is what runs in production; the injected one is a test
   * double. So binding the alias to the default is the right reading, and the
   * env passed at the call site is checked either way. */
  const aliasRe = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[^;\n]*?(?:\|\||\?\?)\s*([A-Za-z0-9_$]+)\s*;/g;
  let alias;
  while ((alias = aliasRe.exec(raw)) !== null) {
    const [, local, fallback] = alias;
    if (direct.has(fallback)) direct.set(local, direct.get(fallback));
  }
  // `this.spawnImpl = options.spawnImpl || spawn;` then `this.spawnImpl(...)`.
  const memberAliasRe = /this\s*\.\s*([A-Za-z0-9_$]+)\s*=\s*[^;\n]*?(?:\|\||\?\?)\s*([A-Za-z0-9_$]+)\s*;/g;
  const memberAliases = new Map();
  while ((alias = memberAliasRe.exec(raw)) !== null) {
    const [, member, fallback] = alias;
    if (direct.has(fallback)) memberAliases.set(`this.${member}`, direct.get(fallback));
  }

  function registerBinding(clause) {
    const text = clause.trim();
    if (text.startsWith('{')) {
      for (const piece of text.slice(1, -1).split(',')) {
        const [importedRaw, localRaw] = piece.split(':');
        const imported = (importedRaw || '').trim();
        const local = (localRaw || importedRaw || '').trim();
        if (!imported || !local) continue;
        if (SPAWN_FUNCTIONS.has(imported)) direct.set(local, imported);
      }
      return;
    }
    if (/^[A-Za-z0-9_$]+$/.test(text)) namespaces.add(text);
  }
  void moduleRe; void blanked;
  return { direct, namespaces, memberAliases };
}

function classifyEnvironmentExpression(expression) {
  const text = expression.trim();
  if (text.length === 0) return { verdict: VERDICTS.UNRESOLVED, detail: 'empty env expression' };

  // Remove every scrub-helper CALL (with its balanced arguments) before looking
  // for process.env, so `{ ...safeLaunchEnvironment(process.env), X: 1 }` reads
  // as scrubbed while `{ ...safeLaunchEnvironment(a), ...process.env }` does not.
  let residue = text;
  let usedHelper = null;
  for (const helper of SCRUB_HELPERS) {
    const re = new RegExp(`\\b${helper}\\s*\\(`, 'g');
    let match;
    while ((match = re.exec(residue)) !== null) {
      const open = residue.indexOf('(', match.index);
      const close = matchBracket(residue, open);
      if (close === -1) break;
      usedHelper = usedHelper || helper;
      residue = residue.slice(0, match.index) + ' '.repeat(close - match.index + 1) + residue.slice(close + 1);
      re.lastIndex = 0;
    }
  }
  const mentionsAmbient = /\bprocess\s*\.\s*env\b/.test(residue);
  if (mentionsAmbient) {
    return {
      verdict: VERDICTS.SPREADS,
      detail: usedHelper
        ? `process.env reaches the child alongside ${usedHelper}()`
        : 'process.env is forwarded to the child'
    };
  }
  if (usedHelper) return { verdict: VERDICTS.SCRUBBED, detail: `scrubbed through ${usedHelper}()` };
  if (/^\{[\s\S]*\}$/.test(text)) {
    if (/\.\.\./.test(text)) return { verdict: VERDICTS.UNRESOLVED, detail: 'object spreads a value this reader cannot follow' };
    return { verdict: VERDICTS.CONSTRUCTED, detail: 'explicit object literal, never touches process.env' };
  }
  return { verdict: VERDICTS.UNRESOLVED, detail: `env comes from \`${text.slice(0, 60)}\`` };
}

/* One hop of local resolution: `const env = <expr>` in the same file. Deeper
 * dataflow is deliberately NOT attempted -- a reader that guesses is worse than
 * one that says UNRESOLVED, because a wrong SCRUBBED is a certified leak. */
function resolveLocalIdentifier(name, blanked) {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) return null;
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`, 'g');
  const match = re.exec(blanked);
  if (!match) return null;
  const start = match.index + match[0].length;
  let end = start;
  let depth = 0;
  /* Do NOT stop at a newline. A multi-line ternary is the normal shape here --
   *     const childEnv = invocation.command === process.execPath
   *       ? { ...env, ELECTRON_RUN_AS_NODE: '1' }
   *       : env;
   * -- and a newline-terminated reader captures only the CONDITION, then
   * classifies the site on an expression that was never the env at all. The
   * length cap keeps a semicolon-less file from running away. */
  const LIMIT = 4000;
  while (end < blanked.length && end - start < LIMIT) {
    const c = blanked[end];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth -= 1; }
    else if ((c === ';' || c === ',') && depth === 0) break;
    end += 1;
  }
  return blanked.slice(start, end).trim();
}

/* A later `delete env.X` / `env.X = undefined` is a hand-rolled scrub. It is
 * reported so the case-sensitivity defect it usually carries is visible, but it
 * never upgrades a verdict. */
function handRolledScrubNames(identifier, blanked) {
  if (!/^[A-Za-z0-9_$]+$/.test(identifier)) return [];
  const names = new Set();
  const deleteRe = new RegExp(`delete\\s+${identifier}\\s*\\.\\s*([A-Za-z0-9_$]+)`, 'g');
  let m;
  while ((m = deleteRe.exec(blanked)) !== null) names.add(m[1]);
  const bracketRe = new RegExp(`delete\\s+${identifier}\\s*\\[`, 'g');
  while ((m = bracketRe.exec(blanked)) !== null) names.add('<computed>');
  return [...names];
}

/* ---------------------------------------------------------------------------
 * Shapes B, A and C from the note above, in that order.
 *
 * All three read the BLANKED text, where comments and string bodies are spaces.
 * That matters more than it sounds: the fix for each of these defects added a
 * comment quoting the old broken line, and a raw-text scanner reports the
 * comment as the defect -- measured while writing this, on this repo's own
 * files. A gate that fires on its own changelog gets switched off.
 * ------------------------------------------------------------------------- */
function scanCredentialHandling(raw, blanked, relativePath) {
  const file = relativePath.replace(/\\/g, '/');
  if (SCRUB_OWNER_FILES.has(file)) return [];
  const findings = [];
  const add = (index, verdict, name, detail) => {
    const { line, column } = lineColumnFor(raw, index);
    findings.push({
      file, line, column,
      symbol: verdict, calledAs: verdict, command: name,
      env: '(n/a)', verdict, detail, handRolledDeletes: []
    });
  };

  /* B. `delete X.CRED`, `delete X['CRED']`, and the list form
   *    `for (const n of ['CRED', ...]) delete env[n]`. All three are
   *    case-SENSITIVE removals of a case-INSENSITIVE thing. */
  const dotDelete = /delete\s+([A-Za-z0-9_$.]+)\s*\.\s*([A-Za-z0-9_$]+)/g;
  let m;
  while ((m = dotDelete.exec(blanked)) !== null) {
    if (!CREDENTIAL_NAME_SET.has(m[2].toLowerCase())) continue;
    add(m.index, VERDICTS.HAND_ROLLED_DELETE, m[2],
      `\`delete ${m[1]}.${m[2]}\` removes ONE casing. Windows resolves environment names case-insensitively, so \`${m[2].toLowerCase()}\` survives and the child reads it. Use deleteEnvNames() from src/lib/env-scrub.js.`);
  }
  /* The list form. Find `delete <ident>[<ident>]` and attribute it to the
   * credential names the enclosing `for` iterates -- which is how every one of
   * the six real instances was written.
   *
   * THE LIST IS NOT ALWAYS INLINE. The first version of this rule read only
   * quoted names out of the for-header, so it caught
   * `for (const n of ['GEMINI_API_KEY', ...]) delete env[n]` and missed
   * `for (const name of STRIPPED_ENV) delete env[name]` -- the shape in
   * fleet-supervisor/evidence.js, one of the six. Found by mutation: the fixed
   * file was reverted to its defective form and the gate stayed GREEN. A named
   * constant is not a safer list, it is the same list one hop away. */
  const computedDelete = /delete\s+([A-Za-z0-9_$]+)\s*\[\s*([A-Za-z0-9_$]+)\s*\]/g;
  while ((m = computedDelete.exec(blanked)) !== null) {
    const window = raw.slice(Math.max(0, m.index - 800), m.index);
    const lastFor = window.lastIndexOf('for ');
    if (lastFor === -1) continue;
    const header = window.slice(lastFor);
    const names = [...header.matchAll(/['"]([A-Za-z0-9_$]+)['"]/g)].map(x => x[1]);
    // Resolve `of SOME_CONSTANT` to the array literal it is declared from.
    for (const ref of header.matchAll(/\bof\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g)) {
      const declaration = new RegExp(`(?:const|let|var)\\s+${ref[1]}\\s*=\\s*(?:Object\\.freeze\\s*\\()?\\s*\\[([\\s\\S]{0,2000}?)\\]`).exec(raw);
      if (declaration) names.push(...[...declaration[1].matchAll(/['"]([A-Za-z0-9_$]+)['"]/g)].map(x => x[1]));
    }
    const hit = names.find(n => CREDENTIAL_NAME_SET.has(n.toLowerCase()));
    if (!hit) continue;
    add(m.index, VERDICTS.HAND_ROLLED_DELETE, hit,
      `a \`for (... of ...) delete ${m[1]}[${m[2]}]\` list containing ${hit} is an exact-case removal, however long the list is and wherever it is declared. Pass the list to deleteEnvNames() instead.`);
  }

  /* A. Reading a credential back out of ambient state. This is the shape that
   *    let a scrub be undone by its own caller: the removal was correct and a
   *    default parameter one function up put the value back. Any
   *    `process.env.CRED` read is refused, because a value that came from the
   *    ambient environment is exactly the value the scrub exists to drop. A
   *    caller that must supply a credential has to be GIVEN one. */
  const ambientDot = /process\s*\.\s*env\s*\.\s*([A-Za-z0-9_$]+)/g;
  while ((m = ambientDot.exec(blanked)) !== null) {
    if (!CREDENTIAL_NAME_SET.has(m[1].toLowerCase())) continue;
    add(m.index, VERDICTS.AMBIENT_READ, m[1],
      `reads ${m[1]} out of the ambient environment. Every scrub in this tree exists to stop that value reaching a child; re-reading it here is how the scrub gets undone by its own caller.`);
  }
  // Bracket form: process.env['ANTHROPIC_API_KEY'] -- the name is in a string
  // literal, so this one has to read RAW text.
  const ambientBracket = /process\s*\.\s*env\s*\[\s*['"]([A-Za-z0-9_$]+)['"]\s*\]/g;
  while ((m = ambientBracket.exec(raw)) !== null) {
    if (!CREDENTIAL_NAME_SET.has(m[1].toLowerCase())) continue;
    add(m.index, VERDICTS.AMBIENT_READ, m[1], `reads ${m[1]} out of the ambient environment.`);
  }

  /* C. A detector that answers "clean" for an environment it cannot inspect.
   *    `if (!env || typeof env !== 'object') return false;` reads as defensive
   *    and is the opposite: node treats a null env as "inherit everything", so
   *    the one input that leaks most gets the most reassuring answer.
   *
   * SCOPED TO ENVIRONMENT-SHAPED NAMES ON PURPOSE. The first draft flagged
   * every `typeof x !== 'object' -> return false` in the tree: 28 hits, of
   * which 28 were ordinary record/payload validators (`usage`, `event`,
   * `args`). A rule that cries wolf 28 times to catch the two that matter
   * teaches everyone to pass --no-verify, so it fires only where the guarded
   * value is an environment. */
  const failOpen = /typeof\s+([A-Za-z0-9_$]*(?:env|environment|Env|Environment)[A-Za-z0-9_$]*)\s*!==\s*['"]?object['"]?\s*\)\s*return\s+(false|\[\s*\]|0|null)\s*;/g;
  while ((m = failOpen.exec(raw)) !== null) {
    add(m.index, VERDICTS.FAIL_OPEN, m[1],
      `returns \`${m[2]}\` -- "nothing is present" -- for a non-object \`${m[1]}\`. node reads a null/absent env as INHERIT EVERYTHING, so this certifies the environment that leaks most. Throw, or resolve to process.env, as src/lib/env-scrub.js does.`);
  }
  return findings;
}

function scanFile(absolutePath, relativePath) {
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const blanked = blankLiterals(raw);

  /* Credential handling is checked in EVERY file, not only the ones that spawn.
   * The six exact-case scrubs this round fixed live in files that build an
   * environment and hand it to someone else to spawn -- gating only on
   * "does this file call child_process" is precisely how they stayed invisible
   * while the spawn sites themselves all looked correct. */
  const findings = scanCredentialHandling(raw, blanked, relativePath);

  const { direct, namespaces, memberAliases } = childProcessBindings(blanked, raw);
  if (direct.size === 0 && namespaces.size === 0 && memberAliases.size === 0) return findings;

  /* Two passes, because there are two ways to reach child_process and a reader
   * that knows only the first reports a confident all-clear over the second.
   *
   * Pass 1: a name bound at the top of the file -- `spawn(...)`, an alias, a
   * namespace `cp.spawn(...)`, or the injectable `deps.spawnImpl || spawn`.
   *
   * Pass 2: the require INLINE at the call site --
   *     require('node:child_process').spawn('claude', [...], { cwd });
   * This form binds nothing, so pass 1 cannot see it. It was found by planting
   * a new unscrubbed spawn in a file whose import is a NAMESPACE
   * (`const childProcess = require('node:child_process')`): the gate stayed
   * green on a spawn that hands a Claude CLI the full ambient environment.
   * A gate with a one-line bypass is worse than no gate, because the green is
   * what stops anyone looking. */
  const sites = [];
  const callRe = /([A-Za-z0-9_$]+)\s*(?:\.\s*([A-Za-z0-9_$]+)\s*)?\(/g;
  let match;
  while ((match = callRe.exec(blanked)) !== null) {
    const [, first, second] = match;
    let symbol = null;
    if (second && namespaces.has(first) && SPAWN_FUNCTIONS.has(second)) symbol = `${first}.${second}`;
    else if (second && memberAliases.has(`${first}.${second}`)) symbol = `${first}.${second}`;
    else if (!second && direct.has(first)) symbol = first;
    if (!symbol) continue;
    const canonical = memberAliases.has(symbol)
      ? memberAliases.get(symbol)
      : (second ? second : direct.get(first));
    sites.push({ index: match.index, symbol, canonical, open: blanked.indexOf('(', match.index) });
  }

  // Module names live in string literals, which the blanking pass erased, so
  // this pass reads RAW text. Offsets are preserved byte-for-byte by design,
  // so the index found here indexes the blanked text correctly too.
  const inlineRe = /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)\s*\.\s*([A-Za-z0-9_$]+)\s*\(/g;
  let inline;
  while ((inline = inlineRe.exec(raw)) !== null) {
    const fn = inline[1];
    if (!SPAWN_FUNCTIONS.has(fn)) continue;
    sites.push({
      index: inline.index,
      symbol: `require('child_process').${fn}`,
      canonical: fn,
      open: inline.index + inline[0].length - 1
    });
  }

  sites.sort((a, b) => a.index - b.index);

  for (const site of sites) {
    const { symbol, canonical } = site;
    const open = site.open;
    const close = matchBracket(blanked, open);
    if (close === -1) continue;
    const argumentText = blanked.slice(open + 1, close);
    const rawArgumentText = raw.slice(open + 1, close);
    const spans = splitTopLevelArguments(argumentText);
    const argumentsRaw = spans.map(([s, e]) => rawArgumentText.slice(s, e).trim());
    const argumentsBlanked = spans.map(([s, e]) => argumentText.slice(s, e).trim());

    const { line, column } = lineColumnFor(raw, site.index);
    const commandExpression = (argumentsRaw[0] || '').replace(/\s+/g, ' ').slice(0, 120);

    // The options object is the last argument that looks like an object literal
    // or a bare identifier. exec/execSync take (cmd, options); spawn takes
    // (cmd, args, options).
    let optionsIndex = -1;
    for (let k = argumentsBlanked.length - 1; k >= 1; k -= 1) {
      const candidate = argumentsBlanked[k];
      if (candidate.startsWith('{') || /^[A-Za-z0-9_$]+$/.test(candidate)) { optionsIndex = k; break; }
      if (candidate.startsWith('(') || candidate.includes('=>')) continue; // callback
    }

    let envExpression = null;
    let optionsIdentifier = null;
    if (optionsIndex !== -1) {
      const optionsBlanked = argumentsBlanked[optionsIndex];
      const optionsRawText = argumentsRaw[optionsIndex];
      if (optionsBlanked.startsWith('{')) {
        /* Property SHORTHAND (`{ cwd, env, shell: false }`) is not a curiosity:
         * the very launcher this gate was written for passes its env that way,
         * and an `env\s*:` -only reader called it INHERITS_AMBIENT -- i.e. it
         * misread a fixed site as broken, and would just as happily misread a
         * broken site as fixed. Resolve the shorthand to its local binding. */
        const shorthandMatch = /(^|[{,\s])env\s*(?=[,}])/.exec(optionsBlanked);
        const envMatch = /(^|[{,\s])env\s*:/.exec(optionsBlanked);
        if (!envMatch && shorthandMatch) {
          envExpression = 'env';
        } else if (envMatch) {
          const valueStart = optionsBlanked.indexOf(':', envMatch.index + envMatch[0].length - 4) + 1;
          let end = valueStart;
          let depth = 0;
          while (end < optionsBlanked.length) {
            const c = optionsBlanked[end];
            if (c === '(' || c === '{' || c === '[') depth += 1;
            else if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth -= 1; }
            else if (c === ',' && depth === 0) break;
            end += 1;
          }
          envExpression = optionsRawText.slice(valueStart, end).trim();
        } else if (/\.\.\./.test(optionsBlanked)) {
          envExpression = null;
          optionsIdentifier = '<spread options>';
        }
      } else {
        optionsIdentifier = optionsBlanked;
        const resolved = resolveLocalIdentifier(optionsBlanked, blanked);
        if (resolved && /env\s*:/.test(resolved)) {
          const envMatch = /env\s*:\s*/.exec(resolved);
          envExpression = resolved.slice(envMatch.index + envMatch[0].length).split(/,(?![^([{]*[)\]}])/)[0].trim();
        }
      }
    }

    let classification;
    if (envExpression === null && optionsIdentifier === '<spread options>') {
      classification = { verdict: VERDICTS.UNRESOLVED, detail: 'options object is spread from a value this reader cannot follow' };
    } else if (envExpression === null && optionsIdentifier) {
      classification = { verdict: VERDICTS.UNRESOLVED, detail: `options come from \`${optionsIdentifier}\`; no env could be resolved` };
    } else if (envExpression === null) {
      classification = {
        verdict: VERDICTS.INHERITS,
        detail: 'no env option: node falls back to the FULL process.env'
      };
    } else {
      classification = classifyEnvironmentExpression(envExpression);
      // Follow one hop if the env is a bare identifier.
      if (classification.verdict === VERDICTS.UNRESOLVED && /^[A-Za-z0-9_$]+$/.test(envExpression)) {
        const resolved = resolveLocalIdentifier(envExpression, blanked);
        if (resolved) {
          const followed = classifyEnvironmentExpression(resolved);
          classification = { ...followed, detail: `${followed.detail} (via local \`${envExpression}\`)` };
        }
      }
    }

    const handRolled = envExpression && /^[A-Za-z0-9_$]+$/.test(envExpression)
      ? handRolledScrubNames(envExpression, blanked)
      : [];

    findings.push({
      file: relativePath.replace(/\\/g, '/'),
      line,
      column,
      symbol: canonical,
      calledAs: symbol,
      command: commandExpression,
      env: envExpression === null ? '(omitted)' : envExpression.replace(/\s+/g, ' ').slice(0, 160),
      verdict: classification.verdict,
      detail: classification.detail,
      handRolledDeletes: handRolled
    });
  }
  return findings;
}

function walk(root, directory, accumulator, problems, optionalDirectory = false) {
  const absolute = path.join(root, directory);
  let entries;
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
  catch (error) {
    // The supported roots do not all contain every optional scan directory,
    // but any other failure means the tree was only partly measured.
    if (optionalDirectory && error && error.code === 'ENOENT') return;
    problems.push(`cannot read scan directory ${absolute}: ${error.message}`);
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(root, relative, accumulator, problems); continue; }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    accumulator.push(relative);
  }
}

function loadAllowlist(root) {
  const file = path.join(root, 'tools', 'spawn-env-scrub-allowlist.json');
  if (!fs.existsSync(file)) return { file, entries: [], problems: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { file, entries: [], problems: [`allowlist is not valid JSON: ${error.message}`] }; }
  const problems = [];
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  entries.forEach((entry, index) => {
    // A reasonless entry is a bypass wearing an allowlist's clothes. Refuse it.
    if (!entry || typeof entry.file !== 'string' || !entry.file) problems.push(`entry ${index} has no file`);
    if (!entry || typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(`entry ${index} (${entry && entry.file}) has no usable reason; an allowlist without reasons rots into a bypass`);
    }
    if (!entry || typeof entry.reviewedBy !== 'string' || !entry.reviewedBy) {
      problems.push(`entry ${index} (${entry && entry.file}) records no reviewer`);
    }
  });
  return { file, entries, problems };
}

/* ---------------------------------------------------------------------------
 * The baseline is RECORDED DEBT, and it is NOT an allowlist.
 *
 * This class was already 129 call sites deep when the gate was written. A gate
 * that only passes once all 129 are fixed would be switched off within a day,
 * and 129 hand-written "reasons" produced in one sitting would be fiction --
 * which is the rot the allowlist rules exist to prevent. So the two are kept
 * strictly apart:
 *
 *   allowlist  a human looked at this call site and judged it safe. Carries a
 *              reason and a reviewer. Small, and every entry is a claim.
 *   baseline   nobody has looked at this yet. Carries no reason and asserts
 *              nothing about safety. It exists only so that a NEW unscrubbed
 *              spawn is distinguishable from the existing pile.
 *
 * The ratchet: counts may fall freely, and `--update-baseline` will only ever
 * write a smaller number. Raising one requires --allow-new-debt, so adding
 * debt is a deliberate, reviewable line in a diff rather than a silent rerun.
 * ------------------------------------------------------------------------- */
const BASELINE_RELATIVE = path.join('tools', 'spawn-env-scrub-baseline.json');

function baselineKey(finding) {
  return [finding.file, finding.symbol, finding.verdict, finding.command].join('|');
}

function loadBaseline(root) {
  const file = path.join(root, BASELINE_RELATIVE);
  if (!fs.existsSync(file)) return { file, debt: {}, missing: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, debt: parsed && parsed.debt ? parsed.debt : {}, missing: false };
  } catch (error) {
    return { file, debt: {}, missing: false, error: error.message };
  }
}

function writeBaseline(file, debt, allowNewDebt, previous) {
  const keys = Object.keys(debt).sort();
  if (!allowNewDebt) {
    for (const key of keys) {
      if (debt[key] > (previous[key] || 0)) {
        throw new Error(
          `refusing to raise recorded debt for ${key} (${previous[key] || 0} -> ${debt[key]}). ` +
          'A new unscrubbed spawn should be fixed, not recorded. Pass --allow-new-debt if it truly must land.'
        );
      }
    }
  }
  const ordered = {};
  for (const key of keys) ordered[key] = debt[key];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    note: 'RECORDED DEBT, NOT AN ALLOWLIST. No entry here asserts that a call site is safe; it records that the site predates the gate. Counts may only fall. See tools/check-spawn-env-scrub.js.',
    generatedAt: new Date().toISOString(),
    debt: ordered
  }, null, 2)}\n`, 'utf8');
}

function allowlistMatch(entries, finding) {
  return entries.find(entry => {
    if (entry.file !== finding.file) return false;
    if (entry.symbol && entry.symbol !== finding.symbol) return false;
    if (entry.command && !finding.command.includes(entry.command)) return false;
    return true;
  }) || null;
}

function main(argv) {
  const asJson = argv.includes('--json');
  const showAll = argv.includes('--all');
  const listIndirect = argv.includes('--list-indirect');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex !== -1 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : REPO_ROOT;

  const scanProblems = [];
  const gatedFiles = [];
  for (const directory of SCAN_DIRECTORIES) walk(root, directory, gatedFiles, scanProblems, true);
  const advisoryFiles = [];
  for (const directory of ADVISORY_DIRECTORIES) walk(root, directory, advisoryFiles, scanProblems, true);
  if (gatedFiles.length === 0) {
    scanProblems.push(`scan found zero gated source files beneath ${root}`);
  }

  const collect = files => {
    const found = [];
    for (const relative of files) {
      try { found.push(...scanFile(path.join(root, relative), relative)); }
      catch (error) { scanProblems.push(`cannot scan ${relative.replace(/\\/g, '/')}: ${error.message}`); }
    }
    return found;
  };

  const gated = collect(gatedFiles);
  const advisory = collect(advisoryFiles);
  const { file: allowlistFile, entries: allowlist, problems: allowlistProblems } = loadAllowlist(root);

  const usedEntries = new Set();
  for (const finding of gated) {
    if (!FAILING_VERDICTS.has(finding.verdict)) continue;
    const entry = allowlistMatch(allowlist, finding);
    if (entry) {
      finding.verdict = VERDICTS.EXEMPT;
      finding.detail = entry.reason;
      usedEntries.add(entry);
    }
  }

  const unscrubbed = gated.filter(f => FAILING_VERDICTS.has(f.verdict));
  const staleEntries = allowlist.filter(entry => !usedEntries.has(entry));

  // Group the remaining unscrubbed sites and compare against recorded debt.
  const baseline = loadBaseline(root);
  const observed = {};
  const byKey = new Map();
  for (const finding of unscrubbed) {
    const key = baselineKey(finding);
    observed[key] = (observed[key] || 0) + 1;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(finding);
  }

  if (argv.includes('--update-baseline')) {
    if (scanProblems.length > 0) {
      for (const problem of scanProblems) console.error(`SCAN INCOMPLETE: ${problem}`);
      return 1;
    }
    // Genesis is the one write that may record debt: there is no prior file to
    // ratchet against, and the whole point is to photograph the existing pile
    // so that anything after it is visibly new. Every LATER write may only
    // lower a count unless --allow-new-debt is passed on purpose.
    const genesis = baseline.missing;
    try {
      writeBaseline(baseline.file, observed, genesis || argv.includes('--allow-new-debt'), baseline.debt);
    } catch (error) {
      console.error(String(error.message));
      return 1;
    }
    const total = Object.values(observed).reduce((a, b) => a + b, 0);
    console.log(`${genesis ? 'baseline created' : 'baseline updated'}: ${Object.keys(observed).length} key(s), ${total} unscrubbed call site(s) recorded as debt.`);
    if (genesis) console.log('  These are RECORDED, not reviewed. None of them has been judged safe by anyone.');
    console.log(`  ${baseline.file}`);
    return 0;
  }

  // A NEW unscrubbed spawn is one that pushes a key above its recorded count,
  // or introduces a key the baseline never had. Both are named by file:line.
  const failures = [];
  const paidDown = [];
  for (const [key, findings] of byKey) {
    const allowed = baseline.debt[key] || 0;
    if (findings.length > allowed) failures.push(...findings.slice(allowed));
  }
  for (const key of Object.keys(baseline.debt)) {
    const now = observed[key] || 0;
    if (now < baseline.debt[key]) paidDown.push({ key, was: baseline.debt[key], now });
  }

  if (listIndirect) {
    console.log('Call sites whose env this reader could not resolve (indirection points):');
    for (const f of gated.filter(f => f.verdict === VERDICTS.UNRESOLVED || f.verdict === VERDICTS.EXEMPT)) {
      console.log(`  ${f.file}:${f.line}  ${f.symbol}(${f.command})  ${f.detail}`);
    }
    if (scanProblems.length > 0) {
      for (const problem of scanProblems) console.error(`SCAN INCOMPLETE: ${problem}`);
      return 1;
    }
    return 0;
  }

  const summary = {};
  for (const f of gated) summary[f.verdict] = (summary[f.verdict] || 0) + 1;

  if (asJson) {
    console.log(JSON.stringify({ root, summary, failures, advisory, staleEntries, allowlistProblems, findings: showAll ? gated : failures }, null, 2));
  } else {
    console.log('# Spawn environment scrub gate');
    console.log(`# root: ${root}`);
    console.log(`# scanned: ${gatedFiles.length} gated files, ${advisoryFiles.length} advisory files`);
    console.log('');
    const rows = showAll ? gated : failures;
    if (rows.length > 0) {
      for (const f of rows) {
        console.log(`${f.verdict === VERDICTS.EXEMPT || !FAILING_VERDICTS.has(f.verdict) ? 'ok  ' : 'FAIL'} ${f.file}:${f.line}:${f.column}`);
        console.log(`       ${f.symbol}(${f.command || '...'})`);
        console.log(`       env: ${f.env}`);
        console.log(`       ${f.verdict} -- ${f.detail}`);
        if (f.handRolledDeletes.length > 0) {
          console.log(`       hand-rolled deletes (case-SENSITIVE, do not count as a scrub): ${f.handRolledDeletes.join(', ')}`);
        }
        console.log('');
      }
    }
    console.log('## summary');
    for (const [verdict, count] of Object.entries(summary).sort()) console.log(`  ${verdict}: ${count}`);
    const advisoryFails = advisory.filter(f => FAILING_VERDICTS.has(f.verdict));
    console.log(`  tests/ (advisory only, never gates): ${advisoryFails.length} unscrubbed`);
    console.log(`  recorded as pre-existing debt (NOT reviewed as safe): ${unscrubbed.length - failures.length}`);
    console.log(`  NEW since the baseline: ${failures.length}`);
    console.log('');
  }

  let exitCode = 0;
  if (scanProblems.length > 0) {
    for (const problem of scanProblems) console.error(`SCAN INCOMPLETE: ${problem}`);
    exitCode = 1;
  }
  if (allowlistProblems.length > 0) {
    console.error('ALLOWLIST REJECTED:');
    for (const problem of allowlistProblems) console.error(`  - ${problem}`);
    console.error(`  (${allowlistFile})`);
    exitCode = 1;
  }
  if (staleEntries.length > 0) {
    console.error('STALE ALLOWLIST ENTRIES -- the call site they excused no longer exists; delete them:');
    for (const entry of staleEntries) console.error(`  - ${entry.file} ${entry.symbol || ''} ${entry.command || ''}`);
    exitCode = 1;
  }
  if (baseline.missing) {
    console.error(`NO BASELINE: ${baseline.file} does not exist, so every unscrubbed call site counts as new.`);
    console.error('Create it once with --update-baseline, then review it.');
    exitCode = 1;
  }
  if (baseline.error) {
    console.error(`BASELINE UNREADABLE: ${baseline.error}`);
    exitCode = 1;
  }
  if (paidDown.length > 0) {
    // Ratchet. If debt was paid and the baseline still claims it, the slack is
    // silently available for the next unscrubbed spawn to hide in.
    console.error('BASELINE IS STALE -- these were fixed but are still recorded as debt. Re-run with --update-baseline:');
    for (const item of paidDown) console.error(`  - ${item.key}  (${item.was} -> ${item.now})`);
    exitCode = 1;
  }
  if (failures.length > 0) {
    console.error(`SPAWN ENVIRONMENT GATE FAILED: ${failures.length} NEW call site(s) hand a child an environment that was never scrubbed.`);
    for (const f of failures) console.error(`  - ${f.file}:${f.line}:${f.column} ${f.symbol}(${f.command || '...'}) -- ${f.verdict}: ${f.detail}`);
    console.error('');
    console.error('Fix by building the child env with safeLaunchEnvironment() from');
    console.error('src/lib/providers/subscription-launch-env.js. Do NOT hand-roll a delete list:');
    console.error('Windows env names are case-insensitive and a plain object is not, so');
    console.error('`delete env.ANTHROPIC_API_KEY` leaves `anthropic_api_key` for the child.');
    console.error('If a call site is genuinely exempt, add it to tools/spawn-env-scrub-allowlist.json');
    console.error('with a reason and a reviewer.');
    exitCode = 1;
  }
  if (exitCode === 0) {
    // Say exactly what passed. "All clear" over 129 recorded-but-unreviewed
    // call sites is the kind of green that stops people looking -- and an
    // unearned green is how this class survived six fixes.
    const debt = unscrubbed.length;
    // --json means stdout is a machine's input. A human sentence appended to it
    // is not a cosmetic problem: it makes JSON.parse throw, so any caller that
    // consumes this gate programmatically breaks on the SUCCESS path only.
    const say = asJson ? console.error : console.log;
    say(`OK: no NEW unscrubbed spawn. ${debt} pre-existing call site(s) remain as recorded debt and are NOT certified safe.`);
    if (debt > 0) say('    Pay it down with safeLaunchEnvironment(), then re-run --update-baseline; the count can only fall.');
  }
  return exitCode;
}

// Let redirected stdout drain. An immediate exit can truncate the JSON report
// while still returning status 0 to the caller consuming it through a pipe.
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  blankLiterals, classifyEnvironmentExpression, scanFile, scanCredentialHandling, main,
  VERDICTS, SCRUB_HELPERS, CREDENTIAL_NAMES
};
