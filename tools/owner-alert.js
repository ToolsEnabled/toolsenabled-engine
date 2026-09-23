#!/usr/bin/env node
'use strict';

// Explicit proactive owner communication. Unlike owner-chat --reply this has
// no inbound directive id, but it uses owner-chat.alert() so delivery gets the
// exact same durable intent -> confirmed-send record and the same injected,
// bounded owner channel.
//
//   node tools/owner-alert.js --text "..." [--actor <name>] [--kind alert|status]
//   node tools/owner-alert.js --text-file <path> [--actor <name>] [--kind alert|status]
//
// --text-file exists because PowerShell quoting mangles long or multi-line
// text, and an owner alert is not something to let a shell rewrite. The file
// is read as UTF-8 and used byte-for-byte apart from a single trailing newline,
// which text editors commonly add.

const fs = require('node:fs');
const ownerChat = require('../src/lib/owner-chat');

const MAX_TEXT_FILE_BYTES = 64 * 1024;

function parseArgs(argv) {
  const options = { text: null, textFile: null, actor: null, kind: 'alert', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--text') options.text = argv[++index];
    else if (arg === '--text-file') options.textFile = argv[++index];
    else if (arg === '--actor') options.actor = argv[++index];
    else if (arg === '--kind') options.kind = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `Unknown argument ${arg}` };
  }
  if (options.help) return options;
  if (options.text === null && options.textFile === null) {
    return { error: 'owner-alert needs --text "..." or --text-file <path>' };
  }
  if (options.text !== null && options.textFile !== null) {
    return { error: 'pass either --text or --text-file, not both' };
  }
  if (options.actor === undefined) {
    return { error: '--actor needs a value' };
  }
  if (!['alert', 'status'].includes(options.kind)) {
    return { error: '--kind must be alert or status' };
  }
  return options;
}

function usage() {
  return [
    'Owner alert -- proactively send an audited alert/status to the owner.',
    '',
    'This command requires an explicitly configured owner sender. Without one it refuses',
    'with OWNER_CHAT_NO_TRANSPORT rather than appearing to send. The message is NOT queued.',
    '',
    '  node tools/owner-alert.js --text "..."       [--actor name] [--kind alert|status]',
    '  node tools/owner-alert.js --text-file <path> [--actor name] [--kind alert|status]',
    '',
    '--text-file preserves multi-line text against PowerShell quoting; it reads UTF-8 and removes one trailing newline.',
    'A message is reported delivered only after the transport returns a message id. Credential-shaped text is refused before any send.'
  ].join('\n');
}

function readTextFile(file) {
  const stats = fs.statSync(file);
  if (stats.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`${file} is ${stats.size} bytes; an owner alert is at most ${ownerChat.MAX_REPLY_LENGTH} characters.`);
  }
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

async function main(argv = process.argv.slice(2), dependencies = {}, overrides = {}, io = process) {
  const options = parseArgs(argv);
  if (options.error) {
    io.stderr.write(`${options.error}\n\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const text = options.textFile === null ? options.text : readTextFile(options.textFile);
    const request = { text, kind: options.kind };
    if (options.actor !== null) request.actor = options.actor;
    const result = await ownerChat.alert(request, dependencies, overrides);
    io.stdout.write(`Delivered owner ${result.kind} (message ${JSON.stringify(result.messageId)}).\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`owner-alert: ${error && error.code ? error.code : 'ERROR'}: ${error && error.message ? error.message : 'failed'}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`owner-alert failed: ${error && error.message ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { MAX_TEXT_FILE_BYTES, main, parseArgs, readTextFile, usage };
