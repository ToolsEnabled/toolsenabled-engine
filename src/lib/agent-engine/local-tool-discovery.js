'use strict';

// This is advertisement, not authorization. The catalogue is exclusively the
// session's already-authorized tools/list result. Actual calls still go through
// the original surface, its authenticated MCP clients, and normal policy gates.
const CORE_NAMES = Object.freeze([
  'agent.spawn', 'agent_comms.local_roster', 'agent_comms.send_local',
  'agent.stop', 'agent.restart', 'agent.resume', 'agent.remove',
  'agent_comms.send', 'agent_comms.read', 'agent_comms.acknowledge'
]);
const COMPACT_THRESHOLD_CHARS = 12000;
const MAX_SELECTED_TOOLS = 12;
const MAX_SEARCH_RESULTS = 8;
const MAX_SCHEMA_REQUESTS = 4;
const HELPER_NAME = 'local_tools_discover';

function wireTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.inputSchema } };
}

function fail(message) {
  const error = new Error(message);
  error.code = 'LOCAL_NODE_CONTEXT_TOO_SMALL';
  return error;
}

function createLocalToolView(surface, record, contextTokens) {
  if (!surface) return null;
  const catalogue = surface.list();
  if (JSON.stringify(catalogue.map(wireTool)).length <= COMPACT_THRESHOLD_CHARS) return surface;
  const byName = new Map(catalogue.map(tool => [tool.name, tool]));
  let helperName = HELPER_NAME;
  for (let suffix = 2; byName.has(helperName); suffix += 1) helperName = `${HELPER_NAME}_${suffix}`;
  const helper = {
    name: helperName,
    description: 'Local session tool discovery. Search the tools already allowed for this agent by query, then request exact names to load their full schemas for the next tool round. This helper only reveals schemas; it does not execute tools or grant permissions.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Words describing the capability to find; returns at most 8 names and short descriptions.' },
        names: { type: 'array', maxItems: MAX_SCHEMA_REQUESTS, items: { type: 'string', maxLength: 256 }, description: 'Up to 4 exact names to advertise and return with their complete input schemas.' }
      }
    }
  };
  const core = CORE_NAMES.filter(name => byName.has(name));
  // Reserve at least half of a typical text context for the conversation and
  // answer. This character budget is conservative sizing, not a tokenizer or
  // a claim about arbitrary models' exact context limits.
  const budget = contextTokens * 2;
  const namesFor = selected => [...new Set([...core, ...selected])];
  const rowsFor = selected => [...namesFor(selected).map(name => byName.get(name)).filter(Boolean), helper];
  const fits = selected => JSON.stringify(rowsFor(selected).map(wireTool)).length <= budget;
  if (!fits([])) throw fail('The local context is too small for this agent\'s coordination tools. Increase Local model context size to at least 8192 tokens.');
  record.localToolNames = (Array.isArray(record.localToolNames) ? record.localToolNames : [])
    .filter(name => byName.has(name) && !core.includes(name)).slice(-MAX_SELECTED_TOOLS);
  while (!fits(record.localToolNames)) record.localToolNames.shift();

  return {
    compact: true,
    discoveryToolName: helperName,
    list: () => rowsFor(record.localToolNames),
    async call(name, args, callOptions) {
      if (name !== helperName) {
        if (!namesFor(record.localToolNames).includes(name)) {
          return { isError: true, text: `That tool is not advertised for this round. Use ${helperName} to search the allowed tools and select its exact schema first.` };
        }
        return surface.call(name, args, callOptions);
      }
      if (callOptions?.signal?.aborted) return { isError: true, text: 'Tool discovery was stopped.' };
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['query', 'names'].includes(key)) ||
          (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) ||
          (args.names !== undefined && (!Array.isArray(args.names) || args.names.length > MAX_SCHEMA_REQUESTS || args.names.some(item => typeof item !== 'string' || item.length > 256)))) {
        return { isError: true, text: 'Use a query of at most 200 characters and at most 4 exact tool names.' };
      }
      const requested = [...new Set(args.names || [])];
      if (requested.some(item => !byName.has(item))) return { isError: true, text: 'A requested tool is not in this session\'s allowed catalogue. No tools were selected.' };
      let selected = record.localToolNames.filter(item => !requested.includes(item));
      selected.push(...requested.filter(item => !core.includes(item)));
      while (selected.length > MAX_SELECTED_TOOLS || !fits(selected)) {
        const removable = selected.findIndex(item => !requested.includes(item));
        if (removable < 0) return { isError: true, text: 'Those exact schemas do not fit the local context. Select fewer tools or increase Local model context size. No selection was changed.' };
        selected.splice(removable, 1);
      }
      record.localToolNames = selected;
      const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const ranked = catalogue.map(tool => ({ tool, score: terms.reduce((sum, term) => sum +
        (tool.name.toLowerCase().includes(term) ? 10 : 0) + (String(tool.description).toLowerCase().includes(term) ? 1 : 0), 0) }))
        .filter(row => !terms.length || row.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const result = {
        helper: 'Local session tool discovery',
        grantsAuthority: false
      };
      if (requested.length) {
        Object.assign(result, {
          mode: 'schemas-loaded',
          schemas: requested.map(item => { const tool = byName.get(item); return { name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema }; }),
          selectedToolNames: namesFor(selected),
          nextStep: 'The requested tools are now available directly. Call the exact tool name using its input schema.'
        });
      } else {
        Object.assign(result, {
          mode: 'search',
          matches: ranked.slice(0, MAX_SEARCH_RESULTS).map(({ tool }) => ({ name: tool.name, description: String(tool.description || '').slice(0, 240) })),
          totalMatches: ranked.length,
          nextStep: `Call ${helperName} with names containing the exact tool names you need to load their schemas.`
        });
      }
      return { isError: false, text: JSON.stringify(result) };
    }
  };
}

module.exports = { COMPACT_THRESHOLD_CHARS, CORE_NAMES, HELPER_NAME, MAX_SEARCH_RESULTS, MAX_SELECTED_TOOLS, createLocalToolView, wireTool };
