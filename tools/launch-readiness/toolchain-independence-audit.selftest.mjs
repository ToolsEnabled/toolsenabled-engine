#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/* Children must never inherit the ambient environment: this machine's env
   carries provider keys, and Windows env names are case-insensitive, so a
   hand-rolled delete list misses casings. The shared scrubber proves the
   scrub held. Added when the spawn gate flagged these exact sites. */
import launchEnvironment from '../../src/lib/providers/subscription-launch-env.js';

import { respellArgv1Prefix, symlinkCapability } from './path-identity-capability.mjs';

// Read the actual CommonJS export object, not Node's inferred named exports.
const { safeLaunchEnvironment } = launchEnvironment;

// URL.pathname yields "/C:/..." on Windows, which spawn resolves to "C:\C:\..." — use fileURLToPath.
const tool = { pathname: fileURLToPath(new URL('./toolchain-independence-audit.mjs', import.meta.url)) };
const toolPathOnDisk = tool.pathname;

function asar(files) {
  let offset = 0;
  const listing = { files: {} };
  const contents = [];
  for (const [name, value] of Object.entries(files)) {
    const buffer = Buffer.from(value);
    const parts = name.split('/'); let cursor = listing.files;
    for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= { files: {} }).files;
    cursor[parts.at(-1)] = { size: buffer.length, offset: String(offset) };
    contents.push(buffer); offset += buffer.length;
  }
  // Emit the REAL asar layout (four uint32 header words, 4-byte aligned JSON), not a
  // convenient invention. A fixture built from the same misconception as the parser
  // validates only that the two agree with each other.
  const json = Buffer.from(JSON.stringify(listing));
  const padding = (4 - (json.length % 4)) % 4;
  const aligned = Buffer.concat([json, Buffer.alloc(padding)]);
  const headerPayloadSize = 4 + aligned.length;
  const headerPickleSize = 4 + headerPayloadSize;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerPickleSize, 4);
  header.writeUInt32LE(headerPayloadSize, 8);
  header.writeUInt32LE(json.length, 12);
  // data section begins at 8 + headerPickleSize === 16 + aligned.length
  return Buffer.concat([header, aligned, ...contents]);
}

async function fixture(root, files) {
  await fs.mkdir(path.join(root, 'resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'app.exe'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, 'resources', 'app.asar'), asar(files));
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'toolchain-audit-'));
try {
  const dirty = path.join(temp, 'dirty');
  const dirtyText = `const cp = require('node:child_process');\ncp.spawn('node', ['C:\\\\Users\\\\builder\\\\secret.js'], { windowsHide: true });\n`;
  await fixture(dirty, { 'dist/main.js': dirtyText });
  const dirtyRun = spawnSync(process.execPath, [tool.pathname, '--dir', dirty], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.notEqual(dirtyRun.status, 0, 'dirty fixture must be red');
  const dirtyOutput = dirtyRun.stdout + dirtyRun.stderr;
  assert.match(dirtyOutput, /resources\/app\.asar::dist\/main\.js/);
  assert.match(dirtyOutput, /"byteOffset":\s*\d+/);
  assert.match(dirtyOutput, /definitely a command/);

  const clean = path.join(temp, 'clean');
  await fixture(clean, { 'dist/main.js': `// Documentation example: spawn('node') is not executed.\nconsole.log('packaged and ready');\n` });
  const cleanRun = spawnSync(process.execPath, [tool.pathname, '--dir', clean], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.equal(cleanRun.status, 0, cleanRun.stdout + cleanRun.stderr);
  assert.match(cleanRun.stdout, /PASS:/);

  const corrupt = path.join(temp, 'corrupt');
  await fs.mkdir(path.join(corrupt, 'resources'), { recursive: true });
  await fs.writeFile(path.join(corrupt, 'resources', 'app.asar'), 'not an asar');
  const corruptRun = spawnSync(process.execPath, [tool.pathname, '--dir', corrupt], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.notEqual(corruptRun.status, 0, 'corrupt asar must fail closed');
  assert.match(corruptRun.stdout + corruptRun.stderr, /corrupt asar/i);

  // Five-shape blindness census, measured against this repository's gate. The
  // labels are deliberately stable so the regression run is also the report of
  // what was and was not reproducible.
  /* Shape 1, main-module identity. On a case-insensitive filesystem the
   * ALTERNATE-CASE spelling is the real discriminator and needs no privilege:
   * argv[1] keeps the invoked casing while import.meta.url is canonical, so a
   * string-comparing guard answers false and the tool exits 0 having audited
   * nothing. A COPY cannot substitute -- a copy's two paths are identical, so a
   * broken guard passes it too. The symlink variant is kept for platforms where
   * case cannot differ, and is skipped LOUDLY when the account cannot create
   * one, because a silent skip is how an unmeasured case reads as a pass. */
  const identityNotes = [];
  /* Respell argv[1] so the guard's two compared values differ as STRINGS while
   * naming one file. Proven to discriminate: under a string-equality mutant the
   * tool does not recognise itself and the audit never runs. Assert on the
   * audit's OWN OUTPUT, never a non-zero exit -- a module that failed to load
   * exits non-zero too. */
  const respelledRun = spawnSync(process.execPath, [...respellArgv1Prefix(), toolPathOnDisk, '--dir', dirty],
    { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.match(respelledRun.stdout, /BEGIN TOOLCHAIN INDEPENDENCE JSON/,
    'a respelled argv[1] must still EXECUTE the audit, not merely exit non-zero');
  assert.notEqual(respelledRun.status, 0, 'the dirty fixture must still grade red through the respelled path');
  identityNotes.push('CHECKED: argv[1] respelled to a different string for the same file; the audit still ran '
    + 'and graded the dirty fixture red. Mutation-proven: a string-comparing guard fails this.');
  const symlinks = symlinkCapability();
  if (symlinks.available) {
    const linkedTool = path.join(temp, 'toolchain-audit-link.mjs');
    await fs.symlink(tool.pathname, linkedTool, 'file');
    const linkedRun = spawnSync(process.execPath, [linkedTool, '--dir', dirty], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
    assert.notEqual(linkedRun.status, 0, 'a symlink spelling of the main module must still execute the audit');
    identityNotes.push('CHECKED: symlink spelling still executed the audit.');
  } else {
    identityNotes.push(`NOT CHECKED: symlink identity -- ${symlinks.reason}`);
  }

  const empty = path.join(temp, 'empty');
  await fs.mkdir(empty);
  const emptyRun = spawnSync(process.execPath, [tool.pathname, '--dir', empty], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.notEqual(emptyRun.status, 0, 'an empty enumeration must be unproven, never PASS');
  assert.match(emptyRun.stdout, /FAIL: 0 text files scanned/);

  const missing = path.join(temp, 'missing');
  const missingRun = spawnSync(process.execPath, [tool.pathname, '--dir', missing], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.equal(missingRun.status, 2, 'a missing input must be reported as an audit error');
  assert.match(missingRun.stdout, /"ok": false/);

  const extra = path.join(temp, 'extra');
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'declared.js'), "console.log('clean');\n");
  // SPAWN-ALLOWLIST: the token below is fixture text written for the audit to
  // reject, not a child-process call executed by this self-test.
  await fs.writeFile(path.join(extra, 'undeclared.js'), "spawn('node');\n");
  const extraRun = spawnSync(process.execPath, [tool.pathname, '--dir', extra], { env: safeLaunchEnvironment(process.env, { context: 'toolchain-independence-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.notEqual(extraRun.status, 0, 'every enumerated regular file, including an unnamed extra, must be audited');
  assert.match(extraRun.stdout, /undeclared\.js/);

  // A corrupt readable archive is an explicit could-not-measure path. It is
  // distinguished from a policy-negative result by exit 2 and an error field.
  assert.equal(corruptRun.status, 2);
  assert.match(corruptRun.stdout, /"error":/);

  console.log('EXECUTABLE CHANGE');
  for (const note of identityNotes) console.log(`1 ${note}`);
  console.log('2 REPRODUCED: input=empty directory; before the fix it returned PASS with 0 scanned; now red.');
  console.log('3 NOT-REPRODUCED: input=missing directory; it returned exit 2 with ok=false and an error.');
  console.log('4 NOT-REPRODUCED: input=clean declared.js plus command-bearing undeclared.js; the extra was scanned and returned red.');
  console.log('5 NOT-REPRODUCED: input=corrupt readable app.asar; could-not-read returned distinct exit 2 with an error, not a policy verdict.');
  console.log('Identity shapes are reported individually above; an unmeasured one names why and is NOT a pass.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
