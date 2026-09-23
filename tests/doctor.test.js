'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-doctor-test-'));
const preloadPath = path.join(temporaryRoot, 'doctor-stub.cjs');

fs.writeFileSync(preloadPath, [
  "'use strict';",
  "const Module = require('node:module');",
  'const originalLoad = Module._load;',
  'Module._load = function(request, parent, isMain) {',
  "  if (request === './lib/system-status' && parent && /[\\\\/]src[\\\\/]doctor\\.js$/.test(parent.filename)) {",
  '    return { doctor: () => JSON.parse(process.env.DOCTOR_TEST_REPORT) };',
  '  }',
  '  return originalLoad.call(this, request, parent, isMain);',
  '};',
  ''
].join('\n'), 'utf8');

function runDoctor(report) {
  return spawnSync(process.execPath, ['--require', preloadPath, 'src/doctor.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DOCTOR_TEST_REPORT: JSON.stringify(report) }
  });
}

const healthy = {
  policy: {},
  mcpServer: {},
  browser: 'available',
  state: { ok: true },
  audit: { ok: true, verification: { valid: true } }
};

try {
  const healthyResult = runDoctor(healthy);
  assert.equal(healthyResult.status, 0, healthyResult.stderr);
  assert.deepEqual(JSON.parse(healthyResult.stdout), healthy,
    'the CLI must print the exact diagnostic report it evaluated');

  const failures = [
    ['empty report', {}],
    ['missing browser result', { ...healthy, browser: undefined }],
    ['unavailable transactional state', { ...healthy, state: { ok: false } }],
    ['unavailable audit state', { ...healthy, audit: { ok: false, verification: { valid: true } } }],
    ['missing audit verification', { ...healthy, audit: { ok: true } }],
    ['invalid audit verification', { ...healthy, audit: { ok: true, verification: { valid: false } } }]
  ];

  for (const [label, report] of failures) {
    const result = runDoctor(report);
    assert.equal(result.status, 1, `${label} must make doctor exit unsuccessfully; stderr: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(report)),
      `${label} must still emit its diagnostic evidence`);
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Doctor CLI fail-closed tests passed.');
