#!/usr/bin/env node
'use strict';

// CLI for the owner chat loop. See src/lib/owner-chat.js for the design rules;
// this file is presentation plus argument parsing.
//
//   node tools/owner-chat.js --pending          THE DRAIN CALL. Run it on every
//                                               wake. Unread owner messages,
//                                               oldest first, verbatim, with
//                                               how long each has been waiting.
//   node tools/owner-chat.js --pending --json   the same, machine-readable
//   node tools/owner-chat.js --pending --include-machine
//                                               explicit maintenance view
//   node tools/owner-chat.js --status           counts + condition only (cheap)
//   node tools/owner-chat.js --transcript       both directions, ordered
//
//   node tools/owner-chat.js --reply <directive-id> --text "..."
//   node tools/owner-chat.js --reply <directive-id> --text-file <path>
//        [--also <directive-id>]...  [--actor <name>]
//
//   node tools/owner-chat.js --ack <directive-id> --note "why"  [--actor <name>]
//        for MACHINE-generated directives only; it refuses on anything the
//        owner actually sent, because those get answered, not filed.
//
// --text-file exists because PowerShell quoting mangles long or multi-line
// text, and a reply to the owner is not something to let a shell rewrite. The
// file is read as UTF-8 and used byte-for-byte apart from a single trailing
// newline, which text editors add and a message surface would render as blank space.
//
// This process starts no child processes and opens no windows.

const fs = require('node:fs');
const ownerChat = require('../src/lib/owner-chat');

const MAX_TEXT_FILE_BYTES = 64 * 1024;

function parseArgs(argv) {
  const options = {
    mode: null, json: false, limit: null,
    id: null, text: null, textFile: null, note: null,
    actor: null, also: [], includeMachine: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pending' || arg === '--drain') options.mode = options.mode || 'pending';
    else if (arg === '--status') options.mode = options.mode || 'status';
    else if (arg === '--transcript') options.mode = options.mode || 'transcript';
    else if (arg === '--reply') { options.mode = 'reply'; options.id = argv[++index]; }
    else if (arg === '--ack') { options.mode = 'ack'; options.id = argv[++index]; }
    else if (arg === '--text') options.text = argv[++index];
    else if (arg === '--text-file') options.textFile = argv[++index];
    else if (arg === '--note') options.note = argv[++index];
    else if (arg === '--actor') options.actor = argv[++index];
    else if (arg === '--also') options.also.push(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--include-machine') options.includeMachine = true;
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else return { error: `Unknown argument ${arg}` };
  }
  if (!options.mode) options.mode = 'pending';
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    return { error: '--limit must be a positive integer' };
  }
  if (options.mode === 'reply') {
    if (!options.id) return { error: '--reply needs a directive id' };
    if (options.text === null && options.textFile === null) {
      return { error: '--reply needs --text "..." or --text-file <path>' };
    }
    if (options.text !== null && options.textFile !== null) {
      return { error: 'pass either --text or --text-file, not both' };
    }
  }
  if (options.mode === 'ack') {
    if (!options.id) return { error: '--ack needs a directive id' };
    if (!options.note) return { error: '--ack needs --note "why this needed no reply"' };
  }
  if (options.also.some(id => !id)) return { error: '--also needs a directive id' };
  return options;
}

function usage() {
  return [
    'Owner chat -- drain the owner directive inbox, and reply to what is in it.',
    '',
    'READING STILL WORKS. --pending, --status and --transcript read durable state and are',
    'unaffected. REPLYING requires an explicitly configured reply-capable owner channel,',
    'so --reply refuses with OWNER_CHAT_NO_TRANSPORT when this CLI has none.',
    '--ack, which acknowledges without replying, still works.',
    '',
    '  node tools/owner-chat.js --pending                 THE DRAIN CALL; run on every wake',
    '  node tools/owner-chat.js --pending --json          machine-readable',
    '  node tools/owner-chat.js --pending --include-machine  explicit maintenance backlog',
    '  node tools/owner-chat.js --status                  condition + counts only',
    '  node tools/owner-chat.js --transcript [--limit N]  both directions, ordered',
    '',
    '  node tools/owner-chat.js --reply <id> --text "..."            [--also <id>] [--actor name]',
    '  node tools/owner-chat.js --reply <id> --text-file <path>      [--also <id>] [--actor name]',
    '  node tools/owner-chat.js --ack   <id> --note "why"            [--actor name]',
    '',
    'A reply is SENT first and the directive is acknowledged only after the transport',
    'accepts it, so a failure can never mark the owner as answered when he was not.',
    '--ack is for machine-generated directives only; it refuses anything he sent.'
  ].join('\n');
}

function stamp(ms) {
  return Number.isSafeInteger(ms) ? new Date(ms).toISOString() : 'never';
}

// The owner's words are reproduced VERBATIM. They are indented for readability
// but not trimmed, rewrapped, or normalized -- every character he typed is on
// screen, including the ones he would not have chosen.
function quote(text) {
  return String(text).split('\n').map(line => `    | ${line}`).join('\n');
}

function renderPending(result) {
  const lines = [];
  const loud = result.condition === ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY;
  if (loud) {
    lines.push('='.repeat(78));
    lines.push(result.headline);
    lines.push('='.repeat(78));
  } else {
    lines.push(result.headline);
  }
  lines.push(`condition=${result.condition}  unread=${result.unread}  fromOwner=${result.ownerUnread}  mechanical=${result.mechanicalUnread}  lastDrained=${stamp(result.lastDrainedAtMs)}${result.lastDrainedBy ? ` by ${result.lastDrainedBy}` : ''}`);

  if (result.items.length === 0) {
    lines.push('');
    lines.push(result.suppressedMachineUnread > 0
      ? `No direct owner message is unread. ${result.suppressedMachineUnread} machine-generated directive(s) remain quiet; use --include-machine only for maintenance.`
      : 'Nothing unread.');
    return lines.join('\n');
  }

  for (const [index, item] of result.items.entries()) {
    lines.push('');
    const flags = [
      item.fromOwner ? 'FROM THE OWNER' : `source ${item.source}`,
      `waiting ${ownerChat.humanDuration(item.ageMs)}`,
      item.stale ? 'STALE' : null,
      item.alreadyDelivered ? 'A REPLY WAS ALREADY DELIVERED FOR THIS' : null,
      item.replyAttempts > 0 && !item.alreadyDelivered ? `${item.replyAttempts} previous reply attempt(s), last ${item.lastReplyState}` : null
    ].filter(Boolean);
    lines.push(`${index + 1}. ${item.id}`);
    lines.push(`   ${flags.join('  |  ')}   (${stamp(item.createdAtMs)})`);
    lines.push(quote(item.text));
  }

  if (result.truncated) {
    lines.push('');
    lines.push(`(more unread beyond the first ${result.limit}; re-run with --limit)`);
  }
  if (result.deliveredButUnacknowledged.length) {
    lines.push('');
    lines.push('DELIVERED BUT NOT ACKNOWLEDGED -- a reply reached the owner and the acknowledgement did not land.');
    lines.push('Do not re-send these; acknowledge them or investigate:');
    for (const entry of result.deliveredButUnacknowledged) {
      lines.push(`  #${entry.sequence} ${entry.directiveId} state=${entry.state} messageId=${entry.messageId} error=${entry.error || 'none'}`);
    }
  }

  // Suggest the RIGHT verb per item: his own messages get answered, machine
  // directives get filed with a reason. Offering --reply on a system-generated
  // status record would send him a message about his own scheduled task,
  // which is noise, not a conversation.
  const fromOwner = result.items.filter(item => item.fromOwner);
  const machine = result.items.filter(item => !item.fromOwner);
  lines.push('');
  if (fromOwner.length) {
    lines.push('ANSWER HIM (this SENDS to his phone, then acknowledges):');
    lines.push(`  node tools/owner-chat.js --reply ${fromOwner[0].id} --text "..."`);
    if (fromOwner.length > 1) {
      lines.push(`  ...answer all ${fromOwner.length} of his messages with one send by appending:`);
      for (const item of fromOwner.slice(1)) lines.push(`      --also ${item.id}`);
    }
  }
  if (machine.length) {
    lines.push('');
    lines.push('File the machine-generated ones once actioned (sends nothing):');
    lines.push(`  node tools/owner-chat.js --ack ${machine[0].id} --note "what you did about it"`);
  }
  return lines.join('\n');
}

function renderStatus(summary) {
  return [
    summary.headline,
    `condition=${summary.condition}`,
    `unread=${summary.unread}  fromOwner=${summary.ownerUnread}  mechanical=${summary.mechanicalUnread}`,
    `oldestOwnerUnread=${stamp(summary.oldestOwnerUnreadAtMs)}  waiting=${summary.waitingMs === null ? 'n/a' : ownerChat.humanDuration(summary.waitingMs)}  staleAfter=${ownerChat.humanDuration(summary.staleThresholdMs)}`,
    `lastDrained=${stamp(summary.lastDrainedAtMs)}${summary.lastDrainedBy ? ` by ${summary.lastDrainedBy}` : ''}`,
    summary.error ? `error=${summary.error}` : null
  ].filter(Boolean).join('\n');
}

function renderTranscript(result) {
  if (result.items.length === 0) return 'No messages in either direction yet.';
  const lines = [`Transcript -- ${result.items.length} of ${result.total} message(s), oldest first.`];
  for (const item of result.items) {
    lines.push('');
    const who = { owner: 'OWNER ', system: 'system', note: 'note  ', controller: 'me    ' }[item.direction] || item.direction;
    lines.push(`[${stamp(item.atMs)}] ${who} (${item.status})`);
    lines.push(quote(item.text));
  }
  return lines.join('\n');
}

function readTextFile(file) {
  const stats = fs.statSync(file);
  if (stats.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`${file} is ${stats.size} bytes; an owner reply is at most ${ownerChat.MAX_REPLY_LENGTH} characters.`);
  }
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.error) {
    process.stderr.write(`${options.error}\n\n${usage()}\n`);
    return 2;
  }
  if (options.mode === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    if (options.mode === 'status') {
      const summary = ownerChat.summarize();
      process.stdout.write(`${options.json ? JSON.stringify(summary, null, 2) : renderStatus(summary)}\n`);
      return summary.condition === ownerChat.CONDITIONS.UNAVAILABLE ? 2 : 0;
    }

    if (options.mode === 'transcript') {
      const result = ownerChat.transcript(options.limit === null ? {} : { limit: options.limit });
      process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : renderTranscript(result)}\n`);
      return 0;
    }

    if (options.mode === 'pending') {
      const request = { stamp: true };
      if (options.includeMachine) request.includeMachine = true;
      if (options.limit !== null) request.limit = options.limit;
      if (options.actor) request.actor = options.actor;
      const result = ownerChat.pending(request);
      process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : renderPending(result)}\n`);
      return result.condition === ownerChat.CONDITIONS.UNAVAILABLE ? 2 : 0;
    }

    if (options.mode === 'reply') {
      const text = options.textFile === null ? options.text : readTextFile(options.textFile);
      const request = { id: options.id, text };
      if (options.actor) request.actor = options.actor;
      if (options.also.length) request.alsoAcknowledge = options.also;
      const result = await ownerChat.reply(request);
      const report = {
        delivered: result.delivered,
        messageId: result.messageId,
        sentAt: stamp(result.sentAtMs),
        acknowledged: result.acknowledged,
        acknowledgedBy: result.acknowledgedBy,
        ackFailures: result.ackFailures
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`Delivered to the owner's pinned chat (message ${result.messageId === null ? 'id unknown' : result.messageId}) at ${report.sentAt}.\n`);
        process.stdout.write(`Acknowledged: ${result.acknowledged.join(', ') || 'none'}\n`);
        if (result.ackFailures.length) {
          process.stdout.write(`WARNING: delivered, but these acknowledgements failed and stay unread: ${result.ackFailures.map(f => `${f.id} (${f.code})`).join(', ')}\n`);
        }
      }
      return result.ackFailures.length ? 4 : 0;
    }

    if (options.mode === 'ack') {
      const request = { id: options.id, note: options.note };
      if (options.actor) request.actor = options.actor;
      const result = ownerChat.acknowledgeWithoutReply(request);
      process.stdout.write(options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Acknowledged ${result.id} with a note; nothing was sent.\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`owner-chat: ${error.code || 'ERROR'}: ${error.message}\n`);
    return 1;
  }

  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`owner-chat failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, renderPending, renderStatus, renderTranscript, usage };
