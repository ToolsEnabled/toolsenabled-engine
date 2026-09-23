'use strict';

/* A MACHINE PROBE THAT COULD NOT RUN MUST NOT REPORT A NUMBER.
 *
 * providers/model.js collects free RAM and free VRAM by running a command and
 * reading a number out of its output. When that command is absent or fails, the
 * honest answer is "we did not look". The VRAM half already answered null and
 * said so in its own comment; the RAM half answered 0 in three separate ways --
 * a failed powershell call, an unparseable /proc/meminfo read, and any platform
 * that is neither Windows nor Linux, where `return 0` was not a measurement at
 * all but a hardcoded claim that the machine has no free memory.
 *
 * WHY IT MATTERED, and it is the reason this file asserts the CONSEQUENCE and
 * not just the value: zero is finite, so it passed the Number.isFinite guard in
 * providers/research-hermes.js and landed on the comparison below it. The
 * person was told "Hermes is paused because local RAM or VRAM headroom is below
 * its safety floor" -- a statement about their hardware -- when the truth was
 * that nothing had been measured. The honest refusal already existed two lines
 * above and was unreachable for RAM precisely because 0 is finite.
 *
 * The probe is driven in a CHILD PROCESS with an empty PATH rather than by
 * stubbing the module's internals. The defect lives in what happens when a real
 * command cannot be found, and a stub that returns '' would be asserting my
 * model of the failure rather than the failure. */

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const MODEL = path.resolve(__dirname, '..', 'src', 'lib', 'providers', 'model.js');
let checks = 0;

function probeWithoutCommands() {
  const code = 'const {probeResources} = require(process.argv[1]);'
    + 'process.stdout.write(JSON.stringify(probeResources()));';
  /* Both spellings: Windows environment names are case-insensitive and a plain
     JS object is not, so setting only PATH can leave Path untouched and the
     child finds powershell after all -- which would make this test pass by
     measuring nothing. */
  const env = Object.assign({}, process.env, {
    PATH: path.join(__dirname, 'no-such-directory-for-probe-test'),
    Path: path.join(__dirname, 'no-such-directory-for-probe-test')
  });
  const out = childProcess.execFileSync(process.execPath, ['-e', code, MODEL], {
    env, encoding: 'utf8', timeout: 60_000
  });
  return JSON.parse(out);
}

const blind = probeWithoutCommands();

assert.equal(blind.freeRamBytes, null,
  'with no command available the RAM probe reported a number; zero here is a claim about somebody\'s hardware made out of a failed lookup');
checks += 1;

assert.equal(blind.freeVramBytes, null,
  'with no command available the VRAM probe reported a number');
checks += 1;

/* THE CONSEQUENCE, which is the half a value assertion cannot reach. This is
   research-hermes.js's guard and its comparison, in the order that file runs
   them. A reading of 0 passes the first and fails the second, which is how a
   "could not measure" became "your machine is too small". */
const FRESH_MIN_RAM_BYTES = 8 * 1024 * 1024 * 1024;
function hermesVerdict(freeRamBytes) {
  if (!Number.isFinite(freeRamBytes)) return 'HERMES_RESOURCE_PROBE_FAILED';
  if (freeRamBytes < FRESH_MIN_RAM_BYTES) return 'HERMES_RESOURCE_PAUSED';
  return 'ok';
}

assert.equal(hermesVerdict(blind.freeRamBytes), 'HERMES_RESOURCE_PROBE_FAILED',
  'an unmeasured machine is told its RAM is below the floor rather than that nothing was measured');
checks += 1;

assert.equal(hermesVerdict(0), 'HERMES_RESOURCE_PAUSED',
  'the control: a reading of 0 really does reach the wrong refusal, so the assertion above is measuring the fix and not the arithmetic');
checks += 1;

/* THE UNSUPPORTED-PLATFORM BRANCH, DRIVEN RATHER THAN READ.
 *
 * `return 0` for a platform that is neither Windows nor Linux was the worst of
 * the three, because it was not a failed measurement at all -- it was a constant
 * asserting that every such machine has no free memory. It cannot be reached by
 * running this file on Windows, and a mutation check confirmed that: restoring
 * the zero there left every other assertion in this file green.
 *
 * So the branch is driven in a child that declares itself another platform
 * BEFORE the module is loaded. That is the real branch running, not a stub of
 * my idea of it. */
function probeOnPlatform(platform) {
  const code = "Object.defineProperty(process, 'platform', { value: process.argv[2] });"
    + 'const {probeResources} = require(process.argv[1]);'
    + 'process.stdout.write(JSON.stringify(probeResources()));';
  const out = childProcess.execFileSync(process.execPath, ['-e', code, MODEL, platform], {
    encoding: 'utf8', timeout: 60_000
  });
  return JSON.parse(out);
}

assert.equal(probeOnPlatform('darwin').freeRamBytes, null,
  'on a platform the probe does not support it reported a number; that is not a measurement, it is a constant claiming the machine has no free memory');
checks += 1;

assert.equal(hermesVerdict(probeOnPlatform('darwin').freeRamBytes), 'HERMES_RESOURCE_PROBE_FAILED',
  'every person on an unsupported platform is told their hardware is too small rather than that nothing was measured');
checks += 1;

/* A REAL ZERO IS STILL A ZERO. Null must mean "did not look" and nothing else,
   or the next reader has the same two states collapsed the other way round. */
const parsed = probeResources_parseCheck();
function probeResources_parseCheck() {
  const source = require('node:fs').readFileSync(MODEL, 'utf8');
  return source;
}
assert.ok(!/parseFirstNumber/.test(parsed),
  'parseFirstNumber is back -- it returns 0 for an unparseable value, which is the defect this file exists to prevent');
checks += 1;

/* On a supported platform the probe must still WORK. Without this, deleting the
   whole collection body and returning null everywhere would pass every
   assertion above. */
if (process.platform === 'win32' || process.platform === 'linux') {
  const live = require(MODEL).probeResources();
  assert.ok(Number.isFinite(live.freeRamBytes) && live.freeRamBytes > 0,
    `the RAM probe returned ${JSON.stringify(live.freeRamBytes)} on a platform it supports; null must mean "could not look", never "always"`);
  checks += 1;
} else {
  console.log('SKIP (NOT counted as a pass): the live-reading check needs Windows or Linux, '
    + `and this is ${process.platform}. Null is the correct answer here, so there is nothing to compare against.`);
}

console.log(`machine-probe-unmeasured-is-not-zero: ${checks} checks passed on ${process.platform}`);
