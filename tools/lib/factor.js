'use strict';

// THE CATALOGUE ALREADY KNOWS WHAT EACH TOOL DOES AND WHAT IT DOES IT TO.
//
// `gmail.list`, `host.read_file`, `calendar.create`, `sandbox.cleanup` --
// every one of those ids names an ACTION and an OBJECT. Measured on the real
// registry: 230 of 272 ids carry a recognisable action verb, across 56
// namespaces. The first version of this system ignored that and hand-wrote the
// cross-product instead: 686 phrases across 78 entries, with the word "read"
// copied separately into the file entry, the email entry, the calendar entry
// and the clipboard entry, each maintained on its own.
//
// So this module derives (action, object) from the id, and the vocabularies
// become two small lists that COMPOSE:
//
//   action   ~6 classes, each with the everyday words people use for it.
//            Shared by all 272 tools. Adding "chuck" to `create` improves
//            every write tool at once.
//   object   one everyday vocabulary per namespace. This is where the real
//            authoring is, because `gmail` is where a person says "inbox".
//
// The read/write split that the old lexicon maintained BY HAND -- the fix for
// `calendar.create` outranking `calendar.list` on "what is on my calendar" --
// falls out of this structure instead of being a thing someone must remember.
//
// AND IT FAILS CLOSED. A tool whose id resolves to no action is not quietly
// given a default; it is an unresolved tool, and the build gate refuses. That
// is the whole point: a new tool added by another lane cannot join the
// catalogue unreachable, because the build stops.

const ACTION_UNRESOLVED = null;

/**
 * Split a tool id into its namespace and its remaining segments.
 *
 * `github.pull_request_create` ->
 *   { namespace: 'github', segments: ['pull','request','create'] }
 */
function splitId(id) {
  const text = String(id);
  const dot = text.indexOf('.');
  const namespace = dot === -1 ? '(root)' : text.slice(0, dot);
  const rest = dot === -1 ? text : text.slice(dot + 1);
  const segments = rest
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\s]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase());
  return { namespace, segments };
}

/**
 * Which action class a tool belongs to.
 *
 * Resolution order, and the order matters:
 *   1. an explicit per-id override, for the ids whose verb is ambiguous or
 *      absent (`browser.start` is a run, `task.start` is a change);
 *   2. the FIRST segment that names an action, left to right, because tool ids
 *      read verb-last-ish but object-first (`pull_request_create` is a
 *      create, not a request);
 *   3. unresolved -- which the gate turns into a failed build.
 */
function actionOf(id, actions) {
  const override = actions.idOverrides[id];
  if (override) {
    if (!actions.actions[override]) {
      const error = new Error(`config/actions.json overrides ${id} to unknown action "${override}"`);
      error.code = 'CAPABILITY_ACTION_UNKNOWN';
      throw error;
    }
    return { action: override, via: 'override' };
  }
  const { segments } = splitId(id);
  for (const segment of segments) {
    const action = actions.bySegment.get(segment);
    if (action) return { action, via: `segment:${segment}` };
  }
  return { action: ACTION_UNRESOLVED, via: 'none' };
}

/** Invert the action table into segment -> action for a single-pass lookup. */
function indexActions(raw) {
  const actions = raw.actions || {};
  const bySegment = new Map();
  const collisions = [];
  for (const [name, entry] of Object.entries(actions)) {
    for (const segment of entry.idSegments || []) {
      const key = String(segment).toLowerCase();
      if (bySegment.has(key) && bySegment.get(key) !== name) {
        collisions.push({ segment: key, between: [bySegment.get(key), name] });
        continue;
      }
      bySegment.set(key, name);
    }
  }
  if (collisions.length) {
    const named = collisions.map(item => `"${item.segment}" claimed by ${item.between.join(' and ')}`).join('; ');
    const error = new Error(
      `config/actions.json maps the same id segment to two actions -- ${named}. `
      + 'A segment must name one action or the derivation is not a derivation.'
    );
    error.code = 'CAPABILITY_ACTION_SEGMENT_COLLISION';
    throw error;
  }
  return { actions, bySegment, idOverrides: raw.idOverrides || {} };
}

/**
 * The object vocabulary for a tool: its namespace's everyday words.
 *
 * Namespaces are the object axis because that is what they are -- `gmail` is
 * email, `screen` is the screen, `workspace` is the other computer. A
 * namespace with no vocabulary is a gap the gate reports rather than a tool
 * that silently indexes with no object words.
 */
function objectOf(id, objects) {
  const { namespace } = splitId(id);
  const entry = objects.namespaces[namespace];
  if (!entry) return { namespace, says: null, note: null };
  return {
    namespace,
    says: entry.says == null ? null : entry.says,
    note: entry.note || null,
  };
}

/**
 * Factor the whole catalogue, and report what did not resolve.
 *
 * Returns one record per tool plus the two gap lists the build gate reads.
 * Nothing here throws on a gap -- the caller decides whether a gap is fatal,
 * because `--stats` wants to SEE the gaps and the write path wants to refuse
 * on them.
 */
function factorCatalogue(toolIds, actions, objects) {
  const records = [];
  const unresolvedActions = [];
  const namespacesWithoutObjects = new Set();

  for (const id of toolIds) {
    const { action, via } = actionOf(id, actions);
    const object = objectOf(id, objects);
    if (!action) unresolvedActions.push(id);
    if (object.says === null) namespacesWithoutObjects.add(object.namespace);
    records.push({
      id,
      action,
      actionVia: via,
      actionSays: action ? (actions.actions[action].says || []) : [],
      namespace: object.namespace,
      objectSays: object.says || [],
    });
  }

  return {
    records,
    unresolvedActions,
    namespacesWithoutObjects: [...namespacesWithoutObjects].sort(),
  };
}

/**
 * The composed vocabulary for every tool: action words + object words +
 * whatever residual idiom names it.
 *
 * This is the whole factorisation in one function. A tool gets the words for
 * the thing it DOES (shared with every other tool of that action) and the
 * words for the thing it does it TO (shared with its namespace). Neither list
 * knew about the other when it was written, and that independence is what
 * makes the arrangement cheap to keep current.
 */
function buildVocabulary(toolIds, actions, objects, phrases = { entries: [] }) {
  const factored = factorCatalogue(toolIds, actions, objects);
  const residualByTool = new Map();
  const unknownPhraseTools = [];
  const known = new Set(toolIds);
  const phraseTable = [];

  for (const entry of phrases.entries || []) {
    const tools = (entry.tools || []).filter(id => {
      if (known.has(id)) return true;
      unknownPhraseTools.push(id);
      return false;
    });
    if (!tools.length) continue;
    /* A residual idiom contributes BOTH ways: its words join the alias field
     * and the whole phrase joins the phrase table.
     *
     * Trying the principled-looking alternative -- phrase table only, on the
     * grounds that an idiom means something its words do not -- cost 25 points
     * of recall@3 on both fixture sets. The words are load-bearing: someone who
     * types half an idiom still deserves partial credit, and BM25 gives exactly
     * that. The measurement overruled the principle. */
    for (const id of tools) {
      if (!residualByTool.has(id)) residualByTool.set(id, []);
      residualByTool.get(id).push(...(entry.says || []));
    }
    for (const said of entry.says || []) {
      if (String(said).trim().split(/\s+/).length >= 2) phraseTable.push({ phrase: said, tools });
    }
  }

  const byTool = new Map();
  for (const record of factored.records) {
    byTool.set(record.id, {
      action: record.action,
      namespace: record.namespace,
      /* OBJECT WORDS ONLY. The action words are deliberately NOT here.
       *
       * Measured, and it cost 68 points of recall before it was understood:
       * folding the action vocabulary into the searchable text puts "read" into
       * the alias field of all 115 read tools, which destroys its IDF and
       * destroys the field's. Worse, a bag of words cannot express the thing
       * the factorisation is FOR -- "read" AND "email" as a conjunction. Two
       * independent weak terms is not one strong pair.
       *
       * So the object axis stays text (a namespace's words are specific: five
       * tools, high IDF, exactly the good half of the old lexicon) and the
       * action axis becomes a query-side signal matched against doc.action.
       * See actionAgreement() in score.js. */
      words: [
        ...record.objectSays,
        ...(residualByTool.get(record.id) || []),
      ],
    });
  }
  return { byTool, phraseTable, unknownPhraseTools, ...factored };
}

/** Every namespace present in the catalogue, for authoring and for the gate. */
function namespacesOf(toolIds) {
  const seen = new Map();
  for (const id of toolIds) {
    const { namespace } = splitId(id);
    seen.set(namespace, (seen.get(namespace) || 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

module.exports = Object.freeze({
  ACTION_UNRESOLVED,
  actionOf,
  buildVocabulary,
  factorCatalogue,
  indexActions,
  namespacesOf,
  objectOf,
  splitId,
});
