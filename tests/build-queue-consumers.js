'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const corpus = require('../src/lib/build-queue-corpus');
const queueReader = require('../src/lib/fleet-supervisor/queue');
const digest = require('../src/lib/agent-digest/collect');
const intent = require('../src/lib/intent-fidelity');

function phase(id, status, title, ownerRequest = null) {
  const suffix = ownerRequest ? ` (owner request ${ownerRequest})` : '';
  return `## ${id} — ${title}${suffix}\n\n**Status:** ${status}\n\n**Build:** exact ${id}\n\n`;
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-consumers-'));
const rootFile = path.join(directory, 'BUILD-QUEUE.md');
const queueDirectory = path.join(directory, 'queue');
fs.mkdirSync(queueDirectory);

const protocol = '## Builder protocol (read once per loop)\n\nPick the lowest open number across root and slices.';
const root = `# Queue\n\n${protocol}\n\n${corpus.renderQueueIndex(['repo-protocol', 'desktop.browser'])}${phase('Q9', 'BLOCKED (fixture)', 'Root cross-package')}`;
fs.writeFileSync(rootFile, root, 'utf8');
fs.writeFileSync(path.join(queueDirectory, 'desktop.browser.md'), phase('Q4', 'PARTIAL fixture', 'Browser package'), 'utf8');
fs.writeFileSync(path.join(queueDirectory, 'repo-protocol.md'), phase('Q2', 'OPEN', 'Queue package', 'R107'), 'utf8');

try {
  const queue = queueReader.readBuildQueue(rootFile);
  assert.deepEqual(queue.files, ['BUILD-QUEUE.md', 'queue/desktop.browser.md', 'queue/repo-protocol.md']);
  assert.equal(queue.protocol, protocol);
  assert.deepEqual(queueReader.openPhases(queue.phases).map(item => item.id), ['Q2', 'Q4']);
  assert.equal(queue.phases.find(item => item.id === 'Q2').body.includes('exact Q2'), true);

  const digestQueue = digest.readQueue(rootFile, fs);
  assert.deepEqual(digestQueue.open, ['Q2']);
  assert.deepEqual(digestQueue.inFlight, ['Q4']);
  assert.deepEqual(digestQueue.blocked, ['Q9']);
  assert.deepEqual(digestQueue.files, queue.files);
  assert.equal(digestQueue.corpusHash, queue.corpusHash);

  const queueText = intent.readQueueText(directory, { fsImpl: fs });
  assert.match(queueText, /## Q2/);
  assert.equal(intent.requestIdForQueueItem('Q2', queueText), 'R107');

  const beforeHash = queue.corpusHash;
  fs.appendFileSync(path.join(queueDirectory, 'repo-protocol.md'), '\n', 'utf8');
  assert.notEqual(queueReader.readBuildQueue(rootFile).corpusHash, beforeHash);

  console.log('build-queue-consumers: 4 contract groups passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
