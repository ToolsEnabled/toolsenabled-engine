'use strict';

// The person's active standing rules, as one block a subagent reads with its
// task. Rules come only from the person (agents may not file them), so they
// are stated as instructions that outrank the task.
const MAX_RULES = 40;
const MAX_CHARS = 6000;

function standingRulesBlock({ collect = selector => require('./owner-request-store').collectStack(selector) } = {}) {
  let layers;
  try { layers = collect({}); } catch { return ''; }
  const lines = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    for (const entry of Array.isArray(layer.entries) ? layer.entries : []) {
      const words = typeof entry.words === 'string' ? entry.words.replace(/\s+/g, ' ').trim() : '';
      if (words) lines.push(`${'  '.repeat(Math.min(Number(entry.depth) || 0, 3))}- ${entry.id}: ${words.slice(0, 500)}`);
    }
  }
  if (!lines.length) return '';
  const shown = [];
  let size = 0;
  for (const line of lines.slice(0, MAX_RULES)) {
    if (size + line.length > MAX_CHARS) break;
    shown.push(line);
    size += line.length + 1;
  }
  const more = lines.length - shown.length;
  return ['STANDING RULES FROM THE PERSON (follow these; they outrank the task above)', ...shown,
    // Rules are delivered here, never fetched: the rest are the person's to see, not instructions to look up.
    ...(more > 0 ? [`(${more} more not shown; the person sees every rule with toolsenabled ledger)`] : [])].join('\n');
}

module.exports = { standingRulesBlock };
