'use strict';

// A disposable Node fixture only. It opens the parent-created fake file and
// coordination directory. It launches no provider, helper, or descendant.
const fs = require('node:fs');
const { createByteAuthority } = require('../../src/lib/region-holds/byte-authority');
const { binding, hash, materialize, prepareCreate, publishCreate, reconcileCreateStage } = require('./byte-authority-fixture');

const [root, resource, actor, startString, endString, replacementText, mode = 'ordinary'] = process.argv.slice(2);
const startByte = Number(startString), endByte = Number(endString);
const writing = mode.startsWith('write-');
const phase = writing ? mode.slice('write-'.length) : mode;
const queued = [];
let wake = null;
process.on('message', message => { if (wake) { const resolve = wake; wake = null; resolve(message); } else queued.push(message); });
const command = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => { wake = resolve; });
function send(value) { if (process.connected) process.send(value); }

const authority = createByteAuthority({
  stateRoot: root,
  materialize,
  prepareCreate: input => {
    const preparation = prepareCreate(input);
    if (phase === 'crash-before-journal') process.exit(70);
    return preparation;
  },
  reconcileCreateStage,
  publish: async input => {
    const { resource: file, beforeSha256, after, operationId, assertCurrent } = input;
    if (input.beforePresent !== false && hash(fs.readFileSync(file)) !== beforeSha256) throw new Error('Fixture publication lost its expected base');
    send({ event: 'publishing', operationId });
    if (phase === 'crash-before') process.exit(71);
    if (phase === 'held') {
      const release = await command();
      if (!release || release.command !== 'release') throw new Error('Missing release barrier');
    }
    let result;
    if (input.publicationMode === 'create-only') {
      result = publishCreate(input, { afterLink: () => { if (phase === 'crash-after-link') process.exit(73); } });
    } else {
      const staging = file + '.' + operationId + '.tmp';
      const fd = fs.openSync(staging, 'wx');
      try { fs.writeFileSync(fd, after); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      assertCurrent();
      fs.renameSync(staging, file);
      result = { published: true };
    }
    if (phase === 'crash-after') process.exit(72);
    return result;
  }
});

(async () => {
  if (!writing) await authority.observeRead({ binding: binding(actor), resource, startByte, endByte });
  send({ event: 'ready' });
  const start = await command();
  if (!start || start.command !== 'apply') throw new Error('Missing start barrier');
  const result = writing ? await authority.applyWrite({ binding: binding(actor), resource, bytes: Buffer.from(replacementText) })
    : await authority.applyPatch({ binding: binding(actor), resource,
    derivePatch: ({ bytes }) => {
      // Find the original read bytes after any disjoint predecessor changed
      // length. The unique fixture payload makes the derivation unambiguous.
      const expected = Buffer.from(actor.startsWith('right') ? 'BB' : 'AA');
      const offset = bytes.indexOf(expected);
      if (offset < 0) throw Object.assign(new Error('fixture span missing'), { code: 'FIXTURE_SPAN_MISSING' });
      return { startByte: offset, endByte: offset + expected.length, replacement: Buffer.from(replacementText) };
    }
  });
  send({ event: 'result', ok: true, receipt: result.receipt });
})().catch(error => {
  send({ event: 'result', ok: false, code: error.code || 'ERROR', message: error.message });
  process.exitCode = 1;
}).finally(() => { if (process.connected) process.disconnect(); });
