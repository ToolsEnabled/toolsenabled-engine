'use strict';

// Only endpoint and variable names live here. The agent resolves the variable;
// Fleet never reads it. One URL and one variable belong to one agent instance.
const QUESTIONS = Object.freeze(['system.ask', 'system.notify']);
const NOTE = 'Questions and notices go through the authority’s system.ask and system.notify tools. The person answers with toolsenabled-authority ask on the host.';
const HOST_NOTE = 'On the ToolsEnabled host: no process in a sandbox can run this command or change these records; anyone signed in to this machine as you can.';
function refusal(message) { return Object.assign(new Error(message), { code: 'OPENSHELL_AUTHORITY_INVALID' }); }

function endpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'tokenEnv,url'
    || typeof input.url !== 'string' || input.url.length > 2048
    || !/^https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/mcp\/[a-z][a-z0-9-]{0,31}$/.test(input.url)
    || typeof input.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.tokenEnv)) {
    throw refusal('An authority needs a plain HTTP grant URL ending in /mcp/<grant-id> and an uppercase environment variable name, never a token value.');
  }
  let url;
  try { url = new URL(input.url); } catch { throw refusal('The authority URL must have a valid host and port.'); }
  if (!url.hostname || url.port === '0') throw refusal('The authority URL must have a valid host and port.');
  return Object.freeze({ url: url.href, tokenEnv: input.tokenEnv });
}

function registrations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'agents,version' || value.version !== 1
    || !value.agents || typeof value.agents !== 'object' || Array.isArray(value.agents)
    || Object.keys(value.agents).length < 1 || Object.keys(value.agents).length > 64) throw refusal('Authority registrations must name between one and 64 agent instances.');
  const agents = {}, urls = new Set(), variables = new Set();
  for (const [id, entry] of Object.entries(value.agents)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw refusal('An authority registration needs a descriptor agent id.');
    const checked = endpoint(entry);
    if (urls.has(checked.url) || variables.has(checked.tokenEnv)) throw refusal('Each agent instance needs its own authority grant URL and environment variable.');
    urls.add(checked.url); variables.add(checked.tokenEnv); agents[id] = checked;
  }
  return Object.freeze({ version: 1, agents: Object.freeze(agents) });
}

function configured({ env = process.env } = {}) {
  if (env.OPENSHELL_SANDBOX !== '1') return false;
  const records = require('./setup/machine-record');
  try {
    const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({ env }), adopt: false });
    return Boolean(record?.openShellAuthority);
  } catch {
    // An unreadable seal must not bring back a local answer channel.
    return true;
  }
}

function requireLocal() {
  if (configured()) throw Object.assign(new Error(NOTE), { code: 'PERSON_CHANNEL_AUTHORITY_REQUIRED' });
}

module.exports = Object.freeze({ QUESTIONS, NOTE, HOST_NOTE, endpoint, registrations, configured, requireLocal });
