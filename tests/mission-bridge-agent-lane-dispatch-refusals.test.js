'EXECUTABLE CHANGE';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dispatch = require('../src/lib/mission-bridge/agent-lane-dispatch.js');

const LAUNCH_ID = 'launch_1234567890abcdef';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-dispatch-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function finalAndTemporaryFiles(root, directory) {
  const artifactDirectory = path.join(root, directory);
  return fs.existsSync(artifactDirectory) ? fs.readdirSync(artifactDirectory) : [];
}

test('persistBrief refuses an existing artifact without overwriting it', t => {
  const root = scratch(t);
  const file = dispatch.durableBriefPath(root, LAUNCH_ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original brief', 'utf8');

  assert.throws(
    () => dispatch.persistBrief({ projectRoot: root, launchId: LAUNCH_ID, content: 'replacement brief' }),
    error => error.code === 'BRIDGE_AGENT_BRIEF_COLLISION' && error.status === 409
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'original brief', 'the refusal preserves the existing brief');
  assert.deepEqual(finalAndTemporaryFiles(root, dispatch.BRIEF_DIRECTORY), [`${LAUNCH_ID}.md`],
    'the refused publish cleans its temporary file and creates nothing else');
});

test('persistBrief reports a write refusal and publishes no artifact', t => {
  const root = scratch(t);
  const injected = {
    ...fs,
    writeFileSync() {
      const error = new Error('injected disk failure');
      error.code = 'EIO';
      throw error;
    }
  };

  assert.throws(
    () => dispatch.persistBrief({ projectRoot: root, launchId: LAUNCH_ID, content: 'durable brief' }, { fsImpl: injected }),
    error => error.code === 'BRIDGE_AGENT_BRIEF_WRITE_FAILED' && error.status === 503 && error.details.cause === 'EIO'
  );
  assert.deepEqual(finalAndTemporaryFiles(root, dispatch.BRIEF_DIRECTORY), [],
    'a failed brief write leaves neither a final artifact nor a temporary file');
});

test('persistCheckpoint reports a write refusal and publishes no artifact', t => {
  const root = scratch(t);
  const injected = {
    ...fs,
    linkSync() {
      const error = new Error('injected publish failure');
      error.code = 'EIO';
      throw error;
    }
  };

  assert.throws(
    () => dispatch.persistCheckpoint({ projectRoot: root, launchId: LAUNCH_ID }, { fsImpl: injected }),
    error => error.code === 'BRIDGE_AGENT_CHECKPOINT_WRITE_FAILED' && error.status === 503 && error.details.cause === 'EIO'
  );
  assert.deepEqual(finalAndTemporaryFiles(root, dispatch.CHECKPOINT_DIRECTORY), [],
    'a failed checkpoint publish leaves neither a final artifact nor a temporary file');
});

test('invalid artifact coordinates refuse before any filesystem write', t => {
  const root = scratch(t);
  let writes = 0;
  const injected = new Proxy(fs, {
    get(target, property) {
      if (['mkdirSync', 'openSync', 'writeFileSync', 'linkSync'].includes(property)) {
        return (...args) => { writes += 1; return target[property](...args); };
      }
      return target[property];
    }
  });

  assert.throws(
    () => dispatch.persistBrief({ projectRoot: root, launchId: '../escape', content: 'brief' }, { fsImpl: injected }),
    error => error.code === 'BRIDGE_AGENT_PATH_INVALID' && error.status === 400
  );
  assert.equal(writes, 0, 'an invalid launch id is rejected before persistence starts');
  assert.deepEqual(fs.readdirSync(root), [], 'the invalid path creates no artifact directory or file');
});
