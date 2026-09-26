'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platformGenerator = require('../../tools/generate-platform-contracts');

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts');

function isArtifact(target) {
  const relative = path.relative(ARTIFACT_ROOT, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function machineWidePython() {
  const systemRoot = path.parse(process.execPath).root;
  const candidates = process.platform === 'win32' ? [
    path.join(systemRoot, 'Program Files (x86)', 'Microsoft Visual Studio', 'Shared', 'Python39_64', 'python.exe'),
    path.join(systemRoot, 'Program Files', 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE',
      'CommonExtensions', 'Microsoft', 'VC', 'SecurityIssueAnalysis', 'python', 'python.exe')
  ] : ['/usr/bin/python3', '/usr/local/bin/python3'];
  const selected = candidates.map(candidate => {
    try {
      // Linux distributions install python3 as a root-owned version symlink.
      // Resolve only these fixed system candidates and execute the real file.
      const resolved = process.platform === 'linux' ? fs.realpathSync(candidate) : candidate;
      if (process.platform === 'linux'
        && !['/usr/bin', '/usr/local/bin'].includes(path.dirname(resolved))) return null;
      const stat = fs.lstatSync(resolved);
      return stat.isFile() && !stat.isSymbolicLink() ? resolved : null;
    } catch { return null; }
  }).find(Boolean);
  assert.ok(selected,
    `cross-language contract validation requires a machine-wide Python runtime; checked: ${candidates.join(', ')}`);
  return selected;
}

function createPlatformContractFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-contract-artifacts-'));
  const mapped = new Map();
  const rendered = platformGenerator.renderAll();
  for (const [target, content] of rendered) {
    if (isArtifact(target)) {
      const disposable = path.join(temporaryRoot, path.basename(target));
      fs.writeFileSync(disposable, content, 'utf8');
      mapped.set(target, disposable);
      continue;
    }
    assert.equal(fs.existsSync(target), true, `generated contract output is missing: ${path.relative(ROOT, target)}`);
    assert.equal(fs.readFileSync(target, 'utf8'), content,
      `generated contract output is stale: ${path.relative(ROOT, target)}`);
    mapped.set(target, target);
  }
  const cleanup = () => {
    try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch {}
  };
  process.once('exit', cleanup);
  return Object.freeze({
    rendered,
    pathFor(target) {
      const resolved = mapped.get(target);
      assert.ok(resolved, `generated output was not rendered: ${target}`);
      return resolved;
    },
    temporaryRoot
  });
}

module.exports = Object.freeze({ createPlatformContractFixture, machineWidePython });
