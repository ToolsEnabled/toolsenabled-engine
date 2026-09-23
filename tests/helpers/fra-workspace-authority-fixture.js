'use strict';

// Unit fixtures issue private capabilities explicitly; copied public contexts
// no longer stand in for a transport. fra-byte-mediation.test.js separately
// proves actual authenticated sockets and the real registry invocation path.
const crypto = require('node:crypto');
const contexts = require('../../src/lib/file-tool-context');
const { createByteAuthority } = require('../../src/lib/region-holds/byte-authority');
const { materialize } = require('./byte-authority-fixture');
const owned = new Map();

function context(seed, generation = 1) {
  const key = generation + ':' + seed;
  if (owned.has(key)) return owned.get(key);
  const workspace = Object.freeze({
    sessionContextDigest: crypto.createHash('sha256').update(key).digest('hex'),
    generation, serverHost: '203.0.113.2', clientHost: '203.0.113.1'
  });
  const scope = contexts.createFraFileToolContext({ workspaceContext: workspace, assertCurrent() {} });
  const result = { fraWorkspaceContext: workspace, fileToolContext: scope };
  owned.set(key, result);
  return result;
}
function authorityFactory(root) {
  const authority = createByteAuthority({ stateRoot: root, materialize,
    publish() { throw new Error('The workspace unit fixture has no write adapter'); } });
  return scope => {
    const binding = contexts.requireFileToolContext(scope);
    contexts.onFileToolContextRetired(scope, authority, reason => authority.closeLaunch({ binding, reason }));
    return authority;
  };
}
async function read(broker, args, context) {
  const invocation = contexts.beginFileToolInvocation(context.fileToolContext, {
    invocationId: 'invocation-' + crypto.randomUUID(), toolName: 'workspace.read'
  });
  try { return await broker.read(args, { ...context, fileToolInvocation: invocation }); }
  finally { contexts.endFileToolInvocation(invocation); }
}
async function retire() {
  await Promise.all([...owned.values()].map(value => contexts.retireFileToolContext(value.fileToolContext, 'unit-fixture-finished')));
  owned.clear();
}
module.exports = { context, authorityFactory, read, retire };
