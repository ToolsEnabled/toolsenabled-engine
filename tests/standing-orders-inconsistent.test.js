'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { assertConsistent } = require('../src/lib/standing-orders');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-orders-inconsistent-'));
const mdPath = path.join(fixtureDir, 'STANDING-ORDERS.md');
const jsonPath = path.join(fixtureDir, 'standing-orders.json');

fs.writeFileSync(mdPath, [
  '## Class: OUTWARD',
  '',
  '1. Existing order.',
  '2. Markdown-only order.',
  ''
].join('\n'));
fs.writeFileSync(jsonPath, JSON.stringify({
  sessionBoot: [{ number: 1, instruction: 'Read the orders.' }],
  classes: [{
    id: 'OUTWARD',
    orders: [{
      number: '1',
      summary: 'Existing order.',
      verbatim: 'a fabricated owner quotation',
      enforcement: 'discipline',
      enforcingComponent: null,
      revocationPhrase: null
    }, {
      number: '3',
      summary: 'JSON-only order.',
      verbatim: null,
      enforcement: 'discipline',
      enforcingComponent: null,
      revocationPhrase: null
    }]
  }]
}));

let writeCount = 0;
let spawnCount = 0;
const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

fs.writeFileSync = (...args) => { writeCount += 1; return originalWriteFileSync(...args); };
fs.appendFileSync = (...args) => { writeCount += 1; return originalAppendFileSync(...args); };
childProcess.spawn = (...args) => { spawnCount += 1; return originalSpawn(...args); };
childProcess.spawnSync = (...args) => { spawnCount += 1; return originalSpawnSync(...args); };

try {
  assert.throws(
    () => assertConsistent({ mdPath, jsonPath }),
    (error) => {
      assert.equal(error.code, 'STANDING_ORDERS_INCONSISTENT');
      assert.deepEqual(error.issues, [
        'Class "OUTWARD" order 2 exists in STANDING-ORDERS.md but not in standing-orders.json.',
        'Class "OUTWARD" order 3 exists in standing-orders.json but not in STANDING-ORDERS.md.',
        'Class "OUTWARD": JSON verbatim/revocationPhrase text does not appear as a quoted substring in STANDING-ORDERS.md: "a fabricated owner quotation"'
      ]);
      assert.match(error.message, /^STANDING-ORDERS\.md and standing-orders\.json have diverged:/);
      return true;
    }
  );
  assert.equal(writeCount, 0, 'a consistency refusal must not write');
  assert.equal(spawnCount, 0, 'a consistency refusal must not spawn');
  console.log('standing-orders inconsistent refusal tests passed');
} finally {
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  childProcess.spawn = originalSpawn;
  childProcess.spawnSync = originalSpawnSync;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
