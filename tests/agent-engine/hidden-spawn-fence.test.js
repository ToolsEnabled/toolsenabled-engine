/* EXECUTABLE CHANGE
 *
 * CAN-FAIL AUDIT (2026-08-26)
 *
 * SUSPECT: the win32-only batch-resolution assertions were a silent no-op on
 * this Linux runner. Mutation: removed `'/v:off',` from the batch argv in
 * src/lib/proc/hidden-spawn.js. Before this change the test stayed green:
 *   hidden-spawn fence: 10 shipped agent-path files checked, 0 violations
 * The unconditional source assertion below now covers the platform precondition.
 * With the same mutation it went RED:
 *   AssertionError [ERR_ASSERTION]: batch resolution must use cmd.exe with the complete explicit, non-shell argv on every platform
 *   code: 'ERR_ASSERTION'
 *   operator: 'match'
 * The product file was restored byte-for-byte (SHA-256
 * 1c521a035a8422c3467606f15a6ce1f45ad2aeb4c8a87a1144bc8b4612423920),
 * after which the test was green again:
 *   hidden-spawn fence: 10 shipped agent-path files checked, 0 violations
 *
 * NOT-FOUND (1): sourceFiles() can be empty, but the independent files.length
 * lower-bound assertion fails before either file loop can pass vacuously;
 * SEAMS is a fixed, non-empty constant.
 * NOT-FOUND (2): no exit-status or truthy child-process-return assertion.
 * NOT-FOUND (3): no test-side try/catch or optional chain swallows a failure.
 * NOT-FOUND (4): no mock substitutes for spawnHidden or its resolver.
 * NOT-FOUND (5), after the fix: no platform guard can silently make the batch
 * contract a no-op; Linux checks its shipped source and Windows additionally
 * executes the resolution assertions. Unmet precondition: this runner is Linux,
 * so the Windows-only behavioral branch itself could not be executed here.
 * NOT-FOUND (6): no expected value is computed by the product code under test.
 */

'use strict';

/* NO CHILD PROCESS IN THE SHIPPED AGENT PATH MAY PUT A CONSOLE WINDOW ON THE
 * DESKTOP, and this test reads the source to say so rather than trusting that
 * every future call site remembers.
 *
 * WHY A SOURCE FENCE. STANDING-ORDERS.md class LOCAL-WORK rule 3 already said
 * "console windows must never flash", and the product still shipped a build
 * that popped a black console every time an agent session started. A rule that
 * lives only in a document, or in a code review, comes back. This is the same
 * shape as tests/credential-capture.js and tests/source-freeze.js: read the
 * bytes that ship, fail on the pattern, name the file.
 *
 * WHAT IT GUARDS, AND WHY THAT LIST. src/lib/agent-engine/ is what
 * shell/agent-host.cjs loads out of the capability payload to start a session,
 * and src/lib/proc/ is the seam it must go through. Those are the paths on the
 * press of "start an agent"; a spawn anywhere in them is one a person is
 * waiting on, watching the screen.
 *
 * THE THREE RULES, and the measurement behind each (2026-08-17, Electron main
 * with no console -- the installed app's condition -- child reporting its own
 * GetConsoleWindow):
 *
 *   1. Every launch goes through spawnHidden(). Measured: `stdio: 'inherit'`
 *      with no windowsHide is the combination that produces a VISIBLE console;
 *      the same with windowsHide produces a hidden one. One seam that always
 *      sets it is the only way that stays true.
 *   2. No `shell: true`. Measured: a shell does NOT by itself pop a window, so
 *      this rule is not about the window -- it is so the seam can state which
 *      executable it started, which is what rule 3 depends on.
 *   3. No direct require of node:child_process. This is the rule that actually
 *      holds the other two up: a file that can reach spawn() directly can
 *      reintroduce the defect while both greps above stay green.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads a pass as more than it is: a
 * GRANDCHILD's flags. The defect that started this was @openai/codex's own
 * launcher spawning codex.exe with inherited stdio and no windowsHide -- source
 * this repo does not own and this test cannot read. That is answered by
 * resolving the launcher away in hidden-spawn.js, and asserted below by name.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const GUARDED_DIRECTORIES = ['src/lib/agent-engine', 'src/lib/proc'];

/* THE ONLY MODULES ALLOWED TO REACH node:child_process, and each is CHECKED
 * rather than merely excused.
 *
 * hidden-spawn.js is the async seam: long-lived children, which is every agent
 * session. run.js is the pre-existing SYNCHRONOUS runner (runChecked), which
 * already spawned with windowsHide:true and shell:false and is used all over
 * this tree for short probes -- rewriting its callers to reach it through the
 * async seam would be a large change that fixes nothing, since it never had the
 * defect. Both are asserted below to keep the two properties; an entry here buys
 * an exemption from "go through a seam", never from "hide the window".
 *
 * If a third file needs child_process, that is a design change, and this list is
 * where it has to be argued rather than somewhere it can be slipped past. */
const SEAMS = Object.freeze([
  'src/lib/proc/hidden-spawn.js',
  'src/lib/proc/run.js',
]);
const SEAM = 'src/lib/proc/hidden-spawn.js';

function sourceFiles() {
  const out = [];
  for (const directory of GUARDED_DIRECTORIES) {
    const absolute = path.join(ROOT, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:c?js|mjs)$/.test(entry.name)) continue;
      const relative = `${directory}/${entry.name}`;
      out.push({ relative, absolute: path.join(absolute, entry.name), source: fs.readFileSync(path.join(absolute, entry.name), 'utf8') });
    }
  }
  return out;
}

/* Comments in this tree discuss `shell: true` and child_process at length --
   that is how the reasoning survives. Stripping comments before matching is
   what lets the rules be stated in prose right next to the code that obeys
   them, instead of the fence forcing the explanation out of the file. */
/* Blank out comments so the rules below match CODE, not the prose that explains
 * them -- the reasoning in this tree lives right next to the thing it describes,
 * and a fence that matched comment text would force the explanations out.
 *
 * THIS IS THE SECOND REWRITE, AND BOTH EARLIER ONES PRODUCED A FALSE GREEN.
 * A whole-file regex for block comments treats a `/` `*` that appears INSIDE a
 * line comment as opening a block, then eats everything up to the next close --
 * on src/lib/proc/run.js that swallowed the real require on line 70, and the
 * fence cheerfully reported zero violations over a file that plainly has one.
 * A whole-file line-comment regex anchored with a bare `^` failed the same way
 * for a different reason: no `m` flag, so it consumed the newline before each
 * comment and resumed inside it.
 *
 * So this walks LINE BY LINE and carries the block state across lines
 * explicitly. It can only ever delete text within a line it has classified, and
 * it can never run past a newline it did not intend to cross. A stripper that
 * eats code turns this entire test into a lie, which is worse than not having
 * it -- so the rule here is that it may under-strip, never over-strip. */
function withoutComments(source) {
  const lines = [];
  let inBlock = false;
  for (const original of source.split('\n')) {
    let text = original;
    if (inBlock) {
      const close = text.indexOf('*/');
      if (close === -1) { lines.push(''); continue; }
      text = text.slice(close + 2);
      inBlock = false;
    }
    /* LINE COMMENT FIRST, BLOCK SECOND, and the order is the whole bug.
       src/lib/proc/run.js line 18 is a line comment containing the glob
       `tests/agent-comms/*.js`. Looking for block comments first sees the slash
       and star in that path as a block OPENING, finds no close on the line, and
       blanks the next fifty lines -- including the require this fence exists to
       notice. Removing the line comment first deletes that text before it can be
       mistaken for anything.
       `//` only starts a comment when it is not part of a `://` in a URL or
       escaped; the same guard the app-side fence uses. */
    text = text.replace(/(^|[^:'"`\\])\/\/.*$/, '$1');
    for (let guard = 0; guard < 100; guard += 1) {
      const open = text.indexOf('/*');
      if (open === -1) break;
      const close = text.indexOf('*/', open + 2);
      if (close === -1) { text = text.slice(0, open); inBlock = true; break; }
      text = `${text.slice(0, open)} ${text.slice(close + 2)}`;
    }
    lines.push(text);
  }
  return lines.join('\n');
}

function run() {
  const files = sourceFiles();
  assert.ok(files.length >= 5, `expected the agent engine and proc seam to have source files; found ${files.length}`);

  const seamPresent = files.some(file => file.relative === SEAM);
  assert.ok(seamPresent, `${SEAM} is the only allowed spawn seam and it is missing`);

  const offenders = [];

  for (const file of files) {
    const code = withoutComments(file.source);

    // Rule 3: only a declared seam may reach node:child_process.
    if (/require\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]/.test(code)) {
      if (!SEAMS.includes(file.relative)) {
        offenders.push(`${file.relative}: requires node:child_process directly; use spawnHidden() from ${SEAM}`);
      }
    }

    // Rule 2: never hand a command to a shell.
    if (/\bshell\s*:\s*true\b/.test(code)) {
      offenders.push(`${file.relative}: passes shell: true`);
    }

    // Rule 1: never ask for a visible console, and never inherit stdio without
    // the flag that hides the console inheriting it creates.
    if (/\bwindowsHide\s*:\s*false\b/.test(code)) {
      offenders.push(`${file.relative}: passes windowsHide: false`);
    }
    if (/\bstdio\s*:\s*['"]inherit['"]/.test(code) && file.relative !== SEAM) {
      offenders.push(`${file.relative}: inherits stdio, which is the one combination measured to create a VISIBLE console`);
    }
  }

  assert.deepStrictEqual(offenders, [], `console-window fence violations:\n  ${offenders.join('\n  ')}`);

  /* The seam itself must keep the two properties every caller is relying on.
     Checked on the source, not by calling it, because the point is that a
     future edit cannot quietly make windowsHide conditional. */
  for (const declared of SEAMS) {
    const code = withoutComments(fs.readFileSync(path.join(ROOT, declared), 'utf8'));
    assert.ok(/windowsHide:\s*true/.test(code), `${declared} is a declared spawn seam and must set windowsHide: true`);
    assert.ok(/shell:\s*false/.test(code), `${declared} is a declared spawn seam and must set shell: false`);
  }

  const seam = fs.readFileSync(path.join(ROOT, SEAM), 'utf8');
  const seamCode = withoutComments(seam);
  assert.ok(
    /HIDDEN_SPAWN_SHELL_REFUSED/.test(seamCode),
    `${SEAM} must refuse a caller that asks for a shell rather than silently obeying`,
  );
  assert.ok(
    /HIDDEN_SPAWN_VISIBLE_REFUSED/.test(seamCode),
    `${SEAM} must refuse windowsHide: false rather than letting one call site opt out`,
  );

  /* The grandchild the flag could not reach. @openai/codex's launcher spawns
     the native binary with inherited stdio and no windowsHide; the only fix
     available to us is to not run the launcher. If this resolution is ever
     deleted the window comes straight back, silently, on a machine where the
     npm layout is present -- which is every machine that has Codex installed. */
  assert.ok(
    /NATIVE_LAUNCHER_SHIMS/.test(seamCode) && /codex\.exe/.test(seamCode),
    `${SEAM} must resolve the Codex npm launcher to its native executable; without it the launcher's own `
    + `stdio:'inherit' spawn allocates a visible console window per session start`,
  );

  // This source fence is unconditional because resolveHiddenInvocation's
  // behavioral batch branch can execute only on Windows. Without it, deleting
  // an argv safety flag remains green on every non-Windows release runner.
  assert.match(
    seamCode,
    /if\s*\(isBatchTarget\(command\)\)\s*{\s*return\s*{\s*command:\s*process\.env\.ComSpec\s*\|\|\s*['"]cmd\.exe['"],\s*args:\s*\[\s*['"]\/d['"],\s*['"]\/v:off['"],\s*['"]\/s['"],\s*['"]\/c['"],\s*['"]call['"],\s*command,\s*\.\.\.args\s*\],\s*env:\s*{},\s*resolved:\s*['"]batch['"],\s*}\s*;?\s*}/,
    'batch resolution must use cmd.exe with the complete explicit, non-shell argv on every platform',
  );

  const { resolveHiddenInvocation, spawnHidden } = require(path.join(ROOT, SEAM));

  // A shell is refused, not obeyed.
  assert.throws(
    () => spawnHidden('node', ['-e', ''], { shell: true }),
    error => error.code === 'HIDDEN_SPAWN_SHELL_REFUSED',
    'spawnHidden must refuse shell: true',
  );
  assert.throws(
    () => spawnHidden('node', ['-e', ''], { windowsHide: false }),
    error => error.code === 'HIDDEN_SPAWN_VISIBLE_REFUSED',
    'spawnHidden must refuse windowsHide: false',
  );

  // A post-scrub credential override is a narrow, named channel rather than a
  // generic environment escape hatch. Each refusal names its condition without
  // ever putting the supplied value in diagnostics.
  assert.throws(
    () => spawnHidden('node', ['-e', ''], { credentialEnvironment: null }),
    error => error.code === 'HIDDEN_SPAWN_CREDENTIAL_ENVIRONMENT_INVALID',
    'spawnHidden must refuse an unknown credentialEnvironment shape',
  );
  const unknownCredentialValue = 'synthetic-value-that-must-not-enter-an-error';
  assert.throws(
    () => spawnHidden('node', ['-e', ''], {
      credentialEnvironment: { NOT_A_RECOGNIZED_CREDENTIAL: unknownCredentialValue }
    }),
    error => (
      error.code === 'HIDDEN_SPAWN_CREDENTIAL_NAME_INVALID'
      && error.message.includes('NOT_A_RECOGNIZED_CREDENTIAL')
      && !error.message.includes(unknownCredentialValue)
    ),
    'spawnHidden must refuse an unrecognized post-scrub variable without printing its value',
  );
  assert.throws(
    () => spawnHidden('node', ['-e', ''], {
      credentialEnvironment: { ANTHROPIC_API_KEY: '' }
    }),
    error => error.code === 'HIDDEN_SPAWN_CREDENTIAL_VALUE_INVALID',
    'spawnHidden must refuse an empty caller-stated credential value',
  );

  // A batch target is resolved to cmd.exe with an explicit argv, never a shell.
  if (process.platform === 'win32') {
    const batch = resolveHiddenInvocation('C:\\tools\\thing.cmd', ['--flag']);
    assert.strictEqual(batch.resolved, 'batch');
    assert.match(batch.command, /cmd\.exe$/i);
    assert.deepStrictEqual(
      batch.args,
      ['/d', '/v:off', '/s', '/c', 'call', 'C:\\tools\\thing.cmd', '--flag'],
      'a .cmd target must be run through cmd.exe with an explicit argv',
    );
  }

  // A command that is neither a launcher shim nor a batch file is untouched.
  const plain = resolveHiddenInvocation('C:\\bin\\thing.exe', ['a', 'b']);
  assert.strictEqual(plain.resolved, null);
  assert.strictEqual(plain.command, 'C:\\bin\\thing.exe');
  assert.deepStrictEqual(plain.args, ['a', 'b']);

  console.log(`hidden-spawn fence: ${files.length} shipped agent-path files checked, 0 violations`);
}

run();
