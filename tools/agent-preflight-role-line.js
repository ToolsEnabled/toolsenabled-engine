'use strict';

// R1186: the SessionStart hook used to hand every new session a hardcoded
// sentence — "the Claude session is coordinator; three Codex managers execute
// bounded missions and dispatch Codex workers". Roles here are SESSION-ASSIGNED,
// so that sentence went stale the moment the owner re-seated anyone, and it was
// stale in two directions at once: it contradicted both CLAUDE.md's
// `coordinator-sol` and the seats declared in `config/agent-org.json`. A session
// that believes it holds a role it does not hold is the expensive failure.
//
// So resolve it instead of asserting it. Live truth is the presence registry;
// declared intent is the org file; the two are reported as what they are. This
// never tells a session which role IT holds — only who is observably holding
// what right now, and how to check.

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const agentOrg = require(path.join(ROOT, 'src', 'lib', 'agent-org'));
const INTERESTING_ROLES = agentOrg.ROLES;

function declaredRoleId(value) {
  return typeof value === 'string'
    && agentOrg.ROLE_ID.test(value)
    && !agentOrg.RESERVED_ROLE_IDS.includes(value);
}

function liveHolders() {
  const presence = require(path.join(ROOT, 'src', 'lib', 'agent-presence'));
  const registry = presence.readRegistry(presence.DEFAULT_STATE_FILE);
  return presence.rosterRows(registry)
    .filter(row => row.liveness === 'running' || row.liveness === 'starting')
    .filter(row => declaredRoleId(row.role));
}

function declaredSeats() {
  const org = require(path.join(ROOT, 'config', 'agent-org.json'));
  const agents = Array.isArray(org.agents) ? org.agents : [];
  return agents.filter(agent => agent.enabled === true && declaredRoleId(agent.role));
}

// Returns one bounded paragraph, or null when it cannot be resolved at all.
// Never throws: a broken registry must not break session start.
function roleLine() {
  let live = [];
  let liveFailed = false;
  try {
    live = liveHolders();
  } catch {
    liveFailed = true;
  }

  const check = 'Confirm with `node tools/agent-roster.js --presence` before assuming any role, including your own.';
  const doctrine = 'Roles are session-assigned: a role belongs to a session, not to a model or a name.';

  if (live.length) {
    const who = live
      .map(row => `${row.role} = ${row.agentId} (${row.tier})`)
      .join('; ');
    return `ROLES LIVE NOW (observed presence, not authority): ${who}. ${doctrine} ${check}`;
  }

  let declared = [];
  let declaredFailed = false;
  try {
    declared = declaredSeats();
  } catch {
    declaredFailed = true;
  }

  const noLive = liveFailed
    ? 'ROLES: the presence registry could not be read, so no role holder is verified.'
    : 'ROLES: no live holder is registered in the presence registry.';

  if (declared.length) {
    const who = declared.map(agent => `${agent.role} = ${agent.id}`).join('; ');
    return `${noLive} DECLARED intent in config/agent-org.json (intent only, grants no authority, and is not evidence anyone is running): ${who}. ${doctrine} Do not assume you hold a declared seat. ${check}`;
  }

  const noDeclared = declaredFailed
    ? 'DECLARED intent could not be read from config/agent-org.json, so no declared seat is verified.'
    : 'No enabled interesting role is declared in config/agent-org.json.';
  return `${noLive} ${noDeclared} ${doctrine} ${check}`;
}

module.exports = Object.freeze({ INTERESTING_ROLES, roleLine, liveHolders, declaredSeats });
