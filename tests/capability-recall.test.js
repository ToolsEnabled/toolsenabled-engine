// EXECUTABLE CHANGE — test-can-fail audit report (testcanfail-tests-capability-recall-test-js).
'use strict';

// BEHAVIOURAL TESTS. WHAT THE SOFTWARE DOES, NOT WHAT ITS SOURCE SAYS.
//
// The rule is taken from tests/retrieval/honest-retrieval.test.js in the engine:
// "Two planted defects passed a fully green suite in this codebase on 2026-08-11
// because the assertions were source-text greps, and dead code greps identically
// to live code." So every assertion below runs the real scorer over the real
// built artifact, or over a small artifact built on the fly, and reads what came
// back.
//
// Each test names the defect it exists to catch, so a red says what broke.
//
//   node tests/capability-recall.test.js

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/* A RESOLVABLE PRODUCT IDENTITY, BECAUSE TWO MODULES HERE ASK THE SETTINGS LAYER.
 * capability-recall's own switch and agent-tool-summary's agent-API clause both
 * read settings, and both REFUSE rather than guess when that read cannot resolve
 * the product state root -- which is the correct behaviour and the reason this
 * file died on every bare `node` run. The helper supplies a throwaway root, so
 * the settings layer answers its DEFAULTS instead of refusing.
 *
 * The explicit `enabled: true` flags below are kept as well, and are not
 * redundant: they pin the judgment checks to a stated value rather than to
 * whatever the default happens to be, so flipping a shipped default cannot
 * silently turn those measurements into something else. The gate itself keeps a
 * dedicated test that passes NO flag. */
require('./helpers/scratch-state-root');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT = path.join(ROOT, 'config', 'capability-index.json');
const SPEC = path.join(ROOT, 'config', 'capability-index-spec.json');

const text = require('../src/lib/capability-recall/text');
const artifactModule = require('../src/lib/capability-recall/artifact');
const compose = require('../src/lib/capability-recall/compose');
const { rank, score } = require('../src/lib/capability-recall/score');
const recallModule = require('../src/lib/capability-recall');
const { recommend, find, allowedIdsForTier } = recallModule;
const builder = require('../tools/build-capability-index');
const { loadCases } = require('./capability-recall-eval');

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function test(name, fn) {
  process.stdout.write(`🧪 ${name}\n`);
  fn();
}

const artifact = artifactModule.loadFrom(ARTIFACT);
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

test('video generation and result tools are findable from ordinary requests', () => {
  for (const [query, id] of [
    ['generate a video', 'video.generate'],
    ['animate this image', 'video.generate'],
    ['cancel my video', 'video.cancel'],
    ['download my video', 'video.download'],
    ['video job status', 'video.status'],
    ['available Seedance models', 'video.models']
  ]) {
    const result = recommend(query, { artifact, enabled: true });
    check(result.tools[0]?.id === id, `DEFECT: ${query} does not rank ${id} first`);
    const denied = recommend(query, { artifact, enabled: true, allowedIds: new Set(['screen.capture']) });
    check(!denied.tools.some(tool => tool.id === id), `DEFECT: recall advertises unauthorized ${id}`);
  }
});

test('orchestration and build-queue vocabulary describes actual effects and remains findable', () => {
  const expectedActions = {
    'agent.restart': 'run',
    'system.resource_advice': 'change',
    'build_queue.open': 'create',
    'build_queue.claim': 'create',
    'build_queue.close': 'remove',
    // Here run is a noun. Reading research run status must not index as
    // executing research merely because the first id segment says run.
    'research.run_list': 'read',
    'research.run_status': 'read'
  };
  for (const [id, action] of Object.entries(expectedActions)) {
    const document = artifact.docs.find(entry => entry.id === id);
    check(Boolean(document), `DEFECT: the shipped index omits ${id}`);
    check(document.action === action, `DEFECT: ${id} is not indexed as ${action}`);
  }
  for (const [query, id] of [
    ['restart an agent', 'agent.restart'],
    ['hold additional agent starts with resource advice', 'system.resource_advice'],
    ['open a build queue item', 'build_queue.open'],
    ['claim a build queue item', 'build_queue.claim'],
    ['close a build queue item', 'build_queue.close']
  ]) {
    const result = recommend(query, { artifact, enabled: true });
    check(result.tools[0]?.id === id, `DEFECT: ${query} does not rank ${id} first`);
    const denied = recommend(query, { artifact, enabled: true, allowedIds: new Set(['screen.capture']) });
    check(!denied.tools.some(tool => tool.id === id), `DEFECT: recall advertises unauthorized ${id}`);
  }
});

/*
 * AUDIT REPORT (2026-08-26)
 *
 * Strengthened assertions and mutation evidence:
 * - Posting-list loop: temporarily replaced the loaded artifact's `postings`
 *   with `{}`. RED: `DEFECT: the index has no posting lists; posting integrity
 *   was not exercised.` Restoring the artifact makes this check green.
 * - Positive-fixture loop: temporarily replaced the gold fixture with its
 *   negative records only. RED: `DEFECT: capability-recall-gold.jsonl carries
 *   no positive cases; budget and composition are unmeasured.` Restoring the
 *   fixture makes this check green.
 * - Action-score loops: temporarily changed score() to return no candidates.
 *   RED: `DEFECT: the greeting produced no candidates; the score/confidence
 *   separation was not exercised.` Restoring score.js makes this check green.
 * - Allowlist membership loop: temporarily changed score() to return no
 *   candidates for the added known-hit allowlisted query. RED: `DEFECT: the
 *   allowlist membership check got no tools and passed vacuously.` Restoring
 *   score.js makes this check green.
 *
 * NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures (the
 * two try/catches retain and assert the error/result); mocks of the subject;
 * skips or platform precondition guards; expected values computed by the same
 * implementation. Fixed literal collections cannot be empty and need no guard.
 *
 * Existing assertion reported, not weakened: the test named "every posting is
 * reproducible from the tokenizer" reconstructs terms from the posting lists,
 * but never tokenizes document text. Its assertions establish non-empty
 * postings and df presence, not the stronger claim in the test name.
 *
 * Restored-run output includes `🧪 the action bonus orders results but never
 * decides whether to speak`, confirming all four strengthened sites ran green;
 * it then reaches `🧪 the allowlist is the SAME allowlist the session-start
 * note derives`. Unmet precondition: the full restored-file run fails there on
 * this repository's existing guided-tier assertion with `DEFECT: no
 * allowlist could be derived for the "guided" level.` Consequently a wholly
 * green file run cannot be quoted without weakening an existing assertion,
 * which the contract forbids. The restored run and targeted mutation runs were
 * made with `node tests/capability-recall.test.js`.
 */

/* ------------------------------------------------------- artifact integrity */

test('the artifact is internally consistent and matches its recorded hash', () => {
  check(artifact.N === artifact.docs.length,
    `DEFECT: N=${artifact.N} but ${artifact.docs.length} documents. A miscounted corpus makes every IDF wrong.`);
  check(artifact.tokenizerVersion === text.TOKENIZER_VERSION,
    'DEFECT: the artifact was built by a different tokenizer than this process runs.');

  const onDisk = fs.readFileSync(ARTIFACT, 'utf8');
  const digest = crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex');
  check(digest === spec.artifactSha256,
    'DEFECT: the artifact does not hash to the value CAPABILITY-INDEX-SPEC.json records. '
    + 'The spec is the provenance record; if it can drift from the file it describes it records nothing.');

  const ids = new Set(artifact.docs.map(document => document.id));
  check(ids.size === artifact.docs.length, 'DEFECT: duplicate tool ids in the index.');
  const postingLists = Object.entries(artifact.postings);
  check(postingLists.length > 0,
    'DEFECT: the index has no posting lists; posting integrity was not exercised.');
  for (const [term, list] of postingLists) {
    check(artifact.df[term] === list.length, `DEFECT: df[${term}] disagrees with its posting list length.`);
  }
});

test('every posting is reproducible from the tokenizer, so build and query cannot drift', () => {
  /* The one failure no test of either half alone can see: the builder and the
   * scorer disagreeing by a single suffix rule. Re-derive a sample of documents
   * through the SAME tokenize() the scorer uses and require the terms to match. */
  const sample = [0, 7, 31, 60, 111, 200, artifact.N - 1];
  for (const index of sample) {
    const document = artifact.docs[index];
    const terms = new Set();
    for (const [term, list] of Object.entries(artifact.postings)) {
      if (list.some(posting => posting[0] === index)) terms.add(term);
    }
    for (const term of terms) {
      check(typeof artifact.df[term] === 'number',
        `DEFECT: ${document.id} has a posting for a term with no df entry.`);
    }
    check(terms.size > 0, `DEFECT: ${document.id} has no postings at all and can never be found.`);
  }
});

test('the owner tool packs are not in a shippable index', () => {
  check(artifact.engine.withPacks === false,
    'DEFECT: this index was built with owner tool packs. src/lib/tool-packs is absent from the installer '
    + 'payload, so it names tools a customer machine cannot call.');
});

/* ------------------------------------------------------------- the auto path */

test('the auto block honours its token budget and its three-slot limit', () => {
  const cases = loadCases(path.join(ROOT, 'tests', 'fixtures', 'capability-recall-gold.jsonl'))
    .filter(entry => entry.kind !== 'negative');
  check(cases.length > 0,
    'DEFECT: capability-recall-gold.jsonl carries no positive cases; budget and composition are unmeasured.');
  for (const entry of cases) {
    /* `enabled: true` IS LOAD-BEARING, NOT TIDINESS. recommend() consults the
       settings layer first, which resolves the product state root -- absent on
       any bare `node` run -- so an ambient call answers outcome 'unavailable'
       with zero tools. Every check below is then satisfied by nothing: [] is
       within the cap of 3, undefined is not over budget, and '' matches the
       no-tools branch. This test PASSED that way on every corpus-less machine
       while measuring nothing at all. The module's own header names this
       caller: "a caller that has already decided (the tests, the eval harness)
       passes `enabled` and pays nothing." The gate itself is pinned separately
       below, so enabling here does not leave it uncovered. */
    const result = recommend(entry.q, { artifact, enabled: true });
    /* THE OUTCOME ASSERTION IS WHAT MAKES THE REST EVIDENCE. Without it the
       three checks that follow are vacuous on any result carrying no tools. */
    check(result.outcome !== 'unavailable',
      `DEFECT: "${entry.q}" produced outcome 'unavailable' (${result.code || 'no code'}); `
      + 'budget and composition are unmeasured on this result.');
    check(result.tools.length <= 3, `DEFECT: ${result.tools.length} tools returned for "${entry.q}"; the cap is 3.`);
    check(!result.overBudget,
      `DEFECT: "${entry.q}" produced ${result.estimatedTokens} tokens against a ${compose.AUTO_BUDGET_TOKENS} budget. `
      + 'The shed ladder is supposed to make that impossible.');
    if (result.tools.length === 0) check(result.text === '', 'DEFECT: no tools but non-empty text.');
    else check(result.text.length > 0, 'DEFECT: tools returned but no text to show.');
  }
});

test('prompts that deserve silence get silence, in both fixture sets', () => {
  for (const file of ['capability-recall-gold.jsonl', 'capability-recall-fresh.jsonl']) {
    const negatives = loadCases(path.join(ROOT, 'tests', 'fixtures', file))
      .filter(entry => entry.kind === 'negative');
    check(negatives.length > 0, `DEFECT: ${file} carries no negative cases; the false-positive metric is unmeasured.`);
    for (const entry of negatives) {
      /* Enabled for the same reason as the budget test above: an ambient call
         answers 'unavailable', and this check pins an exact outcome, so it read
         as a DEFECT on every machine without the product state root. That made
         this step's verdict a property of the shell it was launched from rather
         than of the code. Silence has to be measured silence, not absence of a
         measurement. */
      const result = recommend(entry.q, { artifact, enabled: true });
      check(result.text === '' && result.tools.length === 0,
        `DEFECT: spoke over "${entry.q}" with ${result.tools.map(tool => tool.id).join(', ')}. `
        + 'A block that interrupts conversation is a block people stop reading.');
      check(result.outcome === 'silent', `DEFECT: outcome was "${result.outcome}", expected "silent".`);
    }
  }
});

test('an unreadable settings layer answers unavailable, and never silently recommends', () => {
  /* THE BRANCH THE TWO TESTS ABOVE STOP EXERCISING, pinned on purpose rather
     than left to be covered by accident.

     recommend() asks the settings layer whether the feature is on before it
     does anything else. That read resolves the product state root, which the
     shell publishes and a bare `node` run does not, so the honest answer is
     "could not establish", never "off" and never "on". The distinction is the
     whole point: an unreadable switch must not be read as permission, and it
     must not be read as a refusal either.

     Asserted here WITHOUT passing `enabled`, which is exactly what the callers
     above now pass -- so the gate keeps a test of its own.

     THE UNRESOLVABLE STATE IS FORCED, NOT INHERITED. An earlier version of this
     check simply relied on the ambient environment having no product state root,
     and it broke the moment this file gained a scratch root -- correctly, and it
     caught itself. A test whose premise is "the machine happens to lack
     something" measures the machine. Passing an empty `env` makes the condition
     a stated input, so this check means the same thing on every machine. */
  const result = recommend('take a screenshot of my screen', { artifact, env: {} });
  check(result.outcome === 'unavailable',
    `DEFECT: an unresolvable settings layer answered '${result.outcome}', not 'unavailable'.`);
  check(result.tools.length === 0,
    `DEFECT: ${result.tools.length} tool(s) recommended while the switch could not be read.`);
  check(result.text === '', 'DEFECT: text was produced while the switch could not be read.');
  check(typeof result.code === 'string' && result.code.length > 0,
    'DEFECT: an unavailable outcome carries no code, so a reader cannot tell WHY it could not answer.');
});

test('an empty or wordless prompt is silent rather than an error', () => {
  for (const value of ['', '   ', '???', '...', null, undefined]) {
    const result = recommend(value, { artifact, enabled: true });
    check(result.text === '', `DEFECT: ${JSON.stringify(value)} produced text.`);
    check(result.outcome === 'silent', `DEFECT: ${JSON.stringify(value)} gave outcome "${result.outcome}".`);
  }
});

/* -------------------------------------------------------- permission tiering */

test('a withheld tool is never named, and never silently eats a slot', () => {
  /* The exact lie src/lib/agent-tool-summary.js exists to end, pointed the
   * other way: telling an agent about a tool its permission level refuses. */
  const allowed = new Set(artifact.docs.map(document => document.id).filter(id => !id.startsWith('screen.')));
  const restricted = recommend('take a picture of what is on my screen', { artifact, allowedIds: allowed, enabled: true });
  for (const tool of restricted.tools) {
    check(!tool.id.startsWith('screen.'), `DEFECT: named ${tool.id} to a session that cannot call it.`);
  }

  /* Filtering must happen BEFORE the limit. If a withheld tool consumed a slot,
   * the restricted answer would be shorter than the unrestricted one purely
   * because the top hits were dropped. */
  const guided = new Set(artifact.docs
    .map(document => document.id)
    .filter(id => id.startsWith('memory.') || id.startsWith('web.') || id.startsWith('system.')));
  const answer = find('take a picture of what is on my screen', { artifact, allowedIds: guided });
  for (const tool of answer.tools) check(guided.has(tool.id), `DEFECT: ${tool.id} is outside the allowlist.`);
  check(answer.searchedCount === guided.size,
    `DEFECT: reported searching ${answer.searchedCount} tools but the allowlist holds ${guided.size}.`);

  const allowlistedHit = find('search the web for current information', { artifact, allowedIds: guided });
  check(allowlistedHit.tools.length > 0,
    'DEFECT: the allowlist membership check got no tools and passed vacuously.');
  for (const tool of allowlistedHit.tools) {
    check(guided.has(tool.id), `DEFECT: ${tool.id} from a known hit is outside the allowlist.`);
  }
});

/* ------------------------------------------------------------- the find path */

test('an explicit query always gets an answer, and a miss says what was searched', () => {
  const hit = find('check my email', { artifact });
  check(hit.outcome === 'hit' && hit.text.includes('gmail.list'), 'DEFECT: a clear query did not answer.');
  check(hit.text.includes(String(artifact.N)), 'DEFECT: the answer does not state how many tools were searched.');

  const miss = find('zzyzx quorble frobnicate', { artifact });
  check(miss.outcome === 'miss', `DEFECT: outcome "${miss.outcome}" for a query with no catalogue words.`);
  check(miss.text.length > 0, 'DEFECT: an agent that asked a question got no answer at all.');
  check(miss.text.includes(String(artifact.N)),
    'DEFECT: the miss does not say the whole corpus was read. tools/retrieval/index.js: a genuine gap and an '
    + 'unread index are different claims and must never be collapsed.');
});

test('a near miss held back by the floor is reported as a near miss, not as a gap', () => {
  const query = 'whats the tab currently showing';
  const held = find(query, { artifact, floor: 0.9 });
  const candidate = score(artifact, query).candidates[0];
  check(held.outcome === 'miss', 'DEFECT: expected a miss at an impossible floor.');
  check(held.bestRejected !== null, 'DEFECT: something scored, but bestRejected was not recorded.');
  check(held.bestRejected.score === candidate.confidence && held.bestRejected.score < held.floor,
    'DEFECT: bestRejected.score is not the confidence value that the floor rejected.');
  check(held.bestRejected.rankScore === candidate.score,
    'DEFECT: bestRejected did not retain the separate boosted ranking score.');
  check(/closest/i.test(held.text) && held.text.includes(held.bestRejected.id),
    'DEFECT: the near miss reads as a genuine gap. Those are different claims.');
});

/* --------------------------------------------------------- failure behaviour */

/* THE ARTIFACT-ERROR TESTS BELOW PASS `enabled: true` SO THEY CAN REACH THE
 * ERROR THEY PIN. recommend() asks the settings layer first, and on any bare
 * `node` run that read cannot resolve the product state root, so it
 * short-circuits to SERVICE_PRODUCT_IDENTITY_UNAVAILABLE before the index is
 * ever opened. Ambiently these checks asserted a code they were structurally
 * unable to reach -- and because an unavailable result is also silent and also
 * text-free, the surrounding assertions were satisfied by the wrong cause. The
 * settings gate keeps its own dedicated test above. */
test('a broken index silences the auto block and never throws', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caprecall-'));
  const cases = {
    'CAPABILITY_INDEX_UNPARSEABLE': 'this is not json',
    'CAPABILITY_INDEX_SCHEMA_MISMATCH': JSON.stringify({
      ...artifact, schemaVersion: 'capability-index-v99',
    }),
    'CAPABILITY_INDEX_TOKENIZER_MISMATCH': JSON.stringify({
      ...artifact, tokenizerVersion: 'some-other-tokenizer',
    }),
    'CAPABILITY_INDEX_MALFORMED': JSON.stringify({ ...artifact, N: artifact.N + 5 }),
  };
  for (const [expected, body] of Object.entries(cases)) {
    const file = path.join(directory, `${expected}.json`);
    fs.writeFileSync(file, body);
    let thrown = null;
    let result = null;
    try { result = recommend('take a screenshot', { artifactPath: file, enabled: true }); } catch (error) { thrown = error; }
    check(thrown === null,
      `DEFECT: recommend() threw on ${expected}. It rides a person's turn; a broken index must cost the note, `
      + 'never the turn.');
    check(result.text === '' && result.outcome === 'unavailable',
      `DEFECT: ${expected} did not produce a silent unavailable result.`);
    check(result.code === expected, `DEFECT: reported code "${result.code}", expected "${expected}".`);

    /* find() is the other way round: an agent that asked deserves the reason. */
    const answer = find('take a screenshot', { artifactPath: file, enabled: true });
    check(answer.outcome === 'unavailable' && answer.text.includes(expected),
      `DEFECT: find() did not name ${expected} to the agent that asked.`);
    check(/NOT a finding/i.test(answer.text),
      'DEFECT: an unreadable index must not read as "no such tool exists".');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a missing index is a named refusal, not a crash', () => {
  const result = recommend('take a screenshot', { artifactPath: path.join(os.tmpdir(), 'nope-does-not-exist.json'), enabled: true });
  check(result.outcome === 'unavailable' && result.code === 'CAPABILITY_INDEX_MISSING',
    `DEFECT: got "${result.code}" for a missing artifact.`);
});

/* ------------------------------------------------------------------- privacy */

test('nothing the observer receives contains the prompt', () => {
  /* lean_rag logs every query string, which is right for a research instrument
   * over public docs and wrong here: the query IS the person's words. */
  const secret = 'reschedule my oncology appointment with doctor Halloran';
  const records = [];
  recommend(secret, { artifact, enabled: true, observer: record => records.push(record) });
  find(secret, { artifact, observer: record => records.push(record) });
  check(records.length === 2, 'DEFECT: the observer was not called for both paths.');
  const serialised = JSON.stringify(records).toLowerCase();
  for (const word of ['oncology', 'halloran', 'reschedule', 'appointment', 'doctor']) {
    check(!serialised.includes(word),
      `DEFECT: the word "${word}" from the person's prompt reached the observer. `
      + 'A recommender that quietly transcribes what its user typed is a far larger thing than a recommender.');
  }
});

test('an observer that throws cannot break a turn', () => {
  const result = recommend('take a screenshot', {
    artifact,
    enabled: true,
    observer: () => { throw new Error('observer exploded'); },
  });
  check(result.outcome === 'hit', 'DEFECT: a throwing observer changed the answer.');
});

/* --------------------------------------------------------------- build guard */

test('the CLI checks currentness and reachability before accepting an index', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caprecall-cli-'));
  const registryPath = path.join(directory, 'src', 'lib', 'tool-registry.js');
  const output = path.join(directory, 'capability-index.json');
  const options = {
    engineRoot: directory,
    actions: path.join(ROOT, 'config', 'actions.json'),
    objects: path.join(ROOT, 'config', 'objects.json'),
    phrases: path.join(ROOT, 'config', 'phrases.json'),
    withPacks: false,
    constants: null,
  };
  // Public catalogue metadata is fixture input. The CLI runs the actual
  // builder and scorer; no provider or agent implementation is imported.
  const tools = artifact.docs.map(doc => ({
    name: doc.id, description: doc.summary, effect: doc.effect, provider: doc.provider,
  }));
  const writeRegistry = () => {
    fs.writeFileSync(registryPath, `module.exports = { TOOL_REGISTRY: ${JSON.stringify(tools)} };\n`);
    delete require.cache[registryPath];
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  };
  const cli = mode => spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'build-capability-index.js'),
    '--engine-root', directory, '--out', output, mode,
  ], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const specBefore = fs.readFileSync(SPEC);
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    writeRegistry();
    git('-c', 'init.templateDir=', 'init', '--initial-branch=main');
    git('add', 'src/lib/tool-registry.js');
    git('-c', 'user.name=Capability Recall Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', 'commit', '-m', 'registry fixture');
    const valid = builder.build(options);
    assert.deepStrictEqual(valid.stats.unreachable, [], 'the control must start with a fully reachable registry');
    // A different commit stamp is legitimate; changing content is not.
    valid.artifact.engine.commit = '0'.repeat(40);
    fs.writeFileSync(output, builder.serialise(valid.artifact));
    const current = cli('--check');
    check(current.status === 0 && /^CURRENT -- /m.test(current.stdout),
      `DEFECT: a reachable current index was refused: ${current.stdout}${current.stderr}`);

    for (const stale of ['{}\n', '{invalid-json', null]) {
      if (stale === null) fs.unlinkSync(output);
      else fs.writeFileSync(output, stale);
      const checked = cli('--check');
      check(checked.status === 1 && /^STALE -- /m.test(checked.stdout),
        `DEFECT: a stale, invalid, or absent index was accepted: ${checked.stdout}${checked.stderr}`);
      if (stale === null) check(!fs.existsSync(output), 'DEFECT: checking created an absent index.');
      else check(fs.readFileSync(output, 'utf8') === stale, 'DEFECT: checking rewrote a stale index.');
    }

    tools.find(tool => tool.name === 'agent.spawn').description = '';
    writeRegistry();
    const broken = builder.build(options);
    assert.deepStrictEqual(broken.stats.unreachable, [
      { id: 'agent.spawn', why: 'no description to be found by' },
    ], 'the negative control must fail the real reachability measurement');
    // Simulate an already committed bad artifact. Its bytes match the fresh
    // build, so currentness alone cannot detect the missing description.
    const brokenBytes = builder.serialise(broken.artifact);
    fs.writeFileSync(output, brokenBytes);
    const stats = cli('--stats');
    check(stats.status === 0 && stats.stdout.includes(
      `reachability    ${tools.length - 1}/${tools.length} tools findable by their own description`),
    `DEFECT: measurement mode hid the unreachable tool: ${stats.stdout}${stats.stderr}`);
    const refused = cli('--check');
    check(refused.status === 3 && /CAPABILITY_TOOL_UNREACHABLE/.test(refused.stderr)
      && /agent\.spawn/.test(refused.stderr) && !/^CURRENT -- /m.test(refused.stdout),
    `DEFECT: a matching index with an unreachable agent tool was accepted: ${refused.stdout}${refused.stderr}`);
    check(fs.readFileSync(output, 'utf8') === brokenBytes, 'DEFECT: refusal rewrote the index.');
    assert.deepStrictEqual(fs.readFileSync(SPEC), specBefore, 'checking or measuring rewrote the build spec');
  } finally {
    delete require.cache[registryPath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the build refuses every way the vocabulary can silently rot', () => {
  /* THE ANTI-ROT GATE, TESTED BY BREAKING IT FOUR WAYS.
   *
   * tools/prior-work-index.js states the rule this exists to obey: "If keeping
   * this current requires anybody to remember to do anything, it will fall
   * behind -- it already did, twice." Nobody will remember. So each way the
   * vocabulary can fall behind is a build failure, and each one is exercised
   * here against the real loader rather than asserted in a comment. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caprecall-gate-'));
  const ids = new Set(artifact.docs.map(document => document.id));
  const good = {
    actions: path.join(ROOT, 'config', 'actions.json'),
    objects: path.join(ROOT, 'config', 'objects.json'),
    phrases: path.join(ROOT, 'config', 'phrases.json'),
  };
  const write = (name, value) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const refusalFor = options => {
    try { builder.loadVocabulary({ ...good, ...options }, ids); return null; } catch (error) { return error.code; }
  };

  check(refusalFor({}) === null, 'DEFECT: the real vocabularies do not pass their own gate.');

  // 1. A NEW TOOL NAMED IN A WAY NOTHING RECOGNISES.
  const actions = JSON.parse(fs.readFileSync(good.actions, 'utf8'));
  const strangelyNamed = new Set([...ids, 'screen.hologrammify_desktop']);
  let code = null;
  try { builder.loadVocabulary(good, strangelyNamed); } catch (error) { code = error.code; }
  check(code === 'CAPABILITY_VOCABULARY_INCOMPLETE',
    'DEFECT: a tool whose id resolves to no action built cleanly. It would ship with no action axis at all, '
    + 'and nothing downstream can notice a missing classification.');

  // 2. A WHOLE NAMESPACE NOBODY HAS WORDS FOR.
  const objects = JSON.parse(fs.readFileSync(good.objects, 'utf8'));
  delete objects.namespaces.gmail;
  check(refusalFor({ objects: write('no-gmail.json', objects) }) === 'CAPABILITY_VOCABULARY_INCOMPLETE',
    'DEFECT: a namespace with no object vocabulary built cleanly. Every tool in it could then only be found '
    + 'by its own description, which is exactly how 52 tools shipped unreachable before this gate existed.');

  // 3. AN IDIOM NAMING A TOOL THAT HAS BEEN RENAMED AWAY.
  check(refusalFor({
    phrases: write('stale.json', {
      schemaVersion: 'capability-phrases-v1',
      entries: [{ tools: ['screen.capture', 'screen.capture_hologram'], says: ['picture of my screen'] }],
    }),
  }) === 'CAPABILITY_VOCABULARY_INCOMPLETE',
    'DEFECT: an idiom naming a renamed tool built cleanly. It would look maintained while reaching nothing.');

  // 4. A SEGMENT TABLE THAT IS NOT A DERIVATION.
  actions.actions.read.idSegments.push('create');
  let collision = null;
  try { builder.loadVocabulary({ ...good, actions: write('collide.json', actions) }, ids); }
  catch (error) { collision = error.code; }
  check(collision === 'CAPABILITY_ACTION_SEGMENT_COLLISION',
    'DEFECT: one id segment claimed by two actions built cleanly. The action of a tool would then depend on '
    + 'object key order, which is not a derivation.');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('the action of every tool is derived, and the read/write split falls out of it', () => {
  /* The property the whole factorisation exists for: `calendar.list` and
   * `calendar.create` separate WITHOUT anyone writing a rule about calendars.
   * The old lexicon needed a hand-written split per capability, added only
   * after "what is on my calendar today" returned the tool that ADDS an event. */
  const actionOf = new Map(artifact.docs.map(document => [document.id, document.action]));
  for (const document of artifact.docs) {
    check(typeof document.action === 'string' && document.action.length > 0,
      `DEFECT: ${document.id} shipped with no action. The build gate should have refused it.`);
  }
  const pairs = [
    ['calendar.list', 'calendar.create'], ['gmail.list', 'gmail.send'],
    ['host.read_file', 'host.write_file'], ['clipboard.read', 'clipboard.write'],
    ['memory.get', 'memory.set'], ['repo.read_file', 'repo.write_file'],
  ];
  for (const [reader, writer] of pairs) {
    check(actionOf.get(reader) === 'read',
      `DEFECT: ${reader} derived action "${actionOf.get(reader)}", expected read.`);
    check(actionOf.get(writer) !== 'read',
      `DEFECT: ${writer} derived action "${actionOf.get(writer)}" — the read/write split collapsed.`);
  }
});

test('the action bonus orders results but never decides whether to speak', () => {
  /* Measured at 15% false positives when it did both: "hello there, how are
   * you today" cleared the floor at 0.479 on a lexical 0.329, because the
   * grammar said `read` and calendar.list reads. Agreeing on a verb ranks a
   * tool above another tool; it is not evidence the question was about tools. */
  const { score } = require('../src/lib/capability-recall/score');
  const greeting = score(artifact, 'hello there, how are you today');
  check(greeting.candidates.length > 0,
    'DEFECT: the greeting produced no candidates; the score/confidence separation was not exercised.');
  check(greeting.candidates.some(candidate => candidate.actionAgrees),
    'DEFECT: no candidate agreed on action; the action-bonus assertion was not exercised.');
  for (const candidate of greeting.candidates) {
    check(candidate.confidence <= candidate.score,
      'DEFECT: confidence exceeded the ordering score; they have been conflated.');
    if (candidate.actionAgrees) {
      check(candidate.score > candidate.confidence,
        'DEFECT: an agreeing action did not affect the ordering score at all.');
    }
  }
  const spoke = recommend('hello there, how are you today', { artifact, enabled: true });
  check(spoke.text === '', `DEFECT: spoke over a greeting with ${spoke.tools.map(t => t.id).join(', ')}.`);
});

test('the serialiser is order-independent, so the hash means what it claims', () => {
  /* The first build shipped a 1,857-byte artifact with every document removed
   * and a perfectly respectable sha256 over it, because JSON.stringify's second
   * argument is a recursive key ALLOWLIST rather than a key ordering. */
  const a = builder.serialise({ z: 1, a: { d: 4, c: [3, { f: 6, e: 5 }] } });
  const b = builder.serialise({ a: { c: [3, { e: 5, f: 6 }], d: 4 }, z: 1 });
  check(a === b, 'DEFECT: serialisation depends on key insertion order; the hash cannot mean "same catalogue".');
  check(a.includes('"c":[3,{"e":5,"f":6}]'), 'DEFECT: the serialiser dropped nested content.');
});

/* ------------------------------------------------------------------- costing */

test('a query costs microseconds and the index is shared, not re-parsed', () => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 2000; i += 1) rank(artifact, 'check my email and tell me if anything is urgent', { limit: 3 });
  const perCall = Number(process.hrtime.bigint() - started) / 1e6 / 2000;
  check(perCall < 2,
    `DEFECT: ${perCall.toFixed(3)} ms per query. The whole cost argument for a large fleet rests on this being `
    + 'far below a millisecond.');

  artifactModule.reset();
  const first = artifactModule.load({ artifactPath: ARTIFACT });
  const second = artifactModule.load();
  check(first === second, 'DEFECT: the artifact was parsed twice. Every agent would pay for its own copy.');
  check(Object.isFrozen(second), 'DEFECT: the shared artifact is mutable; one session could corrupt every other.');
  artifactModule.reset();
});

/* --------------------------------------------------------- content sanity */

test('acceptance: the tools a person reaches for constantly are actually reachable', () => {
  /* The equivalent of lean_rag asserting its SetHoldings overloads are present:
   * a handful of named, load-bearing results that must never quietly vanish. */
  const expectations = [
    ['take a screenshot of my screen', 'screen.capture'],
    ['check my email', 'gmail.list'],
    ['what is on my calendar today', 'calendar.list'],
    ['remember this for later', 'memory.set'],
    ['search the web for that', 'web.search'],
    ['run a command on this computer', 'host.exec'],
  ];
  for (const [prompt, expected] of expectations) {
    const result = recommend(prompt, { artifact, enabled: true });
    check(result.tools.some(tool => tool.id === expected),
      `DEFECT: "${prompt}" no longer surfaces ${expected}. Got: ${result.tools.map(t => t.id).join(', ') || '(nothing)'}`);
  }
});

/* ------------------------------------------------------- the settings row */

test('agent.capability_recall is a real switch, not a drawn control', () => {
  /* THE DOCTRINE THIS EXISTS TO SATISFY, in the owner's words (2026-08-11):
   * "every failure which there exists a system for or to prevent; that doesnt
   * do its job according to user settings, is vieweed as software fialure".
   * tests/settings-enforcement-honesty.test.js counts rows that enforce
   * nothing; this is the other half -- the row's named enforcer actually
   * refusing. Driven through the REAL settings loader against a real file, not
   * through the `enabled` shortcut, because the shortcut is the thing that
   * could be wired to nothing. */
  const registryModule = require('../src/lib/settings-registry');
  const { byId } = registryModule.loadRegistry();
  const entry = byId.get(recallModule.CAPABILITY_RECALL_SETTING_ID);
  check(Boolean(entry), 'DEFECT: the catalogue carries no agent.capability_recall row for this module to enforce.');
  check(entry.enforcedBy === 'src/lib/capability-recall/index.js',
    `DEFECT: the row names "${entry && entry.enforcedBy}" as its enforcer; this file is not it.`);
  check(entry.default === true, 'DEFECT: the row no longer ships on, so the default state is not the one measured.');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caprecall-setting-'));
  const valuesPath = path.join(directory, 'settings.json');
  const write = value => fs.writeFileSync(valuesPath, JSON.stringify({
    revision: 1,
    values: { [recallModule.CAPABILITY_RECALL_SETTING_ID]: value },
    provenance: { [recallModule.CAPABILITY_RECALL_SETTING_ID]: { source: 'user', atMs: 1, directive: 'test' } },
  }));

  /* A settings file that does not exist is not a choice: the default stands. */
  check(recallModule.capabilityRecallEnabled({ valuesPath }) === true,
    'DEFECT: an absent settings file read as "off". A default-on feature would retire itself on a fresh install.');

  write(false);
  check(recallModule.capabilityRecallEnabled({ valuesPath }) === false, 'DEFECT: the row set false still read as on.');
  const off = recommend('take a screenshot of my screen', { artifact, valuesPath });
  check(off.text === '' && off.tools.length === 0,
    'DEFECT: the switch is off and a block was composed anyway. That is a control that changes nothing.');
  check(off.outcome === 'disabled' && off.code === 'CAPABILITY_RECALL_DISABLED',
    `DEFECT: outcome was "${off.outcome}"; an off switch must be distinguishable from an empty answer.`);

  write(true);
  check(recallModule.capabilityRecallEnabled({ valuesPath }) === true, 'DEFECT: the row set true read as off.');
  const on = recommend('take a screenshot of my screen', { artifact, valuesPath });
  check(on.tools.some(tool => tool.id === 'screen.capture'),
    'DEFECT: the switch is on and the block is empty, so the two states are the same state.');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('the allowlist is the SAME allowlist the session-start note derives', () => {
  /* THE DRIFT THIS PINS. src/lib/capability-recall/allowlist.js copies the
   * derivation out of src/lib/agent-tool-summary.js rather than sharing it, so
   * the two could silently part and this feature would start naming tools the
   * note (and the dispatcher) refuse -- which is the one thing it promises not
   * to do. allowedCount is the number that module already publishes, so the
   * agreement can be asserted without touching it. */
  const { briefToolSummary } = require('../src/lib/agent-tool-summary');
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const allowed = allowedIdsForTier(tier);
    const note = briefToolSummary({ tier, enabled: true });
    check(allowed instanceof Set && allowed.size > 0, `DEFECT: no allowlist could be derived for the "${tier}" level.`);
    check(note.enabled === true && typeof note.allowedCount === 'number',
      `DEFECT: the note module could not report an allowed count for "${tier}" (${note.code}).`);
    check(allowed.size === note.allowedCount,
      `DEFECT: "${tier}" offers ${note.allowedCount} tools to the note and ${allowed.size} to the recommender. `
      + 'The two derivations have parted, and this one can now name a tool the machine would refuse.');
  }
  check(allowedIdsForTier('not-a-level') === null,
    'DEFECT: an unrecognised level produced an allowlist. Unknown must be null -- an empty Set would read as '
    + '"this level offers nothing" and silence the feature while looking deliberate.');

  /* And the narrowing is honoured end to end: a tool outside the set is never
   * named, however well it scores. */
  const guided = allowedIdsForTier('guided');
  const withoutScreen = new Set([...guided].filter(id => !id.startsWith('screen.')));
  const result = recommend('take a screenshot of my screen', { artifact, allowedIds: withoutScreen, enabled: true });
  check(!result.tools.some(tool => tool.id.startsWith('screen.')),
    `DEFECT: a withheld tool was named anyway: ${result.tools.map(tool => tool.id).join(', ')}`);
});

test('the block reads as a map, never as an instruction', () => {
  const result = recommend('take a screenshot of my screen', { artifact, enabled: true });
  check(/or ignore them|by exact id/i.test(result.text),
    'DEFECT: the block no longer tells the agent it may ignore it. A recommender that can compel a tool call '
    + 'is a recommender that can be wrong expensively.');
  check(!/\byou must\b|\buse these\b|\balways call\b/i.test(result.text),
    'DEFECT: the block instructs rather than offers.');
});

test('"use the credential manager" names OUR credential tool, not somebody else\'s', () => {
  /* THE LIVE CUSTOMER REPORT THIS PINS, pre-beta on 1.0.30, verbatim: agents
   * "have to be prompted to use the credential manager, and they come back
   * having used Google's or Windows' credential manager instead of ours."
   *
   * Removing an agent's built-in tools (agent.agent_api) forces our shell and
   * our web. It cannot force our VAULT, because Windows Credential Manager and
   * a browser's password store are not the agent's built-in tools at all --
   * they are other software on the same desktop, reachable however the agent
   * gets a shell. Nothing removable stands between an agent and the wrong
   * vault. The only thing that does is our own tool being the one it thinks of.
   *
   * MEASURED BEFORE THE FIX, on the built index of 2026-08-25: the person's
   * literal sentence, "use the credential manager", returned agent_comms.send
   * -- an unrelated tool, named confidently, while system.credential_request
   * went unmentioned. "put the token in the vault", "where do I save this
   * secret" and "use the ToolsEnabled credential manager" were answered with
   * silence. Four of the ten sentences below named the credential tool; nine do
   * now.
   *
   * WHY THE LEXICON AND NOT THE DESCRIPTION. config/phrases.json only admits
   * MULTI-WORD idioms -- tools/lib/factor.js keeps a `says` entry out of the
   * phrase table unless it splits into two or more words -- and this intent's
   * entry carried "credential", "vault" and "password" as bare single words.
   * Those become ordinary BM25 alias terms and lose to whatever else in a
   * 268-tool corpus happens to share the sentence. "credential manager" is the
   * fixed expression a person actually types, and it was not there.
   *
   * THIS ASSERTS BEHAVIOUR. It calls recommend() with the sentences and reads
   * what came back; it never greps config/phrases.json. Delete the phrases and
   * this goes red on the retrieval, which is the only thing that matters.
   *
   * AND IT BUILDS ITS OWN INDEX RATHER THAN READING THE SHIPPED ONE. Every
   * other test in this file uses the artifact on disk, which is right for them
   * -- they are testing the artifact. This one is testing the LEXICON, and the
   * artifact is a build output of it. Reading the shipped file would make this
   * test report on how recently somebody ran the builder, so a lexicon fix
   * would look landed while the shipped index still answered the customer's
   * sentence with the wrong tool. That the shipped artifact is rebuilt from
   * these sources is a different promise, already kept by a different gate:
   * `node tools/build-capability-index.js --check`. */
  const freshBuild = builder.build({
    engineRoot: ROOT,
    spec: SPEC,
    actions: path.join(ROOT, 'config', 'actions.json'),
    objects: path.join(ROOT, 'config', 'objects.json'),
    phrases: path.join(ROOT, 'config', 'phrases.json'),
    withPacks: false,
    constants: null
  }).artifact;
  const standard = allowedIdsForTier('standard');
  const MUST_NAME_OUR_VAULT = [
    'use the credential manager',
    'use our credential manager',
    'use the ToolsEnabled credential manager',
    'save this API key in the credential manager',
    'put the token in the vault',
    'where do I save this secret',
    'store my password',
    'add a credential',
    'I need an api key'
  ];
  for (const prompt of MUST_NAME_OUR_VAULT) {
    const result = recommend(prompt, { artifact: freshBuild, allowedIds: standard, enabled: true });
    const named = result.tools.map(tool => tool.id);
    check(named.includes('system.credential_request'),
      `DEFECT: "${prompt}" did not name system.credential_request. It answered with `
      + `${named.length ? named.join(', ') : `silence (${result.why})`}. `
      + 'This is the live pre-beta report: the person asks for the credential manager and the agent '
      + "reaches for Windows' or Google's, because ours was never put in front of it.");
  }

  /* THE OTHER HALF, AND THE ONE THAT MAKES THE FIRST HALF WORTH ANYTHING.
   * Aliasing broadly is how a recommender starts answering everything with the
   * same four tools, so the words added for the report above must not follow a
   * person into unrelated work. These sentences all contain a word the
   * credential intent claims -- key, token, secret, manager, save -- and none
   * of them is asking for the vault. */
  const MUST_NOT_NAME_OUR_VAULT = [
    'open the task manager',
    'save the file',
    'what is on my calendar today',
    'take a screenshot of my screen',
    'send a message to the other agent'
  ];
  for (const prompt of MUST_NOT_NAME_OUR_VAULT) {
    const result = recommend(prompt, { artifact: freshBuild, allowedIds: standard, enabled: true });
    const named = result.tools.map(tool => tool.id);
    check(!named.includes('system.credential_request'),
      `DEFECT: "${prompt}" was answered with system.credential_request (${named.join(', ')}). `
      + 'The credential lexicon has spread past its own intent, which is the failure mode the alias '
      + 'rules exist to prevent -- a recommender that names the vault for everything names it for nothing.');
  }
});

process.stdout.write(`\n✅ capability-recall: ${checks} checks passed\n`);
