'use strict';

// Focused owner-alert contract tests. Every owner channel is injected: this
// file must never write to the live owner journal.
require('./lib/isolated-environment').activate('owner-alert');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ownerChat = require('../src/lib/owner-chat');
const ownerAlert = require('../tools/owner-alert');

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `toolsenabled-owner-alert-${label}-`));
  return { root, chatFile: path.join(root, 'owner-chat.json'), inboxFile: path.join(root, 'owner-directive-inbox.json') };
}

function io() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    streams: {
      stdout: { write: value => { output.stdout += value; } },
      stderr: { write: value => { output.stderr += value; } }
    }
  };
}

(async () => {
  // A confirmed message id is the only condition that permits a sent claim,
  // and the shared owner-chat transcript shows proactive outbound messages.
  {
    const test = fixture('delivered');
    const capture = io();
    const textFile = path.join(test.root, 'status.txt');
    fs.writeFileSync(textFile, 'Bridge healthy\nreply observer armed\n', 'utf8');
    let sent = null;
    try {
      const code = await ownerAlert.main(['--text-file', textFile, '--actor', 'w6', '--kind', 'status'], {
        sendToOwner: async payload => { sent = payload; return { messageId: 'message test/566:opaque' }; }
      }, { chatFile: test.chatFile }, capture.streams);
      assert.equal(code, 0);
      assert.deepEqual(sent, { text: 'Bridge healthy\nreply observer armed' },
        '--text-file must preserve multi-line text apart from one editor trailing newline');
      assert.match(capture.output.stdout, /message "message test\/566:opaque"/);

      const log = ownerChat.readChatLog(test.chatFile);
      assert.equal(log.entries.length, 1);
      assert.equal(log.entries[0].kind, 'status');
      assert.equal(log.entries[0].state, 'sent');
      assert.equal(log.entries[0].messageId, 'message test/566:opaque');
      const transcript = ownerChat.transcript({}, { chatFile: test.chatFile, inboxFile: test.inboxFile });
      assert.equal(transcript.items.length, 1);
      assert.equal(transcript.items[0].status, 'sent');
      assert.equal(transcript.items[0].text, sent.text);
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  // A channel failure must be durably failed and surface its bounded code at
  // the CLI boundary. It must never be rendered as a delivered transcript row.
  {
    const test = fixture('failed');
    const capture = io();
    const failure = new Error('network unavailable');
    failure.code = 'OWNER_ALARM_REFUSED';
    try {
      const code = await ownerAlert.main(['--text', 'Bridge poller stopped'], {
        sendToOwner: async () => { throw failure; }
      }, { chatFile: test.chatFile }, capture.streams);
      assert.equal(code, 1, 'delivery failure exits non-zero');
      assert.match(capture.output.stderr, /OWNER_ALARM_REFUSED/,
        'the CLI must report the owner-channel error code');
      const log = ownerChat.readChatLog(test.chatFile);
      assert.equal(log.entries.length, 1);
      assert.equal(log.entries[0].state, 'failed');
      assert.equal(log.entries[0].error, 'OWNER_ALARM_REFUSED');
      assert.equal(log.entries[0].messageId, null);
      const transcript = ownerChat.transcript({}, { chatFile: test.chatFile, inboxFile: test.inboxFile });
      assert.equal(transcript.items[0].status, 'failed');
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  // Numeric receipts are retained only while reading historical state. A new
  // send must return a bounded opaque id before the CLI can claim delivery.
  {
    const test = fixture('numeric-receipt');
    const capture = io();
    try {
      const code = await ownerAlert.main(['--text', 'Bridge healthy'], {
        sendToOwner: async () => ({ messageId: 566 })
      }, { chatFile: test.chatFile }, capture.streams);
      assert.equal(code, 1);
      assert.match(capture.output.stderr, /OWNER_CHAT_DELIVERY_UNCONFIRMED/);
      const log = ownerChat.readChatLog(test.chatFile);
      assert.equal(log.entries[0].state, 'failed');
      assert.equal(log.entries[0].error, 'OWNER_CHAT_DELIVERY_UNCONFIRMED');
      assert.equal(log.entries[0].messageId, null);
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  // Reuse owner-chat's outbound credential detector before creating an intent
  // or touching the bridge transport.
  {
    const test = fixture('sensitive');
    const capture = io();
    let touchedTransport = false;
    try {
      const code = await ownerAlert.main(['--text', 'api_key=not-for-chat'], {
        sendToOwner: async () => { touchedTransport = true; return { messageId: 'message-test-sensitive' }; }
      }, { chatFile: test.chatFile }, capture.streams);
      assert.equal(code, 1);
      assert.equal(touchedTransport, false, 'credential-shaped text must never reach the bridge');
      assert.match(capture.output.stderr, /OWNER_CHAT_LOOKS_SENSITIVE/);
      assert.equal(fs.existsSync(test.chatFile), false, 'a refused credential must not be written to the transcript');
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  // A supplied --actor must not collapse a missing or empty value into the
  // default actor and report a successful delivery.
  {
    const capture = io();
    let touchedTransport = false;
    const code = await ownerAlert.main(['--text', 'Bridge healthy', '--actor'], {
      sendToOwner: async () => { touchedTransport = true; return { messageId: 'message-test-missing-actor' }; }
    }, {}, capture.streams);
    assert.equal(code, 2, 'a missing --actor value must be refused');
    assert.equal(touchedTransport, false);
    assert.match(capture.output.stderr, /--actor needs a value/);
  }

  {
    const capture = io();
    let touchedTransport = false;
    const code = await ownerAlert.main(['--text', 'Bridge healthy', '--actor', ''], {
      sendToOwner: async () => { touchedTransport = true; return { messageId: 'message-test-empty-actor' }; }
    }, {}, capture.streams);
    assert.equal(code, 1, 'an empty --actor value must be refused');
    assert.equal(touchedTransport, false);
    assert.match(capture.output.stderr, /OWNER_CHAT_INVALID/);
  }

  console.log('Owner alert tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
