#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { respellArgv1Prefix, symlinkCapability } from './path-identity-capability.mjs';
import { fileURLToPath } from 'node:url';
import { auditBuilderConfig, auditExe } from './installer-identity-audit.mjs';
/* Children must never inherit the ambient environment: this machine's env
   carries provider keys, and Windows env names are case-insensitive, so a
   hand-rolled delete list misses casings. The shared scrubber proves the
   scrub held. Added when the spawn gate flagged these exact sites. */
import launchEnvironment from '../../src/lib/providers/subscription-launch-env.js';

// The compatibility module exports a frozen CommonJS object. Node's static
// named-export inference does not expose fields of Object.freeze({...}).
const { safeLaunchEnvironment } = launchEnvironment;

const align4 = (value) => (value + 3) & ~3;
const wide = (text) => Buffer.from(`${text}\0`, 'utf16le');

function block(key, value, type, children = []) {
  const keyBytes = wide(key);
  const valueBytes = type === 1 ? wide(value) : value;
  const valueLength = type === 1 ? valueBytes.length / 2 : valueBytes.length;
  let length = align4(6 + keyBytes.length) + valueBytes.length;
  length = align4(length);
  for (const child of children) length += align4(child.length);
  const output = Buffer.alloc(length);
  output.writeUInt16LE(length, 0);
  output.writeUInt16LE(valueLength, 2);
  output.writeUInt16LE(type, 4);
  keyBytes.copy(output, 6);
  let cursor = align4(6 + keyBytes.length);
  valueBytes.copy(output, cursor);
  cursor = align4(cursor + valueBytes.length);
  for (const child of children) { child.copy(output, cursor); cursor += align4(child.length); }
  return output;
}

function versionInfo(companyName) {
  const values = {
    CompanyName: companyName,
    FileDescription: 'ToolsEnabled Desktop',
    ProductName: 'ToolsEnabled',
    ProductVersion: '1.2.3',
    FileVersion: '1.2.3.4',
    LegalCopyright: 'Copyright 2026 ToolsEnabled',
    OriginalFilename: 'ToolsEnabled.exe',
  };
  const table = block('040904B0', Buffer.alloc(0), 1, Object.entries(values).map(([key, value]) => block(key, value, 1)));
  const stringFileInfo = block('StringFileInfo', Buffer.alloc(0), 1, [table]);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(0x00010002, 8);
  fixed.writeUInt32LE(0x00030004, 12);
  fixed.writeUInt32LE(0x00010002, 16);
  fixed.writeUInt32LE(0x00030000, 20);
  return { bytes: block('VS_VERSION_INFO', fixed, 0, [stringFileInfo]), values };
}

function minimalPe(companyName) {
  const version = versionInfo(companyName);
  const rawOffset = 0x200;
  const resourceRva = 0x1000;
  const dataRelative = 0x80;
  const resource = Buffer.alloc(align4(dataRelative + version.bytes.length));
  resource.writeUInt16LE(1, 14);
  resource.writeUInt32LE(16, 16);
  resource.writeUInt32LE(0x80000020, 20);
  resource.writeUInt16LE(1, 0x20 + 14);
  resource.writeUInt32LE(1, 0x30);
  resource.writeUInt32LE(0x80000040, 0x34);
  resource.writeUInt16LE(1, 0x40 + 14);
  resource.writeUInt32LE(0x409, 0x50);
  resource.writeUInt32LE(0x60, 0x54);
  resource.writeUInt32LE(resourceRva + dataRelative, 0x60);
  resource.writeUInt32LE(version.bytes.length, 0x64);
  version.bytes.copy(resource, dataRelative);
  const file = Buffer.alloc(rawOffset + resource.length);
  file.write('MZ', 0, 'ascii');
  file.writeUInt32LE(0x80, 0x3c);
  file.write('PE\0\0', 0x80, 'ascii');
  file.writeUInt16LE(0x14c, 0x84);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(0xe0, 0x94);
  const optional = 0x98;
  file.writeUInt16LE(0x10b, optional);
  file.writeUInt32LE(16, optional + 92);
  file.writeUInt32LE(resourceRva, optional + 112);
  file.writeUInt32LE(resource.length, optional + 116);
  const section = optional + 0xe0;
  file.write('.rsrc\0\0\0', section, 'ascii');
  file.writeUInt32LE(resource.length, section + 8);
  file.writeUInt32LE(resourceRva, section + 12);
  file.writeUInt32LE(resource.length, section + 16);
  file.writeUInt32LE(rawOffset, section + 20);
  resource.copy(file, rawOffset);
  return { file, values: version.values };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'installer-identity-audit-'));
try {
  const badExe = path.join(root, 'empty-company.exe');
  await writeFile(badExe, minimalPe('').file);
  const redExe = await auditExe(badExe);
  assert.equal(redExe.status, 'FAIL', 'empty CompanyName fixture must be red first');
  assert.deepEqual(redExe.problems, [{ path: 'CompanyName', reason: 'missing-or-empty' }]);

  const good = minimalPe('ToolsEnabled, Inc.');
  const goodExe = path.join(root, 'complete.exe');
  await writeFile(goodExe, good.file);
  const greenExe = await auditExe(goodExe);
  assert.equal(greenExe.status, 'PASS');
  assert.deepEqual(greenExe.fields, good.values);
  assert.deepEqual(greenExe.fixedFileInfo, { fileVersion: '1.2.3.4', productVersion: '1.2.3.0' });

  const garbage = path.join(root, 'garbage.exe');
  await writeFile(garbage, Buffer.from('MZ garbage'));
  const unparsed = await auditExe(garbage);
  assert.equal(unparsed.status, 'FAIL');
  assert.equal(unparsed.parsed, false);
  assert.equal(unparsed.fields, null);
  assert.equal(unparsed.problems[0].reason, 'unparsed');

  const project = path.join(root, 'project');
  const schemaDirectory = path.join(project, 'node_modules', 'app-builder-lib');
  await mkdir(schemaDirectory, { recursive: true });
  const packagePath = path.join(project, 'package.json');
  await writeFile(packagePath, JSON.stringify({ build: { appId: 'dev.toolsenabled', win: { target: 'nsis', signExecutable: true }, nsis: { oneClick: false }, directories: { output: 'dist' } } }));
  const schema = {
    definitions: {
      Configuration: { type: 'object', properties: {
        appId: { type: 'string' },
        win: { $ref: '#/definitions/Win' },
        nsis: { type: 'object', properties: { oneClick: { type: 'boolean' } } },
        directories: { type: 'object', properties: { output: { type: 'string' } } },
        mac: { type: 'object', properties: {} }, linux: { type: 'object', properties: {} },
      } },
      Win: { type: 'object', properties: { target: { type: 'string' } } },
    },
  };
  await writeFile(path.join(schemaDirectory, 'scheme.json'), JSON.stringify(schema));
  const redConfig = await auditBuilderConfig(packagePath);
  assert.equal(redConfig.status, 'FAIL', 'unknown nested key fixture must be red first');
  assert.deepEqual(redConfig.unknownKeys, ['$.build.win.signExecutable']);
  assert(!redConfig.unknownKeys.includes('$.build.win.target'));
  assert(!redConfig.unknownKeys.includes('$.build.nsis.oneClick'));

  await writeFile(packagePath, JSON.stringify({ build: { appId: 'dev.toolsenabled', win: { target: 'nsis' }, nsis: { oneClick: false }, directories: { output: 'dist' } } }));
  const greenConfig = await auditBuilderConfig(packagePath);
  assert.equal(greenConfig.status, 'PASS');
  assert.deepEqual(greenConfig.unknownKeys, []);

  const missingProject = path.join(root, 'missing-schema');
  await mkdir(missingProject);
  const missingPackage = path.join(missingProject, 'package.json');
  await writeFile(missingPackage, JSON.stringify({ build: { win: { target: 'nsis' } } }));
  const unknown = await auditBuilderConfig(missingPackage);
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.problems[0].reason, 'schema-not-found');
  const toolPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'installer-identity-audit.mjs');
  const missingSchemaCli = spawnSync(process.execPath, [toolPath, '--package-json', missingPackage], { env: safeLaunchEnvironment(process.env, { context: 'installer-identity-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.equal(missingSchemaCli.status, 1, 'UNKNOWN schema result must exit non-zero');
  assert.match(missingSchemaCli.stdout, /"status": "UNKNOWN"/u);

  // Blindness census (observations before this regression fix are recorded inline).
  // (1) Main-module identity. The alternate-case spelling needs no privilege and
  // is the discriminator that matters on Windows; the symlink variant is skipped
  // LOUDLY when the account cannot create one.
  const identityNotes = [];
  /* Respell argv[1]: a different string for the same file, which is the pair the
   * guard compares. Mutation-proven to discriminate. */
  const respelledRun = spawnSync(process.execPath, [...respellArgv1Prefix(), toolPath], { env: safeLaunchEnvironment(process.env, { context: 'installer-identity-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
  assert.match(respelledRun.stdout, /Installer identity audit: FAIL/u,
    'a respelled argv[1] must still EXECUTE the audit');
  assert.equal(respelledRun.status, 1);
  identityNotes.push('CHECKED: argv[1] respelled to a different string for the same file; the audit still ran. '
    + 'Mutation-proven: a string-comparing guard fails this.');
  const symlinks = symlinkCapability();
  if (symlinks.available) {
    const linkedTool = path.join(root, 'INSTALLER-IDENTITY-AUDIT.mjs');
    await symlink(toolPath, linkedTool);
    const linkedRun = spawnSync(process.execPath, [linkedTool], { env: safeLaunchEnvironment(process.env, { context: 'installer-identity-audit.selftest.mjs' }), encoding: 'utf8', windowsHide: true });
    assert.equal(linkedRun.status, 1);
    assert.match(linkedRun.stdout, /Installer identity audit: FAIL/u);
    identityNotes.push('CHECKED: symlink spelling still ran the audit.');
  } else {
    identityNotes.push(`NOT CHECKED: symlink identity -- ${symlinks.reason}`);
  }

  // (2) Before the fix, Object.entries({}) produced no findings and therefore PASS.
  await writeFile(packagePath, JSON.stringify({ build: {} }));
  const emptyBuild = await auditBuilderConfig(packagePath);
  assert.equal(emptyBuild.status, 'FAIL');
  assert.equal(emptyBuild.problems[0].reason, 'empty-build-config');

  // (3) Before the fix, packageJson.build ?? {} made an absent input PASS.
  await writeFile(packagePath, JSON.stringify({ name: 'missing-build' }));
  const absentBuild = await auditBuilderConfig(packagePath);
  assert.equal(absentBuild.status, 'FAIL');
  assert.equal(absentBuild.problems[0].reason, 'missing-build-config');

  // (4) Existing recursive comparison already rejected an undeclared extra.
  await writeFile(packagePath, JSON.stringify({ build: { appId: 'dev.toolsenabled', surprise: true } }));
  const extraBuild = await auditBuilderConfig(packagePath);
  assert.equal(extraBuild.status, 'FAIL');
  assert.deepEqual(extraBuild.unknownKeys, ['$.build.surprise']);

  // (5) Before the fix, a missing executable was collapsed into a definite FAIL parse verdict.
  const unreadableExe = await auditExe(path.join(root, 'does-not-exist.exe'));
  assert.equal(unreadableExe.status, 'UNKNOWN');
  assert.equal(unreadableExe.problems[0].reason, 'exe-unreadable');

  console.log('EXECUTABLE CHANGE');
  for (const note of identityNotes) console.log(`(1) ${note}`);
  console.log('(2) REPRODUCED — input: package.json with build: {}; before: PASS; now: FAIL empty-build-config.');
  console.log('(3) REPRODUCED — input: package.json with no build property; before: PASS; now: FAIL missing-build-config.');
  console.log('(4) NOT-REPRODUCED — input: build.appId plus undeclared build.surprise; existing audit returned FAIL with $.build.surprise.');
  console.log('(5) REPRODUCED — input: nonexistent --exe path; before: definite FAIL/unparsed; now: UNKNOWN/exe-unreadable (and CLI remains closed with exit 1).');
  console.log(JSON.stringify({ selftest: 'installer-identity-audit', status: 'PASS' }, null, 2));
  console.log('Installer identity audit self-test: PASS (red-first PE, unparsed PE, red-first schema, green fixtures, and missing schema verified)');
} finally {
  await rm(root, { recursive: true, force: true });
}
