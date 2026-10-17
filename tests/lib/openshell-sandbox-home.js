'use strict';

// A temporary folder standing in for an OpenShell sandbox's home (/sandbox),
// for tests that call the offered tools the way the sandbox's MCP server does.
// Call it before any engine module is required: host-control.js reads the
// account's home once, at load, and the state root is chosen once, like
// bin/toolsenabled-openshell.js does inside a sandbox (~/.toolsenabled).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

function useSandboxHome(label = 'openshell-home') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)));
  const userInfo = os.userInfo;
  os.userInfo = (options) => ({ ...userInfo(options), homedir: home });
  process.env.HOME = home;
  process.env.OPENSHELL_SANDBOX = '1';
  process.env.TOOLSENABLED_STATE_ROOT = path.join(home, '.toolsenabled');
  fs.mkdirSync(path.join(home, 'work'));
  return home;
}

/** A transport-bound file scope and a caller shaped like the MCP server's dispatch. */
function sandboxCaller(t, agentId = 'worker-a') {
  const { executeTool } = require('../../src/lib/tool-registry');
  const contexts = require('../../src/lib/file-tool-context');
  const { toolError } = require('../../src/mcp-server');
  const scope = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
  t.after(() => contexts.retireFileToolContext(scope, 'test-finished'));
  const context = { permissionSession: { origin: 'local', tier: 'full' }, fileToolContext: scope };
  const call = (tool, args) => executeTool(tool, args, context).then((outcome) => outcome.result || outcome);
  // What the agent reads when the call is refused: the MCP result's text and code.
  const refusal = (tool, args) => executeTool(tool, args, context).then(
    () => assert.fail(`${tool} was expected to refuse`),
    (error) => { const result = toolError(error); return { code: error.code, text: result.content[0].text }; });
  return { call, refusal, scope };
}

module.exports = { useSandboxHome, sandboxCaller };
