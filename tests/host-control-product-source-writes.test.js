'use strict';

/* THE OWNER'S SWITCH LIFTS THE CODE-FOLDER RULE, AND ONLY THAT RULE, AND NEVER
 * FOR THE RUNNING PRODUCT.
 *
 * Measured 2026-09-19 on the owner's machine: with "Available tool sets" on
 * Only, every Codex lane writes through host.write_file / host.patch_file and
 * nothing else, and the code-folder rule in
 * src/lib/providers/host-control.js refused every edit to the checkouts the
 * owner had cloned for them (HOST_PATH_WRITE_PROTECTED on
 * Temp\te-home-circle-hotload-app-*\src, on isolated worktrees'
 * src/views/computers.js and shell/fleet-profile-preload.cjs). Eight lanes were
 * blocked in one day and there was no switch. The owner: "there needs to be a
 * switch in settings for this".
 *
 * These checks drive the PRODUCT'S OWN resolveHostPath, both ways round, with
 * the switch handed in through the seam so no settings file is needed, and
 * then drive the real reader against fake settings for the provenance rule.
 * The controls are as load-bearing as the subjects (see the anchor test): a
 * control that stops refusing means the harness is broken.
 *
 *   node tests/host-control-product-source-writes.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hostControl = require('../src/lib/providers/host-control.js');
const { resolveHostPath, setProductSourceWritesPolicyForTests } = hostControl;
const { productSourceWritesPolicy, SETTING_ID } = require('../src/lib/product-source-writes.js');
const { rootPath } = require('../src/lib/runtime');

const HOME = os.homedir();
let failures = 0;

function check(label, run) {
  try {
    run();
    console.log('  ok  ' + label);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + label);
    console.log('       ' + error.message.split('\n').slice(0, 5).join(' | '));
  }
}

function refuses(target) {
  try {
    resolveHostPath(target, { forWrite: true });
    return null;
  } catch (error) {
    return error.code || 'REFUSED';
  }
}

const ON = () => ({ enabled: true, reason: 'chosen', source: 'user' });
const OFF = () => ({ enabled: false, reason: 'off' });

/* A real product tree under the owner profile, carrying the marker the
   resolver looks for, and NOT the tree this test process runs from. */
const scratch = fs.mkdtempSync(path.join(HOME, '.te-source-writes-test-'));
const checkout = path.join(scratch, 'someones-checkout');
fs.mkdirSync(path.join(checkout, 'config'), { recursive: true });
fs.writeFileSync(path.join(checkout, 'config', 'payload-boundary.json'), '{}', 'utf8');

const CODE_LEAVES = [
  path.join('src', 'home-circle-forms.js'),
  path.join('shell', 'fleet-profile-preload.cjs'),
  path.join('tools', 'test', 'x.test.mjs'),
  path.join('bin', 'probe.js'),
  path.join('scripts', 'x.ps1')
];
const ANCHOR_LEAVES = [
  path.join('config', 'toolsenabled.policy.json'),
  'KILLSWITCH',
  path.join('.git', 'config'),
  path.join('node_modules', 'x', 'index.js'),
  'AGENTS.md',
  path.join('state', 'x.json')
];

try {
  check('CONTROL: with the switch off, product code in a checkout is refused', () => {
    setProductSourceWritesPolicyForTests(OFF);
    for (const leaf of CODE_LEAVES) {
      assert.equal(refuses(path.join(checkout, leaf)), 'HOST_PATH_WRITE_PROTECTED', leaf);
    }
  });

  check('with the switch on, product code in a checkout that is not the running product is writable', () => {
    setProductSourceWritesPolicyForTests(ON);
    for (const leaf of CODE_LEAVES) {
      assert.equal(refuses(path.join(checkout, leaf)), null, leaf + ' must be writable once the owner lifted the rule');
    }
    for (const leaf of ['package.json', 'package-lock.json', path.join('config', 'settings-registry.json'), path.join('config', 'payload-boundary.json')]) {
      assert.equal(refuses(path.join(checkout, leaf)), null, leaf + ' is source too once the owner lifted the rule (owner, 2026-09-20)');
    }
    setProductSourceWritesPolicyForTests(OFF);
    assert.equal(refuses(path.join(checkout, 'package.json')), 'HOST_PATH_WRITE_PROTECTED', 'CONTROL: off keeps package.json anchored');
    assert.equal(refuses(path.join(checkout, 'config', 'x.json')), 'HOST_PATH_WRITE_PROTECTED', 'CONTROL: off keeps config/ anchored');
  });

  check('the integrity anchors stay refused with the switch on', () => {
    setProductSourceWritesPolicyForTests(ON);
    for (const leaf of ANCHOR_LEAVES) {
      assert.equal(refuses(path.join(checkout, leaf)), 'HOST_PATH_WRITE_PROTECTED', leaf + ' is an anchor, not a code folder');
    }
  });

  check('the name-anchored sibling-lane rule lifts with the switch too, its anchors do not', () => {
    setProductSourceWritesPolicyForTests(ON);
    const lane = path.join(HOME, 'Desktop', 'ToolsEnabled-lane1');
    assert.equal(refuses(path.join(lane, 'src', 'x.js')), null);
    assert.equal(refuses(path.join(lane, 'config', 'x.json')), null, 'config/ lifts with the switch (owner, 2026-09-20)');
    assert.equal(refuses(path.join(lane, 'KILLSWITCH')), 'HOST_PATH_WRITE_PROTECTED');
    assert.equal(refuses(path.join(lane, 'state', 'x.json')), 'HOST_PATH_FORBIDDEN', 'state/ is a credential store: refused harder than an anchor');
    setProductSourceWritesPolicyForTests(OFF);
    assert.equal(refuses(path.join(lane, 'src', 'x.js')), 'HOST_PATH_WRITE_PROTECTED', 'CONTROL: off keeps the name-anchored rule');
  });

  check('the running product is never writable, whatever the switch says', () => {
    setProductSourceWritesPolicyForTests(ON);
    const running = path.resolve(rootPath());
    assert.equal(refuses(path.join(running, 'src', 'mcp-server.js')), 'HOST_PATH_WRITE_PROTECTED', 'the process root itself');
    assert.equal(refuses(path.join(running, 'tools', 'x.mjs')), 'HOST_PATH_WRITE_PROTECTED');
    assert.equal(refuses(path.join(running, 'package.json')), 'HOST_PATH_WRITE_PROTECTED', 'the running product manifest, whatever the switch says');
    assert.equal(refuses(path.join(running, 'config', 'settings-registry.json')), 'HOST_PATH_WRITE_PROTECTED');
    /* The tree AROUND the running root: the desktop app's own src/ and shell/
       sit one level above the packed capability layer. Build that shape under
       scratch by making the "running" root resolve inside it. */
    const outer = path.join(scratch, 'app-around-running');
    fs.mkdirSync(path.join(outer, 'capability', 'config'), { recursive: true });
    fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'toolsenabled' }), 'utf8');
    fs.writeFileSync(path.join(outer, 'capability', 'config', 'payload-boundary.json'), '{}', 'utf8');
    const runtime = require('../src/lib/runtime');
    const originalRootPath = runtime.rootPath;
    runtime.rootPath = (...parts) => path.join(outer, 'capability', ...parts);
    try {
      assert.equal(refuses(path.join(outer, 'src', 'views', 'computers.js')), 'HOST_PATH_WRITE_PROTECTED',
        'the app tree that contains the running capability root is the running product');
      assert.equal(refuses(path.join(outer, 'shell', 'main.cjs')), 'HOST_PATH_WRITE_PROTECTED');
      assert.equal(refuses(path.join(checkout, 'src', 'x.js')), null, 'CONTROL: an unrelated checkout is still writable');
    } finally {
      runtime.rootPath = originalRootPath;
    }
  });

  check('an unreadable switch keeps the rule (fails closed)', () => {
    setProductSourceWritesPolicyForTests(() => { throw new Error('settings exploded'); });
    assert.equal(refuses(path.join(checkout, 'src', 'x.js')), 'HOST_PATH_WRITE_PROTECTED');
  });

  check('the real reader honours the provenance rule, like outside control', () => {
    setProductSourceWritesPolicyForTests(null);
    const read = (values, provenance) => productSourceWritesPolicy({ loadSettings: () => ({ values, provenance }) });
    assert.equal(read({}, {}).reason, 'not-declared');
    assert.equal(read({ [SETTING_ID]: false }, {}).reason, 'off');
    assert.equal(read({ [SETTING_ID]: true }, {}).reason, 'not-chosen', 'a true nobody chose is a flipped default, not a choice');
    assert.equal(read({ [SETTING_ID]: true }, { [SETTING_ID]: { source: 'agent' } }).reason, 'not-chosen');
    const chosen = read({ [SETTING_ID]: true }, { [SETTING_ID]: { source: 'user' } });
    assert.equal(chosen.enabled, true);
    assert.equal(chosen.source, 'user');
    assert.equal(read({ [SETTING_ID]: true }, { [SETTING_ID]: { source: 'installer' } }).enabled, true);
    assert.equal(productSourceWritesPolicy({ loadSettings: () => { throw new Error('nope'); } }).reason, 'settings-unreadable');
  });

  check('an ordinary file in the checkout is writable either way, so nothing widened by accident', () => {
    setProductSourceWritesPolicyForTests(OFF);
    assert.equal(refuses(path.join(checkout, 'README-notes.txt')), null);
    assert.equal(refuses(path.join(scratch, 'notes.txt')), null);
  });
} finally {
  setProductSourceWritesPolicyForTests(null);
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log('\nhost-control product-source writes: ' + failures + ' FAILED');
  process.exit(1);
}
console.log('\nhost-control product-source writes: all checks passed');
