'use strict';

/* THE WRITE FENCE NAMED A CONVENTION, NOT THE PRODUCT'S ENTRY POINTS.
 *
 * tests/host-control-write-fence-anchor.test.js fixed WHERE the fence is
 * measured from (a tree root discovered on disk, not a folder name). This file
 * covers the other half of the same miss: WHAT it names once it is measuring
 * the right tree. The executable-code rule listed
 * `src|tools|scripts|sidecars|packages|captures|scratch|tmp` -- a plausible
 * convention -- and each package's own manifest says its code starts somewhere
 * that list does not mention:
 *
 *     engine/package.json  bin  -> bin/fallback.js, bin/localcode.js
 *     app/package.json     main -> shell/main.cjs   (Electron main process)
 *
 * Measured 2026-08-25 with resolveHostPath itself, both WRITE-ALLOWED:
 *
 *     WRITE-ALLOWED  ...\opensource\desktop-app\shell\main.cjs
 *     WRITE-ALLOWED  ...\toolsenabled\engine\bin\probe.js
 *     REFUSED        ...\toolsenabled\engine\src\probe.js        (control)
 *
 * `host.write_file` is a destructive local-write that is NOT approval-eligible,
 * so at the Unrestricted tier overwriting shell/main.cjs is arbitrary code in
 * the desktop application's own startup path, with no prompt anywhere.
 *
 * The same run found Documents\PowerShell (PowerShell 6/7+) writable while
 * Documents\WindowsPowerShell (5.1) was refused -- a different folder, the same
 * per-user autorun, and only one edition was in the list.
 *
 * WHY THE CONTROLS BELOW ARE AS LOAD-BEARING AS THE SUBJECTS: an earlier
 * harness for this fence hand-copied the regexes and its own escaping ate the
 * backslashes, so every row came back writable INCLUDING the controls. A
 * control that stops behaving means the harness is broken and no other row
 * means anything. These checks drive the PRODUCT'S OWN resolveHostPath and
 * assert both directions.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHostPath } = require('../src/lib/providers/host-control.js');

const HOME = os.homedir();
const ENGINE_ROOT = path.resolve(__dirname, '..');
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

/* A product tree built on disk under the owner profile, carrying the marker
   the resolver looks for and a manifest that declares its entry points the way
   the real packages do. Built rather than pointed at this machine's checkout:
   a test that depends on the local layout stops being evidence the moment
   somebody moves a folder. */
const scratch = fs.mkdtempSync(path.join(HOME, '.te-entrypoint-test-'));
const tree = path.join(scratch, 'someones-checkout', 'app');
fs.mkdirSync(path.join(tree, 'config'), { recursive: true });
fs.writeFileSync(path.join(tree, 'config', 'payload-boundary.json'), '{}', 'utf8');
fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({
  name: 'toolsenabled', main: 'shell/main.cjs', bin: { probe: 'bin/probe.js' }
}), 'utf8');

try {
  check('the entry points a package declares are fenced, not just src/', () => {
    for (const leaf of [
      path.join('shell', 'main.cjs'),
      path.join('shell', 'product-settings.cjs'),
      path.join('bin', 'probe.js'),
      path.join('bin', 'nested', 'anything.js')
    ]) {
      assert.equal(refuses(path.join(tree, leaf)), 'HOST_PATH_WRITE_PROTECTED',
        leaf + ' is declared runtime code and must never be writable here');
    }
  });

  check('the pre-existing executable-code rules are unchanged', () => {
    /* This fix WIDENED one list. It must not have traded anything away. */
    for (const leaf of ['src', 'tools', 'scripts', 'sidecars', 'packages', 'captures', 'scratch', 'tmp', 'config', 'logs', 'node_modules']) {
      assert.equal(refuses(path.join(tree, leaf, 'x.js')), 'HOST_PATH_WRITE_PROTECTED', leaf + '/ must still be refused');
    }
    assert.equal(refuses(path.join(tree, 'KILLSWITCH')), 'HOST_PATH_WRITE_PROTECTED');
    assert.equal(refuses(path.join(HOME, '.gitconfig')), 'HOST_PATH_WRITE_PROTECTED');
  });

  check('it does not over-refuse: unlisted folders in the same tree stay writable', () => {
    /* Over-refusing is its own defect and is how a guard gets disabled by the
       next person. docs/, reports/, tests/ and a loose file are not code the
       product runs at startup. */
    for (const leaf of [
      path.join('docs', 'notes.md'),
      path.join('reports', 'run.md'),
      path.join('tests', 'probe.test.js'),
      'README-notes.txt'
    ]) {
      assert.equal(refuses(path.join(tree, leaf)), null, leaf + ' must stay writable');
    }
  });

  check('a bin/ or shell/ folder OUTSIDE any marked tree is not fenced', () => {
    /* The anchor is the tree, not the word. A customer with their own bin/
       must not inherit the product's protection. */
    for (const leaf of ['bin', 'shell']) {
      const outside = path.join(scratch, 'unrelated', leaf, 'x.js');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      assert.equal(refuses(outside), null, leaf + '/ outside a product tree must stay writable');
    }
  });

  check('this repository\'s OWN declared bin targets are refused', () => {
    /* Derived from the manifest rather than hard-coded, so it keeps testing
       the real thing if the bin map changes. Skipped, loudly, if the checkout
       is not under the owner profile -- there the refusal would come from
       containment and would prove nothing about this fence. */
    const relativeToHome = path.relative(HOME, ENGINE_ROOT);
    if (relativeToHome.startsWith('..') || path.isAbsolute(relativeToHome)) {
      console.log('       (skipped: checkout is outside the owner profile on this machine)');
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
    const declared = Object.values(manifest.bin || {});
    assert.ok(declared.length > 0, 'the engine manifest must still declare bin entry points');
    for (const relative of declared) {
      assert.equal(refuses(path.join(ENGINE_ROOT, relative)), 'HOST_PATH_WRITE_PROTECTED',
        relative + ' is a declared entry point of this very repository');
    }
  });

  check('both PowerShell editions are fenced, profile and Modules alike', () => {
    /* 5.1 reads Documents\WindowsPowerShell; 6/7+ reads Documents\PowerShell.
       A module dropped in Modules\ is auto-discovered by name, so the folder
       matters as much as the profile file. */
    for (const leaf of [
      path.join('WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join('WindowsPowerShell', 'profile.ps1'),
      path.join('PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join('PowerShell', 'profile.ps1'),
      path.join('PowerShell', 'Modules', 'anything', 'anything.psm1')
    ]) {
      assert.equal(refuses(path.join(HOME, 'Documents', leaf)), 'HOST_PATH_WRITE_PROTECTED',
        'Documents/' + leaf + ' is a per-user autorun');
    }
  });

  check('the PowerShell rule is segment-anchored, not a prefix match', () => {
    /* `PowerShell` must not swallow a folder that merely starts with it, or the
       fence grows into places nobody decided about. */
    const near = path.join(HOME, 'Documents', 'PowerShellNotes', 'x.txt');
    assert.equal(refuses(near), null,
      'a folder merely beginning with "PowerShell" must not be fenced');
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.log('\nhost-control entry-point fence: ' + failures + ' FAILED');
  process.exit(1);
}
console.log('\nhost-control entry-point fence: all checks passed');
