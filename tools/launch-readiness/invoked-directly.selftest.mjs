#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokedDirectly } from './invoked-directly.mjs';
import { caseInsensitiveFilesystem, caseVariantOf, symlinkCapability } from './path-identity-capability.mjs';
import { join as joinPath } from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'invoked-directly-'));
const notes = [];
try {
  const entry = path.join(root, 'entry.mjs');
  const alias = path.join(root, 'alias.mjs');
  await writeFile(entry, '');

  /* ORDER IS LOAD-BEARING. The symlink case used to run FIRST and unguarded, so
   * on an unprivileged Windows account it threw EPERM and killed the four
   * assertions below -- which need no privilege and cover the could-not-collapse
   * behaviour this guard exists for. Everything portable now runs first, and the
   * privileged case is last and conditional. */
  assert.throws(() => invokedDirectly(pathToFileURL(entry).href, null),
    /without process\.argv\[1\]/u, 'missing entry input must not skip the gate');
  assert.throws(() => invokedDirectly(pathToFileURL(entry).href, []),
    /(?:path|string|Buffer|URL)/u, 'an empty enumeration must not skip the gate');
  assert.throws(() => invokedDirectly(pathToFileURL(entry).href, entry, 'unnamed'),
    /undeclared inputs/u, 'undeclared inputs must not pass unnamed');
  assert.throws(() => invokedDirectly(pathToFileURL(entry).href, path.join(root, 'missing.mjs')),
    /ENOENT/u, 'an unreadable entry path must not become a negative guard verdict');

  /* THE PORTABLE DISCRIMINATOR, and on Windows the stronger of the two: the same
   * file named with different casing. A string-comparing guard fails this; a
   * canonicalising one passes. No privilege required. */
  /* A REDUNDANT-SEGMENT respelling: a different string for the same file, and
   * unlike the case variant it discriminates on every platform, not only
   * case-insensitive ones. This is the same divergence the spawned tools use. */
  const respelled = joinPath(path.dirname(entry), '.', path.basename(entry))
    .replace(path.basename(entry), `.${path.sep}${path.basename(entry)}`);
  assert.notEqual(respelled, entry, 'the respelling must actually differ as a string, or it proves nothing');
  assert.equal(invokedDirectly(pathToFileURL(entry).href, respelled), true,
    'a redundantly-spelled path to the same file must retain filesystem identity');
  notes.push('CHECKED: redundant-segment respelling retained identity (portable).');

  const variant = caseVariantOf(entry);
  if (caseInsensitiveFilesystem() && variant) {
    assert.equal(invokedDirectly(pathToFileURL(entry).href, variant), true,
      'a case-folded spelling of the entry must retain filesystem identity');
    notes.push('CHECKED: alternate-case spelling retained identity.');
  } else {
    notes.push(`NOT CHECKED: alternate-case identity, because ${process.platform} filesystems are `
      + 'case-sensitive, so a case variant names a different file. Unmeasured here, not passing.');
  }

  /* Genuinely link-following: two DIFFERENT paths that must resolve to one file.
   * A copy cannot stand in -- a copy is a different file. */
  const symlinks = symlinkCapability();
  if (symlinks.available) {
    await symlink(entry, alias);
    assert.equal(invokedDirectly(pathToFileURL(entry).href, alias), true,
      'a symlink spelling of the entry must retain filesystem identity');
    notes.push('CHECKED: symlink spelling retained identity.');
  } else {
    notes.push(`NOT CHECKED: symlink identity -- ${symlinks.reason}`);
  }

  console.log('PASS: missing, empty, undeclared and unreadable inputs all failed closed.');
  for (const note of notes) console.log(`  ${note}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
