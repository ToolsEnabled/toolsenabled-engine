/* Mutation check (2026-08-27):
 * In src/lib/providers/extension.js, changed the version-part maximum
 * from `Number(part) <= 65535` to `Number(part) <= 65536`.
 * The edit landed, and this isolated test went red on `1.65536`.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const extension = require('../../src/lib/providers/extension');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-provider-test-'));

try {
  assert.equal(extension.validVersion('1.2.3.65535'), true);
  for (const version of ['', '0', '01.2', '1.65536', '1.2.3.4.5']) {
    assert.equal(extension.validVersion(version), false, `${version || '<empty>'} must be rejected`);
  }

  const manifest = {
    manifest_version: 3,
    name: 'Behavior fixture',
    version: '1.2.3',
    description: 'Exercises the public extension-provider validation behavior.',
    icons: { 128: 'icon.png' },
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['https://example.test/*'], js: ['content.js'] }]
  };
  for (const file of ['icon.png', 'popup.html', 'content.js']) {
    fs.writeFileSync(path.join(root, file), file);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));

  assert.deepEqual(extension.manifestReferences(manifest), [
    ['icon.png', 'manifest.icons.128'],
    ['popup.html', 'manifest.action.default_popup'],
    ['content.js', 'manifest.content_scripts[0].js[0]']
  ]);

  const valid = extension.validation({ cwd: root });
  assert.equal(valid.valid, true, valid.errors.join('\n'));
  assert.deepEqual(valid.manifest, { name: 'Behavior fixture', version: '1.2.3', manifestVersion: 3 });

  manifest.action.default_popup = '../outside.html';
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const invalid = extension.validation({ cwd: root });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes('manifest.action.default_popup must stay inside the extension directory: ../outside.html'));

  if (process.platform === 'linux') {
    manifest.action.default_popup = 'popup.html';
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: excluded-worktree-metadata');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'nested'));
    fs.mkdirSync(path.join(root, 'nested', '.git'));
    fs.writeFileSync(path.join(root, 'nested', '.git', 'excluded'), 'excluded');
    fs.writeFileSync(path.join(root, 'node_modules', 'excluded'), 'excluded');
    fs.writeFileSync(path.join(root, 'nested', 'source.js.map'), 'excluded');
    fs.writeFileSync(path.join(root, 'nested', 'sentinel.js'), 'export const value = "βeta";\n');
    const destination = `${root}.zip`;
    try {
      const packaged = extension.packageExtension({ cwd: root, outputPath: destination });
      assert.equal(packaged.valid, true);
      assert.equal(packaged.bytes, fs.statSync(destination).size);
      const inspected = spawnSync('/usr/bin/python3', ['-I', '-c',
        'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"names":z.namelist(),"sentinel":z.read("nested/sentinel.js").decode(),"corrupt":z.testzip()}))', destination
      ], { encoding: 'utf8' });
      assert.equal(inspected.status, 0, inspected.stderr);
      const contents = JSON.parse(inspected.stdout);
      assert.deepEqual(contents.names.sort(), ['content.js', 'icon.png', 'manifest.json', 'nested/sentinel.js', 'popup.html']);
      assert.equal(contents.sentinel, 'export const value = "βeta";\n');
      assert.equal(contents.corrupt, null);
      const before = fs.readFileSync(destination);
      assert.throws(() => extension.packageExtension({ cwd: root, outputPath: destination }), /overwrite/);
      assert.deepEqual(fs.readFileSync(destination), before);
      assert.throws(() => extension.packageExtension({ cwd: root, outputPath: path.join(root, 'inside.zip') }), /outside/);
    } finally { fs.rmSync(destination, { force: true }); }
  }

  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'credentials.json'), '{}');
  assert.deepEqual(extension.findUnsafeEntry(root), {
    path: path.join('assets', 'credentials.json'),
    reason: 'credential-like files are not allowed in extension packages'
  });

  console.log('extension provider behavior checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
