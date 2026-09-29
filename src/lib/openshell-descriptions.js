'use strict';

// What agents are told about each tool inside a person's own NVIDIA OpenShell
// sandbox. The registry's descriptions are written for the desktop app: its
// Settings and Ledger pages, the owner's profile folder, Windows credential
// stores, tools the sandbox does not offer, and a coordination-board key only
// the desktop installer writes. Inside a sandbox those words send an agent
// looking for things that are not there, so the listed tools carry the
// sandbox's own words instead. Each change replaces one exact phrase of the
// registry's text; tests/openshell-descriptions.test.js fails when a phrase no
// longer matches, so a registry edit cannot silently bring the desktop words
// back.

const os = require('node:os');

// The folder the host file tools are confined to (src/lib/providers/host-control.js).
function sandboxHome() {
  return process.platform === 'linux' ? os.userInfo().homedir : os.homedir();
}

/**
 * The phrase changes, per tool. `from` must occur exactly once in the tool's
 * description or one of its schema descriptions. `unless` names a tool whose
 * being offered keeps the registry's phrase (the sentence is true then);
 * `when` names a tool that must be offered for the change to apply.
 */
function phraseChanges(home = sandboxHome()) {
  const homeFolder = `this sandbox's home folder (${home})`;
  const fileTools = ['host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir'];
  return Object.freeze([
    ...fileTools.map((tool) => ({ tool, from: 'the owner profile tree', to: homeFolder })),
    ...fileTools.map((tool) => ({ tool, schemaOnly: true,
      from: 'inside the owner profile tree, or a path relative to the owner profile root.', to: `inside ${homeFolder}, or a path relative to it.` })),
    { tool: 'host.list_dir', schemaOnly: true, from: 'Omit for the profile root.', to: 'Omit for the home folder.' },
    { tool: 'host.read_file',
      from: '(vault/, .ssh, .aws, .gnupg, the owned Chrome profile, DPAPI stores)',
      to: '(the ToolsEnabled vault, .ssh, .aws, .gnupg, and credential-shaped files such as the CLIs\' sign-in files)' },
    { tool: 'host.write_file', from: '(another agent, host.exec, a native tool or an external process)',
      to: '(another agent, a shell command, a native tool or an external process)', unless: 'host.exec' },
    { tool: 'host.write_file', from: 'host.exec and native tools are not mediated',
      to: 'Shell commands and native tools are not mediated', unless: 'host.exec' },
    { tool: 'host.patch_file', from: 'host.exec and native tools are not mediated',
      to: 'Shell commands and native tools are not mediated', unless: 'host.exec' },
    { tool: 't_ledger.file', from: ' and t_ledger.remove to delete it.',
      to: '; the person removes a record in their terminal with `toolsenabled ledger remove`.', unless: 't_ledger.remove' },
    { tool: 'a_ledger.file', from: 'they answer it on the Ledger page whenever they get to it',
      to: 'they answer it in their terminal with `toolsenabled ledger` whenever they get to it' },
    { tool: 'a_ledger.file', from: ' For a live yes/no the person answers immediately, use system.ask instead.',
      to: '', unless: 'system.ask' },
    { tool: 'r_ledger.file', from: 'when "Who adds standing rules" in Settings is "Agents too"',
      to: 'when the setting rules.filing_from is "Agents too" (the person sets it in their terminal with `toolsenabled settings`)' },
    { tool: 'memory.set', from: '; read agent-coord key channel-map-read-this-first for the full contract', to: '' },
    { tool: 'memory.set', from: ' To message another agent running on THIS computer\'s agent tree right now, use agent_comms.send_local instead.',
      to: ' To message another agent on this sandbox\'s agent tree right now, use agent_comms.send_local instead.', when: 'agent_comms.send_local' },
    { tool: 'memory.set', from: ' To message another agent running on THIS computer\'s agent tree right now, use agent_comms.send_local instead.',
      to: '', unless: 'agent_comms.send_local' },
    { tool: 'memory.search', from: '; see its key channel-map-read-this-first', to: '' },
    { tool: 'search.index',
      from: 'into a local semantic vector store (incremental; only changed files are re-embedded). Embeddings use local Ollama when available, else a deterministic lexical fallback.',
      to: 'for local search (incremental; only changed files are re-indexed). Embeddings use an Ollama server at 127.0.0.1:11434 inside this sandbox when one runs there (none does by default); otherwise search is lexical: it matches the words and characters in the files, not their meaning.' },
    { tool: 'search.query', from: 'Semantically search the indexed files for a natural-language query',
      to: 'Search the indexed files for a query (lexical unless search.status reports Ollama embeddings: use words the files contain)' },
    { tool: 'search.status', from: 'Report the semantic index', to: 'Report the search index' },
    { tool: 'agent.stop', from: ', exactly as the person\'s own Stop does', to: '' },
    { tool: 'agent.resume',
      from: ' When agentResume is unset, the persisted working profile makes Independent, Autonomous and Autonomous+ automatic; lower profiles require a direct turn.',
      to: '' },
    { tool: 'agent_comms.send_local',
      from: 'Send a message to another agent running on THIS computer\'s agent tree -- your manager, an agent that reports to you, or an agent the user directly linked to your circle. Direct links can cross trees.',
      to: 'Send a message to another agent on this sandbox\'s agent tree -- your manager or an agent that reports to you. One that is not running gets it when it runs again.' },
    { tool: 'agent_comms.send_local', from: ' This is the local channel; agent_comms.send is the separate cross-machine one and refuses a local recipient.',
      to: '', unless: 'agent_comms.send' },
    { tool: 'agent_comms.send_local', schemaOnly: true, from: 'Managers, reports and user-linked peers are reachable.',
      to: 'Your manager and the agents that report to you are reachable.' },
    { tool: 'agent_comms.local_roster',
      from: 'List the agents on this computer\'s tree that you may message right now: your manager, the agents that report to you, and user-linked peers (including other trees), only while their sessions are running. Linked peers include an agentId you can use as the send_local recipient when names repeat.',
      to: 'List the agents on this sandbox\'s tree you may message: your manager and the agents that report to you, each with its state. A message to one that is not running waits until it runs again. Each has an agentId you can use as the send_local recipient when names repeat.' },
  ]);
}

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + from.length) >= 0) return null;
  return text.slice(0, at) + to + text.slice(at + from.length);
}

// Applies one change to a listed tool: to its description, or else to exactly
// one string in its input schema. Returns the changed tool, or null when the
// phrase is not there exactly once.
function applyChange(tool, change) {
  if (!change.schemaOnly) {
    const description = replaceOnce(tool.description, change.from, change.to);
    if (description !== null) return { ...tool, description };
  }
  let hits = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      const changed = replaceOnce(value, change.from, change.to);
      if (changed === null) return value;
      hits += 1;
      return changed;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    return value;
  };
  const inputSchema = walk(tool.inputSchema);
  return hits === 1 ? { ...tool, inputSchema } : null;
}

/**
 * The listed tools with the sandbox's words. `tools` is listTools() output
 * (name, description, inputSchema, annotations); the offered names decide the
 * `unless` changes. A phrase that does not match leaves the text as it is.
 */
function sandboxWording(tools, { home } = {}) {
  const offered = new Set(tools.map((tool) => tool.name));
  const changes = phraseChanges(home);
  return tools.map((tool) => changes
    .filter((change) => change.tool === tool.name && !(change.unless && offered.has(change.unless))
      && !(change.when && !offered.has(change.when)))
    .reduce((current, change) => applyChange(current, change) || current, tool));
}

// capability.find answers from a generated index whose one-line summaries
// are the first sentence of each registry description (tools/lib/corpus.js
// firstSentence, 120 characters for a clause and 300 for a summary). Inside a
// sandbox the returned tools get the same two lines cut from the sandbox's
// description instead.
function firstSentence(text, max) {
  const one = String(text || '').split('\n')[0].trim();
  const dot = one.indexOf('. ');
  const cut = dot > 20 ? one.slice(0, dot + 1) : one;
  return cut.length > max ? `${cut.slice(0, max - 1)}\u2026` : cut;
}

/**
 * A rewrite for capability.find's documents: `offered` is the session's
 * offered tool names, `descriptionOf(id)` the registry description.
 */
function recallRewrite(offered, descriptionOf, { home } = {}) {
  const changes = phraseChanges(home);
  return (document) => {
    const original = descriptionOf(document.id);
    if (typeof original !== 'string') return document;
    const worded = changes
      .filter((change) => change.tool === document.id && !change.schemaOnly
        && !(change.unless && offered.has(change.unless)) && !(change.when && !offered.has(change.when)))
      .reduce((text, change) => {
        const changed = applyChange({ description: text, inputSchema: {} }, change);
        return changed ? changed.description : text;
      }, original);
    if (worded === original) return document;
    return { ...document, clause: firstSentence(worded, 120), summary: firstSentence(worded, 300) };
  };
}

module.exports = Object.freeze({ phraseChanges, sandboxWording, applyChange, sandboxHome, recallRewrite });
