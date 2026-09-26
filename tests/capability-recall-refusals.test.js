'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { find, recommend } = require('../src/lib/capability-recall');

function withSideEffectGuards(run) {
  const writes = ['appendFile', 'appendFileSync', 'writeFile', 'writeFileSync'];
  const spawns = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'];
  const originals = new Map();
  const seen = [];
  for (const [owner, names, kind] of [[fs, writes, 'write'], [childProcess, spawns, 'spawn']]) {
    for (const name of names) {
      originals.set(`${kind}:${name}`, owner[name]);
      owner[name] = () => { seen.push(`${kind}:${name}`); throw new Error(`unexpected ${kind}`); };
    }
  }
  try {
    const result = run();
    assert.deepEqual(seen, [], `refusal caused side effects: ${seen.join(', ')}`);
    return result;
  } finally {
    for (const [key, original] of originals) {
      const [kind, name] = key.split(':');
      (kind === 'write' ? fs : childProcess)[name] = original;
    }
  }
}

function throwingArtifact(message) {
  let reads = 0;
  return {
    options: {
      get artifact() {
        reads += 1;
        throw new Error(message);
      },
    },
    reads: () => reads,
  };
}

{
  let observations = 0;
  const injected = throwingArtifact('injected index loader failure');
  injected.options.enabled = true;
  injected.options.observer = () => { observations += 1; };
  const result = withSideEffectGuards(() => recommend('take a screenshot', injected.options));

  assert.equal(injected.reads(), 1, 'recommend did not drive the failing artifact dependency');
  assert.equal(result.code, 'CAPABILITY_INDEX_UNAVAILABLE');
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.text, '');
  assert.deepEqual(result.tools, []);
  assert.match(result.why, /injected index loader failure/);
  assert.equal(observations, 0, 'a refusal must not publish a successful-search observation');
}

{
  let observations = 0;
  const injected = throwingArtifact('injected query index loader failure');
  injected.options.observer = () => { observations += 1; };
  const result = withSideEffectGuards(() => find('take a screenshot', injected.options));

  assert.equal(injected.reads(), 1, 'find did not drive the failing artifact dependency');
  assert.equal(result.code, 'CAPABILITY_INDEX_UNAVAILABLE');
  assert.equal(result.outcome, 'unavailable');
  assert.deepEqual(result.tools, []);
  assert.match(result.text, /could not be consulted/);
  assert.match(result.text, /nothing was searched/i);
  assert.equal(observations, 0, 'a refusal must not publish a successful-search observation');
}

{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-recall-settings-'));
  const valuesPath = path.join(directory, 'settings.json');
  fs.writeFileSync(valuesPath, '{not json', 'utf8');
  const before = fs.readFileSync(valuesPath, 'utf8');
  let artifactReads = 0;
  let observations = 0;
  const options = {
    valuesPath,
    env: {},
    get artifact() { artifactReads += 1; return {}; },
    observer: () => { observations += 1; },
  };
  const result = withSideEffectGuards(() => recommend('take a screenshot', options));

  assert.equal(result.code, 'CAPABILITY_RECALL_SETTINGS_UNAVAILABLE');
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.text, '');
  assert.deepEqual(result.tools, []);
  assert.match(result.why, /could not be read/i);
  assert.equal(artifactReads, 0, 'the index was opened after the settings refusal');
  assert.equal(observations, 0, 'a settings refusal must not publish an observation');
  assert.equal(fs.readFileSync(valuesPath, 'utf8'), before, 'the refused call changed the settings file');
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('capability recall refusal tests passed');
