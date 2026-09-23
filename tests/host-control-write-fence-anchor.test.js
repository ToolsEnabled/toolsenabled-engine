'use strict';

/* THE WRITE FENCE MUST BE ANCHORED ON A TREE, NOT ON A FOLDER NAME.
 *
 * Measured 2026-08-25 with resolveHostPath itself: every rule in
 * WRITE_EXCLUDED_PATH_PATTERNS reads `[\/]ToolsEnabled[^\/]*[\/]<protected>`,
 * which requires the protected folder to be the IMMEDIATE CHILD of a directory
 * literally named ToolsEnabled*. The shipping checkout is one level deeper --
 * `.../toolsenabled/engine/config` -- so NOT ONE rule matched it:
 *
 *     WRITE-ALLOWED  ...\toolsenabled\engine\config\toolsenabled.policy.json
 *     WRITE-ALLOWED  ...\toolsenabled\engine\src\mcp-server.js
 *     REFUSED        ...\Desktop\ToolsEnabled-lane1\config\...   (control)
 *
 * The fence was real and pointed at a layout the product does not use. Since
 * `host.write_file` is a destructive local-write that is NOT approval-eligible,
 * that made the approval boundary self-deleting at the Unrestricted tier: write
 * `{approvals:{enabled:false}}` over the policy file and host.exec, scheduler.*
 * and system.credential_remove are all ungated afterwards. Guided and Standard
 * were never reachable -- they refuse host.write_file outright.
 *
 * WHY THE CONTROLS BELOW ARE AS LOAD-BEARING AS THE SUBJECTS: the first harness
 * that measured this defect used hand-copied regexes and its own escaping ate
 * the backslashes, so EVERY row came back writable -- including the control
 * that should have refused. A control that stops refusing means the harness is
 * broken and no other row means anything. These tests therefore drive the
 * PRODUCT'S OWN resolveHostPath and assert both directions.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHostPath } = require('../src/lib/providers/host-control.js');

const HOME = os.homedir();
let failures = 0;

function check(label, run) {
  try {
    run();
    console.log('  ok  ' + label);
  } catch (error) {
    failures += 1;
    console.log('  FAIL ' + label);
    console.log('       ' + error.message.split('\n')[0]);
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

/* A real product tree, built on disk under the owner profile so containment
   passes, with the marker the resolver actually looks for. Built rather than
   pointed at the live checkout: a test that depends on this machine's own
   layout stops being evidence the moment somebody moves a folder, which is the
   exact class of defect this file exists for. */
const scratch = fs.mkdtempSync(path.join(HOME, '.te-fence-test-'));
const nested = path.join(scratch, 'someones-checkout', 'engine');
fs.mkdirSync(path.join(nested, 'config'), { recursive: true });
fs.writeFileSync(path.join(nested, 'config', 'payload-boundary.json'), '{}', 'utf8');

try {
  check('a busy product-tree check is not reported as a definite protected or absent answer', () => {
    const busy = path.join(scratch, 'busy-check');
    const target = path.join(busy, 'notes.txt');
    fs.mkdirSync(busy);
    const originalAccessSync = fs.accessSync;
    fs.accessSync = candidate => {
      if (candidate === path.join(busy, 'config', 'payload-boundary.json')) {
        const error = new Error('descriptor table busy');
        error.code = 'EMFILE';
        throw error;
      }
      return originalAccessSync(candidate);
    };
    try {
      assert.throws(
        () => resolveHostPath(target, { forWrite: true }),
        error => error.code === 'HOST_PATH_CHECK_FAILED'
          && /does NOT claim.*absent/.test(error.message),
        'EMFILE must have a could-not-check code and an explicit non-absence statement'
      );
    } finally {
      fs.accessSync = originalAccessSync;
    }
  });

  check('CONTROL: a legitimate no-tree answer remains cached', () => {
    const ordinary = path.join(scratch, 'cached-ordinary');
    const target = path.join(ordinary, 'notes.txt');
    fs.mkdirSync(ordinary);
    assert.equal(refuses(target), null, 'the initial, legitimate absence result is writable');

    const originalAccessSync = fs.accessSync;
    let repeatedProbe = false;
    fs.accessSync = candidate => {
      if (candidate === path.join(ordinary, 'config', 'payload-boundary.json')) {
        repeatedProbe = true;
        const error = new Error('the cached directory was probed again');
        error.code = 'EIO';
        throw error;
      }
      return originalAccessSync(candidate);
    };
    try {
      assert.equal(refuses(target), null, 'the cached legitimate result remains usable');
      assert.equal(repeatedProbe, false, 'the legitimate no-tree answer must still be cached');
    } finally {
      fs.accessSync = originalAccessSync;
    }
  });

  check('a product tree nested BELOW a ToolsEnabled-named folder is still fenced', () => {
    for (const leaf of [
      path.join('config', 'toolsenabled.policy.json'),
      path.join('src', 'mcp-server.js'),
      path.join('tools', 'cloud-lane.js'),
      'KILLSWITCH',
      'package.json',
      path.join('.git', 'config'),
      'AGENTS.md'
    ]) {
      const target = path.join(nested, leaf);
      assert.equal(refuses(target), 'HOST_PATH_WRITE_PROTECTED',
        leaf + ' must be refused inside a product tree at any depth');
    }
  });

  check('the tree is found by its MARKER, not by any folder being called ToolsEnabled', () => {
    /* No path component here contains the product name at all. If this passes
       only because of the name-anchored list, renaming the fixture breaks it --
       which is precisely the defect. */
    // The Windows account itself may legitimately be named ToolsEnabled-Dev.
    // What matters to the old name-based rule is the fixture path *beneath*
    // that profile, so do not mistake the account boundary for a fixture
    // component that could satisfy the protected-leaf pattern.
    assert.ok(!/toolsenabled/i.test(path.relative(HOME, nested)),
      'fixture components below the profile must not contain the product name, or the marker proof means nothing');
    assert.equal(refuses(path.join(nested, 'config', 'x.json')), 'HOST_PATH_WRITE_PROTECTED');
  });

  check('an ordinary file inside the same tree is still writable', () => {
    /* The fence protects named anchors, not the whole tree. Over-refusing would
       be its own defect and would get the guard disabled by the next person. */
    assert.equal(refuses(path.join(nested, 'README-notes.txt')), null,
      'an unlisted file in a product tree must stay writable');
  });

  check('an ordinary file OUTSIDE any product tree is still writable', () => {
    assert.equal(refuses(path.join(scratch, 'notes.txt')), null);
  });

  check('the walk stops at the tree root: a sibling directory is not fenced', () => {
    /* `config` here is a child of the SCRATCH root, which carries no marker, so
       it must not inherit the nested tree's protection. Anchoring on "any
       ancestor anywhere" instead of "the nearest marked root" would refuse
       this, and would eventually refuse a customer's unrelated config/ folder. */
    const sibling = path.join(scratch, 'unrelated', 'config', 'settings.json');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    assert.equal(refuses(sibling), null,
      'a config/ outside any marked tree must not be fenced');
  });

  check('the name-anchored rules still hold, so nothing was traded away', () => {
    /* The original list still covers sibling-lane layouts and the non-repo
       anchors. This fix ADDED a check; it must not have replaced one. */
    const lane = path.join(HOME, 'Desktop', 'ToolsEnabled-lane1', 'config', 'x.json');
    assert.equal(refuses(lane), 'HOST_PATH_WRITE_PROTECTED');
    assert.equal(refuses(path.join(HOME, '.gitconfig')), 'HOST_PATH_WRITE_PROTECTED');
  });

  check('the vault refusal is unchanged and still wins by its own rule', () => {
    /* Name-independent and separate from this fence; asserted so a future
       change here cannot quietly demote it. */
    assert.equal(refuses(path.join(nested, 'vault', 'secrets.json')), 'HOST_PATH_FORBIDDEN');
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log('\nhost-control write-fence anchor: ' + failures + ' FAILED');
  process.exit(1);
}
console.log('\nhost-control write-fence anchor: all checks passed');
