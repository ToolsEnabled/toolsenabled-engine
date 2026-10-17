'use strict';

// Memory as agents inside an OpenShell sandbox use it: values written by one
// agent and searched for by another, in the words the agent remembers.

const { useSandboxHome, sandboxCaller } = require('./lib/openshell-sandbox-home');
useSandboxHome('openshell-memory');

const test = require('node:test');
const assert = require('node:assert/strict');

test('memory.search finds a value by any literal part of it, quotes, backslashes, tabs and line breaks included', async (t) => {
  const { call } = sandboxCaller(t);
  const values = {
    quote: 'He said "ship it" on Friday',
    path: 'C:\\Users\\me\\notes.txt',
    lines: 'line one\nline two',
    tabbed: 'name\tvalue',
    nested: { title: 'Release "v2" plan' }
  };
  for (const [key, value] of Object.entries(values)) await call('memory.set', { namespace: 'recall', key, value });
  for (const [query, key] of [
    ['said "SHIP it"', 'quote'], ['"ship it"', 'quote'], ['Users\\me', 'path'],
    ['one\nline two', 'lines'], ['name\tvalue', 'tabbed'], ['Release "v2"', 'nested']
  ]) {
    const found = await call('memory.search', { query, namespace: 'recall' });
    assert.deepEqual(found.entries.map((entry) => entry.key), [key], JSON.stringify(query));
  }
});

test('a search over large values stays within what the agent CLIs keep and still names every match', async (t) => {
  const { call } = sandboxCaller(t);
  for (let i = 0; i < 20; i += 1) {
    await call('memory.set', { namespace: 'large', key: `entry-${i}`, value: `needle ${i} ${'padding words '.repeat(700)}` });
  }
  const found = await call('memory.search', { query: 'needle', namespace: 'large', limit: 20 });
  assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 32 * 1024, `${Buffer.byteLength(JSON.stringify(found))} bytes`);
  assert.equal(found.count, 20);
  assert.deepEqual(found.entries.map((entry) => entry.key).sort(), Array.from({ length: 20 }, (_, i) => `entry-${i}`).sort());
  const withValue = found.entries.filter((entry) => entry.value !== undefined);
  const omitted = found.entries.filter((entry) => entry.valueOmitted === true);
  assert.ok(withValue.length >= 1 && omitted.length >= 1);
  assert.equal(withValue.length + omitted.length, 20);
  assert.match(found.note, /memory\.get/);
  // Each omitted value is one memory.get away.
  const one = await call('memory.get', { namespace: 'large', key: omitted[0].key });
  assert.match(one.value, /^needle /);
  // A small result is returned as it was.
  const small = await call('memory.search', { query: 'needle 7 ', namespace: 'large' });
  assert.equal(small.note, undefined);
  assert.equal(small.entries[0].value.startsWith('needle 7 '), true);
});
