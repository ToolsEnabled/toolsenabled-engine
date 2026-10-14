// EXECUTABLE CHANGE — testcanfail-tests-capability-recall-demo-js
//
// Strengthened assertion: section 5 used to iterate freshMetrics.misses without
// first proving that the collection contained anything. An empty miss census
// therefore printed the heading, executed no checks, and left this executable
// green. The demo now pins the independently authored fresh-set misses and
// their wanted tools. Mutation: in a scratch copy, changed loadFresh() to return
// an empty case list. RED output:
//   AssertionError [ERR_ASSERTION]: fresh-set miss census changed; section 5 would be incomplete
//   + actual - expected
//   + []
//   - [
//   -   {
//   -     q: 'whats the tab currently showing',
//   -     want: [ 'browser.playwright_call' ]
//   -   },
//   -   {
//   -     q: 'what have the agents been up to on here',
//   -     want: [ 'audit.tail' ]
//   -   }
//   - ]
// Restored-source green run: capability-recall-demo: assertions passed
// NOT-FOUND (1), after the fix: remaining loops use non-empty array literals or
// iterate result tools only to render optional explanatory detail.
// NOT-FOUND (2): no exit-status or truthy-return assertion exists; the optional
// comparison process's own JSON is rendered rather than asserted.
// NOT-FOUND (3): no assertion is inside the JSON-rendering try/catch; parse
// failure is deliberately displayed as "no JSON packet", not swallowed evidence.
// NOT-FOUND (4): no mocks are used.
// NOT-FOUND (5): no platform skip disables the core demo or its assertions.
// Unmet precondition: without --engine-root (or TOOLSENABLED_ENGINE_ROOT), the
// optional shipped-orient comparison is not run; changing that process's spawn
// or resolution is outside this task's fence.
// NOT-FOUND (6): expected queries/tool ids are independent literals, not values
// computed by evaluate(), loadFresh(), score(), or recommend().

'use strict';

// WHAT THE PERSON TYPES, AND WHAT THE AGENT WOULD SEE. VERBATIM.
//
//   node tests/capability-recall-demo.js [--engine-root <path>]
//
// Owner requirement, 2026-08-22: "once you get it working show me examples of
// what the input prompt and what the agents see are. make sure to test and
// optimize your system first."
//
// So this runs AFTER the eval, prints the eval's headline numbers at the top so
// what follows is dated and measured rather than chosen, and then shows three
// blocks per example: the exact prompt, the exact text that would be appended
// to that turn, and why it was chosen.
//
// THE EXAMPLE SET IS CHOSEN TO BE HONEST, NOT FLATTERING. It includes prompts
// that must produce nothing, a prompt whose best answer the permission level
// withholds, and the two cases from the fresh set that this build still gets
// wrong. Leaving those out would make this a brochure.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT = path.join(ROOT, 'config', 'capability-index.json');
const SPEC = path.join(ROOT, 'config', 'capability-index-spec.json');

const { loadFrom } = require('../src/lib/capability-recall/artifact');
const { recommend, find } = require('../src/lib/capability-recall');
const { score } = require('../src/lib/capability-recall/score');
const { evaluate, loadGold, loadFresh } = require('./capability-recall-eval');

const artifact = loadFrom(ARTIFACT);
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const RULE = '='.repeat(100);
const THIN = '-'.repeat(100);

function engineRootFromArgs(argv) {
  const index = argv.indexOf('--engine-root');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return process.env.TOOLSENABLED_ENGINE_ROOT || null;
}

function indent(text, prefix = '    ') {
  return String(text).split('\n').map(line => `${prefix}${line}`).join('\n');
}

/** The evidence behind a result, in words rather than numbers alone. */
function why(prompt, result) {
  const scored = score(artifact, prompt);
  const lines = [];
  for (const tool of result.tools) {
    const candidate = scored.candidates.find(entry => entry.id === tool.id);
    if (!candidate) continue;
    const parts = [`score ${candidate.score.toFixed(3)}`];
    if (candidate.phrase) parts.push(`matched the curated intent "${candidate.phrase}"`);
    const words = candidate.matchedWords.filter(Boolean);
    if (words.length) parts.push(`words: ${words.slice(0, 6).join(', ')}`);
    if (candidate.strongWords && candidate.strongWords.length) {
      parts.push(`decisive: ${candidate.strongWords.join(', ')}`);
    }
    lines.push(`${tool.id} — ${parts.join(' · ')}`);
  }
  return lines;
}

function showAuto(title, prompt, options = {}) {
  const result = recommend(prompt, { artifact, ...options });
  console.log(THIN);
  console.log(title);
  console.log('');
  console.log('  THE PERSON TYPES');
  console.log(indent(JSON.stringify(prompt)));
  console.log('');
  console.log('  WHAT IS APPENDED TO THAT TURN');
  if (result.text) {
    console.log(indent(result.text));
    console.log('');
    console.log(`    [${result.estimatedTokens} tokens of a ${120} budget, detail level ${result.detailLevel}]`);
  } else {
    console.log('    (nothing — the block is not added at all, and the turn goes to the agent unchanged)');
    console.log(`    reason: ${result.why}`);
  }
  const reasons = why(prompt, result);
  if (reasons.length) {
    console.log('');
    console.log('  WHY');
    for (const line of reasons) console.log(indent(line));
  }
  console.log('');
  return result;
}

function showQuery(prompt, options = {}) {
  const result = find(prompt, { artifact, ...options });
  console.log(THIN);
  console.log('AN AGENT ASKS THE INDEX DIRECTLY (the invited path, a bigger budget)');
  console.log('');
  console.log('  THE AGENT CALLS');
  console.log(indent(`capability.find(${JSON.stringify(prompt)})`));
  console.log('');
  console.log('  WHAT COMES BACK');
  console.log(indent(result.text));
  console.log('');
  console.log(`    [${result.estimatedTokens} tokens of a 500 budget · outcome ${result.outcome}]`);
  console.log('');
  return result;
}

function main(argv) {
  const goldMetrics = evaluate(artifact, artifact.constants, loadGold());
  const freshMetrics = evaluate(artifact, artifact.constants, loadFresh());
  assert.deepStrictEqual(
    freshMetrics.misses.map(({ q, want }) => ({ q, want })),
    [
      { q: "inspect this project's deployment setup", want: ['deployment.detect'] },
      { q: 'whats the tab currently showing', want: ['browser.playwright_call'] },
      { q: 'what have the agents been up to on here', want: ['audit.tail'] },
    ],
    'fresh-set miss census changed; section 5 would be incomplete'
  );

  console.log(RULE);
  console.log('CAPABILITY RECALL — WHAT THE AGENT ACTUALLY SEES');
  console.log(RULE);
  console.log(`index      ${artifact.N} tools · ${Object.keys(artifact.df).length} terms · `
    + `${fs.statSync(ARTIFACT).size} bytes · engine ${String(spec.engineCommit).slice(0, 8)}`);
  console.log(`gold set   recall@3 ${(goldMetrics.recall3 * 100).toFixed(1)}%  `
    + `false-positive ${(goldMetrics.falsePositive * 100).toFixed(1)}%   `
    + '(105 cases — this set SHAPED the lexicon, so read it as saturated, not as a result)');
  console.log(`fresh set  recall@3 ${(freshMetrics.recall3 * 100).toFixed(1)}%  `
    + `false-positive ${(freshMetrics.falsePositive * 100).toFixed(1)}%   `
    + '(38 cases written afterwards and never used to tune anything — THIS is the honest number)');
  console.log('');

  console.log(RULE);
  console.log('1. THE ORDINARY CASE — the wording does not resemble the tool description at all');
  console.log(RULE);
  showAuto('An alias is the only reason this works. No word of the prompt appears in screen.capture\'s description.',
    'take a picture of what is on my screen');
  showAuto('The read/write split is DERIVED: calendar.list is action:read and calendar.create is action:create '
    + 'because their ids say so. Nobody wrote a rule about calendars.',
    'what is on my calendar today');
  showAuto('Colloquial, and in the fresh set — nothing here was used to tune anything.',
    'which processes are hogging the machine');

  console.log(RULE);
  console.log('2. SILENCE — the answer most prompts deserve');
  console.log(RULE);
  for (const prompt of ['hi', 'that looks good to me', 'stop', 'leave it for now']) {
    showAuto('A conversational turn. The block is not added, so the agent sees exactly what the person wrote.', prompt);
  }

  console.log(RULE);
  console.log('3. A TOOL THIS PERMISSION LEVEL WITHHOLDS');
  console.log(RULE);
  const guided = new Set(artifact.docs.map(document => document.id).filter(id => !id.startsWith('screen.')));
  console.log('An installation whose permission level does not offer the screen family.');
  console.log('');
  showAuto('Unrestricted: the screen tools are offered.', 'screenshot the window and email it to me');
  showAuto('Same prompt, screen.* withheld. The withheld tool is not named -- and nothing is substituted for '
    + 'it either. Filtering happens before the floor, so what is left simply does not clear the bar, and the '
    + 'block says nothing rather than offering the nearest thing that survived the allowlist.',
    'screenshot the window and email it to me', { allowedIds: guided });

  console.log(RULE);
  console.log('4. THE INVITED PATH — an agent asking for help mid-work');
  console.log(RULE);
  showQuery('I need to get a file from the other computer');
  showQuery('zzyzx quorble frobnicate');

  console.log(RULE);
  console.log('5. WHAT THIS BUILD STILL GETS WRONG');
  console.log(RULE);
  console.log('Every fresh-set miss, with where the wanted tool actually landed. That is the designed failure:');
  console.log('a lexicon-only recommender cannot reach wording nobody anticipated, and when it cannot, the');
  console.log('honest response is to say nothing rather than to guess.');
  console.log('');
  for (const miss of freshMetrics.misses) {
    const result = showAuto(`Wanted: ${miss.want.join(' | ')}`, miss.q);
    const scored = score(artifact, miss.q);
    /* Report where the WANTED tool actually landed, not where the top candidate
     * landed. Those are the same thing only sometimes, and writing "the right
     * answer was ranked #1" when it was ranked third would be the demo telling
     * a more flattering story than the run. */
    const position = scored.candidates.findIndex(candidate => miss.want.includes(candidate.id));
    if (position >= 0) {
      const found = scored.candidates[position];
      const margin = found.confidence - result.floor;
      if (margin >= 0) {
        console.log(`    ${found.id} ranked #${position + 1} at ${found.score.toFixed(3)}; `
          + `confidence ${found.confidence.toFixed(3)} cleared the ${result.floor} floor by ${margin.toFixed(3)}, `
          + `but it was still withheld: ${result.why}`);
      } else {
        console.log(`    ${found.id} ranked #${position + 1} at ${found.score.toFixed(3)}; `
          + `confidence ${found.confidence.toFixed(3)} was short of the ${result.floor} floor by ${(-margin).toFixed(3)}`);
      }
    } else {
      console.log(`    none of ${miss.want.join(' | ')} scored at all; `
        + `the closest thing the index found was ${scored.candidates.length ? scored.candidates[0].id : '(nothing)'}`);
    }
    console.log('');
  }

  console.log(RULE);
  console.log('6. THE SAME PROMPTS THROUGH WHAT SHIPS TODAY');
  console.log(RULE);
  const engineRoot = engineRootFromArgs(argv);
  if (!engineRoot) {
    console.log('(pass --engine-root <path> to run tools/grepsaver-orient.js beside this for comparison)');
    return;
  }
  const orient = path.join(engineRoot, 'tools', 'grepsaver-orient.js');
  if (!fs.existsSync(orient)) {
    console.log(`(no tools/grepsaver-orient.js under ${engineRoot})`);
    return;
  }
  console.log('tools/grepsaver-orient.js is the only query-aware path in the product today. It answers with');
  console.log('NAMESPACES rather than tools, and it is keyed on the lane directive rather than the person\'s words.');
  console.log('');
  for (const prompt of ['take a picture of what is on my screen', 'which processes are hogging the machine', 'hi']) {
    const result = spawnSync(process.execPath, [orient, '--json', prompt], {
      cwd: engineRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
    });
    let summary = '(could not run)';
    try {
      const packet = JSON.parse(result.stdout);
      const namespaces = (packet.toolNamespaces || []).map(entry => `${entry.namespace} (${entry.toolCount} tools)`);
      const cards = (packet.cards || []).map(card => card.id);
      summary = [
        `exit ${result.status}`,
        `namespaces: ${namespaces.length ? namespaces.join(', ') : '(none)'}`,
        `cards: ${cards.length ? cards.join(', ') : '(none)'}`,
      ].join(' · ');
    } catch { summary = `(exit ${result.status}; no JSON packet)`; }
    const ours = recommend(prompt, { artifact });
    console.log(THIN);
    console.log(`  PROMPT   ${JSON.stringify(prompt)}`);
    console.log(`  today    ${summary}`);
    console.log(`  this     ${ours.tools.length ? ours.tools.map(tool => tool.id).join(', ') : '(silence)'}`);
  }
  console.log('');
}

if (require.main === module) main(process.argv.slice(2));
