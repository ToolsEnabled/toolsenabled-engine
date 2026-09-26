'use strict';

// This child is intentionally state-only. It races two separate task-bound
// P13 consumptions against one durable approval attachment fence.
const { createStateStore } = require('../src/lib/state-store');

let state;
try {
  const input = JSON.parse(process.argv[2]);
  state = createStateStore({ file: input.file, busyTimeoutMs: 30_000 });
  state.consumePolicyDispatchAuthorization({
    authorizationId: input.authorizationId,
    toolName: input.toolName,
    argsHash: input.argsHash,
    approvalId: input.approvalId,
    approvalInputHash: input.approvalInputHash
  });
  process.stdout.write(JSON.stringify({ ok: true, authorizationId: input.authorizationId }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error && error.code ? error.code : null }));
} finally {
  if (state) state.close();
}
