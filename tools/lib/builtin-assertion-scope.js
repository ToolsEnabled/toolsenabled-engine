'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileHash, validateRequest, validateAssertionEvidence } = require('./builtin-assertion-evidence');
const MANIFEST = 'tests/builtin-assertion-scopes.json';
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const relativeFile = (root, file) => {
  if (typeof file !== 'string' || !file || /[\\:\0]/.test(file) || path.posix.isAbsolute(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid reviewed assertion source path');
  const result = path.join(root, ...file.split('/'));
  if (fs.realpathSync(result) !== result || !fs.statSync(result).isFile()) throw new Error('reviewed assertion source must be a real regular file');
  return result;
};
const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error('unsupported assertion scope fields');
};

function createBuiltinAssertionRun(root, outputRoot) {
  if (path.resolve(root) !== root || fs.realpathSync(root) !== root) throw new Error('assertion source root must be a real absolute path');
  if (path.resolve(outputRoot) !== outputRoot || inside(root, outputRoot)
      || fs.realpathSync(path.dirname(outputRoot)) !== path.dirname(outputRoot)) throw new Error('retained assertion evidence must be outside the source tree with a real parent');
  const manifestPath = relativeFile(root, MANIFEST);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, ['schemaVersion', 'unit', 'programs']);
  if (manifest.schemaVersion !== 1 || manifest.unit !== 'outermost-builtin-assert-call' || !Array.isArray(manifest.programs) || !manifest.programs.length) throw new Error('invalid assertion scope manifest');
  const programs = new Map();
  for (const row of manifest.programs) {
    exactKeys(row, ['file', 'modules', 'excludedAssertions', 'expectedAssertions', 'sourceClosure', 'review']);
    if (!/\.(?:cjs|js)$/.test(row.file) || programs.has(row.file) || typeof row.review !== 'string' || row.review.trim().length < 32
        || !Number.isSafeInteger(row.expectedAssertions) || row.expectedAssertions < 1 || !Array.isArray(row.modules) || !row.modules.includes(row.file)
        || new Set(row.modules).size !== row.modules.length || !Array.isArray(row.sourceClosure)
        || !Array.isArray(row.excludedAssertions) || new Set(row.excludedAssertions).size !== row.excludedAssertions.length) throw new Error('invalid reviewed assertion program');
    const closure = new Map();
    for (const source of row.sourceClosure) {
      exactKeys(source, ['file', 'sha256']);
      const file = relativeFile(root, source.file);
      if (closure.has(source.file) || !/^[a-f0-9]{64}$/.test(source.sha256) || fileHash(file) !== source.sha256) throw new Error('changed or duplicate reviewed assertion source');
      closure.set(source.file, { path: file, sha256: source.sha256 });
    }
    if (row.modules.some(file => !closure.has(file))) throw new Error('assertion closure omits a measured fixture');
    if (row.excludedAssertions.some(file => !closure.has(file) || row.modules.includes(file))) throw new Error('assertion closure omits or measures an excluded source');
    programs.set(row.file, { ...row, sourceClosure: [...closure.values()], modules: row.modules.map(file => closure.get(file)),
      excludedAssertions: row.excludedAssertions.map(file => closure.get(file)) });
  }
  // A caller must select a fresh leaf; no previous trace can be overwritten or
  // mistaken for this run, and none lives inside the deleted test-state tree.
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  const authority = [manifestPath, path.join(root, 'tests/run-isolated.js'),
    path.join(root, 'tests/lib/isolated-child.js'), path.join(root, 'src/lib/linux-process-control.js'),
    path.join(root, 'src/lib/linux-process-supervisor.py'), __filename].map(file => ({ path: file, sha256: fileHash(file) }));
  const expectedHarness = [path.join(root, 'tools/lib/builtin-assertion-evidence.js'), path.join(root, 'tools/measure-builtin-assertions.js')]
    .map(file => ({ path: file, sha256: fileHash(file) }));
  const expectedNode = { path: process.execPath, version: process.version, sha256: fileHash(process.execPath) };
  const artifact = file => ({ path: path.relative(outputRoot, file).split(path.sep).join('/'), sha256: fileHash(file), bytes: fs.statSync(file).size });
  return {
    prepare(file, index) {
      const row = programs.get(file);
      if (!row) return null;
      for (const source of authority) if (fileHash(source.path) !== source.sha256) throw new Error('assertion measurement authority changed before invocation');
      const directory = path.join(outputRoot, String(index + 1).padStart(5, '0'));
      fs.mkdirSync(directory, { mode: 0o700 });
      const requestPath = path.join(directory, 'request.json');
      const request = { schemaVersion: 1, nonce: crypto.randomBytes(24).toString('hex'), root,
        entry: relativeFile(root, file), args: [], modules: row.modules, excludedAssertions: row.excludedAssertions,
        sourceClosure: [...row.sourceClosure, { path: manifestPath, sha256: manifestSha256 }],
        expectedAssertions: row.expectedAssertions, tracePath: path.join(directory, 'trace.jsonl') };
      validateRequest(request);
      fs.writeFileSync(requestPath, JSON.stringify(request, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const argv = [process.execPath, expectedHarness[1].path, '--request', requestPath];
      return {
        argv,
        finish(result) {
          const stdoutPath = path.join(directory, 'stdout.log');
          const stderrPath = path.join(directory, 'stderr.log');
          fs.writeFileSync(stdoutPath, result.stdout || Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(stderrPath, result.stderr || Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
          const measurement = { schemaVersion: 1, outputRoot, file, argv, cwd: root,
            authority, expectedHarness, expectedNode, scopeManifest: { file: MANIFEST, sha256: manifestSha256 },
            process: { pid: result.pid, exitCode: result.status, signal: result.signal || null, error: result.error?.code || null },
            request: artifact(requestPath), stdout: artifact(stdoutPath), stderr: artifact(stderrPath),
            trace: fs.existsSync(request.tracePath) ? artifact(request.tracePath) : null };
          try {
            for (const source of authority) if (fileHash(source.path) !== source.sha256) throw new Error('assertion measurement authority changed during invocation');
            if (!measurement.trace) throw new Error('assertion trace was not produced');
            const evidence = validateAssertionEvidence({ trace: fs.readFileSync(request.tracePath, 'utf8'), request, result,
              expectedHarness, expectedNode, expectedPlatform: process.platform, expectedCwd: root });
            return { evidence, measurement };
          } catch (error) { return { measurement, evidenceError: error.message }; }
        }
      };
    }
  };
}

module.exports = { MANIFEST, createBuiltinAssertionRun };
