'use strict';

// What the ToolsEnabled host OUTSIDE the OpenShell sandboxes serves
// (src/lib/openshell-host-server.js, adapters/openshell/HOST-OUTSIDE.md): the
// person's settings, the ledger of asks, tasks and standing rules they decide
// on, and the signed audit record. Agents reach these only through the host's
// MCP endpoint, so no process in a sandbox can edit the files behind them.
//
// The sealed setup record disables sandbox-local question tools when an
// authority is configured. The authority grant is then the question channel.
//
// Never here: the person's own decisions (answering an ask, completing or
// removing a task, changing a setting). Those stay commands on the host,
// `toolsenabled-authority ledger` and `toolsenabled-authority settings`, which no
// process in a sandbox can run.
const OPENSHELL_HOST_TOOLS = Object.freeze([
  'system.ask', 'system.notify',
  'settings.read',
  'ledger.read', 't_ledger.file', 't_ledger.progress', 't_ledger.complete', 'r_ledger.file', 'a_ledger.file',
  'audit.status', 'audit.tail', 'audit.verify'
]);

/** A sandbox tool list without the tools the host serves. */
function withoutHostTools(names) {
  const served = new Set(OPENSHELL_HOST_TOOLS);
  return names.filter((name) => !served.has(name));
}

module.exports = Object.freeze({ OPENSHELL_HOST_TOOLS, withoutHostTools });
