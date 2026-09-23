// EXECUTABLE CHANGE
// testcanfail-tests-owner-chat-js
//
// Strengthened assertion: fleet-supervisor --status ownerChat.condition.
// Mutation: tools/fleet-supervisor.js temporarily replaced the summarized
// condition with ownerChat.CONDITIONS.UNAVAILABLE. Before this change the test
// remained green: "Owner chat tests passed." After this change it went RED:
// "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
// + actual - expected
//
// + 'UNAVAILABLE'
// - 'CLEAR'"
// The product file was then restored byte-for-byte (matching SHA-256
// fefa78a46be66acdb74ee216af3eb5ea58173be170ffffc403de87e54273ee76), and
// the green confirmation was: "Owner chat tests passed."
//
// NOT-FOUND (1): all loop/forEach assertion bodies have provably non-empty
// inputs constructed in their tests; none can pass because its input is empty.
// NOT-FOUND (2): there are no exit-status or truthy-process-return assertions.
// NOT-FOUND (3): there are no try/catch or optional-chain failure swallows.
// NOT-FOUND (4): mocks supply external send/ack boundaries, while assertions
// verify owner-chat state, ordering, persistence, and validation—not the mocks.
// NOT-FOUND (5): there are no skips or platform precondition guards.
// NOT-FOUND (6), except the strengthened assertion below: no other expected
// value is computed by the same behavior that it checks.
// Preconditions: all met; the direct Node test command and fleet-supervisor
// subprocess were runnable on this platform.

'use strict';

// Owner chat loop tests (the drain + reply half of the directive inbox).
// Plain `node tests/owner-chat.js`. No network anywhere: sendToOwner and the
// acknowledgement are injected, and every file lives in a scratch directory.
//
// The failure these exist to prevent is specific and already happened: the
// owner sent three Telegram messages, got three acks from the bridge, and
// never got a reply, because nothing drained the inbox. So the load-bearing
// assertions here are the ordering one (send strictly before acknowledge),
// the failure one (a delivery failure leaves him visibly waiting), and the
// verbatim one (his exact bytes survive the round trip to the screen).

require('./lib/isolated-environment').activate('owner-chat');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inbox = require('../src/lib/owner-directive-inbox');
const ownerChat = require('../src/lib/owner-chat');
const ownerChatCli = require('../tools/owner-chat.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-chat-'));
let caseIndex = 0;
function freshFiles() {
  caseIndex += 1;
  const dir = path.join(root, `case-${caseIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  return { inboxFile: path.join(dir, 'inbox.json'), chatFile: path.join(dir, 'chat.json') };
}

function fixedClock(startMs) {
  let value = startMs;
  const clock = () => value;
  clock.advance = ms => { value += ms; };
  clock.set = ms => { value = ms; };
  return clock;
}

// The owner's three real messages, byte-for-byte, plus the machine-generated
// auto-resume directive that sits alongside them in the live inbox.
const OWNER_MESSAGES = Object.freeze([
  'if you need more terra agents to speed up the reviews (it looks like a lot is stuck in review) you can do that. chat to me here for now',
  'you should be able to respond to me here like a chat basically please enable',
  'when you do enable this chat for yourself please respond'
]);

function seedOwnerInbox(overrides, { count = 3 } = {}) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(inbox.append({
      text: OWNER_MESSAGES[index % OWNER_MESSAGES.length],
      source: 'telegram',
      submittedBy: 'owner-telegram',
      idempotencyKey: `telegram:update:${1000 + index}`
    }, overrides).id);
  }
  return ids;
}

// Write the inbox directly when a test needs EXACT timestamps (the age and
// staleness assertions do). append() stamps Date.now() and cannot be clocked.
function seedInboxAt(files, specs) {
  const items = specs.map((spec, index) => ({
    id: `owner-directive-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    text: spec.text,
    status: spec.status || 'unread',
    source: spec.source || 'telegram',
    submittedBy: spec.submittedBy || 'owner-telegram',
    idempotencyKey: null,
    createdAtMs: spec.atMs,
    updatedAtMs: spec.atMs,
    acknowledgedAtMs: null,
    acknowledgedBy: null
  }));
  fs.writeFileSync(files.inboxFile,
    `${JSON.stringify({ version: inbox.VERSION, nextSequence: items.length + 1, items, events: [] }, null, 2)}\n`,
    'utf8');
  return items.map(item => item.id);
}

async function run() {
  // -------------------------------------------------------------------------
  // 1. pending(): unread only, oldest-first, bounded, honest counts
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const machine = inbox.append({
      text: 'Owner step complete: something mechanical.',
      source: 'dashboard', submittedBy: 'system-observer'
    }, files);
    const ids = seedOwnerInbox(files);

    // By default, pending() surfaces only the owner's own unread messages --
    // machine-generated directives stay quiet unless includeMachine is asked
    // for. The COUNTS (unread/ownerUnread/mechanicalUnread) stay honest
    // either way; only the returned item LIST is filtered.
    const ownerOnly = ownerChat.pending({}, files);
    assert.equal(ownerOnly.items.length, 3);
    assert.deepEqual(ownerOnly.items.map(item => item.id), ids);
    assert.equal(ownerOnly.unread, 4);
    assert.equal(ownerOnly.ownerUnread, 3);
    assert.equal(ownerOnly.mechanicalUnread, 1);
    assert.equal(ownerOnly.suppressedMachineUnread, 1,
      'the suppressed-machine count must say how many were hidden by default');
    assert.equal(ownerOnly.truncated, false);

    const all = ownerChat.pending({ includeMachine: true }, files);
    assert.equal(all.items.length, 4);
    assert.deepEqual(all.items.slice(0, 3).map(item => item.id), ids,
      'pending() must put Telegram owner messages ahead of machine directives');
    assert.equal(all.items[3].id, machine.id);
    assert.equal(all.items[0].fromOwner, true);
    assert.equal(all.items[3].fromOwner, false, 'a machine-generated directive is not the owner waiting');
    assert.equal(all.unread, 4);
    assert.equal(all.ownerUnread, 3);
    assert.equal(all.suppressedMachineUnread, 0, 'nothing is suppressed once includeMachine is set');
    assert.equal(all.truncated, false);

    const bounded = ownerChat.pending({ limit: 2 }, files);
    assert.equal(bounded.items.length, 2, 'limit must bound the returned items');
    assert.equal(bounded.truncated, true, 'a bounded read must say it was bounded');
    assert.equal(bounded.unread, 4, 'the COUNT must stay honest even when the list is bounded');
    assert.equal(bounded.items[0].id, ids[0]);

    assert.throws(() => ownerChat.pending({ limit: 0 }, files), error => error.code === 'OWNER_CHAT_INVALID');
    assert.throws(() => ownerChat.pending({ limit: 9999 }, files), error => error.code === 'OWNER_CHAT_INVALID');
    assert.throws(() => ownerChat.pending({ nope: 1 }, files), error => error.code === 'OWNER_CHAT_INVALID');
    assert.throws(() => ownerChat.pending({ includeMachine: 'yes' }, files), error => error.code === 'OWNER_CHAT_INVALID');

    // The suggested next command must offer --reply for HIS messages and --ack
    // for the machine-generated one. Suggesting --reply on a system-generated
    // status record would Telegram him about his own scheduled task.
    const rendered = ownerChatCli.renderPending(all);
    assert.ok(rendered.includes(`--reply ${ids[0]} --text`), 'the reply suggestion must target his oldest message');
    assert.ok(!rendered.includes(`--reply ${machine.id}`), 'a machine directive must never be offered as a reply target');
    assert.ok(rendered.includes(`--ack ${machine.id} --note`), 'a machine directive must be offered the send-nothing verb');
    for (const id of ids.slice(1)) {
      assert.ok(rendered.includes(`--also ${id}`), 'every other owner message must be offered as an --also target');
    }
  }

  // -------------------------------------------------------------------------
  // 2. Verbatim preservation, byte-exact, all the way to the rendered screen
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const gnarly = '  keep EVERY word -- typos incl. "submitted" 100%\n\ttabbed line\ncafé — em dash  ';
    const appended = inbox.append({ text: gnarly, source: 'telegram', submittedBy: 'owner-telegram' }, files);
    const result = ownerChat.pending({}, files);
    assert.equal(Buffer.compare(Buffer.from(result.items[0].text, 'utf8'), Buffer.from(gnarly, 'utf8')), 0,
      'the owner\'s text must survive pending() byte-for-byte: no trim, no rewrap, no normalization');
    assert.equal(result.items[0].id, appended.id);

    // And through the human renderer: every original line must still be present
    // in full, only prefixed for readability.
    const rendered = ownerChatCli.renderPending(result);
    for (const line of gnarly.split('\n')) {
      assert.ok(rendered.includes(`| ${line}`), `rendered output dropped or altered the line ${JSON.stringify(line)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. reply(): sends BEFORE acknowledging, and acks carry delivery evidence
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    const order = [];
    const clock = fixedClock(1_800_000_000_000);
    let statusAtSendTime = null;

    const sendToOwner = async ({ text }) => {
      // The moment of truth: at send time the directive must still be UNREAD.
      statusAtSendTime = inbox.readInbox(files.inboxFile).items.find(item => item.id === ids[0]).status;
      order.push(`send:${text}`);
      return { channel: 'agent-comms', messageId: 'message-test-55501' };
    };
    const acknowledge = (input, overrides) => {
      order.push(`ack:${input.id}`);
      return inbox.acknowledge(input, overrides);
    };

    const result = await ownerChat.reply(
      { id: ids[0], text: 'Enabled. I can reply here now.', actor: 'controller' },
      { sendToOwner, acknowledge },
      { ...files, now: clock }
    );

    assert.equal(statusAtSendTime, 'unread', 'the directive must still be unread when the reply is put on the wire');
    assert.deepEqual(order, ['send:Enabled. I can reply here now.', `ack:${ids[0]}`],
      'reply() must send first and acknowledge second -- never the reverse');
    assert.equal(result.delivered, true);
    assert.equal(result.messageId, 'message-test-55501');
    assert.deepEqual([...result.acknowledged], ids);
    assert.equal(result.ackFailures.length, 0);

    // The acknowledgement itself carries the evidence: who, via what, and the
    // opaque owner-channel receipt that proves it was actually delivered.
    const acked = inbox.readInbox(files.inboxFile).items.find(item => item.id === ids[0]);
    assert.equal(acked.status, 'acknowledged');
    assert.match(acked.acknowledgedBy, /^controller via owner-chat reply receipt-[a-f0-9]{24}$/);
    assert.equal(result.acknowledgedBy, acked.acknowledgedBy);

    // And the durable chat log carries the reply text verbatim, linked to the directive.
    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.entries.length, 1);
    assert.equal(chat.entries[0].directiveId, ids[0]);
    assert.equal(chat.entries[0].state, 'acknowledged');
    assert.equal(chat.entries[0].text, 'Enabled. I can reply here now.');
    assert.equal(chat.entries[0].messageId, 'message-test-55501');
    assert.ok(Number.isSafeInteger(chat.entries[0].sentAtMs));
    assert.ok(chat.entries[0].sentAtMs <= chat.entries[0].acknowledgedAtMs,
      'the recorded send time must never be after the recorded acknowledgement time');

    assert.equal(ownerChat.pending({}, files).condition, ownerChat.CONDITIONS.CLEAR);
  }

  // -------------------------------------------------------------------------
  // 4. Delivery failure leaves the directive UNREAD and records the failure
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    let ackCalls = 0;

    const failingSend = async () => {
      const error = new Error('owner journal refused');
      error.code = 'OWNER_ALARM_REFUSED';
      throw error;
    };
    await assert.rejects(
      () => ownerChat.reply(
        { id: ids[0], text: 'this never reaches him' },
        { sendToOwner: failingSend, acknowledge: () => { ackCalls += 1; } },
        files
      ),
      error => error.code === 'OWNER_CHAT_DELIVERY_FAILED'
    );

    assert.equal(ackCalls, 0, 'a failed delivery must not acknowledge anything');
    const live = inbox.readInbox(files.inboxFile).items.find(item => item.id === ids[0]);
    assert.equal(live.status, 'unread', 'a failed delivery must leave the owner visibly waiting');
    assert.equal(live.acknowledgedBy, null);

    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.entries.length, 1);
    assert.equal(chat.entries[0].state, 'failed', 'the failure must be recorded, not swallowed');
    assert.equal(chat.entries[0].error, 'OWNER_ALARM_REFUSED');
    assert.equal(chat.entries[0].sentAtMs, null);

    const still = ownerChat.pending({}, files);
    assert.equal(still.ownerUnread, 1);
    assert.equal(still.items[0].replyAttempts, 1);
    assert.equal(still.items[0].lastReplyState, 'failed');
    assert.equal(still.items[0].alreadyDelivered, false,
      'a failed send must NOT read as "already delivered" -- that would suppress the retry');
  }

  // -------------------------------------------------------------------------
  // 4b. A new numeric transport receipt is not current delivery evidence
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    let ackCalls = 0;
    await assert.rejects(
      () => ownerChat.reply(
        { id: ids[0], text: 'this receipt cannot confirm delivery' },
        { sendToOwner: async () => ({ messageId: 77 }), acknowledge: () => { ackCalls += 1; } },
        files
      ),
      error => error.code === 'OWNER_CHAT_DELIVERY_UNCONFIRMED'
    );
    assert.equal(ackCalls, 0);
    assert.equal(inbox.readInbox(files.inboxFile).items[0].status, 'unread');
    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.entries[0].state, 'failed');
    assert.equal(chat.entries[0].error, 'OWNER_CHAT_DELIVERY_UNCONFIRMED');
    assert.equal(chat.entries[0].messageId, null);
  }

  // -------------------------------------------------------------------------
  // 5. Delivered-but-unacknowledged is visible and never re-sent blindly
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    const brokenAck = () => { const e = new Error('busy'); e.code = 'OWNER_DIRECTIVE_INBOX_BUSY'; throw e; };

    const result = await ownerChat.reply(
      { id: ids[0], text: 'delivered but the ack will fail' },
      { sendToOwner: async () => ({ messageId: 'message-test-77' }), acknowledge: brokenAck },
      files
    );
    assert.equal(result.delivered, true, 'the send genuinely happened, so it must be reported as delivered');
    assert.equal(result.ackFailures.length, 1);
    assert.equal(result.ackFailures[0].code, 'OWNER_DIRECTIVE_INBOX_BUSY');

    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.entries[0].state, 'sent-unacknowledged');
    assert.equal(chat.entries[0].messageId, 'message-test-77');

    const view = ownerChat.pending({}, files);
    assert.equal(view.deliveredButUnacknowledged.length, 1,
      'a reply that reached him but was not acknowledged must be named, not hidden');
    assert.equal(view.items[0].alreadyDelivered, true,
      'the drain must warn that a reply already reached him, so he is not messaged twice');
    assert.ok(ownerChatCli.renderPending(view).includes('DELIVERED BUT NOT ACKNOWLEDGED'));
  }

  // -------------------------------------------------------------------------
  // 6. No double-ack, no double-send
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    let sends = 0;
    const send = async () => { sends += 1; return { messageId: `message-test-${900 + sends}` }; };

    await ownerChat.reply({ id: ids[0], text: 'first and only' }, { sendToOwner: send }, files);
    assert.equal(sends, 1);

    await assert.rejects(
      () => ownerChat.reply({ id: ids[0], text: 'second attempt' }, { sendToOwner: send }, files),
      error => error.code === 'OWNER_CHAT_ALREADY_ACKNOWLEDGED'
    );
    assert.equal(sends, 1, 'replying to an already-acknowledged directive must not put a second message on the wire');

    const acked = inbox.readInbox(files.inboxFile).items.find(item => item.id === ids[0]);
    assert.match(acked.acknowledgedBy, /^controller via owner-chat reply receipt-[a-f0-9]{24}$/,
      'the original acknowledgement must not be overwritten by a refused second attempt');

    await assert.rejects(
      () => ownerChat.reply({ id: 'owner-directive-00000000-0000-4000-8000-999999999999', text: 'ghost' }, { sendToOwner: send }, files),
      error => error.code === 'OWNER_CHAT_DIRECTIVE_NOT_FOUND'
    );
    assert.equal(sends, 1, 'an unknown directive must be refused BEFORE anything is sent');
  }

  // -------------------------------------------------------------------------
  // 7. One reply can answer several messages (his three, in one go)
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 3 });
    let sends = 0;

    const result = await ownerChat.reply(
      { id: ids[0], text: 'Answering all three.', alsoAcknowledge: [ids[1], ids[2]] },
      { sendToOwner: async () => { sends += 1; return { messageId: 'message-test-4242' }; } },
      files
    );
    assert.equal(sends, 1, 'answering three messages together must send exactly one message');
    assert.deepEqual([...result.acknowledged], ids);

    const live = inbox.readInbox(files.inboxFile);
    for (const id of ids) {
      const item = live.items.find(candidate => candidate.id === id);
      assert.equal(item.status, 'acknowledged');
      assert.match(item.acknowledgedBy, /^controller via owner-chat reply receipt-[a-f0-9]{24}$/,
        'every directive answered by one reply must point at that same delivered reply');
    }
    assert.equal(ownerChat.pending({}, files).condition, ownerChat.CONDITIONS.CLEAR);
  }

  // -------------------------------------------------------------------------
  // 8. The stale-unread condition surfaces, and only for the owner's messages
  // -------------------------------------------------------------------------
  {
    const base = 1_800_000_000_000;
    const clock = fixedClock(base);

    // Nothing at all.
    const empty = freshFiles();
    assert.equal(ownerChat.pending({}, { ...empty, now: clock }).condition, ownerChat.CONDITIONS.CLEAR);

    // A machine directive alone is NOT an owner waiting, however old it gets.
    const machineOnly = freshFiles();
    seedInboxAt(machineOnly, [{ text: 'System observation complete: mechanical.', source: 'dashboard', submittedBy: 'system-observer', atMs: base - 86_400_000 }]);
    let view = ownerChat.pending({}, { ...machineOnly, now: clock });
    assert.equal(view.condition, ownerChat.CONDITIONS.DIRECTIVES_UNREAD);
    assert.equal(view.ownerWaiting, false);
    assert.equal(view.ownerUnread, 0);

    // The owner speaks. Fresh: unread, but not yet the loud condition.
    const files = freshFiles();
    const [machineId, ownerId] = seedInboxAt(files, [
      { text: 'System observation complete: mechanical.', source: 'dashboard', submittedBy: 'system-observer', atMs: base - 5_000 },
      { text: OWNER_MESSAGES[1], atMs: base }
    ]);
    assert.ok(machineId && ownerId);
    view = ownerChat.pending({}, { ...files, now: clock });
    assert.equal(view.condition, ownerChat.CONDITIONS.OWNER_MESSAGE_UNREAD);
    assert.equal(view.ownerWaiting, false);
    assert.equal(view.items.find(item => item.id === ownerId).stale, false);

    // One second under the threshold: still not loud.
    clock.set(base + ownerChat.STALE_UNREAD_MS - 1000);
    assert.equal(ownerChat.pending({}, { ...files, now: clock }).condition, ownerChat.CONDITIONS.OWNER_MESSAGE_UNREAD);

    // At the threshold: LOUD.
    clock.set(base + ownerChat.STALE_UNREAD_MS);
    view = ownerChat.pending({}, { ...files, now: clock });
    assert.equal(view.condition, ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY);
    assert.equal(view.ownerWaiting, true);
    assert.equal(view.items.find(item => item.id === ownerId).stale, true);
    const allView = ownerChat.pending({ includeMachine: true }, { ...files, now: clock });
    assert.equal(allView.items.find(item => item.id === machineId).stale, false,
      'a machine directive must never be marked as an owner waiting, whatever its age');
    assert.ok(view.headline.includes('OWNER WAITING FOR A REPLY'), 'the loud condition must say so in words');
    assert.ok(view.headline.includes(ownerChat.DRAIN_COMMAND), 'the condition must always carry the command that fixes it');
    assert.ok(ownerChatCli.renderPending(view).startsWith('='),
      'the drain output must lead with the loud banner when the owner is waiting');

    // summarize() -- the cheap embedded view -- must agree exactly.
    const summary = ownerChat.summarize({ ...files, now: clock });
    assert.equal(summary.condition, ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY);
    assert.equal(summary.ownerWaiting, true);
    assert.equal(summary.ownerUnread, 1);
    assert.equal(summary.unread, 2);
    assert.equal(summary.waitingMs, ownerChat.STALE_UNREAD_MS);
  }

  // -------------------------------------------------------------------------
  // 8b. Telegram owner messages are never buried behind machine noise
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const base = 1_800_000_000_000;
    const clock = fixedClock(base + 10_000);
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push({
        text: `machine health event ${i}`,
        source: 'health-observer',
        submittedBy: 'health-observer',
        atMs: base + i + 1_000
      });
    }
    rows.push({ text: OWNER_MESSAGES[0], source: 'telegram', submittedBy: 'owner-telegram', atMs: base });
    const ids = seedInboxAt(files, rows);
    const ownerId = ids[ids.length - 1];
    const view = ownerChat.pending({ limit: 1 }, { ...files, now: clock });
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].id, ownerId,
      'the bounded default view must put a Telegram owner message ahead of newer machine noise');
    assert.equal(view.items[0].source, 'telegram');

    // The same ordering guarantee must hold even when machine noise is
    // explicitly included, not just because the default view hides it.
    const allView = ownerChat.pending({ limit: 1, includeMachine: true }, { ...files, now: clock });
    assert.equal(allView.items.length, 1);
    assert.equal(allView.items[0].id, ownerId,
      'with includeMachine set, the bounded view must still rank the Telegram owner message ahead of newer machine noise');
  }

  // -------------------------------------------------------------------------
  // 9. summarize() never throws, even on unreadable state
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    fs.writeFileSync(files.inboxFile, 'this is not json', 'utf8');
    const summary = ownerChat.summarize(files);
    assert.equal(summary.condition, ownerChat.CONDITIONS.UNAVAILABLE,
      'a surface that cannot look must say UNAVAILABLE, not pretend everything is fine');
    assert.ok(summary.headline.includes('UNAVAILABLE'));
    assert.equal(summary.ownerWaiting, false);
  }

  // -------------------------------------------------------------------------
  // 10. --ack is for machine directives only; it refuses the owner's own words
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const machine = inbox.append({
      text: 'System observation complete: mechanical.', source: 'dashboard', submittedBy: 'system-observer'
    }, files);
    const owner = inbox.append({ text: OWNER_MESSAGES[2], source: 'telegram', submittedBy: 'owner-telegram' }, files);

    const acked = ownerChat.acknowledgeWithoutReply(
      { id: machine.id, note: 'Resumed the vertex work this unblocked.' }, {}, files);
    assert.equal(acked.acknowledged, true);
    const live = inbox.readInbox(files.inboxFile).items.find(item => item.id === machine.id);
    assert.equal(live.status, 'acknowledged');
    assert.match(live.acknowledgedBy, /^controller via owner-chat ack \d+$/);
    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.entries[0].kind, 'ack');
    assert.equal(chat.entries[0].text, 'Resumed the vertex work this unblocked.',
      'an acknowledgement without a reply must still record WHY');
    assert.equal(chat.entries[0].messageId, null, '--ack must send nothing');

    assert.throws(
      () => ownerChat.acknowledgeWithoutReply({ id: owner.id, note: 'filing this' }, {}, files),
      error => error.code === 'OWNER_CHAT_NEEDS_A_REPLY'
    );
    assert.equal(
      inbox.readInbox(files.inboxFile).items.find(item => item.id === owner.id).status, 'unread',
      'the owner\'s own message must stay unread until it is actually answered');
    assert.throws(
      () => ownerChat.acknowledgeWithoutReply({ id: machine.id, note: '   ' }, {}, files),
      error => error.code === 'OWNER_CHAT_INVALID'
    );
  }

  // -------------------------------------------------------------------------
  // 11. Credential-shaped replies are refused before anything is sent
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    let sends = 0;
    await assert.rejects(
      () => ownerChat.reply(
        { id: ids[0], text: 'here it is, api_key: sk-ABCDEFGHIJKLMNOPQRSTUVWX' },
        { sendToOwner: async () => { sends += 1; return { messageId: 'message-test-sensitive' }; } },
        files
      ),
      error => error.code === 'OWNER_CHAT_LOOKS_SENSITIVE'
    );
    assert.equal(sends, 0, 'a credential-shaped reply must never reach the wire');
    assert.equal(ownerChat.readChatLog(files.chatFile).entries.length, 0,
      'a refused reply must not be written to the durable log either');
    assert.equal(inbox.readInbox(files.inboxFile).items[0].status, 'unread');
  }

  // -------------------------------------------------------------------------
  // 12. Threading: the merged transcript is the thread, no conversation ids
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const base = 1_800_000_000_000;
    const clock = fixedClock(base + 1000);
    const [firstId, secondId] = seedInboxAt(files, [
      { text: OWNER_MESSAGES[1], atMs: base },
      { text: 'great, how many terra agents are running?', atMs: base + 2000 }
    ]);

    await ownerChat.reply({ id: firstId, text: 'Enabled. Replying here now.' },
      { sendToOwner: async () => ({ messageId: 'message-test-10' }) }, { ...files, now: clock });

    const view = ownerChat.pending({}, { ...files, now: clock });
    assert.equal(view.items.length, 1, 'the answered message must leave the unread list');
    assert.equal(view.items[0].id, secondId);

    const thread = ownerChat.transcript({}, files);
    assert.deepEqual(thread.items.map(item => item.direction), ['owner', 'controller', 'owner'],
      'the merged transcript must read as an alternating conversation without conversation ids');
    assert.equal(thread.items[0].text, OWNER_MESSAGES[1]);
    assert.equal(thread.items[1].text, 'Enabled. Replying here now.');
    assert.equal(thread.items[2].text, 'great, how many terra agents are running?');

    clock.set(base + 3000);
    await ownerChat.reply({ id: secondId, text: 'Four.' },
      { sendToOwner: async () => ({ messageId: 'message-test-11' }) }, { ...files, now: clock });
    const thread2 = ownerChat.transcript({ limit: 4 }, files);
    assert.deepEqual(thread2.items.map(item => item.direction), ['owner', 'controller', 'owner', 'controller']);
    assert.equal(ownerChat.pending({}, { ...files, now: clock }).condition, ownerChat.CONDITIONS.CLEAR);
  }

  // -------------------------------------------------------------------------
  // 12b. The transcript never attributes a machine directive to the owner
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const base = 1_800_000_000_000;
    seedInboxAt(files, [
      { text: OWNER_MESSAGES[0], atMs: base },
      { text: 'System observation complete: mechanical.', source: 'dashboard', submittedBy: 'system-observer', atMs: base + 1000 },
      { text: 'controller smoke test', source: 'dashboard', submittedBy: 'owner-via-dashboard', atMs: base + 2000 }
    ]);
    const thread = ownerChat.transcript({}, files);
    assert.deepEqual(thread.items.map(item => item.direction), ['owner', 'system', 'system'],
      'only words the owner actually typed may be labelled as his');
    const rendered = ownerChatCli.renderTranscript(thread);
    assert.equal((rendered.match(/OWNER/g) || []).length, 1,
      'the rendered transcript must show exactly one OWNER line for one owner message');
  }

  // -------------------------------------------------------------------------
  // 13. The drain stamp is durable, so any later reader sees when it last ran
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const base = 1_800_000_000_000;
    const clock = fixedClock(base);
    seedInboxAt(files, [{ text: OWNER_MESSAGES[0], atMs: base }]);

    assert.equal(ownerChat.summarize({ ...files, now: clock }).lastDrainedAtMs, null);
    const stamped = ownerChat.pending({ stamp: true, actor: 'controller' }, { ...files, now: clock });
    assert.equal(stamped.stampRecorded, true);
    assert.equal(stamped.stampError, null);
    assert.equal(stamped.lastDrainedAtMs, base,
      'a successful stamp must not render as the pre-write "never drained" value');
    const after = ownerChat.summarize({ ...files, now: clock });
    assert.equal(after.lastDrainedAtMs, base);
    assert.equal(after.lastDrainedBy, 'controller');
    const chat = ownerChat.readChatLog(files.chatFile);
    assert.equal(chat.lastObservation.condition, ownerChat.CONDITIONS.OWNER_MESSAGE_UNREAD);
    assert.equal(chat.lastObservation.ownerUnread, 1);

    // A read WITHOUT --stamp must not move it: looking is not draining.
    clock.advance(60_000);
    ownerChat.pending({}, { ...files, now: clock });
    assert.equal(ownerChat.summarize({ ...files, now: clock }).lastDrainedAtMs, base);

    // Name the contract distinction: the inbox read still succeeds while a
    // fresh lock makes the optional stamp impossible. That is not the same as
    // establishing that no drain stamp happened.
    fs.writeFileSync(`${files.chatFile}.lock`, 'held', 'utf8');
    const notEstablished = ownerChat.pending(
      { stamp: true, actor: 'controller' }, { ...files, now: clock }
    );
    assert.equal(notEstablished.stampRecorded, false,
      '"this did not happen" must differ from "this could not be established"');
    assert.equal(notEstablished.stampError, 'OWNER_CHAT_BUSY');
    assert.equal(notEstablished.lastDrainedAtMs, base,
      'a failed new stamp must retain the last established drain time');
    fs.unlinkSync(`${files.chatFile}.lock`);
  }

  // -------------------------------------------------------------------------
  // 14. tools/fleet-supervisor.js --status carries it, and stays pure JSON
  // -------------------------------------------------------------------------
  {
    const cli = path.join(__dirname, '..', 'tools', 'fleet-supervisor.js');
    const stateFile = path.join(root, 'fleet-status-probe.json');
    const stdout = require('node:child_process').execFileSync(
      process.execPath, [cli, '--status', '--state-file', stateFile],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000 }
    );
    // The banner MUST live inside the JSON: this stdout is a parsed contract.
    const report = JSON.parse(stdout.split('\n(no durable state yet')[0]);
    assert.equal(Object.keys(report)[0], 'ownerChat',
      'the owner-waiting condition must be the first key an operator reads in fleet status');
    assert.equal(report.ownerChat.condition, 'CLEAR',
      'an isolated fleet status with no owner inbox must report the clear condition');
    assert.equal(report.ownerChat.drainCommand, ownerChat.DRAIN_COMMAND);
    assert.equal(typeof report.ownerChat.headline, 'string');
    assert.ok(report.laneCounts, 'the supervisor\'s own status must still be present and unchanged in shape');
  }

  // -------------------------------------------------------------------------
  // 15. Historical numeric receipts remain readable migration state
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    const ids = seedOwnerInbox(files, { count: 1 });
    await ownerChat.reply(
      { id: ids[0], text: 'historical receipt fixture' },
      { sendToOwner: async () => ({ messageId: 'message-test-current' }) },
      files
    );
    const historical = JSON.parse(fs.readFileSync(files.chatFile, 'utf8'));
    historical.entries[0].messageId = 55501;
    fs.writeFileSync(files.chatFile, `${JSON.stringify(historical, null, 2)}\n`, 'utf8');
    assert.equal(ownerChat.readChatLog(files.chatFile).entries[0].messageId, 55501,
      'a numeric receipt already stored by the retired transport must remain readable for migration');
  }

  // -------------------------------------------------------------------------
  // 16. The chat log refuses to reset itself silently
  // -------------------------------------------------------------------------
  {
    const files = freshFiles();
    fs.writeFileSync(files.chatFile, '{ not json', 'utf8');
    assert.throws(() => ownerChat.readChatLog(files.chatFile), error => error.code === 'OWNER_CHAT_STATE_CORRUPT');
    fs.writeFileSync(files.chatFile, JSON.stringify({
      version: 1, nextSequence: 1, lastDrainedAtMs: null, lastDrainedBy: null,
      lastObservation: null, entries: [{ sequence: 1 }]
    }), 'utf8');
    assert.throws(() => ownerChat.readChatLog(files.chatFile), error => error.code === 'OWNER_CHAT_STATE_CORRUPT');

    // But a corrupt OUTBOUND log must never be able to hide an INBOUND message.
    inbox.append({ text: OWNER_MESSAGES[0], source: 'telegram', submittedBy: 'owner-telegram' }, files);
    const view = ownerChat.pending({}, files);
    assert.equal(view.ownerUnread, 1, 'a broken reply log must not suppress the owner\'s unread message');
  }

  // -------------------------------------------------------------------------
  // 17. CLI argument parsing refuses the shapes that would send the wrong thing
  // -------------------------------------------------------------------------
  {
    assert.equal(ownerChatCli.parseArgs([]).mode, 'pending', 'the bare command must be the drain call');
    assert.equal(ownerChatCli.parseArgs(['--pending']).mode, 'pending');
    assert.equal(ownerChatCli.parseArgs(['--status']).mode, 'status');
    const reply = ownerChatCli.parseArgs(['--reply', 'owner-directive-x', '--text', 'hi', '--also', 'owner-directive-y']);
    assert.equal(reply.mode, 'reply');
    assert.equal(reply.id, 'owner-directive-x');
    assert.deepEqual(reply.also, ['owner-directive-y']);
    assert.ok(ownerChatCli.parseArgs(['--reply', 'owner-directive-x']).error, '--reply without text must be refused');
    assert.ok(ownerChatCli.parseArgs(['--reply', 'owner-directive-x', '--text', 'a', '--text-file', 'b']).error,
      'two sources of truth for the reply text must be refused');
    assert.ok(ownerChatCli.parseArgs(['--ack', 'owner-directive-x']).error, '--ack without a reason must be refused');
    assert.ok(ownerChatCli.parseArgs(['--bogus']).error);
  }

  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write('Owner chat tests passed.\n');
}

run().catch(error => {
  process.stderr.write(`Owner chat tests FAILED: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
