'use strict';

// TURN THE TOOL REGISTRY INTO DOCUMENTS. BUILD TIME ONLY.
//
// One tool, one document, four fields -- the same shape tools/retrieval/fts-index.js
// scores with, plus a fourth for the curated lexicon so its weight can be tuned
// independently of the tool's own words.
//
//   identity  the id and its parts. `screen.capture_window` is also
//             "screen capture window", because a person does not type dots.
//   title     the first sentence of the description. What the tool IS.
//   body      the whole description, parameter names and their descriptions,
//             the effect, the provider, and the annotation words.
//   alias     the everyday vocabulary, COMPOSED rather than enumerated:
//             the words for this tool's ACTION (config/actions.json, shared by
//             every tool that does that thing) plus the words for its OBJECT
//             (config/objects.json, one vocabulary per namespace), plus any
//             residual idiom that will not factor (config/phrases.json).
//
// THE FACTORISATION IS THE POINT. The first version enumerated this field per
// capability: 78 entries, 903 hand-written words and phrases, with "read"
// copied separately into the file entry, the email entry, the calendar entry
// and the clipboard entry. Measured leverage of that arrangement: each authored
// word reached about 2.8 tools. Composed, an action word reaches every tool in
// its class (~45) and an object word reaches its namespace (~5) -- about 15.9
// tools per word. Same field, same scoring, one fifth of the maintenance.
//
// AND THE READ/WRITE SPLIT IS NOW FREE. `calendar.list` is action:read and
// `calendar.create` is action:create because their ids say so. The old lexicon
// had to encode that by hand for every capability, after "what is on my
// calendar today" returned the tool that ADDS an event.
//
// WHY ALIASES ARE A FIELD AND NOT A SCORING BRANCH. Folding them into the
// document means one BM25 pass scores everything, one weight to move, and the
// vocabulary inherits IDF like any other evidence -- so a word that turns out
// to be common across many tools stops carrying weight by itself,
// automatically. A separate "if alias then boost" branch would re-derive all
// of that, badly.
//
// THE OWNER TOOL PACKS ARE NOT INCLUDED BY DEFAULT, and that is a correctness
// decision rather than a convenience. src/lib/tool-packs/ is absent from the
// installer payload (measured: capability/src/lib/ has no tool-packs directory),
// so the 321-tool registry an owner machine can build is 49 tools larger than
// anything a customer can call. Indexing those would teach a customer's agent
// to reach for tools that do not exist on their machine -- the exact
// silence-reads-as-capability defect src/lib/agent-tool-summary.js was written
// to end, pointed the other way.

const path = require('node:path');

const MAX_CLAUSE_CHARS = 120;

/* The annotation words, spelled the way a person would say them rather than
 * the way the schema spells them. "destructiveHint: true" is not searchable;
 * "hard to undo" is. */
function annotationWords(tool) {
  const annotations = tool.annotations || {};
  const out = [];
  if (annotations.readOnlyHint === true) out.push('read only', 'reads', 'safe', 'does not change anything');
  if (annotations.readOnlyHint === false) out.push('changes something', 'writes');
  if (annotations.destructiveHint === true) out.push('destructive', 'hard to undo', 'permanent');
  if (annotations.openWorldHint === true) out.push('external', 'reaches outside this machine', 'network', 'internet');
  if (annotations.idempotentHint === true) out.push('repeatable', 'safe to retry');
  return out;
}

function effectWords(effect) {
  switch (effect) {
    case 'local-read': return ['local read', 'reads this computer'];
    case 'local-write': return ['local write', 'changes this computer'];
    case 'external-read': return ['external read', 'reads from a service'];
    case 'external-write': return ['external write', 'sends to a service'];
    default: return effect ? [String(effect)] : [];
  }
}

/** The first sentence, bounded. Mirrors tools/grepsaver-tooldigest.js firstSentence(). */
function firstSentence(text, max = MAX_CLAUSE_CHARS) {
  const one = String(text || '').split('\n')[0].trim();
  const dot = one.indexOf('. ');
  const cut = dot > 20 ? one.slice(0, dot + 1) : one;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

function parametersOf(tool) {
  const schema = tool.inputSchema || tool.baseInputSchema || {};
  const properties = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    required: required.has(name),
    desc: firstSentence(value && value.description, 90),
  }));
}

/**
 * Load the registry from an engine checkout, in THIS process.
 *
 * Never over the MCP wire. tools/grepsaver-tooldigest.js records the measurement
 * that makes this non-negotiable: a plain tools/list on that checkout returned
 * 103 tools while the registry defined 263, because the server resolves a
 * permission tier from local install state and narrows what it advertises. An
 * index built from that wire would be missing 60% of the catalogue and would
 * look completely healthy.
 */
function loadRegistry(engineRoot, { withPacks = false } = {}) {
  const root = path.resolve(engineRoot);
  const registryPath = path.join(root, 'src', 'lib', 'tool-registry.js');
  if (withPacks) {
    // Order is load-bearing: the registry freezes TOOL_REGISTRY at module load,
    // and the pack index refuses (loudly) if it is required afterwards.
    require(path.join(root, 'src', 'lib', 'tool-packs', 'index.js'));
  }
  const registry = require(registryPath);
  if (!Array.isArray(registry.TOOL_REGISTRY) || registry.TOOL_REGISTRY.length === 0) {
    const error = new Error(`${registryPath} did not export a non-empty TOOL_REGISTRY`);
    error.code = 'CAPABILITY_REGISTRY_EMPTY';
    throw error;
  }
  return registry.TOOL_REGISTRY;
}

/**
 * Compose one document per tool.
 *
 * `vocabularyByTool` is a Map of tool id -> { words, action, namespace },
 * produced by tools/lib/factor.js from the composed vocabularies. Every tool
 * has one: the build gate refuses a catalogue where any tool does not.
 *
 * `action` and `namespace` are carried onto the document as METADATA, not as
 * searchable text. They are what lets the decision layer ask "is the runner-up
 * a different kind of thing?" -- three screen.capture* variants agreeing is a
 * coherent answer worth returning, while a screen tool and a billing tool tied
 * at the same score is an ambiguous field worth staying quiet about.
 */
function composeDocuments(tools, vocabularyByTool = new Map()) {
  return tools.map(tool => {
    const id = String(tool.name);
    const namespace = id.includes('.') ? id.split('.')[0] : '(root)';
    const parameters = parametersOf(tool);
    const annotations = tool.annotations || {};

    const identity = [id, id.replace(/[._]/g, ' '), namespace].join(' ');
    const title = firstSentence(tool.description, 200);
    const body = [
      String(tool.description || ''),
      parameters.map(parameter => `${parameter.name} ${parameter.desc}`).join(' '),
      effectWords(tool.effect).join(' '),
      annotationWords(tool).join(' '),
      tool.provider ? String(tool.provider) : '',
    ].filter(Boolean).join(' ');
    const vocabulary = vocabularyByTool.get(id) || { words: [], action: null };
    const alias = vocabulary.words.join(' ');

    return {
      id,
      ns: namespace,
      action: vocabulary.action,
      effect: tool.effect || null,
      provider: tool.provider || null,
      ro: annotations.readOnlyHint === true,
      destructive: annotations.destructiveHint === true,
      ext: annotations.openWorldHint === true,
      clause: firstSentence(tool.description, MAX_CLAUSE_CHARS),
      params: parameters,
      fields: { identity, title, body, alias },
    };
  });
}

module.exports = Object.freeze({
  MAX_CLAUSE_CHARS,
  annotationWords,
  composeDocuments,
  effectWords,
  firstSentence,
  loadRegistry,
  parametersOf,
});
