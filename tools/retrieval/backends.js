'use strict';

// THE SEAM AN EMBEDDING BACKEND PLUGS INTO, AND THE REASON IT IS A SEAM AND NOT
// A FEATURE YET.
//
// R1246 asks for FTS now and a clean place for meaning-based retrieval later.
// The temptation is to leave a `// TODO: embeddings` and a branch that silently
// does keyword search when the semantic path is unavailable. That branch is
// exactly the defect class this surface exists to remove: the user turns on
// "meaning search", the backend is not installed, and the product quietly
// serves keyword results while the setting says otherwise. Absence read as
// consent, one more time.
//
// So the seam has THREE states and never two:
//
//   disabled-by-setting  the user has not asked for meaning search. Keyword
//                        ranking is what runs, and the packet says so.
//   unavailable          the user HAS asked for it and no backend is
//                        installed in this build. Keyword ranking is what
//                        runs, the packet says so IN THE ANSWER, and the
//                        caller can see that what they configured did not
//                        happen. It does not fail the query -- withholding a
//                        RE-RANK would be withholding the answer itself --
//                        but it never claims to have done it.
//   active               a registered backend actually ran.
//
// THE CONTRACT
// ------------
// A backend is a plain object:
//
//   {
//     name:      'ollama-nomic',            // stable identifier
//     kind:      'semantic',                // 'lexical' | 'semantic'
//     settingId: 'retrieval.meaning_search',// the control that authorises it
//     available(): boolean,                 // cheap, synchronous, no network
//     rerank(candidates, { topic, terms }): candidates   // pure, order only
//   }
//
// `rerank` may REORDER and may attach a `semanticScore`, and may do nothing
// else. It must not add candidates (a re-ranker that can invent a result is a
// second retrieval path with no corpus accounting) and it must not drop them
// below the caller's limit (dropping is a relevance decision the honest-miss
// algebra above it has already made). index.js enforces both mechanically, so a
// misbehaving backend is caught rather than trusted.
//
// Registration is explicit: `registerBackend(backend)`. Nothing scans a
// directory, and nothing is enabled by being present -- a registered backend
// still runs only if its settingId is enabled with user or installer
// provenance, decided in settings-gate.js.

const { RERANK_SETTING_ID } = require('./settings-gate');

const RERANK_STATE = Object.freeze({
  DISABLED: 'disabled-by-setting',
  UNAVAILABLE: 'unavailable',
  ACTIVE: 'active',
});

// The built-in ranking is bm25 inside SQLite. It is named here so a packet can
// always answer "what ranked this" with something other than silence.
const BASELINE_RANKER = Object.freeze({
  name: 'fts5-bm25',
  kind: 'lexical',
  why: 'SQLite FTS5 bm25 with identity/title/body column weights',
});

const backends = new Map();

function validateBackend(backend) {
  const errors = [];
  if (!backend || typeof backend !== 'object') return ['a backend must be an object'];
  if (typeof backend.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(backend.name)) {
    errors.push('name must be lowercase dashed text');
  }
  if (backend.kind !== 'semantic' && backend.kind !== 'lexical') errors.push('kind must be "semantic" or "lexical"');
  if (typeof backend.settingId !== 'string' || !backend.settingId.startsWith('retrieval.')) {
    errors.push('settingId must name a retrieval.* control, so the user can refuse it');
  }
  if (typeof backend.available !== 'function') errors.push('available() is required');
  if (typeof backend.rerank !== 'function') errors.push('rerank() is required');
  return errors;
}

function registerBackend(backend) {
  const errors = validateBackend(backend);
  if (errors.length) {
    throw new Error(`retrieval backend "${backend && backend.name}" is not registrable: ${errors.join('; ')}`);
  }
  backends.set(backend.name, Object.freeze({ ...backend }));
  return backend.name;
}

function unregisterBackend(name) {
  return backends.delete(name);
}

function listBackends() {
  return [...backends.values()].map(backend => ({ name: backend.name, kind: backend.kind, settingId: backend.settingId }));
}

/**
 * Decide what, if anything, re-ranks this answer -- and say so honestly.
 *
 * `gateDecision` is the settings-gate result for RERANK_SETTING_ID.
 */
function resolveRerank(gateDecision) {
  if (!gateDecision || gateDecision.state !== 'enabled') {
    return Object.freeze({
      state: RERANK_STATE.DISABLED,
      backend: null,
      ranker: BASELINE_RANKER.name,
      why: `Meaning-based re-ranking is off (${gateDecision ? gateDecision.why : 'no decision was made'}). `
        + `Results are ordered by ${BASELINE_RANKER.why}.`,
    });
  }
  const candidates = [...backends.values()].filter(backend => backend.settingId === gateDecision.settingId);
  const usable = candidates.find(backend => {
    try { return backend.available() === true; } catch { return false; }
  });
  if (!usable) {
    return Object.freeze({
      state: RERANK_STATE.UNAVAILABLE,
      backend: null,
      ranker: BASELINE_RANKER.name,
      why: candidates.length
        ? `Meaning-based re-ranking is ON in your settings, but no registered backend reported itself available `
          + `(${candidates.map(b => b.name).join(', ')}). These results were ordered by ${BASELINE_RANKER.why} instead. `
          + 'They are real results; they are not the ranking you asked for.'
        : 'Meaning-based re-ranking is ON in your settings, but this build ships no semantic backend. These results were '
          + `ordered by ${BASELINE_RANKER.why} instead. They are real results; they are not the ranking you asked for.`,
    });
  }
  return Object.freeze({
    state: RERANK_STATE.ACTIVE,
    backend: usable.name,
    ranker: usable.name,
    why: `Re-ranked by "${usable.name}" (${usable.kind}) after ${BASELINE_RANKER.why} produced the candidates.`,
  });
}

/**
 * Apply the resolved backend, enforcing the contract rather than trusting it.
 *
 * A backend that adds or removes candidates is refused and the baseline order
 * is kept, with the refusal reported. A retrieval path that can be widened by a
 * plugin is not a retrieval path with a corpus accounting.
 */
// A text-safe identity for a candidate. It was a template literal with a NUL
// separator, which worked at runtime and made git classify this file as BINARY --
// so the patch carrying it could not be applied. JSON is unambiguous, printable,
// and cannot collide however a docId is spelt.
function identityOf(candidate) {
  return JSON.stringify([candidate.source, candidate.docId]);
}

function applyRerank(resolution, candidates, context) {
  if (!resolution || resolution.state !== RERANK_STATE.ACTIVE) return { candidates, violation: null };
  const backend = backends.get(resolution.backend);
  if (!backend) return { candidates, violation: `backend "${resolution.backend}" disappeared between resolution and use` };
  let reranked;
  try {
    reranked = backend.rerank(candidates.slice(), context);
  } catch (error) {
    return { candidates, violation: `backend "${backend.name}" threw during rerank: ${error.message}` };
  }
  if (!Array.isArray(reranked) || reranked.length !== candidates.length) {
    return { candidates, violation: `backend "${backend.name}" changed the candidate count, which a re-ranker may not do` };
  }
  const before = new Map();
  for (const candidate of candidates) {
    const identity = identityOf(candidate);
    before.set(identity, (before.get(identity) || 0) + 1);
  }
  for (const candidate of reranked) {
    const identity = candidate && identityOf(candidate);
    const remaining = identity && before.get(identity);
    if (!remaining) {
      return { candidates, violation: `backend "${backend.name}" introduced a result that was not a candidate` };
    }
    before.set(identity, remaining - 1);
  }
  return { candidates: reranked, violation: null };
}

module.exports = Object.freeze({
  BASELINE_RANKER,
  RERANK_SETTING_ID,
  RERANK_STATE,
  applyRerank,
  listBackends,
  registerBackend,
  resolveRerank,
  unregisterBackend,
  validateBackend,
});
