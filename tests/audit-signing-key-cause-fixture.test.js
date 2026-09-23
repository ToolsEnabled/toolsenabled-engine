'use strict';
/* THE SAME GATE AS audit-signing-key-cause.test.js, BUT AGAINST A REAL BROKEN VAULT.
 *
 * The sibling suite injects accessors that throw. This one does not inject a
 * failure at all: it reproduces a REAL, deterministic vault failure and checks
 * that the reason the vault layer actually raised is still reachable from the
 * refusal audit.js throws.
 *
 * THE FIXTURE, measured 2026-09-16. Run the product with PSModulePath pointing
 * at the PowerShell 7 Modules directory ONLY. Windows PowerShell 5.1 -- which
 * is what tools/secrets.ps1 runs under -- can then no longer autoload
 * Microsoft.PowerShell.Security, so the vault script fails, deterministically,
 * on every call. With PSModulePath pointing at the 5.1 system module directory
 * instead, the same run succeeds. That is a whole failing environment, not a
 * stub: the same shape produced the AUDIT_UNAVAILABLE entries in the 1.0.45
 * cut of that date.
 *
 * WHAT IS ASSERTED, and what is deliberately NOT. The expected reason is not
 * written down here -- it is DISCOVERED at run time by wrapping the real
 * accessor, capturing the real error it throws under the real broken
 * environment, and then requiring THAT text to be reachable from what audit.js
 * surfaced. So this suite cannot be satisfied by any particular wording, and a
 * better implementation than today's, or a vault layer that later says
 * something more useful, keeps it green. Reachable means message or cause
 * chain; either route counts.
 *
 * SECRETS: no secret value is printed, hashed or described. The child prints
 * error MESSAGES and a key NAME only, and it never prints the accessor's
 * return value -- a successful get returns the key material itself, which is
 * why the success path below discards it and skips rather than reporting on
 * it.
 *
 * REFUSALS: this suite skips out loud, never silently, and it skips through
 * t.skip(reason) rather than a bare return. That distinction is not cosmetic:
 * a console.log plus a return produces the SAME TAP summary as a real pass --
 * "ok" and "skipped 0" -- so a fully skipped run would be indistinguishable
 * from a passing one, which defeats the only thing this fixture exists to
 * give. Seven skip sites across the two cases name their own condition: not
 * Windows, no PowerShell 7 module directory, an override set to a missing
 * directory, the fixture failing to reproduce, or the vault script failing
 * without writing to its diagnostic stream.
 *
 *   node --test tests/audit-signing-key-cause-fixture.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

// Discovered, never hardcoded: any installed PowerShell 7 package with a
// Modules directory will do, whatever its version or install root.
function powershell7ModulesDirectory() {
  const override = process.env.TOOLSENABLED_TEST_PS7_MODULES;
  if (override) {
    // An override that is SET and missing is a mistake worth hearing about.
    // Falling back to a scan here would measure a different environment than
    // the one that was asked for and report it as the one that was asked for --
    // and it would make the skip path unreachable from the override, which is
    // exactly what it was added for.
    if (fs.existsSync(override)) return { directory: override, reason: null };
    return { directory: null,
      reason: 'TOOLSENABLED_TEST_PS7_MODULES is set but no such directory exists on this host, so the broken PSModulePath was not built and nothing was measured.' };
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map(root => path.join(root, 'WindowsApps'));
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      if (!/^Microsoft\.PowerShell_\d+\./.test(entry)) continue;
      const modules = path.join(root, entry, 'Modules');
      if (fs.existsSync(modules) && fs.existsSync(path.join(root, entry, 'pwsh.exe'))) {
        return { directory: modules, reason: null };
      }
    }
  }
  return { directory: null,
    reason: 'no installed PowerShell 7 package with both pwsh.exe and a Modules directory was found under ProgramFiles\\WindowsApps, so the broken PSModulePath cannot be built. Set TOOLSENABLED_TEST_PS7_MODULES to point at one.' };
}

// The child runs in its own process because the fixture IS an environment: the
// broken PSModulePath has to be in place before the vault script is spawned.
const CHILD = `
'use strict';
// Same isolation the measured suite uses, activated BEFORE anything is loaded:
// it gives this child its own empty workspace, so the signing key is absent and
// the CREATE path -- the bare catch the 1.0.45 cut fell into -- is the one that
// runs.
require(process.env.TE_FIXTURE_ISOLATION).activate('audit-signing-key-cause-fixture');
const runtime = require(process.env.TE_FIXTURE_RUNTIME);
const audit = require(process.env.TE_FIXTURE_AUDIT);
let captured = null;
// The REAL accessor under the REAL broken environment. Wrapping it only
// records what it threw; it changes nothing about what audit.js is handed.
function watchedGetOrCreate(key, candidate) {
  try { return runtime.getOrCreateSecret(key, candidate); }
  catch (error) { captured = error; throw error; }
}
function watchedGet(key) {
  try { return runtime.getSecret(key); }
  catch (error) { if (error && error.code !== 'SECRET_NOT_CONFIGURED') captured = error; throw error; }
}
let thrown = null;
try {
  audit.resetForTests();
  audit.status({ getSecret: watchedGet, getOrCreateSecret: watchedGetOrCreate });
} catch (error) { thrown = error; }
const chain = [];
const seen = new Set();
let cursor = thrown;
while (cursor && !seen.has(cursor) && chain.length < 10) {
  seen.add(cursor);
  chain.push(typeof cursor.message === 'string' ? cursor.message : String(cursor));
  cursor = cursor.cause;
}
// WHAT THE VAULT SCRIPT ITSELF SAID, discovered rather than written down.
//
// Only run once the audit path has ALREADY failed: a vault that just refused
// cannot succeed here, so this can never store anything. stdout is handed to
// the OS as 'ignore' -- on a get-or-create the child's stdout IS the key
// material, so it is discarded by the spawn options, not by this file
// remembering to look away. Only stderr is read.
let childStderr = '';
if (thrown) {
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', process.env.TE_FIXTURE_VAULT_SCRIPT, 'get-or-create-stdin', 'toolsenabled_w65_fixture_probe'
  ], { input: 'unused-because-the-vault-is-already-refusing', encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, shell: false });
  childStderr = String(probe.stderr || '').replace(/\\s+/g, ' ').trim();
}
process.stdout.write(JSON.stringify({
  reproduced: Boolean(thrown) && Boolean(captured),
  threw: Boolean(thrown),
  capturedReason: captured && typeof captured.message === 'string' ? captured.message : null,
  childStderr,
  code: thrown ? thrown.code : null,
  reachable: chain
}));
`;

function runFixture(modulesDirectory) {
  const env = {
    ...process.env,
    PSModulePath: modulesDirectory,
    TE_FIXTURE_VAULT_SCRIPT: path.join(__dirname, '..', 'tools', 'secrets.ps1'),
    TE_FIXTURE_ISOLATION: path.join(__dirname, 'lib', 'isolated-environment.js'),
    TE_FIXTURE_RUNTIME: path.join(__dirname, '..', 'src', 'lib', 'runtime.js'),
    TE_FIXTURE_AUDIT: path.join(__dirname, '..', 'src', 'lib', 'audit.js')
  };
  const result = spawnSync(process.execPath, ['-e', CHILD], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  if (result.error) return { error: `the fixture child could not be started: ${result.error.message}` };
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); }
  catch { return { error: `the fixture child printed no usable result; stderr was: ${String(result.stderr).slice(0, 500)}` }; }
  return { parsed };
}

test('under a real broken vault the signing-key refusal still carries the reason the vault raised', t => {
  if (process.platform !== 'win32') {
    // A named refusal, reported to the runner as a skip so the summary line
    // cannot read like a pass.
    return t.skip('this fixture is the Windows PowerShell module-autoload failure; this host is ' + process.platform + '.');
  }
  const { directory: modules, reason: discoveryRefusal } = powershell7ModulesDirectory();
  if (!modules) {
    return t.skip(discoveryRefusal);
  }
  const { parsed, error } = runFixture(modules);
  assert.equal(error, undefined, String(error));
  if (!parsed.reproduced) {
    return t.skip('the fixture did not reproduce on this host (threw=' + parsed.threw
      + ', a vault reason was captured=' + Boolean(parsed.capturedReason)
      + '). The vault succeeded despite the module-only PSModulePath, so there is no destroyed cause to test for.');
  }

  // The refusal code is what callers key on; widening the error must not move it.
  assert.equal(parsed.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE',
    'the refusal code must stay stable; it was ' + parsed.code);

  // Discovered at run time from the real failure. Nothing here pins a spelling.
  const reason = parsed.capturedReason;
  assert.ok(reason, 'the wrapped accessor recorded no reason, so this run proves nothing');
  assert.ok(parsed.reachable.join('\n').includes(reason),
    'the reason the vault layer raised must still be reachable from the refusal, by message or by cause chain. '
    + 'The vault said: ' + JSON.stringify(reason) + '. The refusal offered: ' + JSON.stringify(parsed.reachable));
});

// THE FAR END OF THE CHAIN. The case above proves audit.js relays what it was
// handed. This one proves that what it is handed is the vault SCRIPT's own
// words, so the whole path explains itself. Fixing one half while the other
// still swallows the reason is worse than the silence it replaced, because it
// looks fixed.
//
// The expected text is the stderr the script actually produced on this host,
// captured in the same run. Nothing is written down, so a different PowerShell
// build, a different failure, or a reworded script all still pass.
test('the vault script own words reach the product diagnostic, not just the accessor prose', t => {
  if (process.platform !== 'win32') {
    return t.skip('this fixture is the Windows PowerShell module-autoload failure; this host is ' + process.platform + '.');
  }
  const { directory: modules, reason: discoveryRefusal } = powershell7ModulesDirectory();
  if (!modules) {
    return t.skip(discoveryRefusal);
  }
  const { parsed, error } = runFixture(modules);
  assert.equal(error, undefined, String(error));
  if (!parsed.reproduced) {
    return t.skip('the fixture did not reproduce on this host, so the vault script never failed and has no words to relay.');
  }
  if (!parsed.childStderr) {
    return t.skip('the vault script failed without writing to stderr on this host, so there is no captured reason to require.');
  }

  assert.equal(parsed.code, 'AUDIT_SIGNING_KEY_UNAVAILABLE',
    'the refusal code must stay stable; it was ' + parsed.code);

  // A bounded, distinctive slice of what the script said. Taking a slice keeps
  // the assertion honest against any clamp applied along the way.
  const needle = parsed.childStderr.slice(0, 120);
  assert.ok(parsed.reachable.join('\n').includes(needle),
    'the vault script own words must reach the product diagnostic. The script said: '
    + JSON.stringify(needle) + '. The refusal offered: ' + JSON.stringify(parsed.reachable));
});
