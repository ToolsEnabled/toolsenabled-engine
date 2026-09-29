'use strict';

// ONE TOKENIZER, USED BY THE BUILD AND BY EVERY QUERY.
//
// This file exists as its own module for a single reason: a query term the
// index could never contain produces a confident MISS for a document that is
// sitting right there. tools/retrieval/fts-index.js states the same rule about
// matching SQLite's unicode61 tokenizer, and this is the same hazard one step
// further -- if the builder and the scorer disagree by one suffix rule, the
// artifact is wrong in a way no test of either half alone can see.
//
// So: the builder imports tokenize() from here, the scorer imports tokenize()
// from here, and the artifact records TOKENIZER_VERSION. An artifact built by a
// different tokenizer version is refused at load rather than answered from.
//
// THE STOPWORD LIST IS DELIBERATELY THE SAME LIST as tools/retrieval/fts-index.js
// and tools/prior-work-index.js. Two discovery surfaces that disagree about
// whether "how" is a searchable word give two different answers to the same
// question, and the disagreement is invisible.

const TOKENIZER_VERSION = 'capability-tokenizer-v1';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'at',
  'with', 'how', 'what', 'where', 'why', 'when', 'who', 'do', 'does', 'did', 'i',
  'we', 'my', 'this', 'that', 'these', 'those', 'be', 'am', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will', 'get', 'got', 'find', 'show', 'me',
  'about', 'from', 'by', 'as', 'if', 'not', 'no', 'yes', 'any', 'all', 'has',
  'have', 'had', 'been', 'being', 'but', 'so', 'than', 'then', 'there', 'here',
  'you', 'your', 'our', 'us', 'its', 'his', 'her', 'they', 'them', 'up', 'out',
  'into', 'over', 'under', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'too', 'very', 'just', 'now', 'also', 'md', 'json', 'http', 'https', 'www',
]);

/* Terms that describe THIS corpus rather than any topic in it. Measured on the
 * real registry: `local` appears in 192 of 272 descriptions, `write` in 149,
 * `read` in 133, `one` in 130, `never` in 113. They are not English stopwords
 * and they are NOT dropped -- IDF already flattens them -- but they are named
 * so the eval can report a match that rests only on one of them, which is the
 * exact shape a false positive takes in this catalogue. */
const CORPUS_COMMON = new Set(['local', 'read', 'write', 'one', 'never', 'tool', 'tools']);

/* A DELIBERATELY CONSERVATIVE STEMMER.
 *
 * Full Porter over-stems identifiers ("capture" to "captur", "release" to
 * "releas") and this corpus is mostly identifiers. What actually costs recall
 * here is plain morphology: a person writes "screenshots" and the description
 * says "screenshot"; "running agents" against "run". So this handles exactly
 * that, and only when the remaining stem is long enough to still mean
 * something.
 *
 * Both the raw word AND its stem are indexed, in separate term spaces, so an
 * exact match always outranks a morphological one instead of being blurred
 * into it. See the tilde prefix in expand(). */
const STEM_KEEP = new Set([
  // Words whose trailing s/es/ing/ed is not a suffix. Stemming these produces a
  // stem that collides with an unrelated word, which is worse than no stem.
  // Only SINGULAR/BASE forms belong here. Listing "settings" as well as
  // "setting" was a measured bug: it stopped the plural reaching the singular,
  // so a description saying "setting" was invisible to a person typing
  // "settings". The stage order below re-checks this set after plural
  // stripping, which is what makes listing only the base form correct.
  'address', 'access', 'process', 'status', 'less', 'class', 'pass', 'gloss',
  'business', 'progress', 'express', 'across', 'press', 'dns', 'cross',
  'thing', 'string', 'ring', 'bring', 'during', 'ping', 'spring',
  'setting', 'meeting', 'listing', 'billing', 'ending', 'padding', 'heading',
  'need', 'seed', 'feed', 'speed', 'breed', 'creed', 'freed', 'exceed',
]);

/**
 * Reduce a word to the form it shares with its own inflections.
 *
 * Applied in stages, because the stages compose: "settings" is plural first
 * ("setting") and must then be recognised as a KEEP word before the -ing rule
 * would wreck it ("sett").
 *
 * The final stage strips a trailing silent e. That single line is what makes
 * capture / captures / captured / capturing all meet at "captur" -- without it
 * "captured" stemmed to "captur" while "capture" stayed "capture", so the two
 * never matched and the whole stem space was decorative for -e verbs, which is
 * most of this catalogue's vocabulary.
 */
function stem(word) {
  if (word.length < 5 || STEM_KEEP.has(word)) return word;
  let out = word;

  // Stage 1 -- plural and third person.
  if (out.endsWith('ies') && out.length > 5) out = `${out.slice(0, -3)}y`;
  else if (out.endsWith('sses')) out = out.slice(0, -2);
  else if (out.endsWith('es') && out.length > 5 && /(?:ch|sh|x|z|s)es$/.test(out)) out = out.slice(0, -2);
  else if (out.endsWith('s') && !out.endsWith('ss') && !out.endsWith('us')) out = out.slice(0, -1);
  if (STEM_KEEP.has(out)) return out;

  // Stage 2 -- verb forms. "running" gives "runn" gives "run": undo an ordinary
  // doubled consonant. "falling" must stay "fall" rather than becoming "fal",
  // which is why the character class excludes l, s and f.
  if (out.endsWith('ing') && out.length > 6) {
    const base = out.slice(0, -3);
    out = /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  } else if (out.endsWith('ed') && out.length > 5) {
    const base = out.slice(0, -2);
    out = /([bdgmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (STEM_KEEP.has(out)) return out;

  // Stage 3 -- trailing silent e. See the note above.
  if (out.length >= 6 && out.endsWith('e')) out = out.slice(0, -1);
  return out;
}

/**
 * Split any text into raw words.
 *
 * Identifiers are split on their own boundaries too: `screen.capture_window`
 * and `captureWindow` both yield ['screen','capture','window'], because a
 * person does not type dots and an agent should still find the tool.
 */
function words(text) {
  const source = String(text === null || text === undefined ? '' : text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const out = [];
  for (const word of source.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    out.push(word);
  }
  return out;
}

/**
 * The indexed/queried term list for a piece of text, as term -> count.
 *
 * Every word contributes TWO terms: itself, and `~<stem>`. Keeping them in
 * separate spaces is what lets the scorer pay full weight for "capture"
 * matching "capture" and a discounted weight for "capturing" matching
 * "capture", instead of blurring those into the same evidence.
 *
 * The stem term is emitted EVEN WHEN IT EQUALS THE WORD. Emitting it only on a
 * difference left the stem space partial, and a partial space silently fails
 * in one direction: a document saying "setting" had no `~setting` entry, so a
 * person typing "settings" -- whose stem term IS `~setting` -- matched nothing.
 * A total space costs about 70 KB and removes the whole class.
 */
function expand(text) {
  const counts = new Map();
  for (const word of words(text)) {
    counts.set(word, (counts.get(word) || 0) + 1);
    const stemmed = stem(word);
    if (stemmed.length >= 3) {
      const term = `~${stemmed}`;
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return counts;
}

/** The flat, de-duplicated term list for a query. Order is first-seen. */
function tokenize(text) {
  return [...expand(text).keys()];
}

/** True for a term that describes the corpus rather than a topic in it. */
function corpusCommon(term) {
  return CORPUS_COMMON.has(term.startsWith('~') ? term.slice(1) : term);
}

/** A normalized single-spaced string, for phrase matching in the lexicon. */
function normalizePhrase(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = Object.freeze({
  CORPUS_COMMON,
  STOPWORDS,
  TOKENIZER_VERSION,
  corpusCommon,
  expand,
  normalizePhrase,
  stem,
  tokenize,
  words,
});
