#!/usr/bin/env node
'use strict';

// recall -- ask every knowledge source you have enabled, once, and get an
// answer that is honest about what it did not look at.
//
//   node tools/recall.js "spend cap"
//   node tools/recall.js --json --limit 12 "purchase list"
//
// EXIT CODES ARE THE POINT OF THIS FILE.
//
//   0  FOUND     something matched, and it is cited below.
//   2  USAGE     you did not give it a topic.
//   3  MISS      every registered source was enabled, read IN FULL, and
//                genuinely contains nothing about this.
//   4  UNKNOWN   a source could not be read, or one is switched off, so this
//                run cannot claim the topic is unexplored.
//   5  WITHHELD  the surface is off in your settings. Nothing was searched.
//
// tools/grepsaver-orient.js used to exit 0 while printing "No carded system
// matched" -- including for "trademark", with six trademark documents sitting
// in docs/ -- and exit 0 is what every caller reads as "fine, nothing to see".
// The fleet redid four nights of work on the strength of it. So nothing here
// exits 0 unless something was actually found, and a build chain that consumes
// this status gets a different number for "nothing exists" than for "I could
// not look" than for "you switched me off".
//
// NEVER READ THIS STATUS THROUGH A PIPE. `node tools/recall.js x | tail`
// reports TAIL's status, not this one.

const { recall, RECALL_EXIT } = require('./retrieval');

const USAGE = 'usage: node tools/recall.js [--json] [--limit N] "<topic>"\n';

function parseArgv(argv) {
  const args = argv.slice(2);
  const words = [];
  let asJson = false;
  let limit = 8;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') { asJson = true; continue; }
    if (arg === '--limit') {
      const rawLimit = args[index + 1];
      const requestedLimit = Number(rawLimit);
      if (rawLimit === undefined || !Number.isInteger(requestedLimit)
        || requestedLimit < 1 || requestedLimit > 25) {
        return { error: '--limit must be an integer from 1 through 25' };
      }
      limit = requestedLimit;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { help: true, words, asJson, limit };
    words.push(arg);
  }
  return { help: false, words, asJson, limit };
}

function renderMarkdown(packet) {
  const out = [];
  out.push(`# Recall: ${packet.topic}`);
  out.push('');

  if (packet.outcome === 'withheld') {
    out.push(`**WITHHELD.** ${packet.why}`);
    out.push('');
    out.push(`Turn it on at \`${packet.settingsGate.surface.settingId}\`` +
      (packet.settingsGate.valuesPath ? ` (settings file: \`${packet.settingsGate.valuesPath}\`).` : '.'));
    out.push('');
    return out.join('\n');
  }

  if (packet.outcome === 'hit') {
    out.push(`**${packet.results.length} result(s).** ${packet.why}`);
  } else if (packet.outcome === 'miss') {
    out.push(`**MISS -- a genuine gap.** ${packet.why}`);
  } else {
    out.push(`**UNKNOWN -- this run cannot answer.** ${packet.why}`);
  }
  out.push('');

  if (packet.results.length) {
    out.push('## Results');
    for (const result of packet.results) {
      out.push(`- \`${result.locator}\` (${result.source}, score ${result.score} on the ${result.scoreScale} scale)`);
      if (result.title) out.push(`  ${result.title}`);
      if (result.snippet) out.push(`  > ${String(result.snippet).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    out.push('');
  }

  out.push('## Sources');
  for (const source of packet.sources) {
    if (source.state === 'read') {
      out.push(`- \`${source.id}\` READ (${source.documentsConsulted} record(s))`
        + (source.delegatedTo ? ` via ${source.delegatedTo}` : ''));
    } else {
      out.push(`- \`${source.id}\` **${source.state.toUpperCase()}** (${source.code}) -- ${source.why}`);
    }
  }
  out.push('');

  if (packet.ranking && packet.ranking.state !== 'active') {
    out.push(`_Ranking: ${packet.ranking.why}_`);
    out.push('');
  }
  if (packet.ranking && packet.ranking.contractViolation) {
    out.push(`**Re-ranking backend refused:** ${packet.ranking.contractViolation}`);
    out.push('');
  }
  if (packet.index && packet.index.storage === 'memory') {
    out.push(`_Index: ${packet.index.why}_`);
    out.push('');
  }
  if (packet.settingsGate.rejected.length) {
    out.push('**Some of your retrieval settings were refused:**');
    for (const rejection of packet.settingsGate.rejected) out.push(`- \`${rejection.id}\`: ${rejection.reason}`);
    out.push('');
  }
  out.push(`> ${packet.trust}`);
  return out.join('\n');
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${USAGE}`);
    process.exitCode = RECALL_EXIT.USAGE;
    return;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exitCode = RECALL_EXIT.USAGE;
    return;
  }
  const topic = parsed.words.join(' ').trim();
  if (!topic) {
    process.stderr.write(USAGE);
    process.exitCode = RECALL_EXIT.USAGE;
    return;
  }
  const packet = recall(topic, { limit: parsed.limit });
  if (parsed.asJson) process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  else process.stdout.write(`${renderMarkdown(packet)}\n`);
  process.exitCode = packet.exitCode;
}

if (require.main === module) main(process.argv);

module.exports = { main, parseArgv, renderMarkdown };
