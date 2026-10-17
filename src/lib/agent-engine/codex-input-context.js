'use strict';

// Codex's approval metadata on an MCP elicitation (_meta / meta), projected
// into the provider-neutral input context (input-contract.js). Ported from the
// Windows host line's 700f45c, where it lived in the shared contract.
// Provider context is untrusted disclosure, never authority or a response.
// Only this normalized projection crosses the private terminal boundary. Raw
// parameters, descriptions, persistence preferences and display prose do not.
const { MISSING_CONTEXT, boundedData, record, safeToolName, safeRelativeTarget } = require('./input-contract');

function normalizeProviderInputContext(raw) {
  const base = { ...MISSING_CONTEXT };
  if (raw === undefined || raw === null) return MISSING_CONTEXT;
  let meta;
  try { meta = boundedData(raw); record(meta); }
  catch { return Object.freeze({ ...base, purpose: 'provider-approval', status: 'malformed' }); }
  const marker = meta.codex_approval_kind;
  if (Object.hasOwn(meta, 'codex_approval_kind') && (typeof marker !== 'string' || !marker.length || marker.length > 128)
      || Object.hasOwn(meta, 'codex_requires_user_input') && typeof meta.codex_requires_user_input !== 'boolean'
      || Object.hasOwn(meta, 'codex_request_type') && typeof meta.codex_request_type !== 'string') {
    return Object.freeze({ ...base, purpose: 'provider-approval', status: 'malformed' });
  }
  const approval = marker !== undefined || meta.codex_request_type === 'approval_request' || meta.codex_requires_user_input === true;
  const context = { ...base, purpose: marker === 'mcp_tool_call' ? 'mcp-tool-approval' : approval ? 'provider-approval' : 'unknown',
    status: marker === 'mcp_tool_call' ? 'recognized' : 'unrecognized' };
  if (safeToolName(meta.tool_name)) context.toolName = meta.tool_name;
  // This is a lexical relative hint only. Workspace/credential/byte authority
  // is still checked by dispatch; absolute targets are deliberately omitted.
  if (meta.tool_params && typeof meta.tool_params === 'object' && !Array.isArray(meta.tool_params)
      && safeRelativeTarget(meta.tool_params.path)) context.target = meta.tool_params.path;
  return Object.freeze(context);
}

module.exports = { normalizeProviderInputContext };
