'use strict';

/* THE BATCH TARGET -- a coordinator declares everything up front, the
 * declaration passes production gates, and after admission the coordinator
 * LOSES CONTROL OF IT.
 *
 * WHY THAT LAST PROPERTY IS THE WHOLE DESIGN. Every cloud wave this project has
 * run so far was hand-driven: someone chose tasks, watched them, re-dispatched
 * the ones that came back empty, and decided mid-flight what to do next. That
 * does not ship. A person cannot babysit eighty launches a minute, and an agent
 * that steers its own batch mid-flight is an agent whose scope nobody bounded.
 *
 * So the shape is declarative. One call carries the target, the bounds, and the
 * gates. Admission either accepts the whole thing or refuses it BY NAME. After
 * admission the record is sealed and the batch runs to its own bounds.
 *
 * LOSING CONTROL IS ONLY SAFE IF ADMISSION IS STRICT. That is the trade this
 * file exists to make honest. Every gate below refuses rather than warns,
 * because a warning on an unattended batch is a message nobody is there to
 * read. The gates are ordered cheapest-first so a malformed declaration is
 * refused before anything touches the network.
 *
 * THE SEAL IS NOT DECORATION. `admissionSha256` is computed over the canonical
 * declaration at admission. A runner re-checks it before every dispatch, so a
 * declaration mutated after admission stops the batch instead of quietly
 * dispatching something nobody admitted. Without it "the coordinator loses
 * control" would be a convention, and conventions are what this codebase keeps
 * finding on the wrong side of a defect.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const { CloudAgentError } = require('./errors');
/* THE BRIEF VALIDATOR IS REUSED, NOT RESTATED. tools/agent-contract.js already
 * refuses an unknown role, a missing field, a "because" that names no
 * measurement, a "done" only the agent itself could check, and a file:line
 * citation. Every one of those rules was paid for with a wasted wave. A second
 * standard here would drift from it, and the looser of the two would become
 * the real one. */
const agentContract = require('../../../tools/agent-contract.js');

const BATCH_SCHEMA = 'toolsenabled.cloud-batch.target/v1';

/* Measured on this machine 2026-08-24 and stated rather than assumed: the
 * provider accepted roughly 160 launches per two minutes per account, i.e. ~80
 * a minute each. The ceiling here is per ACCOUNT and deliberately a little
 * under that, because a batch that saturates the rate limit converts a
 * throughput problem into a 429 storm and the retries cost more than the
 * headroom saved. A declaration asking for more is refused rather than clamped:
 * silently serving less than was asked for is how a harness comes to report a
 * number nobody can reproduce. */
const MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT = 72;

const PROJECT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BATCH_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
// Same shape the registry enforces for mirror branches; one rule, not two.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

/* Canonical form, so the seal is over MEANING and not over key order or
 * whitespace. Two declarations that would dispatch identically must hash
 * identically, or the seal fires on formatting and gets disabled. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function sealOf(declaration) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(declaration))).digest('hex');
}

/* ---------------------------------------------------------------------------
 * The declaration.
 * ------------------------------------------------------------------------- */

function parseBatchTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('CLOUD_BATCH_MALFORMED', 'a batch target must be an object declaring everything the batch needs up front.');
  }
  if (input.schemaVersion !== BATCH_SCHEMA) {
    fail('CLOUD_BATCH_MALFORMED', `schemaVersion must be ${JSON.stringify(BATCH_SCHEMA)}.`);
  }
  if (!BATCH_ID.test(String(input.batchId || ''))) {
    fail('CLOUD_BATCH_MALFORMED', 'batchId must be lowercase [a-z0-9_-], 1-64 characters. It is how this batch is referred to after the coordinator stops steering it.');
  }
  if (!PROJECT_KEY.test(String(input.project || ''))) {
    fail('CLOUD_BATCH_MALFORMED', 'project must name a registered cloud mirror project.');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    fail('CLOUD_BATCH_MALFORMED', 'tasks must be a non-empty array. A batch that declares no work is a call nobody meant to make.');
  }
  const bounds = input.bounds;
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
    fail('CLOUD_BATCH_MALFORMED', 'bounds must be declared up front: how many, how fast, and across how many accounts.');
  }
  for (const field of ['launchesPerMinute', 'accounts']) {
    if (!Number.isInteger(bounds[field]) || bounds[field] < 1) {
      fail('CLOUD_BATCH_MALFORMED', `bounds.${field} must be a positive integer.`);
    }
  }
  /* WHAT THIS BATCH IS DISPATCHED AGAINST, stated rather than inferred.
   *
   * Absent, it means a MIRROR, which is the default and the strong case: the
   * mirror is published from the local tree, so a cloud agent sees exactly what
   * is here.
   *
   * `{ publishedCommit }` is the honest alternative for the case where no
   * mirror is available -- the agents work from a published branch that is
   * BEHIND local. That is not automatically wrong: engine harvests were clean
   * at 5 commits behind, and useless at 467. The distance is not the thing that
   * matters; whether THIS TASK'S OWN FILE moved is. So declaring it swaps the
   * mirror gate for a per-task drift gate that gives the same guarantee for the
   * tasks it admits.
   *
   * IT HAS TO BE DECLARED, NEVER INFERRED FROM A MISSING MIRROR. A batch that
   * silently fell back to publishedCommit mode when the mirror was unreachable
   * would lose the mirror's guarantee at exactly the moment nobody was watching
   * -- which is the whole failure this lane exists to end. */
  let against = null;
  if (input.against !== undefined && input.against !== null) {
    if (typeof input.against !== 'object' || Array.isArray(input.against)) {
      fail('CLOUD_BATCH_MALFORMED', 'against must be an object when declared.');
    }
    if (!COMMIT_SHA.test(String(input.against.publishedCommit || ''))) {
      fail('CLOUD_BATCH_MALFORMED',
        'against.publishedCommit must be a full 40-character commit id -- the exact commit a cloud agent would see. An abbreviation cannot be compared against a diff reliably.');
    }
    against = Object.freeze({ publishedCommit: input.against.publishedCommit });
  }

  return Object.freeze({
    schemaVersion: BATCH_SCHEMA,
    batchId: input.batchId,
    project: input.project,
    tasks: input.tasks,
    bounds: Object.freeze({ launchesPerMinute: bounds.launchesPerMinute, accounts: bounds.accounts }),
    against,
    harvest: parseHarvestSpec(input.harvest),
    provider: parseProviderSpec(input.provider, bounds.accounts)
  });
}

/* THE DISPATCH HALF OF "SPECIFY EVERYTHING UP FRONT". tools/cloud-lane.js has
 * always named the gap in its own handoff comment: runBatch also takes
 * `dispatch` and `accounts`, and the CLI could not honestly supply either,
 * because provider coordinates taken from FLAGS would sit outside the seal --
 * a sealed batch could be pointed at an environment nobody admitted without
 * breaking the seal. The first 150-task batch actually run (2026-08-24) was
 * dispatched by a harness composed outside the repo for exactly this reason.
 *
 * So the coordinates live HERE, inside the declaration the seal is computed
 * over: which branch the cloud agents check out, and which environment each
 * account launches into. What stays OUTSIDE the seal is machine-local by
 * nature and already re-checked downstream: each account's CODEX_HOME comes
 * from the multi-account registry on the dispatching machine, and runBatch
 * re-checks the account list against the admitted rate itself.
 *
 * ABSENT MEANS THE OLD CONTRACT, not a defect: a declaration without
 * `provider` admits exactly as before, and dispatching it still requires a
 * caller-supplied dispatch. Nothing that admitted yesterday refuses today. */
function parseProviderSpec(input, declaredAccounts) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('CLOUD_BATCH_MALFORMED', 'provider must be an object when declared: { branch, environments, concurrency }.');
  }
  const unknown = Object.keys(input).filter((key) => !['branch', 'environments', 'concurrency'].includes(key));
  if (unknown.length) {
    fail('CLOUD_BATCH_MALFORMED',
      `provider declares ${unknown.map((k) => JSON.stringify(k)).join(', ')}, which nothing consumes. An accepted-but-ignored field reads as specified and does nothing, so it is refused instead.`);
  }
  const branch = input.branch === undefined ? 'main' : input.branch;
  if (typeof branch !== 'string' || !BRANCH.test(branch)) {
    fail('CLOUD_BATCH_MALFORMED', 'provider.branch must be a usable branch name -- it is the branch every cloud agent checks out.');
  }
  const environments = input.environments;
  if (!environments || typeof environments !== 'object' || Array.isArray(environments)) {
    fail('CLOUD_BATCH_MALFORMED',
      'provider.environments must map each account name to its environment id. An account with no environment has nowhere to launch.');
  }
  const names = Object.keys(environments);
  if (names.length === 0) {
    fail('CLOUD_BATCH_MALFORMED', 'provider.environments must name at least one account.');
  }
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      fail('CLOUD_BATCH_MALFORMED', `provider.environments names ${JSON.stringify(name)}, which is not a usable account name.`);
    }
    if (!/^[0-9a-f]{32}$/.test(String(environments[name] || ''))) {
      fail('CLOUD_BATCH_MALFORMED',
        `provider.environments[${JSON.stringify(name)}] must be a 32-hex-character environment id -- the exact environment that account is authorized for.`);
    }
  }
  /* THE COUNT IS THE SAME FACT TWICE, so it must agree with itself.
   * bounds.accounts is what gateBounds cleared the launch rate against;
   * admitting a rate for three accounts and then dispatching across two is
   * exactly the mismatch checkAccountsCanCarryRate refuses at run time --
   * refusing it here names it while the coordinator is still steering. */
  if (names.length !== declaredAccounts) {
    fail('CLOUD_BATCH_MALFORMED',
      `provider.environments names ${names.length} account(s) but bounds.accounts declares ${declaredAccounts}. `
      + 'The admitted rate is cleared against bounds.accounts; a different dispatch roster would carry a rate nobody admitted.');
  }
  const concurrency = input.concurrency === undefined ? 1 : input.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    fail('CLOUD_BATCH_MALFORMED', 'provider.concurrency must be a whole number from 1 to 32 when declared.');
  }
  const frozenEnvironments = Object.freeze(names.sort().reduce((out, name) => {
    out[name] = environments[name];
    return out;
  }, {}));
  return Object.freeze({ branch, environments: frozenEnvironments, concurrency });
}

/* THE HARVEST HALF OF "SPECIFY EVERYTHING UP FRONT". Until this, `harvest` was
 * carried through unvalidated and consumed by nothing -- an API surface that
 * reads as specified and does nothing, which is the settings-that-enforce-
 * nothing defect one layer up. The owner's design is explicit: the coordinator
 * specifies everything, harvesters included, and then loses control.
 *
 * WHO CONSUMES IT: the harvester enumerates a wave from the batch JOURNAL (the
 * provider's own list caps at 20 rows and shows one account, so the journal is
 * the only complete record). openBatch writes this spec into the journal
 * header, so the harvester finds the landing branch and the verification bar
 * in the same file that names the tasks -- declared once, sealed with the rest.
 *
 * WHAT IS DELIBERATELY NOT OFFERED: a way to skip verification. Every harvested
 * diff is verified against a control at the same pin, because the alternative
 * was measured this week -- a batch of unrelated diffs "fixing" a test the
 * environment had broken, and thirteen standing failures reported as fresh
 * regressions. `mutationSample` sets how many landed TESTS are additionally
 * proven able to go red; nought is refused, since most wave tasks WRITE tests
 * and a test that cannot fail guards nothing. */
function parseHarvestSpec(input) {
  if (input === undefined || input === null) {
    /* Declared defaults, not an absence. A batch that says nothing about
     * harvest still gets a real spec, visible in the sealed declaration. */
    return Object.freeze({ branch: 'harvest/batch', mutationSample: 5 });
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('CLOUD_BATCH_MALFORMED', 'harvest must be an object when declared: { branch, mutationSample }.');
  }
  const unknown = Object.keys(input).filter((key) => !['branch', 'mutationSample'].includes(key));
  if (unknown.length) {
    fail('CLOUD_BATCH_MALFORMED',
      `harvest declares ${unknown.map((k) => JSON.stringify(k)).join(', ')}, which nothing consumes. An accepted-but-ignored field reads as specified and does nothing, so it is refused instead.`);
  }
  const branch = input.branch === undefined ? 'harvest/batch' : input.branch;
  if (typeof branch !== 'string' || !BRANCH.test(branch)) {
    fail('CLOUD_BATCH_MALFORMED', 'harvest.branch must be a usable branch name; harvested work lands there and nowhere else.');
  }
  const sample = input.mutationSample === undefined ? 5 : input.mutationSample;
  if (!Number.isInteger(sample) || sample < 1) {
    fail('CLOUD_BATCH_MALFORMED',
      'harvest.mutationSample must be a whole number of at least 1. Most wave tasks write tests, and a landed test never shown able to go red guards nothing -- skipping the check is not offered.');
  }
  return Object.freeze({ branch, mutationSample: sample });
}

/* ---------------------------------------------------------------------------
 * The production gates. Ordered cheapest first.
 * ------------------------------------------------------------------------- */

function gateShape(declaration, findings) {
  const seen = new Map();
  declaration.tasks.forEach((task, index) => {
    if (!task || typeof task !== 'object') {
      findings.push({ gate: 'shape', refused: `task ${index} is not an object.` });
      return;
    }
    if (typeof task.contract !== 'string' || !task.contract.includes('CONTRACT/1')) {
      findings.push({ gate: 'brief', refused: `task ${index} carries no CONTRACT/1 block. An unbriefed dispatch spends real quota to produce a diff nobody can use.` });
    } else {
      /* UNDERSPECIFIED IS REFUSED, NOT WARNED. This batch runs unattended, so
         a brief nobody checked reaches an agent with nobody left to notice. */
      const parsed = agentContract.parse(task.contract);
      const errors = [...parsed.errors, ...agentContract.validate(parsed.fields)];
      for (const problem of errors) {
        findings.push({ gate: 'brief', refused: `task ${index} (${task.target || 'no target'}): ${problem}` });
      }
    }
    /* COLLISION IS STRUCTURAL, NOT ADVISORY. Two cloud agents editing one file
     * produce two diffs that cannot both apply, and the harvest pays for it in
     * merge conflicts -- 10 of 40 in the last measured wave. Refusing the
     * declaration is cheaper than resolving the conflicts it would create. */
    const target = typeof task.target === 'string' ? task.target.trim().toLowerCase() : null;
    if (!target) {
      findings.push({ gate: 'shape', refused: `task ${index} declares no target file, so nothing bounds what it may edit.` });
      return;
    }
    if (seen.has(target)) {
      findings.push({
        gate: 'collision',
        refused: `tasks ${seen.get(target)} and ${index} both target ${task.target}. Two agents editing one file produce two diffs that cannot both apply.`
      });
      return;
    }
    seen.set(target, index);
  });
}

function gateBounds(declaration, findings) {
  const { launchesPerMinute, accounts } = declaration.bounds;
  const ceiling = MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT * accounts;
  if (launchesPerMinute > ceiling) {
    findings.push({
      gate: 'bounds',
      refused: `bounds ask for ${launchesPerMinute} launches a minute across ${accounts} account(s), above the measured ceiling of ${ceiling} (${MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT} per account). Refusing rather than quietly serving less, because a batch that reports a rate it did not achieve is a number nobody can reproduce.`
    });
  }
}

async function gateMirror(declaration, findings, { mirrorApi, registryPath }) {
  /* THE HARD REQUIREMENT, and the reason this whole lane exists. A cloud agent
   * diffs against the MIRROR. If the mirror is behind the local tree, every
   * agent in the batch works from stale source: their citations address code
   * that moved, their patches fail to apply, and the failure surfaces at
   * harvest as "the fix is already present" or an empty diff. That was measured
   * -- the app's cloud branch was 467 commits behind local HEAD, and its
   * harvests were the ones that came back useless while the engine's, 5 behind,
   * came back clean. So a batch is refused at admission rather than discovering
   * it 250 dispatches later. */
  let verdict;
  try {
    verdict = await mirrorApi.checkMirrorFreshness({
      projectKey: declaration.project,
      ...(registryPath ? { registryPath } : {})
    });
  } catch (error) {
    findings.push({
      gate: 'mirror',
      refused: `the mirror for ${declaration.project} could not be confirmed current: ${error && error.message}`,
      code: error && error.code
    });
    return;
  }
  /* ONLY AN EXPLICIT TRUE ESTABLISHES FRESHNESS. A dependency that resolves
   * with undefined, null, or a response missing `fresh` did not answer the
   * question. Treating those malformed responses as the non-false case used
   * to admit the batch with no established mirror state. */
  if (!verdict || verdict.fresh !== true) {
    findings.push({
      gate: 'mirror',
      refused: verdict && verdict.fresh === false
        ? `the mirror for ${declaration.project} is not at local HEAD, so every agent in this batch would diff against stale source.`
        : `the mirror freshness check for ${declaration.project} returned no definite fresh answer, so what the agents would see is unestablished.`
    });
  }
}

/* THE DRIFT GATE -- the mirror's guarantee, per task, for the case where there
 * is no mirror.
 *
 * A batch declaring `against.publishedCommit` sends agents to work from a
 * branch that is behind local. For a task whose own target file has NOT moved
 * since that commit, the agent sees byte-identical source and the distance is
 * irrelevant. For a task whose file HAS moved, the agent works from an older
 * version: its citations address code that changed, and its diff arrives at
 * harvest as a conflict or as a fix already present. Both were measured.
 *
 * So this refuses the moved ones by name and admits the rest. That is a
 * stronger statement than "the branch is only N commits behind", because N says
 * nothing about whether it is the wrong N.
 */
async function gateDrift(declaration, findings, { changedSince }) {
  if (!declaration.against) return;
  if (typeof changedSince !== 'function') {
    findings.push({
      gate: 'drift',
      refused: 'this batch declares against.publishedCommit, but no way to ask which files changed since it was supplied. Refusing rather than admitting tasks whose staleness nobody could check -- "could not look" is not "did not move".'
    });
    return;
  }
  let moved;
  try { moved = await changedSince(declaration.against.publishedCommit); }
  catch (error) {
    findings.push({ gate: 'drift', refused: `the files changed since ${declaration.against.publishedCommit.slice(0, 12)} could not be established: ${error && error.message}` });
    return;
  }
  /* An absent or malformed result is not an empty diff. Previously every
   * non-Set/non-array answer collapsed to an empty Set, so all tasks passed
   * merely because changedSince failed to provide a usable measurement. */
  if (!(moved instanceof Set) && !Array.isArray(moved)) {
    findings.push({
      gate: 'drift',
      refused: `the files changed since ${declaration.against.publishedCommit.slice(0, 12)} were not returned as a Set or array, so drift was not measured.`
    });
    return;
  }
  const movedSet = moved instanceof Set ? moved : new Set(moved);
  declaration.tasks.forEach((task, index) => {
    const file = task && typeof task.target === 'string' ? task.target : null;
    if (file && movedSet.has(file)) {
      findings.push({
        gate: 'drift',
        refused: `task ${index} targets ${file}, which has changed since the published commit this batch dispatches against. The agent would work from an older copy of the one file it was sent to edit.`
      });
    }
  });
}

/**
 * Run every gate and either ADMIT the batch or refuse it with all findings.
 *
 * ALL findings are returned, not the first. A coordinator that is about to stop
 * steering needs to fix everything in one pass; refusing one reason at a time
 * turns admission into a guessing game and is how people start bypassing it.
 */
async function admitBatch(input, { mirrorApi, registryPath = null, changedSince = null, now = null } = {}) {
  const declaration = parseBatchTarget(input);
  const findings = [];

  gateShape(declaration, findings);
  gateBounds(declaration, findings);
  // Network last: a malformed declaration must not cost a round trip.
  if (findings.length === 0) {
    /* EXACTLY ONE OF THESE RUNS, and which one is the coordinator's declared
       choice rather than a fallback. A batch against a published commit has no
       mirror to check; a batch against a mirror has no published commit to
       measure drift from. Running neither would admit a batch whose source
       nobody vouched for, so the else-branch refuses instead. */
    if (declaration.against) {
      await gateDrift(declaration, findings, { changedSince });
    } else if (mirrorApi) {
      await gateMirror(declaration, findings, { mirrorApi, registryPath });
    } else {
      findings.push({
        gate: 'source',
        refused: 'this batch declares no `against.publishedCommit` and no mirror was supplied to check, so what the agents would actually see is unestablished. Declare one or the other -- an unvouched-for source is the staleness this lane exists to end.'
      });
    }
  }

  if (findings.length > 0) {
    fail('CLOUD_BATCH_REFUSED',
      `the batch target was refused by ${findings.length} gate finding(s), so nothing was dispatched: `
      + findings.map((f) => `[${f.gate}] ${f.refused}`).join(' | '),
      { findings });
  }

  return Object.freeze({
    admitted: true,
    batchId: declaration.batchId,
    project: declaration.project,
    taskCount: declaration.tasks.length,
    bounds: declaration.bounds,
    /* THE SEAL. Recomputed by the runner before every dispatch. A declaration
     * edited after admission stops the batch rather than dispatching something
     * nobody admitted -- which is what makes "the coordinator loses control" a
     * mechanism instead of a promise. */
    admissionSha256: sealOf(declaration),
    admittedAt: now === null ? null : now,
    declaration
  });
}

/**
 * The runner's check before each dispatch. Separated from admitBatch so it can
 * be called cheaply and often; a seal verified once at the start would not
 * notice an edit made at dispatch 200.
 */
function assertSealIntact(admission, declaration) {
  const actual = sealOf(parseBatchTarget(declaration));
  if (actual !== admission.admissionSha256) {
    fail('CLOUD_BATCH_SEAL_BROKEN',
      `the batch declaration changed after admission (admitted ${admission.admissionSha256.slice(0, 16)}, now ${actual.slice(0, 16)}). `
      + 'Stopping rather than dispatching work that never passed the gates.');
  }
  return true;
}

module.exports = Object.freeze({
  BATCH_SCHEMA,
  MAX_LAUNCHES_PER_MINUTE_PER_ACCOUNT,
  admitBatch,
  assertSealIntact,
  parseBatchTarget,
  sealOf
});
