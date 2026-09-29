'use strict';

// The tools ToolsEnabled offers inside a person's own NVIDIA OpenShell
// sandbox: a reviewed positive list, applied through TOOLSENABLED_TOOL_ALLOWLIST
// on top of the recorded permission level.
//
// OpenShell already provides the sandbox, the network policy, credential
// custody and access approvals, so ToolsEnabled's own versions of those are
// not offered here: its Docker sandboxes, vault and credential capture, egress
// checks and generic HTTP tool. Desktop and host tools (screen, windows,
// clipboard, browser, remote access, the app and editors) cannot work inside a
// sandbox. Integrations that need their own credentials and network rules
// (GitHub, Google, payments, publishing) come back as each gains an OpenShell
// provider profile. Agent control is offered with --agents (below).

const OPENSHELL_TOOLS = Object.freeze([
  // The shared work record: tasks any agent can pick up where another stopped.
  'task.submit', 'task.claim', 'task.start', 'task.heartbeat', 'task.checkpoint',
  'task.complete', 'task.fail', 'task.cancel', 'task.get', 'task.list',
  'ledger.read', 't_ledger.file', 't_ledger.progress', 't_ledger.complete', 'r_ledger.file',
  // Asks for the person, answered with `toolsenabled-openshell ledger answer`.
  'a_ledger.file',
  // Byte-mediated file editing (docs/byte-coordination.md, host section): a
  // write or patch needs this agent's read of the current bytes, byte-disjoint
  // edits by different agents are rebased, and stale edits refuse, so agents
  // sharing one workspace do not clobber each other. Contained to the
  // sandbox home, with credential files refused. The level must be
  // unrestricted: the confined levels permanently refuse the host tools.
  // host.exec is not offered; agents have their own shells.
  'host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir',
  // Memory and local search that carry across sessions and agents.
  'memory.get', 'memory.set', 'memory.search',
  'search.index', 'search.query', 'search.status',
  // What is running, what is allowed, and the signed record of what happened
  // (its key is kept by the sandbox vault, src/lib/vault-openshell.js).
  'settings.read', 'capability.find', 'system.status', 'system.doctor',
  'audit.status', 'audit.tail', 'audit.verify',
  // The sandbox's own policy, denials and proposals.
  'openshell.status', 'openshell.denials', 'openshell.propose'
]);

// Offered only when the person turns agents on (toolsenabled-openshell setup
// --agents): the agent tree inside the same sandbox (src/lib/openshell-agent-host.js),
// Codex and Claude workers that can start workers of their own, their
// lifecycle and slot controls, and the local message route between them. In
// that mode the sandbox's policy, not the recorded level, bounds the workers,
// so these are added rather than narrowed; each session's role still narrows
// them (the slot controls are an explicit role grant, src/lib/role-functions.js).
// agent.set_account is not offered: a sandbox has one sign-in per CLI.
const OPENSHELL_AGENT_TOOLS = Object.freeze([
  'agent.spawn', 'agent.stop', 'agent.restart', 'agent.remove', 'agent.resume',
  'agent.set_model', 'agent.set_effort', 'agent.set_provider', 'agent.set_role',
  'agent_comms.send_local', 'agent_comms.local_roster',
]);

/** The OpenShell list narrowed to what the recorded level's allowlist permits. */
function openShellAllowlist(tierAllowlist, { agents = false } = {}) {
  const permitted = new Set(tierAllowlist);
  const base = OPENSHELL_TOOLS.filter((name) => permitted.has(name));
  return agents ? [...base, ...OPENSHELL_AGENT_TOOLS] : base;
}

module.exports = Object.freeze({ OPENSHELL_TOOLS, OPENSHELL_AGENT_TOOLS, openShellAllowlist });
