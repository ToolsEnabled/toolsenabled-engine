'use strict';

// State-only worker for the P14 exactly-once race.  It never evaluates a
// provider handler or opens a browser.
const { createStateStore } = require('../src/lib/state-store');
const scopedApprovals = require('../src/lib/scoped-approvals');

let state;
try {
  const input = JSON.parse(process.argv[2]);
  state = createStateStore({ file: input.file, busyTimeoutMs: 30_000 });
  scopedApprovals.consumeForDispatch({
    authorizationId: input.authorizationId,
    toolName: input.toolName,
    arguments: input.arguments,
    approvalToken: input.approvalToken
  }, { state });
  process.stdout.write(JSON.stringify({ ok: true, authorizationId: input.authorizationId }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error && error.code ? error.code : null }));
} finally {
  if (state) state.close();
}
