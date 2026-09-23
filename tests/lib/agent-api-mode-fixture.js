'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Argv/confinement fixtures that exercise native CLI tools must declare the
// mode that permits those tools. Never borrow or edit the owner's settings.
function selectAgentApiMode(mode) {
  if (!['Only', 'Enabled', 'Disabled'].includes(mode)) throw new TypeError('Invalid fixture API mode.');
  require('./isolated-environment').activate('agent-api-mode-fixture');
  const root = process.env.TOOLSENABLED_TEST_ROOT;
  const file = require('../../src/lib/settings').resolveValuesPath({});
  const relative = path.relative(root, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'API-mode fixture settings must remain inside the isolated test root');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ revision: 1, values: { 'agent.agent_api': mode },
    provenance: { 'agent.agent_api': { source: 'user', atMs: 1, directive: null } } }));
}

module.exports = { selectAgentApiMode };
