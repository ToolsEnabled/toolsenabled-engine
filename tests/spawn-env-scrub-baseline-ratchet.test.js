#!/usr/bin/env node
'use strict';
/* THE BASELINE RATCHET, EXERCISED AGAINST A SYNTHETIC ROOT.
 *
 * tools/check-spawn-env-scrub.js records unscrubbed spawn call sites as debt and
 * refuses to let the count rise without --allow-new-debt. That refusal is the gate.
 *
 * IT WAS BYPASSABLE BY DELETING THE FILE IT RATCHETS AGAINST. Measured before the
 * fix: add one unscrubbed spawn and `--update-baseline` refuses, as designed. Delete
 * tools/spawn-env-scrub-baseline.json and run the same command, and it becomes a
 * "genesis" write -- records the new call site as accepted debt, exits 0, and the
 * gate goes green with the unscrubbed spawn still there. Absence of the baseline was
 * read as permission to record anything.
 *
 * The gate takes --root, so this runs against a three-file temporary repository
 * rather than copying the real one. That keeps the test fast AND makes the counts
 * legible: one call site, then two.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHECKER = path.join(path.resolve(__dirname, '..'), 'tools', 'check-spawn-env-scrub.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-ratchet-'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

const BASELINE = path.join(root, 'tools', 'spawn-env-scrub-baseline.json');
fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'tools'), { recursive: true });

function unscrubbed(name) {
  fs.writeFileSync(path.join(root, 'src', 'lib', name),
    "'use strict';\nconst { spawn } = require('node:child_process');\n"
    + "module.exports = () => spawn('node', ['-e', '0'], { env: process.env });\n", 'utf8');
}
function run(...args) {
  const result = spawnSync(process.execPath, [CHECKER, '--root', root, ...args], { encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

unscrubbed('one.js');

// With no baseline the gate refuses: every call site counts as new.
check(run().code !== 0, 'with no baseline, an unscrubbed spawn must refuse');

// THE FIX. A missing baseline is not permission to photograph whatever is there.
const implicit = run('--update-baseline');
check(implicit.code !== 0, '--update-baseline must refuse to create a baseline implicitly');
check(/NO BASELINE/.test(implicit.out), 'the refusal says the baseline is absent');
check(/--genesis/.test(implicit.out), 'and it names the flag that would make it deliberate');
check(!fs.existsSync(BASELINE), 'and it wrote nothing');

// Genesis remains possible, deliberately and on the record.
check(run('--update-baseline', '--genesis').code === 0, '--genesis creates the first baseline');
check(fs.existsSync(BASELINE), 'the baseline exists after a deliberate genesis');
check(run().code === 0, 'and the recorded pile is then accepted');

// The property that already worked: a NEW call site may not raise the count silently.
unscrubbed('two.js');
check(run().code !== 0, 'a second unscrubbed spawn is refused');
const raise = run('--update-baseline');
check(raise.code !== 0, '--update-baseline must not raise recorded debt on its own');
check(/refusing to raise recorded debt/.test(raise.out), 'and it says so');
check(run('--update-baseline', '--allow-new-debt').code === 0, '--allow-new-debt records it on purpose');

// AND THE BYPASS STAYS CLOSED with a baseline that existed and was removed.
fs.rmSync(BASELINE);
const afterDelete = run('--update-baseline');
check(afterDelete.code !== 0, 'deleting the baseline must not become a fresh genesis');
check(!fs.existsSync(BASELINE), 'nothing was written by the bypass attempt');

console.log(`spawn-env-scrub baseline ratchet: ${checks} checks passed`);
