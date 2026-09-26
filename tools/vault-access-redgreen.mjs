#!/usr/bin/env node
/* THE GATE'S OWN MUTATION CHECK, AS A SCRIPT RATHER THAN A PARAGRAPH.
 *
 * A gate nobody has ever seen fail is not known to be a gate. This script
 * breaks the enforcement it guards, proves the suite goes RED, restores the
 * file byte-for-byte, and proves the suite goes GREEN again -- printing all
 * four outcomes so the evidence is reproducible by running one command instead
 * of trusting a transcript.
 *
 * THE MUTATION IS THE PRE-CHANGE CODE. It deletes the three
 * `assertVaultReadAllowed(...)` calls from src/lib/runtime.js, which is exactly
 * what that file contained before the owner's per-credential switches were
 * enforced here. So the RED below is not a synthetic break: it is the measured
 * defect reproducing itself, and the suite catching it.
 *
 * RESTORATION IS VERIFIED BY DIGEST, NOT BY INTENT. The SHA-256 of the file is
 * taken before the mutation and again after the restore, and a mismatch is a
 * hard failure -- a mutation check that left the tree altered would be worse
 * than none.
 *
 *   node tools/vault-access-redgreen.mjs
 *
 * Exit 0 only if GREEN -> RED -> GREEN all held and the digest was restored.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'src', 'lib', 'runtime.js');
const SUITE = path.join('tests', 'vault-access-policy-enforced.test.js');

/* The three enforcement calls, quoted with enough of their surroundings to be
   unambiguous. Each must be found exactly once: a silent zero-match mutation
   would print a false GREEN, which is the failure this whole script exists to
   make impossible. */
const ENFORCEMENT_CALLS = [
  '  assertVaultReadAllowed(key);\n  if (process.platform === \'linux\') return require(\'./vault-linux\').get(key);',
  '  assertVaultReadAllowed(keys);\n  if (process.platform === \'linux\') return require(\'./vault-linux\').getMany(keys);',
  '  assertVaultReadAllowed(key);\n  if (typeof candidate !== \'string\' || !candidate)'
];

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

function runSuite() {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', SUITE], {
    cwd: ROOT, encoding: 'utf8', env: process.env, windowsHide: true
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const line = name => (output.match(new RegExp(`^# ${name} (\\d+)$`, 'm')) || [])[1] ?? '?';
  return {
    pass: line('pass'),
    fail: line('fail'),
    green: result.status === 0,
    failedNames: [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]),
    summary: `# pass ${line('pass')}  # fail ${line('fail')}  (exit ${result.status})`
  };
}

function report(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(result.summary);
  for (const name of result.failedNames) console.log(`  not ok - ${name}`);
  return result;
}

const original = readFileSync(TARGET, 'utf8');
const originalDigest = digest(original);
console.log(`target : ${path.relative(ROOT, TARGET)}`);
console.log(`sha256 before : ${originalDigest}`);

let failures = 0;

const before = report('GREEN (enforcement present)', runSuite());
if (!before.green) { console.error('REFUSED: the suite is not green before the mutation, so nothing below would mean anything.'); process.exit(2); }

/* Apply the mutation. Every call must match exactly once. */
let mutated = original;
for (const call of ENFORCEMENT_CALLS) {
  const occurrences = mutated.split(call).length - 1;
  if (occurrences !== 1) {
    console.error(`REFUSED: expected exactly 1 occurrence of an enforcement call, found ${occurrences}. `
      + 'The mutation would not be the change it claims to be. Nothing was written.');
    process.exit(2);
  }
  /* Drop only the assertVaultReadAllowed line, keeping the line that followed
     it, so the mutation removes the CHECK and nothing else. */
  mutated = mutated.replace(call, call.split('\n').slice(1).join('\n'));
}
writeFileSync(TARGET, mutated, 'utf8');

let red;
try {
  red = report('RED (enforcement deleted -- the pre-change code)', runSuite());
  if (red.green) { console.error('THE GATE DOES NOT GATE: the suite passed with the enforcement deleted.'); failures += 1; }
} finally {
  writeFileSync(TARGET, original, 'utf8');
}

const restoredDigest = digest(readFileSync(TARGET, 'utf8'));
console.log(`\nsha256 after restore : ${restoredDigest}`);
if (restoredDigest !== originalDigest) {
  console.error('RESTORATION FAILED: the file was not returned byte-for-byte.');
  process.exit(2);
}
console.log('restoration : byte-for-byte identical');

const after = report('GREEN (enforcement restored)', runSuite());
if (!after.green) { console.error('The suite did not return to green after restoration.'); failures += 1; }

console.log(`\nRESULT: ${failures === 0 ? 'GREEN -> RED -> GREEN held' : 'MUTATION CHECK FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
