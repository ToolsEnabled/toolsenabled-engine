'use strict';

// Shared, content-neutral text matching used by ledger lifecycle and repo-only
// audit tools. Eight words is long enough to avoid incidental collisions while
// remaining stable when append markers interrupt a longer text.
const SHINGLE_WORDS = 8;

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

function shingles(normalized) {
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < SHINGLE_WORDS) return [];
  const out = [];
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
    out.push(words.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  return out;
}

module.exports = Object.freeze({ SHINGLE_WORDS, normalize, shingles });
