'use strict';

// A positive-only inherited requirement. Ordinary developer ratchets keep their
// existing behaviour; no child chain may turn this release requirement off.
const STRICT_ENV = 'TOOLSENABLED_TEST_STRICT';
const strictRequested = (environment = process.env) => environment[STRICT_ENV] === '1';

// These remain individually executable, but are not unattended deterministic
// coverage. This is an exact declaration, not a filename-pattern skip rule.
const OPT_IN_TESTS = Object.freeze([
  { file: 'tests/agent-engine/claude-live-turn.js', script: 'test:agent-engine:live', reason: 'real provider turn when credentials are available' },
  { file: 'tests/agent-engine/codex-live-turn.js', script: 'test:agent-engine:live', reason: 'real provider turn when the CLI is installed' },
  { file: 'tests/intent-fidelity-live.js', script: 'test:intent-fidelity:live', reason: 'real provider checks against explicitly selected historical owner-ledger evidence' },
  { file: 'tests/scheduler-windows-mutation.js', script: 'test:scheduler:mutation', reason: 'mutates the real Windows Task Scheduler' },
  { file: 'tests/scheduler-windows-legacy-mutation.js', script: 'test:scheduler:mutation', reason: 'mutates the real Windows Task Scheduler' }
].map(Object.freeze));

function validateTap(stdout, code, signal) {
  const results = [];
  const summaries = new Map();
  const groups = [{ indent: 0, count: 0, plan: null }];
  // Same structural rule as the app's reviewed Node TAP validator. Counting
  // each indentation independently loses a missing intermediate parent.
  function groupFor(indent, isResult) {
    let group = groups.at(-1);
    if (indent < group.indent) {
      if (!isResult || group.plan !== group.count || group.indent !== indent + 4) {
        throw new Error('TAP nested plan is incomplete or has no parent result');
      }
      groups.pop();
      group = groups.at(-1);
    }
    if (indent > group.indent) {
      if (group.plan !== null) throw new Error('TAP result appears after its group plan');
      group = { indent, count: 0, plan: null };
      groups.push(group);
    }
    if (group.plan !== null) throw new Error('TAP duplicate plan or result after a completed plan');
    return group;
  }
  let current = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (/^\s*Bail out!(?:\s|$)/i.test(line)) throw new Error('TAP bail out cannot certify a completed suite');
    const result = /^( *)(not ok|ok) (\d+) - (.*)$/.exec(line);
    if (result) {
      const group = groupFor(result[1].length, true);
      const number = Number(result[3]);
      if (!Number.isSafeInteger(number) || number !== group.count + 1) throw new Error('TAP result sequence ordinal is missing, duplicated, or out of order');
      group.count += 1;
      current = {
        indent: result[1].length,
        failed: result[2] === 'not ok', skipped: / # SKIP(?:\s|$)/i.test(result[4]),
        todo: / # TODO(?:\s|$)/i.test(result[4]), suite: false
      };
      results.push(current);
      continue;
    }
    if (/^\s*(?:not ok|ok)\b/.test(line)) throw new Error('TAP test result is malformed');
    if (current && line === `${' '.repeat(current.indent + 2)}type: 'suite'`) current.suite = true;
    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary) {
      if (summaries.has(summary[1])) throw new Error(`duplicate TAP # ${summary[1]} summary`);
      if (!Number.isSafeInteger(Number(summary[2]))) throw new Error('invalid TAP count');
      summaries.set(summary[1], Number(summary[2]));
    }
    const plan = /^( *)1\.\.(\d+)$/.exec(line);
    if (plan) {
      const group = groupFor(plan[1].length, false);
      group.plan = Number(plan[2]);
      if (!Number.isSafeInteger(group.plan) || group.plan !== group.count) throw new Error('TAP group plan does not reconcile');
      continue;
    }
    if (/^\s*\d+\.\./.test(line)) throw new Error('TAP test plan is malformed');
  }
  const required = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const missing = required.filter(field => !summaries.has(field));
  if (missing.length) throw new Error(`incomplete TAP summary: missing ${missing.join(', ')}`);
  const counts = Object.fromEntries(summaries);
  if (groups.length !== 1 || groups[0].plan !== groups[0].count) {
    throw new Error('TAP plan is missing or a nested group has no parent result');
  }
  if (counts.cancelled || counts.todo || results.some(entry => entry.todo)) {
    throw new Error(`incomplete suite: ${counts.cancelled} cancelled, ${counts.todo} TODO test(s)`);
  }
  if (counts.tests === 0 || counts.pass + counts.fail === 0) throw new Error('ZERO completed tests; skips are not executed coverage');
  const tests = results.filter(entry => !entry.suite);
  if (counts.tests !== tests.length || counts.suites !== results.length - tests.length
      || counts.tests !== counts.pass + counts.fail + counts.skipped
      || counts.fail !== tests.filter(entry => entry.failed).length
      || counts.skipped !== tests.filter(entry => entry.skipped).length) {
    throw new Error('TAP summary counts do not reconcile with the reported results');
  }
  if (signal || code !== (counts.fail > 0 ? 1 : 0)) throw new Error('process exit/signal disagrees with TAP failure count');
  return { kind: 'reconciled-tap', counts, unexecuted: counts.skipped };
}

function validateCompletion(result) {
  if (result.error) throw new Error(`child did not complete: ${result.error.code || result.error.message}`);
  if (result.signal || !Number.isInteger(result.status)) throw new Error('child terminated without a completed exit status');
  const stdout = String(result.stdout || '');
  const tap = /^(?:TAP version \d+|1\.\.\d+|# (?:tests|suites|pass|fail|cancelled|skipped|todo) \d+|(?:not ok|ok) \d+ - )/m.test(stdout);
  if (tap) return validateTap(stdout, result.status, result.signal);
  // Legacy assertion programs have a process-exit contract, not a TAP count.
  // Do not manufacture an assertion count or credit an unreconciled skip.
  if (/^(?:SKIP|SKIPPED)\b/im.test(`${stdout}\n${result.stderr || ''}`)) throw new Error('standalone program reported unexecuted coverage without reconciled TAP');
  return { kind: 'process-exit', counts: null, unexecuted: null };
}

module.exports = { STRICT_ENV, OPT_IN_TESTS, strictRequested, validateTap, validateCompletion };
