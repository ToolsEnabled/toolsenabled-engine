#!/usr/bin/env node
'use strict';

// The recent-work feed on its own, so the onboarding packet's "read it yourself"
// pointer leads somewhere real. Every drop the packet makes has to name a
// command an agent can actually run, or the drop is just a hole.
//
// Read-only. Spawns git, reads local files, mutates nothing.

const path = require('node:path');
const { collectRecentWork, DEFAULT_WINDOW_HOURS, RECENT_WORK_BYTES, SECTION_CAPS } = require('../src/lib/agent-recent-work');

function usage() {
  return [
    'node tools/recent-work.js [--json] [--hours <n>] [--scope minimal|task|full] [--project <dir>]',
    '',
    'What has actually been done here in the last few hours, derived from git,',
    'the working tree, reports/lanes mtimes and state/test-runs/latest.json.',
    'Nothing is hand-maintained; entries expire by leaving the window.',
    '',
    `  --hours   window in hours (default ${DEFAULT_WINDOW_HOURS}; widened once if empty)`,
    `  --scope   how much may be printed (default task; caps ${Object.keys(SECTION_CAPS).join('/')})`,
    `  --json    the raw feed, budgeted to ${RECENT_WORK_BYTES.task} bytes at task scope`
  ].join('\n');
}

function parseArgs(argv) {
  const values = { scope: 'task', project: process.cwd() };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') { values.json = true; continue; }
    if (flag === '--help' || flag === '-h') { values.help = true; continue; }
    const next = argv[index + 1];
    if (flag === '--hours' && next !== undefined) { values.hours = Number(next); index += 1; continue; }
    if (flag === '--scope' && next !== undefined) { values.scope = next; index += 1; continue; }
    if (flag === '--project' && next !== undefined) { values.project = next; index += 1; continue; }
    const error = new Error(`Unknown or incomplete option ${flag}.\n\n${usage()}`);
    error.code = 'RECENT_WORK_USAGE';
    throw error;
  }
  if (values.hours !== undefined && (!Number.isFinite(values.hours) || values.hours <= 0)) {
    const error = new Error('--hours must be a positive number.');
    error.code = 'RECENT_WORK_USAGE';
    throw error;
  }
  if (!Object.hasOwn(SECTION_CAPS, values.scope)) {
    const error = new Error(`--scope must be one of: ${Object.keys(SECTION_CAPS).join(', ')}.`);
    error.code = 'RECENT_WORK_USAGE';
    throw error;
  }
  return values;
}

// The text form leads with the headline and the retired block, in that order,
// because those are the two an agent must not skim past. Everything after them
// saves time; those two prevent a wrong action.
function render(feed) {
  const lines = [feed.headline, ''];
  if (feed.retired.length) {
    lines.push('NO LONGER TRUE:');
    for (const entry of feed.retired) {
      if (entry.kind === 'lane-report-subject-changed-since') {
        lines.push(`  - ${entry.report}: its subject ${entry.subject} changed ${entry.subjectNewerByH}h after the report was written (${entry.basis})`);
        continue;
      }
      lines.push(`  - ${entry.kind}${Number.isFinite(entry.count) ? ` (${entry.count})` : ''}`);
      for (const item of entry.paths || []) lines.push(`      ${item}`);
      if (entry.notListed) lines.push(`      ...and ${entry.notListed} more — ${entry.readItAt}`);
      if (entry.note) lines.push(`      note: ${entry.note}`);
    }
  } else if (feed.unknown.length) {
    lines.push('NO LONGER TRUE: not established — one or more contributing checks could not be completed; see COULD NOT DETERMINE.');
  } else {
    lines.push('NO LONGER TRUE: nothing detected. That is a negative result from the checks listed in `derivedFrom`, not a guarantee.');
  }
  lines.push('', `LAST RECORDED TEST SUITE: ${JSON.stringify(feed.lastSuite)}`);
  lines.push('', `LANDED: ${JSON.stringify(feed.landed)}`);
  lines.push('', `IN FLIGHT (uncommitted): ${JSON.stringify(feed.inFlight)}`);
  lines.push('', `LANE VERDICTS IN WINDOW: ${JSON.stringify(feed.concluded)}`);
  lines.push('', `COULD NOT DETERMINE: ${JSON.stringify(feed.unknown)}`);
  lines.push('', `FEED BUDGET: ${JSON.stringify(feed.budget)}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  let options;
  try { options = parseArgs(process.argv); }
  catch (error) {
    process.stderr.write(`${error.code || 'RECENT_WORK_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const feed = collectRecentWork({
    root: path.resolve(options.project),
    scope: options.scope,
    ...(options.hours === undefined ? {} : { windowHours: options.hours })
  });
  process.stdout.write(options.json ? `${JSON.stringify(feed, null, 2)}\n` : render(feed));
}

if (require.main === module) main();

module.exports = Object.freeze({ parseArgs, render, usage });
