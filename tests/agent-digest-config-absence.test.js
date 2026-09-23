'use strict';

// R1260 T4.3 -- ABSENCE-READ-AS-CONSENT ON AN OUTWARD-SENDING SUBSYSTEM.
//
// WHY THIS FILE EXISTS SEPARATELY FROM tests/agent-digest.js.
// The corrected assertions also live in tests/agent-digest.js (which previously
// PINNED the defect with `assert.equal(missing.enabled, true)`), but that suite
// is RED at base SHA ceae7e7f for an unrelated, pre-existing environment
// reason: its check at line ~790 calls resolveRecipient({ account:
// 'accta' }) and this tree's config/google-accounts.profile.json carries
// no accounts, so it throws "Unknown Google account 'accta'. Known:
// (none)". Its runner is a sequential for-loop that stops at the first throw,
// so every later check -- including the config one -- never executes. A fix
// whose only proof sits behind a check that cannot run is not proven, so the
// behaviour is asserted here too, in a file that runs today and can be shown
// to go red on demand.
//
// THE DEFECT. src/lib/agent-digest/index.js read `raw.enabled !== false` over
// `readJson(file, {})`, and readJson returns the fallback for ENOENT. A MISSING
// config/agent-digest.json therefore produced {}, and `{}.enabled !== false` is
// true -- deleting the configuration for a subsystem that EMAILS THE OWNER
// switched it on. Absence read as consent, on an outward-sending surface.
//
// Every assertion below is behavioural: it calls the real loadConfig against
// real files on disk. Nothing is asserted about the source text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const digestIndex = require('../src/lib/agent-digest');
const ROOT = path.resolve(__dirname, '..');

const temporaries = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-digest-absence-'));
  temporaries.push(dir);
  return dir;
}

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

try {
  const dir = tempDir();

  // ---- THE ABSENCE CASE FIRST -------------------------------------------
  check('a missing configuration file leaves the emailing digest OFF', () => {
    const absent = path.join(dir, 'definitely-absent.json');
    assert.equal(fs.existsSync(absent), false, 'the fixture must genuinely not exist');
    const config = digestIndex.loadConfig(absent);
    assert.equal(config.enabled, false,
      'a MISSING config/agent-digest.json enabled an emailing subsystem: absence was read as consent');
  });

  check('the withholding is explained by which absence was met, not by a generic word', () => {
    const config = digestIndex.loadConfig(path.join(dir, 'definitely-absent.json'));
    assert.equal(typeof config.enabledReason, 'string');
    assert.match(config.enabledReason, /no configuration file/,
      'the reason must name the missing file; saying "disabled in config/agent-digest.json" sends a reader to edit a file that is not there');
  });

  check('a configuration that never says enabled:true does not enable it either', () => {
    const file = path.join(dir, 'silent.json');
    fs.writeFileSync(file, JSON.stringify({ tickSeconds: 15, generationTimeoutMs: 1000 }));
    const config = digestIndex.loadConfig(file);
    assert.equal(config.enabled, false, 'a config that omits `enabled` must not enable the digest');
    assert.match(config.enabledReason, /not enabled by silence/);
    assert.equal(config.tickMs, 15000, 'the rest of the configuration must still be honoured');
  });

  check('no near-miss value stands in for the literal boolean true', () => {
    const file = path.join(dir, 'near-miss.json');
    for (const value of ['true', 'yes', 1, {}, [], 'enabled']) {
      fs.writeFileSync(file, JSON.stringify({ enabled: value }));
      assert.equal(digestIndex.loadConfig(file).enabled, false,
        `enabled: ${JSON.stringify(value)} must not switch on an outward-sending subsystem`);
    }
  });

  // ---- ONLY THEN THE PRESENCE CASE --------------------------------------
  check('an explicit enabled:true still switches it on, with no reason recorded', () => {
    const file = path.join(dir, 'on.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, tickSeconds: 20 }));
    const config = digestIndex.loadConfig(file);
    assert.equal(config.enabled, true);
    assert.equal(config.enabledReason, null);
    assert.equal(config.tickMs, 20000);
  });

  check('an explicit enabled:false is reported as the user turning it off, not as an absence', () => {
    const file = path.join(dir, 'off.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: false }));
    const config = digestIndex.loadConfig(file);
    assert.equal(config.enabled, false);
    assert.match(config.enabledReason, /sets enabled: false/,
      '"you said no" and "you never said" are different facts and must read differently');
  });

  check('the shipped configuration still loads and is still enabled', () => {
    const shipped = digestIndex.loadConfig(path.join(ROOT, 'config', 'agent-digest.json'));
    assert.equal(shipped.enabled, true, 'the change must not silently switch off the configured installation');
    assert.equal(shipped.enabledReason, null);
    assert.ok(shipped.generationTimeoutMs > 0);
  });

  process.stdout.write(`Agent digest config-absence tests passed (${checks} checks).\n`);
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  for (const dir of temporaries) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch { /* best effort */ }
  }
}
