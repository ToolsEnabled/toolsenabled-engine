'use strict';

// Refuse a durable task success that carries a machine truncation or timeout
// marker. The caller can checkpoint partial work or report failure instead.

const MAX_SCAN_NODES = 512;
const MAX_VALUE_CHARS = 20000;

/** Every string argument value with its argument path. Bounded. */
function findStringArguments(args, { maxNodes = MAX_SCAN_NODES } = {}) {
  const found = [];
  let visited = 0;
  const walk = (value, keyPath) => {
    if (visited >= maxNodes) return;
    visited += 1;
    if (typeof value === 'string') {
      if (value.length > 0) found.push({ key: keyPath || '$', value: value.slice(0, MAX_VALUE_CHARS) });
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) walk(entry, `${keyPath}[${index}]`);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, keyPath ? `${keyPath}.${key}` : key);
    }
  };
  walk(args, '');
  return found;
}

const TERMINAL_SUCCESS_TOOLS = new Set(['task.complete']);

const TRUNCATION_SENTINEL = [
  { pattern: /\[\s*(?:output\s+|response\s+|result\s+)?truncated[^\]]*\]/i, what: 'a bracketed [truncated] marker' },
  { pattern: /<\s*truncated[^>]*>/i, what: 'a <truncated> marker' },
  { pattern: /\.\.\.\s*\(\s*truncated/i, what: 'an ellipsis-truncated marker' },
  { pattern: /%TRUNCATED%/i, what: 'a %TRUNCATED% sentinel' },
  { pattern: /"?(?:stop|finish)_reason"?\s*[:=]\s*"?(?:max_tokens|length)"?/i, what: 'a provider stop_reason of max_tokens/length' },
  { pattern: /\bmax_output_tokens\s+(?:reached|exceeded|hit)\b/i, what: 'an output-token limit report' },
  { pattern: /\bETIMEDOUT\b/, what: 'an ETIMEDOUT error code' },
  { pattern: /\bSIGKILL\b/, what: 'a SIGKILL signal name' },
  { pattern: /\bcommand timed out after\b/i, what: 'a command-timeout report' },
  { pattern: /\bwall[- ]clock (?:limit|budget) (?:reached|exceeded)\b/i, what: 'a wall-clock budget report' }
];

/**
 * @param {string} toolName
 * @param {object} args
 * @returns {{key:string, value:string, what:string}|null}
 */
function findTruncatedSuccessClaim(toolName, args) {
  if (!TERMINAL_SUCCESS_TOOLS.has(toolName)) return null;
  for (const { key, value } of findStringArguments(args)) {
    for (const { pattern, what } of TRUNCATION_SENTINEL) {
      if (pattern.test(value)) {
        const match = value.match(pattern);
        return { key, value: String(match && match[0] ? match[0] : value).slice(0, 200), what };
      }
    }
  }
  return null;
}

function truncatedSuccessRefusal(toolName, finding) {
  const error = new Error(
    `Tool '${toolName}' would record a TERMINAL SUCCESS whose payload carries ${finding.what} at argument `
    + `${finding.key} (${JSON.stringify(finding.value)}). `
    + 'Built-in completion integrity policy: a timeout or truncation is continuation, never success. '
    + 'A success recorded over a truncated result is a softened status, and a softened status '
    + 'is what the person reading the report ends up believing. '
    + 'The honest paths are open and unchanged: checkpoint the partial progress and keep working '
    + `(task.checkpoint), or record the real `
    + `outcome (task.fail) with its disposition. `
    + 'If the work genuinely finished and this marker is quoted evidence rather than your own outcome, '
    + 'summarise it in words instead of pasting the sentinel.'
  );
  error.code = 'TRUNCATED_SUCCESS_REFUSED';
  error.tool = toolName;
  error.field = finding.key;
  return error;
}

function assertActionGuards(toolName, args) {
  const finding = findTruncatedSuccessClaim(toolName, args);
  if (finding) throw truncatedSuccessRefusal(toolName, finding);
}

module.exports = { assertActionGuards, findStringArguments,
  findTruncatedSuccessClaim, TERMINAL_SUCCESS_TOOLS };
