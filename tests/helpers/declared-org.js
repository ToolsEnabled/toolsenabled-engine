'use strict';

// THE SHIPPED DECLARED ORG, FOR TESTS THAT NEED AN ENABLED CONTROLLER.
//
// config/agent-org.json is the neutral checked-in product configuration. It is
// classified open and mirrored, so tests should exercise that real shipped file
// instead of silently substituting an example when it is missing. A missing or
// invalid declaration is therefore a direct test failure with the path named.

const fs = require('node:fs');
const path = require('node:path');
const { normalizeOrg } = require('../../src/lib/agent-org');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const DECLARED = path.join(CONFIG_DIR, 'agent-org.json');

/** The org file actually in use, named so a failure message can point at it. */
function declaredOrgPath() {
  return DECLARED;
}

/** The normalized shipped org. Throws if the file is missing or invalid -- a
 *  test that needs an org cannot meaningfully continue without it. */
function declaredOrg() {
  const file = declaredOrgPath();
  return normalizeOrg(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** The id of an enabled controller, which is what every caller actually wanted.
 *  Throws with the file named rather than returning undefined, because an
 *  undefined actor surfaces later as an unrelated authority error. */
function enabledControllerId(org = declaredOrg()) {
  const controller = org.agents.find(agent => agent.enabled === true && agent.role === 'controller');
  if (!controller) {
    throw new Error(`No enabled controller is declared in ${declaredOrgPath()}; tests that act as one cannot run.`);
  }
  return controller.id;
}

module.exports = { declaredOrg, declaredOrgPath, enabledControllerId };
