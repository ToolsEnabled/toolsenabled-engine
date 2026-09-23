#!/usr/bin/env node
'use strict';

/* A CONTRACT IS A FORM, NOT AN ESSAY.
 *
 * WHY. Briefing an agent by EXPLAINING mechanisms costs ~1,250 tokens per
 * dispatch, is retyped slightly differently every time, and is read
 * unreliably -- an agent skims prose and parses a grammar. Measured against the
 * briefs this project has actually been sending: six authored lines expand to
 * the same brief, and a namespace-scoped API sheet (tools/agent-api-sheet.js)
 * costs 244 tokens for everything the agent can call.
 *
 * THE SPLIT THAT MAKES IT WORK. The AUTHOR writes only what is specific to this
 * task. The DISPATCHER expands the invariants -- the rules every contract in
 * this project carries, each of which was paid for with a real failure. Those
 * rules stop being something I remember to type and become something the form
 * cannot omit.
 *
 * THE GRAMMAR, all of it:
 *
 *     CONTRACT/1
 *     role      INVESTIGATOR            # one of ROLES
 *     target    src/lib/                # a real path or glob; first line of the brief
 *     do        <one line>              # the task
 *     because   <one line>              # the MEASURED fact that justifies it
 *     done      <one line>              # what finished means, checkable by someone else
 *     report    REPORT-thing.md         # where the answer goes
 *     api       repo,code               # optional: namespaces to hand over as a sheet
 *     allow     commit                  # optional: lift one default prohibition, deliberately
 *
 * REFUSED, NOT WARNED, because a malformed contract spends real quota to
 * produce a diff nobody can use:
 *   - an unknown role, or a missing required field;
 *   - a `because` that states no measurement -- the commonest way a contract
 *     sends an agent to fix something that is not broken;
 *   - a `done` that cannot be checked by anybody but the agent itself;
 *   - a file:line citation anywhere -- line numbers do not survive a different
 *     branch, and this project lost three whole dispatch waves to agents
 *     correctly finding nothing at lines that addressed other code.
 */

const ROLES = Object.freeze([
  'IMPLEMENTER', 'INVESTIGATOR', 'TESTER', 'VERIFIER',
  'HARVESTER', 'PLANNER', 'COORDINATOR', 'MANAGER', 'WORKER',
]);

// Shared by advertised tool schema and expanded child briefs. This explains
// input syntax, not permission to delegate or evidence about the current task.
const CONTRACT_GUIDE = [
  'To call agent.spawn, contract is a newline-separated input form, not this expanded brief.',
  'Begin with CONTRACT/1; required fields are role, target, do, because, done, report (key then space then value).',
  `role: ${ROLES.join('|')}. Optional fields: api (comma-separated namespaces), allow (explicit exceptions).`,
  'because must cite actual task evidence: an observed number, named failing check or quoted output; never invent a measurement.',
  'done must name an independently verifiable artifact/check, not subjective claims such as "works correctly". Cite symbols, not file:line.',
  'Illustrative syntax only: replace the example paths, task, evidence and completion checks with your actual task; this example is not observed evidence.',
  '```text',
  'CONTRACT/1',
  'role INVESTIGATOR',
  'target src/',
  'do Inspect the reported failure and write findings; do not edit source.',
  'because The parent reports 2 refused spawn attempts.',
  'done REPORT-child.md names inspected symbols, findings and verification commands.',
  'report REPORT-child.md',
  '```',
].join('\n');

const REQUIRED = Object.freeze(['role', 'target', 'do', 'because', 'done', 'report']);

/* Every line below is a rule this project learned by losing something. They are
 * expanded into every brief so that remembering them is not a person's job. */
const INVARIANTS = Object.freeze([
  'evidence   path + quoted symbol or string. NEVER file:line -- line numbers address different code on a different branch.',
  'absent     two independent search methods before claiming something is unused. Helpers, re-exports, constants and destructured defaults ({ escape = escapeText }) hide callers; a single grep has produced wrong "zero callers" verdicts here.',
  'unknown    "could not look" and "not there" are different answers. Never merge them.',
  'rank       safety > irreversible/external > confidential > correctness > workflow. Rank by what a person loses, not by what is interesting.',
  'gate       any gate you add gets a mutation check: break it, show RED, restore, show GREEN, both outputs in the report.',
  'caps       declare any bound you apply (subset, sample, top-N). A truncated count reported as a total reads as complete.',
  'tests      assert BEHAVIOUR by calling with values. Never pin an implementation spelling -- a spelling pin fails against a BETTER implementation and the quickest way green is to reinstate the defect.',
  'refusals   a skip or refusal names itself and its reason. A silent skip is the defect this codebase keeps re-finding.',
  'secrets    never print a credential value into a report, diff, fixture or log. Name the variable and the sink, never the value.',
  'conflict   if this contract and the code disagree, THE CODE IS THE FACT. Report the disagreement; do not bend the code to the contract.',
]);

const FORBIDDEN = Object.freeze([
  'git checkout / stash / reset -- destroys other agents\' only copy in a shared tree',
  'commit, push',
  'weakening a test or a check to make something pass',
  'hardcoding a path, port, machine or account name',
  'moving customer-facing copy to fit a missing implementation',
]);

/* WHAT COUNTS AS A FIELD LINE, and what is the line before it continuing.
 *
 * The grammar above is `key value`: a lowercase word, whitespace, the rest.
 * That is still the form, and it is still what the examples show. But the
 * things that WRITE contracts now are agents, and measured 2026-09-03 in the
 * live log, an agent's spawn was refused with nine "not a field line" errors
 * for a contract that read `ROLE: Worker`, `TITLE: ...`, `WORKDIR: ...` and
 * then prose -- the shape of the EXPANDED brief it had itself been given,
 * written back as input. Two other refusals were for `because2`, an agent
 * reaching for a second `because` because the first was refused as repeated.
 *
 * So two forms are read, and neither is ambiguous:
 *   key value       the original -- a lowercase word then whitespace
 *   Key: value      any-case word then a colon -- the colon is the signal
 * and everything else is a CONTINUATION of the field above it rather than an
 * error, because a value worth writing is often worth two lines. A repeated
 * field continues too. The only remaining parse error is text before the
 * first field, which really is not part of any field.
 *
 * A capitalised word followed by a space is NOT a field. `Read the file` is
 * prose, and treating it as field `read` would silently eat the sentence. */
const FIELD_LINE = /^(?:([A-Za-z][A-Za-z0-9_-]{0,31}):\s*(.*)|([a-z]+)\s+(.*))$/;

/* A MECHANICAL FAULT THE READER CAN FIX IS NOT WORTH A ROUND TRIP.
 *
 * A missing header used to return here with `fields: {}`, so the caller was
 * told FIVE things -- "no CONTRACT/1 header; missing required field: role;
 * missing required field: target; missing required field: do; missing required
 * field: because" -- for ONE mistake, and none of the four were true: every
 * field was sitting right there, unread, because the parse stopped before it
 * looked. MEASURED 2026-09-03 on the owner's ledger: that exact five-part
 * sentence is the single commonest agent.spawn refusal.
 *
 * So the header's absence is now REPAIRED rather than reported, and only on
 * proof: the body is re-read as if the header were present, and the repair is
 * accepted ONLY when that reading yields every required field with no parse
 * error of its own. Prose cannot satisfy that -- it has no `role`, no `done`,
 * no `report` -- so the strictness of the condition is what makes the repair
 * safe rather than generous.
 *
 * NOTHING ELSE IS FORGIVEN. This restores the fields; validate() still judges
 * them, and every gate it applies -- the role table, the measurement in
 * `because`, the checkable `done`, the file:line rule -- runs exactly as
 * before on exactly the same text. A contract that is wrong is still refused,
 * and now it is refused for the reason it is actually wrong.
 *
 * The repair is reported on the result as `repaired` so the caller can see
 * what was assumed rather than having it happen invisibly. */
function parseBody(lines, from) {
  const fields = {};
  const errors = [];
  let current = null;
  for (const line of lines.slice(from)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = FIELD_LINE.exec(trimmed);
    if (!match) {
      if (current === null) { errors.push(`not a field line: ${trimmed.slice(0, 60)}`); continue; }
      fields[current] = `${fields[current]} ${trimmed}`.trim();
      continue;
    }
    const key = (match[1] || match[3]).toLowerCase();
    const value = (match[2] !== undefined ? match[2] : match[4]).trim();
    fields[key] = Object.hasOwn(fields, key) ? `${fields[key]} ${value}`.trim() : value;
    current = key;
  }
  /* The role table is upper case and an agent writes `Worker` as often as
     `WORKER`; the word is the same word. */
  if (typeof fields.role === 'string') fields.role = fields.role.toUpperCase();
  return { errors, fields };
}

function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim() === 'CONTRACT/1');
  if (head !== -1) return parseBody(lines, head + 1);

  /* No header. Read the whole thing as a body and keep that reading only if it
     is unambiguously a contract: every required field present, and nothing in
     it that failed to parse. Anything less returns the original refusal, whose
     first line is the one true thing about it. */
  const repaired = parseBody(lines, 0);
  const complete = repaired.errors.length === 0
    && REQUIRED.every((key) => typeof repaired.fields[key] === 'string' && repaired.fields[key] !== '');
  if (!complete) return { errors: ['no CONTRACT/1 header'], fields: {} };
  return {
    errors: [],
    fields: repaired.fields,
    repaired: Object.freeze(['the CONTRACT/1 header was missing and was assumed: '
      + 'every required field was present and readable without it']),
  };
}

/* A `because` that names no measurement is the commonest way a contract sends an
 * agent to fix something that is not broken. Numbers, a comparison, a named
 * failing check or a quoted output all count; an adjective does not. */
function statesAMeasurement(value) {
  return /\d/.test(value) || /\b(measured|exits? 1|returns?|reports?|FAIL|red|green|zero|none|refus)\b/i.test(value);
}

/* THE ADJECTIVE GATE JUDGES PROSE, SO IT MUST NOT READ FILENAMES.
 *
 * `done` is required to name the file the diff may touch, and this repository
 * contains `tools/require-clean-tree.mjs`. `\bclean\b` matched inside that
 * FILENAME -- `-` is a word boundary -- so a correct brief was refused with
 * "done is not checkable by anybody but the agent", and the only way to satisfy
 * the gate was to stop naming the target. Measured 2026-08-25: it blocked the
 * one file in the app's release chain that gates a cut on a clean tree.
 *
 * The rule is aimed at subjective claims ("done when it is properly cleaned
 * up"), which survive this stripping untouched. Only path-shaped tokens are
 * removed, so the gate keeps every case it was written for. */
function withoutPaths(value) {
  return String(value).replace(/[\w./\\-]*[\w-]\.(?:js|mjs|cjs|jsx|json|css|html|ts|md|txt|ps1|py|sh|ya?ml)\b/gi, ' ');
}

function validate(fields) {
  const errors = [];
  for (const key of REQUIRED) if (!fields[key]) errors.push(`missing required field: ${key}`);
  if (fields.role && !ROLES.includes(fields.role)) {
    errors.push(`role must be one of ${ROLES.join('|')} -- got ${fields.role}`);
  }
  if (fields.because && !statesAMeasurement(fields.because)) {
    errors.push('because states no measurement. Name a number, a failing check, or quoted output -- '
      + 'an adjective is how an agent gets sent to fix something that is not broken.');
  }
  if (fields.done && /\b(properly|correctly|well|good|clean|nice)\b/i.test(withoutPaths(fields.done))) {
    errors.push('done is not checkable by anybody but the agent. Say what someone else could verify.');
  }
  for (const [key, value] of Object.entries(fields)) {
    if (/[\w./-]+\.(?:js|mjs|cjs|json|css|html|ts):\d+/.test(value)) {
      errors.push(`${key} cites file:line. Line numbers address different code on another branch -- `
        + 'quote the symbol or the string instead.');
    }
  }
  return errors;
}

function expand(fields, apiSheet) {
  const allowed = new Set(String(fields.allow || '').split(',').map((s) => s.trim()).filter(Boolean));
  const forbidden = FORBIDDEN.filter((rule) => ![...allowed].some((a) => rule.includes(a)));
  const out = [];
  out.push(`ROLE: ${fields.role} working in ${fields.target} -- ${fields.do}`);
  out.push('');
  out.push(`WHY (measured): ${fields.because}`);
  out.push(`DONE WHEN: ${fields.done}`);
  out.push('');
  /* THE REPORT LINE IS NEAR THE TOP BECAUSE IT WAS AT THE BOTTOM AND GOT LOST.
   *
   * Measured 2026-08-24: of the cloud tasks that came back, NINE returned no
   * diff at all, and every one of them was an investigation -- "Find...",
   * "List...", "Enumerate...", "Audit...". Seven of the nine were in one repo.
   * An agent that only READS produces no code change, so if it does not write
   * the report there is nothing in the diff and the dispatch is simply lost.
   *
   * The instruction was present the whole time. It was the LAST line, after ten
   * rules and a tool sheet. For an investigator whose entire output is the
   * report, that is the most important sentence in the brief sitting where a
   * reader has already stopped. The dispatcher this file replaced learned the
   * same lesson the other way round -- a fence placed FIRST became the task and
   * three agents did the warning and returned nothing. Whatever leads, leads. */
  out.push('WRITE THE REPORT EVEN IF YOU CHANGE NO CODE.');
  out.push(`  -> ${fields.report}, at the repository root, in the same task diff.`);
  out.push('  A task that changes nothing and reports nothing is indistinguishable from');
  out.push('  a task that never ran. If your answer is "nothing is wrong here", that is a');
  out.push('  finding and it goes in the file with the evidence that established it.');
  out.push('');
  out.push('RULES');
  for (const rule of INVARIANTS) out.push('  ' + rule);
  out.push('');
  out.push('FORBIDDEN');
  for (const rule of forbidden) out.push('  - ' + rule);
  if (allowed.size) out.push(`  (lifted for this contract: ${[...allowed].join(', ')})`);
  out.push('');
  if (apiSheet) {
    out.push('TOOLS YOU MAY CALL');
    out.push(apiSheet.trim());
    out.push('');
  }
  out.push('DELEGATION INPUT FORMAT (only when delegation is authorized)');
  out.push(CONTRACT_GUIDE);
  out.push('');
  out.push(`REPORT: ${fields.report} -- lead with the costliest finding, not the first one you found.`);
  return out.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const fs = require('node:fs');
  const file = argv[0];
  if (!file) { console.error('usage: node tools/agent-contract.js <contract.txt>'); return 2; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { console.error(`REFUSED: cannot read ${file}: ${error.message}`); return 2; }

  const { errors: parseErrors, fields } = parse(text);
  const errors = [...parseErrors, ...validate(fields)];
  if (errors.length) {
    console.error('CONTRACT REFUSED -- a malformed contract spends real quota to produce a diff nobody can use:');
    for (const error of errors) console.error('  - ' + error);
    return 1;
  }

  let sheet = '';
  if (fields.api) {
    const { execFileSync } = require('node:child_process');
    try {
      /* THE CHILD GETS A SCRUBBED ENVIRONMENT, AND THIS LINE WAS THE BUG.
       *
       * It used to pass no `env` at all, which means node hands the child the
       * FULL process.env -- including any ANTHROPIC_API_KEY sitting in this
       * shell. The repository's spawn-environment gate caught it on the first
       * run after this file landed: "2 NEW call site(s) hand a child an
       * environment that was never scrubbed." One of the two was this file.
       *
       * That is worth recording rather than quietly fixing: this module exists
       * to make agent briefs carry the project's hygiene rules, and it shipped
       * violating a different one. The gate is why it did not survive an hour.
       *
       * Scrubbed with the shared helper on purpose. The gate's own advice says
       * not to hand-roll a delete list, because Windows environment names are
       * case-insensitive while a JS object is not -- so `delete
       * env.ANTHROPIC_API_KEY` leaves `anthropic_api_key` behind for the child
       * to find. */
      const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
      sheet = execFileSync(process.execPath,
        [require('node:path').join(__dirname, 'agent-api-sheet.js'), '--ns', fields.api],
        { encoding: 'utf8', windowsHide: true, env: safeLaunchEnvironment(process.env, { context: 'agent api sheet' }) });
      /* A zero-byte successful child is not evidence that the requested tool
       * surface is empty. It is an unmeasured surface: without this floor the
       * falsy `sheet` also made expand() omit TOOLS YOU MAY CALL while this
       * command still exited 0, confidently producing an incomplete brief. */
      if (!sheet.trim()) {
        throw new Error('agent-api-sheet.js exited successfully but produced no output');
      }
    } catch (error) {
      console.error(`REFUSED: the API sheet for "${fields.api}" could not be produced, so the brief would `
        + `hand over a tool surface nobody verified: ${error.message}`);
      return 2;
    }
  }
  console.log(expand(fields, sheet));
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { ROLES, REQUIRED, INVARIANTS, FORBIDDEN, CONTRACT_GUIDE, parse, validate, expand, statesAMeasurement };
