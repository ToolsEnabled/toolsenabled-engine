'use strict';

// THE GRAMMAR CARRIES THE ACTION, AND THE TOKENIZER THROWS THE GRAMMAR AWAY.
//
// Measured: "what is on my calendar today" detected NO action at all. Every
// word carrying the request -- what, is, on, my -- is a stopword, and the only
// survivor is the object. English puts the action of a QUESTION in exactly the
// function words a bag-of-words index must discard, so the action axis fired
// on explicit imperatives ("delete that file") and stayed silent on the
// question forms people actually type.
//
// So action detection reads the RAW text, before tokenisation, and these
// patterns supply what the grammar means. It is the cheapest signal in the
// system: no authoring per tool, no vocabulary to maintain, and it applies to
// all 272 tools at once.
//
// KEPT DELIBERATELY SMALL. This is not a parser and must not grow into one. A
// pattern belongs here only when it names an ACTION that the words alone
// cannot -- "what/which/how many" means read, "let me know" means send. A
// pattern that merely correlates with a topic belongs in the object
// vocabulary, where IDF can judge it.

/** Ordered [pattern, action]. Every match contributes one vote. */
const GRAMMAR = Object.freeze([
  // Interrogatives: the question word IS the request to read.
  [/\b(?:what|whats|which|who|whose|how many|how much|how long)\b/, 'read'],
  // Existential and possessive questions: "is there", "do i have", "have we got".
  [/\b(?:is|are|was|were|do|does|did|have|has|had|can)\s+(?:there|i|we|you|it|they|any|my|the)\b/, 'read'],
  [/\b(?:show|tell|give|remind)\s+(?:me|us)\b/, 'read'],
  [/\b(?:anything|anybody|anyone|something)\b/, 'read'],
  [/\blook(?:s|ing)?\s+(?:like|at|in|through)\b/, 'read'],
  // Multi-word verbs whose parts mean nothing separately.
  [/\blet\s+(?:me|us|them|him|her)\s+know\b/, 'send'],
  [/\bget\s+rid\s+of\b/, 'remove'],
  [/\b(?:set|sets|setting)\s+up\b/, 'create'],
  [/\bspin\s+up\b/, 'create'],
  [/\bkick\s+off\b/, 'run'],
  [/\bfire\s+off\b/, 'run'],
  [/\bpull\s+up\b/, 'read'],
  [/\bwrite\s+(?:down|it\s+down|that\s+down)\b/, 'create'],
]);

/**
 * Which actions the raw text's grammar suggests, as action -> vote count.
 *
 * Votes rather than a single answer, because a sentence can genuinely carry
 * two ("show me what is there and delete it"), and because these votes are
 * pooled with the word-level ones in score.js rather than overriding them.
 */
function grammarVotes(rawText) {
  const text = String(rawText === null || rawText === undefined ? '' : rawText).toLowerCase();
  const votes = new Map();
  if (!text) return votes;
  for (const [pattern, action] of GRAMMAR) {
    if (pattern.test(text)) votes.set(action, (votes.get(action) || 0) + 1);
  }
  return votes;
}

module.exports = Object.freeze({ GRAMMAR, grammarVotes });
