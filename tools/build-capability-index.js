#!/usr/bin/env node
'use strict';

// BUILD THE CAPABILITY INDEX. SHIP TIME, ONCE, FROM THE REGISTRY ITSELF.
//
//   node tools/build-capability-index.js            # write config/capability-index.json
//   node tools/build-capability-index.js --stats    # print, write nothing
//   node tools/build-capability-index.js --check    # is the artifact current?
//   node tools/build-capability-index.js --with-packs
//
// IT INDEXES THIS CHECKOUT BY DEFAULT. --engine-root <path> still points it at
// another one, which is how the lane this came from read the engine from
// outside it; here the registry it must describe is the one in this repository,
// so the default is this repository and no caller has to know that.
//
// THE REGISTRY IS READ IN THIS PROCESS. Never over the MCP wire.
// tools/grepsaver-tooldigest.js records the measurement that makes this
// non-negotiable: a plain tools/list returned 103 tools where the registry
// defined 263, because the server narrows what it advertises to the local
// permission tier. An index built from that would be missing most of the
// catalogue and would look perfectly healthy.
//
// AND THE COUNT IS CHECKED BEFORE ANYTHING IS WRITTEN. A registry that reads
// short is a broken build, not a smaller index.
//
// OWNER TOOL PACKS ARE OFF BY DEFAULT. src/lib/tool-packs/ does not ship in the
// installer payload, so an index built with them would recommend, to a
// customer's agent, 49 tools that do not exist on that customer's machine.
// --with-packs exists for an owner-machine build and is recorded in the spec.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { composeDocuments, firstSentence, loadRegistry } = require('./lib/corpus');
const factor = require('./lib/factor');
const { TOKENIZER_VERSION, expand, normalizePhrase } = require('../src/lib/capability-recall/text');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_VERSION = 'capability-index-v1';
const BUILDER_VERSION = 'capability-index-builder-v1';

/* A registry this much smaller than the last recorded build is treated as a
 * broken read rather than a shrinking product. Tools do get removed, so this
 * is a floor on the ABSOLUTE count, set well below the real catalogue and
 * checked against the aliases too -- an alias naming a tool that is not there
 * fails the build outright, which catches a genuine truncation immediately. */
const MINIMUM_PLAUSIBLE_TOOLS = 120;

/* Bounds on what each document carries into the artifact. The index has to be
 * small enough to load in every host process without anyone thinking about it,
 * so a description is stored only as much as the renderers can actually show. */
const SUMMARY_CHARS = 300;
const MAX_STORED_PARAMS = 6;
const PARAM_DESC_CHARS = 70;

/* Starting constants. The tuner (tests/capability-recall-eval.js --tune) moves
 * the weights, the stem discount, the phrase boost and the two floors against
 * the gold set and writes the winners back here-shaped into the artifact.
 * k1 and commonFraction are deliberately NOT tuned: k1 1.2 is the textbook
 * default, commonFraction 0.4 is the constant tools/retrieval/fts-index.js and
 * tools/prior-work-index.js already share, and a tuner free to move everything
 * overfits a gold set this size. */
const DEFAULT_CONSTANTS = Object.freeze({
  k1: 1.2,
  weights: Object.freeze({ identity: 8, title: 4, body: 1, alias: 6 }),
  b: Object.freeze({ identity: 0.4, title: 0.6, body: 0.75, alias: 0.4 }),
  stemDiscount: 0.55,
  commonFraction: 0.4,
  /* A matched word this rare, when the tool names it in its identity or its
   * aliases, is enough evidence on its own. See the strong-word note in
   * score.js. 0.025 of 272 is a df of about 6. */
  strongTermFraction: 0.025,
  /* The evidence a query must carry before a full match can mean "certain".
   * See the denominator note in score.js: without it a one-word prompt that
   * matches its one word scores 1.0 however thin that word is. */
  priorMass: 6,
  /* How much a query word that no tool contains counts against coverage, as a
   * fraction of the idf a df of zero earns. See the denominator note in
   * score.js: at 1.0 it sinks greetings and detailed requests alike. */
  absentWeight: 0.4,
  /* How many of the query's most informative terms form the denominator, and
   * how much total mass unknown words may add to it. See the focus note in
   * score.js -- these two exist because a colloquial sentence is mostly
   * framing, and charging a tool for the framing silenced every natural
   * request. Terms, not words: each word contributes a raw term and a stem
   * term, so 6 is roughly three words of intent. */
  focusTerms: 6,
  maxAbsentMass: 8,
  /* Scores this close are a tie; see the tie-break note in score.js. Sized from
   * measurement: tools sharing an alias entry land about 4e-5 apart, so 0.002
   * catches float noise and nothing real. At 0.02 it reordered genuinely
   * different scores and cost a gold case. */
  tieBand: 0.002,
  /* Agreement between the action a query names and the action a tool's id says
   * it performs. ONE signal replacing 120 bag-of-words terms; see
   * detectActions() in score.js for why the axes are scored separately. */
  actionBoost: 0.15,
  phraseBoost: 0.3,
  floorAuto: 0.42,
  floorQuery: 0.25,
});

const FIELDS = ['identity', 'title', 'body', 'alias'];

function parseArguments(argv) {
  const args = argv.slice(2);
  const options = {
    engineRoot: process.env.TOOLSENABLED_ENGINE_ROOT || ROOT,
    out: path.join(ROOT, 'config', 'capability-index.json'),
    spec: path.join(ROOT, 'config', 'capability-index-spec.json'),
    actions: path.join(ROOT, 'config', 'actions.json'),
    objects: path.join(ROOT, 'config', 'objects.json'),
    phrases: path.join(ROOT, 'config', 'phrases.json'),
    withPacks: false,
    mode: 'write',
    constants: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--engine-root') { options.engineRoot = args[index + 1]; index += 1; }
    else if (arg === '--out') { options.out = path.resolve(args[index + 1]); index += 1; }
    else if (arg === '--actions') { options.actions = path.resolve(args[index + 1]); index += 1; }
    else if (arg === '--objects') { options.objects = path.resolve(args[index + 1]); index += 1; }
    else if (arg === '--phrases') { options.phrases = path.resolve(args[index + 1]); index += 1; }
    else if (arg === '--constants') { options.constants = JSON.parse(fs.readFileSync(args[index + 1], 'utf8')); index += 1; }
    else if (arg === '--with-packs') options.withPacks = true;
    else if (arg === '--stats') options.mode = 'stats';
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else throw new Error(`unrecognised argument: ${arg}`);
  }
  return options;
}

function engineCommit(engineRoot) {
  const result = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true, shell: false,
    env: safeLaunchEnvironment(process.env, { context: 'capability index git revision' }),
  });
  const commit = result.stdout && result.stdout.trim();
  if (result.error || result.status !== 0 || !commit) {
    const detail = result.error
      ? result.error.message
      : (result.stderr && result.stderr.trim()) || `git exited with status ${String(result.status)}`;
    const error = new Error(`could not establish the engine commit for ${engineRoot}: ${detail}`);
    error.code = 'CAPABILITY_ENGINE_COMMIT_UNKNOWN';
    throw error;
  }
  return commit;
}

/**
 * Load the three factored vocabularies and resolve them against the registry.
 *
 * THE GATE LIVES HERE, and it is the reason the factorisation is worth having.
 * The old lexicon could rot silently: a renamed tool kept its alias entry, the
 * entry kept looking maintained, and the words reached nothing. The composed
 * vocabularies can rot in three new ways, so all three are refusals:
 *
 *   1. a tool id that resolves to no action and has no override -- a new tool
 *      named in a way the segment table has never seen;
 *   2. a namespace with no object vocabulary -- a whole new family of tools
 *      that no person has words for;
 *   3. a residual phrase naming a tool that no longer exists.
 *
 * Dead vocabulary is reported too (a namespace entry for a namespace that is
 * gone), because a vocabulary file that accumulates entries for things that
 * left is how the next person stops trusting it.
 */
function loadVocabulary(options, toolIds) {
  const actions = factor.indexActions(JSON.parse(fs.readFileSync(options.actions, 'utf8')));
  const objects = JSON.parse(fs.readFileSync(options.objects, 'utf8'));
  const phrases = JSON.parse(fs.readFileSync(options.phrases, 'utf8'));
  const built = factor.buildVocabulary([...toolIds], actions, objects, phrases);

  const refusals = [];
  if (built.unresolvedActions.length) {
    refusals.push(
      `${built.unresolvedActions.length} tool id(s) resolve to no action: ${built.unresolvedActions.join(', ')}. `
      + 'Add the verb to config/actions.json idSegments if it is a general verb (preferred -- it will classify '
      + 'future tools too), or add an entry to idOverrides if the id is genuinely irregular.'
    );
  }
  if (built.namespacesWithoutObjects.length) {
    refusals.push(
      `${built.namespacesWithoutObjects.length} namespace(s) have no object vocabulary: `
      + `${built.namespacesWithoutObjects.join(', ')}. Add them to config/objects.json -- without words for the `
      + 'thing itself, every tool in that namespace can only be found by its own description.'
    );
  }
  if (built.unknownPhraseTools.length) {
    refusals.push(
      `config/phrases.json names ${built.unknownPhraseTools.length} tool id(s) that are not in the registry: `
      + `${[...new Set(built.unknownPhraseTools)].join(', ')}.`
    );
  }
  if (refusals.length) {
    const error = new Error(refusals.join('\n  '));
    error.code = 'CAPABILITY_VOCABULARY_INCOMPLETE';
    throw error;
  }

  const present = new Set(factor.namespacesOf([...toolIds]).map(([name]) => name));
  const dead = Object.keys(objects.namespaces).filter(name => !present.has(name));

  const actionCounts = new Map();
  for (const record of built.records) actionCounts.set(record.action, (actionCounts.get(record.action) || 0) + 1);

  /* The query-side half of the action axis: which action(s) a person's word
   * suggests. Built from the SAME `says` lists the documents were composed
   * from, so the two halves cannot drift. */
  const actionByWord = {};
  for (const [name, entry] of Object.entries(actions.actions)) {
    for (const said of entry.says || []) {
      for (const word of String(said).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        if (!actionByWord[word]) actionByWord[word] = [];
        if (!actionByWord[word].includes(name)) actionByWord[word].push(name);
      }
    }
  }

  return {
    byTool: built.byTool,
    actionByWord,
    phraseTable: built.phraseTable,
    deadNamespaces: dead,
    actionCounts,
    counts: {
      idSegments: [...actions.bySegment.keys()].length,
      overrides: Object.keys(actions.idOverrides).length,
      actionWords: Object.values(actions.actions).reduce((total, entry) => total + (entry.says || []).length, 0),
      objectWords: Object.values(objects.namespaces).reduce((total, entry) => total + (entry.says || []).length, 0),
      namespaces: Object.keys(objects.namespaces).length,
      residualPhrases: (phrases.entries || []).reduce((total, entry) => total + (entry.says || []).length, 0),
    },
  };
}

/**
 * EVERY TOOL MUST BE REACHABLE BY SOMETHING A PERSON COULD TYPE.
 *
 * The minimum bar, deliberately gentle: a tool must be retrievable by its OWN
 * first description sentence. A tool that cannot be found by its own words has
 * no route to a person at all, and the old build shipped 52 tools with no
 * vocabulary and no way to notice.
 *
 * Measured before this gate existed: 51 of those 52 already passed, so the bar
 * is real without being punitive -- it catches the tool nothing can reach, not
 * the tool that is merely obscure.
 */
function checkReachability(artifact, rank) {
  const unreachable = [];
  for (let index = 0; index < artifact.docs.length; index += 1) {
    const document = artifact.docs[index];
    if (!document.clause) { unreachable.push({ id: document.id, why: 'no description to be found by' }); continue; }
    /* eslint-disable-next-line no-continue -- read below */
    /* TOP TEN, BECAUSE TEN IS A REAL SURFACE. find() returns ten, so "reachable"
     * means "would appear in an explicit query for its own description". At
     * five the gate was asking a different and unfair question -- whether a
     * tool beats its five nearest siblings -- and refused the build over
     * one deployment-status tool being crowded out by four other deployment
     * tools. That tool was findable; it was merely not the most findable of its
     * family, which is not a defect. */
    const found = rank(artifact, document.clause, { floor: 0, limit: 10 });
    if (!found.results.some(result => result.id === document.id)) {
      unreachable.push({ id: document.id, why: 'not in the top 10 for its own first sentence' });
    }
  }
  return unreachable;
}

/** Build the inverted index from composed documents. */
function buildIndex(documents) {
  const postings = new Map();
  const totals = { identity: 0, title: 0, body: 0, alias: 0 };
  const stored = [];

  documents.forEach((document, documentIndex) => {
    const length = { identity: 0, title: 0, body: 0, alias: 0 };
    const perTerm = new Map();
    FIELDS.forEach((field, fieldIndex) => {
      const counts = expand(document.fields[field]);
      let fieldLength = 0;
      for (const [term, count] of counts) {
        fieldLength += count;
        let row = perTerm.get(term);
        if (!row) { row = [0, 0, 0, 0]; perTerm.set(term, row); }
        row[fieldIndex] += count;
      }
      length[field] = fieldLength;
      totals[field] += fieldLength;
    });

    for (const [term, row] of perTerm) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([documentIndex, row[0], row[1], row[2], row[3]]);
    }

    stored.push({
      id: document.id,
      ns: document.ns,
      action: document.action,
      effect: document.effect,
      provider: document.provider,
      ro: document.ro,
      destructive: document.destructive,
      ext: document.ext,
      clause: document.clause,
      summary: firstSentence(document.fields.body, SUMMARY_CHARS),
      params: document.params.slice(0, MAX_STORED_PARAMS).map(parameter => ({
        name: parameter.name,
        required: parameter.required,
        desc: String(parameter.desc || '').slice(0, PARAM_DESC_CHARS),
      })),
      len: length,
    });
  });

  const documentCount = documents.length || 1;
  const avgLen = {};
  for (const field of FIELDS) avgLen[field] = totals[field] / documentCount;

  const df = {};
  const orderedPostings = {};
  for (const term of [...postings.keys()].sort()) {
    const list = postings.get(term);
    df[term] = list.length;
    orderedPostings[term] = list;
  }
  return { docs: stored, postings: orderedPostings, df, avgLen };
}

function build(options) {
  const engineRoot = path.resolve(options.engineRoot);
  if (!fs.existsSync(path.join(engineRoot, 'src', 'lib', 'tool-registry.js'))) {
    const error = new Error(`no src/lib/tool-registry.js under --engine-root ${engineRoot}`);
    error.code = 'CAPABILITY_ENGINE_ROOT_INVALID';
    throw error;
  }

  const tools = loadRegistry(engineRoot, { withPacks: options.withPacks });
  if (tools.length < MINIMUM_PLAUSIBLE_TOOLS) {
    const error = new Error(
      `the registry at ${engineRoot} reported only ${tools.length} tools, below the ${MINIMUM_PLAUSIBLE_TOOLS} floor. `
      + 'That is what a truncated or partially loaded registry looks like from here, and an index built from it '
      + 'would be silently missing most of the catalogue. Nothing was written.'
    );
    error.code = 'CAPABILITY_REGISTRY_SHORT';
    throw error;
  }

  const toolIds = new Set(tools.map(tool => String(tool.name)));
  const vocabulary = loadVocabulary(options, toolIds);
  const documents = composeDocuments(tools, vocabulary.byTool);
  if (documents.length !== tools.length) {
    const error = new Error(
      `document composition produced ${documents.length} documents for ${tools.length} registry tools. `
      + 'Reachability and index counts would be incomplete, so nothing was written.'
    );
    error.code = 'CAPABILITY_DOCUMENT_COUNT_MISMATCH';
    throw error;
  }
  const { docs, postings, df, avgLen } = buildIndex(documents);

  const indexById = new Map(docs.map((document, position) => [document.id, position]));
  /* Longest phrase first, so a specific intent is preferred over a generic one
   * that happens to be a substring of it. */
  const phraseTable = vocabulary.phraseTable
    .map(entry => ({ p: normalizePhrase(entry.phrase), tools: entry.tools.map(id => indexById.get(id)).filter(value => value !== undefined) }))
    .filter(entry => entry.tools.length > 0)
    .sort((a, b) => b.p.length - a.p.length || a.p.localeCompare(b.p));

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    builderVersion: BUILDER_VERSION,
    engine: {
      commit: engineCommit(engineRoot),
      toolCount: tools.length,
      withPacks: options.withPacks,
    },
    constants: options.constants || DEFAULT_CONSTANTS,
    N: docs.length,
    avgLen,
    docs,
    df,
    postings,
    phrases: phraseTable,
    actionByWord: vocabulary.actionByWord,
  };

  /* THE LAST GATE: can every tool be reached by anything a person could type?
   * Run on the finished artifact because it needs the real scorer. */
  const { rank } = require('../src/lib/capability-recall/score');
  const unreachable = checkReachability(artifact, rank);

  const stats = {
    unreachable,
    tools: tools.length,
    namespaces: new Set(docs.map(document => document.ns)).size,
    terms: Object.keys(df).length,
    postings: Object.values(postings).reduce((total, list) => total + list.length, 0),
    actionWords: vocabulary.counts.actionWords,
    objectWords: vocabulary.counts.objectWords,
    idSegments: vocabulary.counts.idSegments,
    overrides: vocabulary.counts.overrides,
    residualPhrases: vocabulary.counts.residualPhrases,
    vocabularyNamespaces: vocabulary.counts.namespaces,
    deadNamespaces: vocabulary.deadNamespaces,
    actionCounts: [...vocabulary.actionCounts].sort((a, b) => b[1] - a[1]),
    phrases: phraseTable.length,
  };
  return { artifact, stats };
}

/* Stable serialisation. The hash has to mean "the same catalogue produced the
 * same index", so the bytes must not depend on key insertion order.
 *
 * Written out longhand rather than with JSON.stringify's second argument. That
 * argument LOOKS like a key ordering and is actually a recursive allowlist: it
 * keeps only the named keys, at every depth. Passing the top-level key names
 * produced a syntactically valid 1,857-byte artifact with every document,
 * posting and phrase silently removed, and a sha256 over it that looked
 * perfectly respectable. Measured here on the first build. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function serialise(artifact) {
  return `${stableStringify(artifact)}\n`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function specFor(artifact, stats, text) {
  return `${JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    builderVersion: artifact.builderVersion,
    tokenizerVersion: artifact.tokenizerVersion,
    engineCommit: artifact.engine.commit,
    toolCount: artifact.engine.toolCount,
    ownerToolPacksIncluded: artifact.engine.withPacks,
    ownerToolPacksNote: artifact.engine.withPacks
      ? 'BUILT WITH OWNER PACKS. This index names tools absent from the installer payload and must not ship to customers.'
      : 'Owner tool packs excluded, matching the installer payload (capability/src/lib has no tool-packs directory).',
    documents: artifact.N,
    terms: stats.terms,
    postings: stats.postings,
    aliasEntries: stats.aliasEntries,
    aliasedTools: stats.aliasedTools,
    phrases: stats.phrases,
    constants: artifact.constants,
    artifactBytes: Buffer.byteLength(text, 'utf8'),
    artifactSha256: sha256(text),
    canonicalArtifact: `engine=${artifact.engine.commit} | tools=${artifact.engine.toolCount} `
      + `| tokenizer=${artifact.tokenizerVersion} | sha256=${sha256(text)}`,
  }, null, 2)}\n`;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`build-capability-index: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.mode === 'help') {
    process.stdout.write(
      'usage: node tools/build-capability-index.js [--engine-root <path>] [--with-packs] [--stats|--check]\n'
    );
    return;
  }
  if (!options.engineRoot) {
    process.stderr.write(
      'build-capability-index: no engine root to read (--engine-root, or TOOLSENABLED_ENGINE_ROOT, is empty).\n'
      + '  It defaults to this checkout. Whatever it names is READ ONLY; nothing is written into it.\n'
    );
    process.exitCode = 2;
    return;
  }

  let built;
  try {
    built = build(options);
  } catch (error) {
    process.stderr.write(`build-capability-index: REFUSED (${error.code || 'FAILED'})\n  ${error.message}\n`);
    process.exitCode = 3;
    return;
  }

  const text = serialise(built.artifact);
  const stats = built.stats;
  const report = [
    `tools           ${stats.tools}${built.artifact.engine.withPacks ? ' (with owner packs -- not shippable)' : ''}`,
    `namespaces      ${stats.namespaces}`,
    `terms           ${stats.terms}`,
    `postings        ${stats.postings}`,
    `actions         ${stats.actionCounts.map(([name, count]) => `${name}=${count}`).join('  ')}`,
    `derivation      ${stats.idSegments} id segments + ${stats.overrides} overrides`,
    `vocabulary      ${stats.actionWords} action words (shared) + ${stats.objectWords} object words `
      + `over ${stats.vocabularyNamespaces} namespaces + ${stats.residualPhrases} residual`,
    `residual table  ${stats.phrases} multi-word idioms`,
    ...(stats.deadNamespaces.length
      ? [`DEAD VOCABULARY  ${stats.deadNamespaces.join(', ')} — namespaces that no longer exist`] : []),
    `reachability    ${stats.tools - stats.unreachable.length}/${stats.tools} tools findable by their own description`,
    `artifact        ${Buffer.byteLength(text, 'utf8')} bytes`,
    `sha256          ${sha256(text)}`,
    `engine commit   ${built.artifact.engine.commit}`,
  ].join('\n');

  if (options.mode === 'stats') {
    process.stdout.write(`${report}\n`);
    return;
  }
  // Matching bytes do not establish a usable index. Apply the same
  // reachability guard to an existing artifact as to a newly written one.
  if (stats.unreachable.length) {
    process.stderr.write([
      'build-capability-index: REFUSED (CAPABILITY_TOOL_UNREACHABLE)',
      `  ${stats.unreachable.length} tool(s) fail the description reachability check:`,
      ...stats.unreachable.map(item => `    ${item.id} -- ${item.why}`),
      '  Review the tool description, namespace object words in config/objects.json,',
      '  or the idiom that names the tool in config/phrases.json. Nothing was written.',
      '',
    ].join('\n'));
    process.exitCode = 3;
    return;
  }
  if (options.mode === 'check') {
    let current = null;
    try { current = fs.readFileSync(options.out, 'utf8'); } catch { /* reported below */ }
    /* COMPARED WITHOUT THE BUILD STAMP, OR THIS GATE CANNOT EVER PASS.
     *
     * The artifact records the engine commit it was built at. Committing the
     * artifact moves HEAD, so the next build stamps a different commit and the
     * committed copy differs from a fresh build -- permanently. Measured: HEAD
     * c9a7d173 against a stamp of 9bae071a, the commit it was built at, one
     * before the commit that contains it. No number of rebuilds closes that:
     * the stamp is a function of the commit, and the commit is a function of
     * the content that holds the stamp.
     *
     * An unsatisfiable gate is worse than no gate, because the first person to
     * meet it baselines it away and the real check goes with it. This one had
     * already gone red on every commit and hidden a live defect: 93f6562 fixed
     * capability retrieval in config/phrases.json and the built index shipped
     * with the old phrase table, because a permanently-red gate tells you
     * nothing when it turns red for a real reason.
     *
     * The stamp stays IN the artifact -- knowing which engine commit an index
     * came from is real provenance. It just stops being part of the question
     * the gate asks, which is whether the index matches the registry and the
     * phrase table. toolCount and withPacks remain compared: those describe the
     * content, not when it was written. */
    const withoutBuildStamp = value => {
      if (typeof value !== 'string') return null;
      let parsed;
      try { parsed = JSON.parse(value); } catch { return null; }
      if (parsed && parsed.engine && typeof parsed.engine === 'object') delete parsed.engine.commit;
      return JSON.stringify(parsed);
    };
    const currentComparable = withoutBuildStamp(current);
    const freshComparable = withoutBuildStamp(text);
    /* A committed artifact that will not parse is STALE, never CURRENT: the
       comparison could not be made, and "could not tell" must not read as
       "matches". */
    if (currentComparable !== null && freshComparable !== null && currentComparable === freshComparable) {
      process.stdout.write(`CURRENT -- ${options.out} matches the ${stats.tools}-tool registry.\n${report}\n`);
      return;
    }
    process.stdout.write(`STALE -- ${options.out} does not match the ${stats.tools}-tool registry. Rebuild.\n${report}\n`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, text);
  fs.writeFileSync(options.spec, specFor(built.artifact, stats, text));
  process.stdout.write(`wrote ${options.out}\nwrote ${options.spec}\n${report}\n`);
}

if (require.main === module) main(process.argv);

module.exports = Object.freeze({
  BUILDER_VERSION,
  DEFAULT_CONSTANTS,
  MINIMUM_PLAUSIBLE_TOOLS,
  SCHEMA_VERSION,
  build,
  buildIndex,
  checkReachability,
  loadVocabulary,
  serialise,
  stableStringify,
  sha256,
});
