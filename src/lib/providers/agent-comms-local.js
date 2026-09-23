'use strict';

// ONE AGENT ON THIS COMPUTER WRITING TO ANOTHER ONE ON THIS COMPUTER.
//
// WHY THE CROSS-MACHINE MESSENGER CANNOT PROVIDE THIS ROUTE.
// src/lib/providers/agent-comms.js is a CROSS-MACHINE messenger and refuses a
// same-machine recipient on purpose. Its recipient enum is built at module load
// from the service registry's machine list, and the shipped registry declares
// exactly one machine, so the tool offers exactly one recipient value and
// answers that one value with
//   {accepted:false, code:'AGENT_COMMS_CROSS_MACHINE_RECIPIENT_REQUIRED'}.
// A feature no caller can invoke. That file is not changed here and its
// cross-machine contract is untouched; this is the local sibling it always
// pointed at without one existing.
//
// NOTHING HERE IS NEW MACHINERY, AND THAT IS DELIBERATE. The local message
// fabric already existed, fully built, with durable history, a durable
// at-least-once broker spool and an in-process transport that opens no socket:
// src/lib/agent-comms/local-runtime.js, used today by tools/agent-msg.js and by
// src/lib/owner-directive-notification.js. What did not exist was any way to
// ADDRESS a tree agent, because the tree's manager/child relationship lived
// only in the app window. src/lib/agent-comms/tree-node-directory.js is that
// missing map, and this file is the seam between it and the fabric.
//
// THE STATE ROOT IS PASSED EXPLICITLY AND THAT IS A FIX, NOT A PREFERENCE.
// local-runtime.js defaults its broker file to rootPath('state', ...) -- the
// directory the PROGRAM lives in. On an installed copy that is the install
// directory, which is not guaranteed writable, is replaced wholesale by the
// next update, and is exactly what src/lib/runtime-state-root.js exists to stop.
// Every path this file hands the runtime is a statePath.

const { statePath } = require('../runtime-state-root');
const { composeRuntimeRoster, createLocalAgentCommsRuntime, normalizeAgentId } = require('../agent-comms/local-runtime');
const { createTreeNodeDirectory } = require('../agent-comms/tree-node-directory');

const MAX_BODY_LENGTH = 4000;

class LocalAgentMessageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalAgentMessageError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new LocalAgentMessageError(code, message, details);
}

function localBrokerFile() {
  return statePath('state', 'agent-comms', 'local-broker.json');
}

function createLocalAgentMessageProvider({
  directory = null,
  runtimeFactory = createLocalAgentCommsRuntime,
  brokerFile = null,
  now = Date.now,
  readDelegationPolicy = require('../agent-delegation-policy').readAgentDelegationPolicy
} = {}) {
  const tree = directory || createTreeNodeDirectory({ now });

  /* THE RUNTIME IS REBUILT WHEN THE CIRCLE SET CHANGES, NOT ON EVERY READ.
   *
   * MEASURED 2026-09-02 on the installed 1.0.41: the application's tree poll
   * calls inbox() for every running session every 1.2 seconds, and each call
   * built a whole new runtime -- the control-plane snapshot out of sqlite, the
   * declared-agent file, the presence file, and a full rewrite of the 13 KB
   * machine-wide broker file, under its claim-directory lock. With several
   * agents running that is a standing rebuild storm on the Electron main
   * thread, for a set of agents that had not changed.
   *
   * The memo below is keyed on the exact agent set the build would use, so a
   * circle appearing or leaving still rebuilds on the very next call. Nothing
   * here decides delivery: send/read still resolve against the directory and
   * the fabric.
   *
   * AND THE ONE-SECOND LIFETIME WAS SHORTER THAN THE POLL IT WAS WRITTEN FOR,
   * so on the path it was written for it never hit once. MEASURED 2026-09-03 on
   * this checkout against an isolated state root -- three circles, forty
   * messages already on the wire, a 12,608-byte spool -- driving inbox() at the
   * shell's own 1200 ms tick: the FIRST call of every tick cost 11.5-14.3 ms
   * (median 12.2) and the later calls of the same tick 1.2-2.3 ms (median 1.3).
   * One rebuild per tick, every tick, forever, because 1000 < 1200 and the two
   * numbers live in two repositories. The memo was cutting S rebuilds per tick
   * down to one and being credited with cutting them to none.
   *
   * WHAT REPLACES THE CLOCK IS THE ANSWER ITSELF. composeRuntimeRoster() builds
   * exactly the roster a build would use -- and IS the function the build uses,
   * so the two cannot drift -- for 0.34 ms against a 16.7-49.9 ms build. The
   * memo is therefore kept when the roster a fresh build WOULD produce is the
   * roster this one HAS. That is strictly fresher than a one-second window, not
   * looser: an agent declared in the org file or registered in presence by
   * another process was invisible here for up to a second and is now seen on
   * the very next call.
   *
   * WHY A RUNTIME MAY BE HELD LONGER, MEASURED RATHER THAN ASSUMED. A runtime
   * built before a message existed still reads that message: three sends made
   * through a DIFFERENT provider instance after the build were each visible to
   * the held runtime's fabric.read(), and a send made through the held runtime
   * after other writers had moved the spool was still accepted and still
   * reported delivered. Reads resolve against the durable store and every
   * broker mutation re-reads the spool under its lock (broker.js commit()), so
   * the only thing a build freezes is the roster -- exactly what the witness
   * checks.
   *
   * THE CEILING IS NOT DECORATION. Building a broker also RECONCILES the spool:
   * it drops delivered entries and reclaims claims whose holder process died.
   * Nothing documents this poll as the owner of that sweep, and every agent's
   * own send builds a fresh runtime in its own process and sweeps there -- but
   * this process must not stop sweeping altogether because its roster went
   * quiet. Ten seconds is one broker lock timeout (broker.js
   * DEFAULT_LOCK_TIMEOUT_MS), the longest this subsystem already lets a single
   * spool operation wait, and it leaves six sweeps inside the 60-second window
   * the broker's own wake cooldown and stale-lock recovery run on.
   *
   * AN INJECTED runtimeFactory FALLS BACK TO A CLOCK. The witness is the
   * DEFAULT factory's own composition; a caller supplying its own factory reads
   * its own org file, presence file and store, and this module has no honest
   * way to compose that caller's roster. Those callers get a clock rather than a
   * witness that would be describing the wrong machine.
   *
   * MERGE 2026-09-03: that clock is the ceiling, not one second. Two lanes
   * measured this memo on the same day. The other one measured that a
   * one-second lifetime is SHORTER than the application's own 1200 ms tree poll
   * (shell/agent-host.cjs TREE_POLL_MS), so it expired 200 ms before every tick
   * and could never span two of them -- the one thing it exists to do -- and
   * raised it. Holding the two numbers apart would have quietly restored that
   * defect for every injected caller, so the fallback is the same
   * RUNTIME_MEMO_CEILING_MS the witness path already allows: 8.3x the poll
   * period, and never longer than the sweep ceiling measured just above.
   */
  const RUNTIME_MEMO_CEILING_MS = 10_000;
  const RUNTIME_MEMO_MS = RUNTIME_MEMO_CEILING_MS;
  /* HOW LONG A BATCHED READ MAY BLOCK THE MAIN THREAD WAITING FOR THE SPOOL LOCK.
   *
   * CHOSEN ON MEASUREMENT, not taste. Seeded from the real 2.6 MB live spool at
   * 80f08ecb, one uncontended rebuild costs 160-235 ms while HOLDING this lock,
   * so a round arriving behind a single holder needs roughly a quarter second
   * to get through. This budget of 1,000 ms therefore absorbs about four
   * consecutive holders before it gives up, while bounding the worst
   * main-thread stall to about a second instead of broker.js's patient
   * DEFAULT_LOCK_TIMEOUT_MS of 10_000 -- which was measured blocking this round
   * for 9,072 ms with just ONE other process holding the lock.
   *
   * It is deliberately well under the memo ceiling above: a round that gives up
   * has not moved any cursor, so the next tick simply tries again. */
  const READ_LOCK_BUDGET_MS = 1_000;
  let runtimeMemo = null;

  /* The roster a fresh build would produce, as one comparable string, or null
     when this provider cannot honestly compute it. Null means "ask the clock",
     never "assume unchanged": a roster that cannot be read is exactly when a
     held runtime is most likely to be the wrong one. */
  function rosterWitness(extraAgentIds) {
    if (runtimeFactory !== createLocalAgentCommsRuntime) return null;
    try {
      const roster = composeRuntimeRoster({ extraAgentIds, now });
      return `${roster.machineId}\u0000${roster.agentIds.join('\u0000')}`;
    } catch {
      return null;
    }
  }

  function memoIsUsable(memo, witness, at) {
    if (witness === null || memo.witness === null) return at - memo.at < RUNTIME_MEMO_MS;
    return witness === memo.witness && at - memo.at < RUNTIME_MEMO_CEILING_MS;
  }

  function runtimeFor(agentIds, { lockTimeoutMs = null } = {}) {
    // Every provider instance opens the same machine-wide broker file. Its
    // directory therefore has to include every registered tree recipient, not
    // only the two participants in this call, or unrelated queued traffic can
    // make an otherwise valid runtime fail or be mistaken for deregistration.
    //
    // THIS READ IS THE INVALIDATION, NOT AN INPUT TO THE MEMOIZED VALUE. It is
    // deliberately in front of the memo check: it is what makes a circle that
    // registered a moment ago change the key. Moving it behind the memo would
    // save under a millisecond and turn the lifetime above into a real
    // staleness window on exactly the fact a person is watching for.
    const registeredAgentIds = tree.listNodes({ includeSuperseded: true }).map(node => node.agentId);
    const extraAgentIds = [...new Set([...registeredAgentIds, ...agentIds.filter(Boolean)])];
    const file = brokerFile || localBrokerFile();
    const key = `${file}\u0000${[...extraAgentIds].sort().join('\u0000')}`;
    const at = now();
    const witness = rosterWitness(extraAgentIds);
    if (runtimeMemo && runtimeMemo.key === key && memoIsUsable(runtimeMemo, witness, at)) {
      return runtimeMemo.runtime;
    }
    const runtime = runtimeFactory({
      extraAgentIds,
      brokerFile: file,
      retainModelHandoffs: true,
      now,
      ...(lockTimeoutMs === null ? {} : { lockTimeoutMs })
    });
    runtimeMemo = { key, at, witness, runtime };
    return runtime;
  }

  /* A REFUSAL IS AN ANSWER, NOT AN EXCEPTION.
   *
   * Every reason a message cannot be delivered here is something the person
   * could fix by looking at their own screen -- the circle is not running, the
   * name is not on the tree, there is no line between the two circles, two
   * circles share a name. A thrown error would reach the model as a tool
   * failure and reach the person as nothing at all. So the refusals come back
   * as a value the model can read aloud, carrying the names it can actually
   * reach, and only a genuinely malformed call throws. */
  /* WHOSE SESSION IS CALLING, as the tool surface vouched for it -- never as
   * the caller wrote it. The owner host binds a session before it may call
   * anything (src/owner-host.js) and hands the bound session id to every tool
   * call as `agentSessionId`, plus a full `agentPrincipal` when the session
   * also holds a declared identity; both name the same session. The directory
   * requires that bound session's own live row, including when another circle
   * is the only live match for an old name after a stop or move. A caller the
   * surface could not vouch for gets null, and the directory answers from
   * names alone, exactly as it always did. The call ARGUMENTS are never read
   * for this: a session id written there is the caller's word. */
  function callerSessionId(context) {
    const principal = context && context.agentPrincipal;
    if (principal && typeof principal.sessionId === 'string' && principal.sessionId.trim()) {
      return principal.sessionId.trim();
    }
    if (context && typeof context.agentSessionId === 'string' && context.agentSessionId.trim()) {
      return context.agentSessionId.trim();
    }
    return null;
  }

  async function send(input = {}, context = {}) {
    require('../agent-delegation-policy').assertAgentCommunicationAllowed(readDelegationPolicy());
    const body = typeof input.body === 'string' ? input.body : '';
    if (body.trim().length === 0) fail('AGENT_MESSAGE_BODY_REQUIRED', 'A message body is required.');
    if (body.length > MAX_BODY_LENGTH) {
      fail('AGENT_MESSAGE_BODY_TOO_LONG', `A message may be at most ${MAX_BODY_LENGTH} characters.`);
    }
    const senderSessionId = callerSessionId(context);
    const resolved = tree.resolveDelivery({ from: input.from, to: input.to, senderSessionId });
    if (resolved.ok !== true) {
      return Object.freeze({
        accepted: false,
        code: resolved.code,
        reason: resolved.message,
        // WHAT IT COULD HAVE SAID INSTEAD. A refusal that only says no makes
        // the next attempt a guess; this is the list the person drew.
        reachable: tree.reachableFrom({ from: input.from, senderSessionId })
      });
    }
    const runtime = runtimeFor([resolved.sender.agentId, resolved.recipient.agentId]);
    const sender = runtime.identity(resolved.sender.agentId);
    const recipient = runtime.identity(resolved.recipient.agentId);
    const result = await runtime.fabric.send(
      {
        sender,
        recipient,
        kind: 'notice',
        // THE NAMES TRAVEL WITH THE MESSAGE. The fabric addresses durable agent
        // ids; the person and the receiving model both think in circle names.
        // Putting the sender's name in the body is what lets the receiving
        // transcript say who wrote, without the reader having to hold a second
        // table of ids.
        body: `${resolved.sender.nodeName}: ${body}`
      },
      Object.freeze({ identity: sender })
    );
    if (!result || result.accepted !== true) {
      return Object.freeze({
        accepted: false,
        code: (result && result.code) || 'AGENT_MESSAGE_REFUSED',
        reason: 'The local message fabric refused this message.'
      });
    }
    return Object.freeze({
      accepted: true,
      code: result.code,
      to: resolved.recipient.nodeName,
      from: resolved.sender.nodeName,
      relation: resolved.relation,
      messageId: result.message && result.message.id,
      sequence: result.stream && result.stream.sequence,
      /* THE BROKER'S RECEIPT, NOT THE LIFECYCLE'S. `result.delivery` is the
       * ask/answer lifecycle projection and is null for a notice by design
       * (src/lib/agent-comms/delivery.js tracks only the two kinds that expect
       * an answer). Reading it here reported delivered:false on messages the
       * broker had already confirmed -- a true field about the wrong thing,
       * which is the worst kind of wrong for a receipt a model reads aloud. */
      /* T255: A STOPPED RECIPIENT IS NEVER REPORTED AS DELIVERED, AND THE
       * BROKER'S OWN `delivered` CANNOT BE USED RAW HERE. Measured: for a
       * stopped circle the broker answers delivered:true, because in the
       * broker's vocabulary delivery means the envelope reached the INBOX --
       * its own note says "Transport delivery reaches the inbox, not the
       * model." For a running circle the courier drains that inbox within a
       * tick, so the two readings agree. For a stopped one they do not: nothing
       * is draining it, and passing that true through would tell the person
       * their message was delivered to an agent that has not run since. That is
       * the identical class of defect the comment below this field already
       * records -- a true field about the wrong thing -- so the same rule is
       * applied to the same field for the case it was never written for. */
      delivered: resolved.recipientStopped === true
        ? false
        : Boolean(result.broker && result.broker.delivered === true),
      /* T255. RECORDED IS NOT DELIVERED, AND THIS IS THE FIELD THAT KEEPS THEM
       * APART. When the recipient's session has stopped, the message is now
       * accepted and durably held by the fabric instead of refused -- but no
       * session is reading it, so `delivered` above is false and saying anything
       * else would be the "true field about the wrong thing" this very receipt
       * was already fixed once for.
       *
       * The caller owes the person one of THREE answers, not two, and this field
       * is what makes the middle one sayable: delivered; held while the circle
       * starts; or refused. Collapsing it to a boolean would trade today's
       * unhelpful-but-honest refusal for a silent hold, which is strictly worse
       * -- the person would be told nothing at all while their message sat. The
       * start itself can also be DEFERRED by the resource admission guard, which
       * answers with its own named codes and a retryAfterMs; whoever performs
       * the wake must pass those through rather than reduce them to a failure.
       *
       * Absent on the ordinary path, so no existing reader changes behaviour. */
      ...(resolved.recipientStopped === true
        ? {
          recipientStopped: true,
          wakeRequired: true,
          note: `${resolved.recipient.nodeName} is not running. The message is recorded and will be read once that circle starts; it has not been delivered yet.`
        }
        : {})
    });
  }

  /* WHO THIS AGENT MAY WRITE TO, ANSWERED FROM THE SAME MAP THE SEND USES.
   * A roster computed anywhere else could disagree with the delivery rule, and
   * the disagreement would show up as a refusal on a name the product had just
   * offered. */
  function roster(input = {}, context = {}) {
    const senderSessionId = callerSessionId(context);
    const diagnosis = typeof tree.reachabilityFrom === 'function'
      ? tree.reachabilityFrom({ from: input.from, senderSessionId })
      : Object.freeze({
        ok: true,
        reachable: tree.reachableFrom({ from: input.from, senderSessionId }),
        unavailable: Object.freeze([])
      });
    const result = {
      from: typeof input.from === 'string' ? input.from.trim() : '',
      reachable: Object.freeze(diagnosis.reachable.map(node => Object.freeze({
        ...node,
        status: 'reachable-now'
      }))),
      unavailable: diagnosis.unavailable
    };
    if (diagnosis.ok === false) {
      result.ok = false;
      result.code = diagnosis.code;
      result.reason = diagnosis.message;
      if (diagnosis.managerName) result.managerName = diagnosis.managerName;
    } else {
      result.ok = true;
    }
    return Object.freeze(result);
  }

  /* WHAT ARRIVED FOR ONE TREE AGENT, from the fabric's own durable inbox.
   *
   * The app calls this for every session it is running; the cursor it passes is
   * the last sequence it has already put on screen, so a message is shown once
   * and a window that reopens does not replay the conversation. */
  async function inbox({ agentId, cursor = 0, limit = 25 } = {}) {
    const runtime = runtimeFor([agentId]);
    const agent = runtime.identity(agentId);
    const failures = readDeliveryFailures(runtime, [agentId]);
    const page = await runtime.fabric.read({
      agent,
      audience: { type: 'direct', agent },
      cursor,
      limit
    });
    return Object.freeze({ agentId, page: withDeliveryReceipts(page, agentId, failures) });
  }

  /* THE DOOR A DURABLE CURSOR NEEDS (T201).
   *
   * inbox() above READS and nothing more. The app therefore had nowhere to say
   * "this one reached its agent", so it kept its own in-memory `treeCursor` and
   * the durable cursor stayed at zero for the life of the install. That is why
   * nothing could declare itself a reader: history.js will refuse to evict a
   * record its declared reader has not acknowledged
   * (HISTORY_CHANNEL_UNREAD_FULL), and a reader that can never acknowledge
   * would wedge the channel closed instead of protecting it. The door has to
   * exist before anyone is declared.
   *
   * THIS IS THE SAME DOOR THE CROSS-MACHINE PROVIDER ALREADY HAS, deliberately:
   * src/lib/providers/agent-comms.js acknowledge() calls fabric.markRead with
   * exactly this shape. A second spelling of one rule is how the last round of
   * this defect was assembled, so this resolves its runtime and audience the
   * way inbox() directly above does -- same runtimeFor, same identity, same
   * `{ type: 'direct', agent }` -- and hands the rest to the fabric.
   *
   * markRead is STRICTLY IN ORDER by design: it refuses anything that is not
   * the next unread record for that agent, by sequence AND messageId
   * (FABRIC_READ_OUT_OF_ORDER). That refusal is returned, not thrown, so a
   * caller acknowledging a batch can stop at the first one the fabric will not
   * take rather than lose its place. */
  async function acknowledge({ agentId, messageId, sequence, evidence = null } = {}) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      fail('AGENT_ACK_AGENT_INVALID', 'acknowledge needs the agentId whose cursor is advancing.');
    }
    if (typeof messageId !== 'string' || messageId.length === 0) {
      fail('AGENT_ACK_MESSAGE_INVALID', 'acknowledge needs the messageId it is acknowledging.');
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail('AGENT_ACK_SEQUENCE_INVALID', 'acknowledge needs the positive durable sequence of that message.');
    }
    const runtime = runtimeFor([agentId]);
    const agent = runtime.identity(agentId);
    return runtime.fabric.markRead({
      agent,
      audience: { type: 'direct', agent },
      messageId,
      sequence,
      /* Evidence may not be empty (FABRIC_READ_EVIDENCE_REQUIRED). The source
         names the door so a read receipt can be told apart from a person's own
         acknowledgement in the same channel. */
      evidence: evidence === null
        ? { source: 'agent_comms.local_inbox' }
        : { source: 'agent_comms.local_inbox', note: evidence }
    });
  }

  function readDeliveryFailures(runtime, agentIds) {
    // Compatibility for injected/older runtimes: their original read still
    // works. A present receipt reader that fails must not look like no failure.
    if (typeof runtime.fabric.deliveryFailures !== 'function') return null;
    return runtime.fabric.deliveryFailures({ agents: agentIds.map(id => runtime.identity(id)) });
  }

  function withDeliveryReceipts(page, agentId, failures) {
    if (failures === null) return page;
    const recipientReceipts = failures.filter(row => row.recipientAgentId === agentId);
    const terminal = new Map(recipientReceipts.filter(row =>
      ['BROKER_MESSAGE_DEAD_LETTERED', 'BROKER_MODEL_HANDOFF_CONFIRMED'].includes(row.code))
      .map(row => [row.messageId, row.code === 'BROKER_MESSAGE_DEAD_LETTERED' ? 'dead-lettered' : 'model-handoff-confirmed']));
    return Object.freeze({ ...page,
      // Retain the original sequence so the consumer can move past a terminal
      // record without either delivering it again or stranding its inbox.
      records: Object.freeze(page.records.map(record => terminal.has(record.message.id)
        ? Object.freeze({ ...record, deliveryStatus: terminal.get(record.message.id) }) : record)),
      pendingDeliveries: Object.freeze(recipientReceipts.filter(row =>
        ['BROKER_DELIVERY_DEFERRED', 'BROKER_DELIVERY_AWAITING_MODEL'].includes(row.code))
        .map(row => Object.freeze({ message: row.message, deferredAt: row.at, recovered: row.code === 'BROKER_DELIVERY_DEFERRED' }))),
      deliveryReceipts: Object.freeze(failures.filter(row => row.senderAgentId === agentId
        && row.code !== 'BROKER_DELIVERY_AWAITING_MODEL' && row.notifySender !== false)
        .map(({ message: _message, ...receipt }) => Object.freeze(receipt))),
    });
  }

  async function discard({ agentId, message } = {}) {
    return transitionDelivery('discardDelivery', agentId, message);
  }

  async function defer({ agentId, message } = {}) {
    return transitionDelivery('deferDelivery', agentId, message);
  }

  async function acknowledgeDeferred({ agentId, message } = {}) {
    return transitionDelivery('acknowledgeDeferredDelivery', agentId, message);
  }

  /* WHAT THIS SESSION HAS ACTUALLY READ, SAID OUT LOUD TO THE DURABLE STREAM
   * (T201).
   *
   * THE HOLE THIS CLOSES. inbox()/inboxes() above are POSITIONED reads: the
   * caller passes the cursor it has already shown and fabric.read() answers
   * from there without recording anything. The application's tree courier
   * keeps that position in memory, on the session, and never told the durable
   * history about it -- so for every tree message ever sent, the stored cursor
   * for the recipient stayed at zero. history.append()'s retention could
   * therefore not know that anything was unread, and evicted the oldest record
   * whenever the channel filled. The app has a sentence for the result:
   * "[Tree courier] Earlier agent messages have expired before this session
   * could read them". A message the person sent to an agent expired before the
   * agent ever saw it.
   *
   * THE DOOR IS SEPARATE FROM THE READ ON PURPOSE. Reading a page is not
   * evidence that anything consumed it -- a window can open, read, and close
   * again. This is called once the RECIPIENT'S MODEL has accepted the words,
   * which is the only moment anyone can honestly say the message arrived.
   * fabric.markRead() enforces that the acknowledgement is strictly in order
   * and matches the next unread record, so a caller cannot skip past something
   * it never showed.
   *
   * `evidence` is required by the fabric and must not be empty; the default
   * says the one thing this path actually knows. */
  async function acknowledgeRead({ agentId, message, sequence, evidence = null } = {}) {
    normalizeAgentId(agentId);
    const runtime = runtimeFor([agentId]);
    if (typeof runtime.fabric.markRead !== 'function') {
      fail('AGENT_READ_RECEIPTS_UNAVAILABLE', 'This runtime cannot record what a session has already read.');
    }
    if (!message || typeof message.id !== 'string' || message.id.length < 1) {
      fail('AGENT_READ_RECEIPT_INVALID', 'A read receipt needs the original message envelope.');
    }
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      fail('AGENT_READ_RECEIPT_INVALID', 'A read receipt needs the position the message was read at.');
    }
    const agent = runtime.identity(agentId);
    return runtime.fabric.markRead({
      agent,
      audience: { type: 'direct', agent },
      evidence: evidence || { handedToModel: true },
      messageId: message.id,
      sequence
    });
  }

  function transitionDelivery(verb, agentId, message) {
    normalizeAgentId(agentId);
    const runtime = runtimeFor([agentId]);
    if (typeof runtime.fabric[verb] !== 'function') {
      fail('AGENT_DELIVERY_RECEIPTS_UNAVAILABLE', 'This runtime cannot retain recipient handoff state.');
    }
    return runtime.fabric[verb]({ agent: runtime.identity(agentId), message });
  }

  /* WHAT ARRIVED FOR EVERY CIRCLE ON THIS COMPUTER, ASKED ONCE.
   *
   * WHY inbox() ALONE WAS NOT ENOUGH. The application's tree courier asks once
   * per running circle per tick, and every one of those calls repeats the same
   * two answers before it can read a single page: the tree directory's own file
   * (tree.listNodes()) and the roster witness above. MEASURED 2026-09-03 on this
   * checkout -- three circles, forty messages on the wire, a 12,608-byte spool,
   * an isolated state root -- listNodes() costs 0.75-1.83 ms (median 1.10) and
   * composeRuntimeRoster() 0.77-2.64 ms (median 0.89), while the page read they
   * exist to enable costs 0.14-2.27 ms (median 0.29). Six circles therefore paid
   * roughly twelve milliseconds of identical bookkeeping per tick to read six
   * pages worth under two.
   *
   * THE ANSWER IS THE SAME ANSWER, so it is established once and used for every
   * page in the round. Nothing about a page changes: each is the same positioned
   * read of the same durable stream that inbox() performs, and inbox() is left
   * exactly as it was for every caller that wants one circle.
   *
   * A CIRCLE THIS RUNTIME CANNOT READ FOR IS OMITTED, NEVER ANSWERED EMPTY. An
   * agent the roster does not know, or a stream that would not read, drops OUT
   * of the answer -- the caller sees no page for it and leaves its cursor where
   * it was, which is "not read this round" and is retried on the next one. An
   * empty page would say "nothing arrived", which is how a message gets lost
   * once and never noticed. That is the same posture inbox()'s callers already
   * take when a single read throws. */
  async function inboxes(requests = []) {
    if (!Array.isArray(requests)) {
      fail('AGENT_INBOX_REQUESTS_INVALID', 'inboxes takes a list of {agentId, cursor, limit} requests.');
    }
    const wanted = requests
      .filter(request => request && typeof request.agentId === 'string' && request.agentId.length > 0)
      .map(request => Object.freeze({
        agentId: request.agentId,
        cursor: Number.isFinite(request.cursor) ? request.cursor : 0,
        limit: Number.isSafeInteger(request.limit) ? request.limit : 25
      }))
      /* A NAME THE FABRIC COULD NEVER ADDRESS DROPS OUT HERE, BEFORE THE BUILD.
         runtimeFor() hands every requested id to the roster, and the roster
         REFUSES a malformed one -- so one unusable name in a round would throw
         the whole round and every circle in it would go unread, on this tick and
         on every tick after. That is the shape of the tree-directory outage this
         product has already had once: one bad row refusing every reader. */
      .filter(request => {
        try { normalizeAgentId(request.agentId); return true; } catch { return false; }
      });
    if (wanted.length === 0) return Object.freeze([]);
    /* THE ROUND WAITS FOR THE SPOOL LOCK ON THE MAIN THREAD, SO IT WAITS BRIEFLY.
     *
     * Building a runtime constructs a broker, and the broker takes the
     * machine-wide spool lock through withStateLock(), which waits with
     * Atomics.wait -- a real thread block, not a yield. At broker.js's own
     * DEFAULT_LOCK_TIMEOUT_MS that is up to ten seconds during which this
     * process renders nothing and answers nothing.
     *
     * MEASURED at 80f08ecb, seeded from the real 2.6 MB live spool
     * (builds\w14-measure-inbox-sync.cjs, builds\w14-probe-round.cjs): an
     * uncontended rebuild costs 160-235 ms of synchronous pre-await time, and
     * ONE other process holding the lock turned this round into a 9,072 ms
     * main-thread block. Live's worst tree-courier:read-dispatch span is
     * 3,257 ms, which sits inside that range.
     *
     * NOT THE SCAN. The same measurement shows 3 circles and 21 circles cost
     * the same, so the per-request work above is not where the time goes and
     * indexing or capping it would buy nothing.
     *
     * READS ARE BOUNDED, WRITES ARE NOT. A read that is skipped is retried on
     * the courier's very next tick and nothing is lost -- the cursors do not
     * move, exactly as for a circle that is omitted below. A send that is
     * refused is a message the person asked to deliver and did not get, so
     * send() keeps the full patient wait. That asymmetry is the whole design.
     *
     * NO NEW TIMER: the retry is the tick that was already going to happen. */
    let runtime;
    let failures;
    try {
      runtime = runtimeFor(wanted.map(request => request.agentId), { lockTimeoutMs: READ_LOCK_BUDGET_MS });
      failures = readDeliveryFailures(runtime, wanted.map(request => request.agentId));
    } catch {
      /* THE WHOLE ROUND IS OMITTED, NOT ANSWERED EMPTY. Before this, a
         contended lock threw out of here -- outside the per-request catch
         below -- so every circle went unread AND the caller saw a failure
         rather than "not read this round". That is the same "one bad row
         refusing every reader" shape the filter above exists to prevent.
         Omitting leaves every cursor where it was, which is retried. */
      return Object.freeze([]);
    }
    const answered = [];
    for (const request of wanted) {
      try {
        const agent = runtime.identity(request.agentId);
        const page = await runtime.fabric.read({
          agent,
          audience: { type: 'direct', agent },
          cursor: request.cursor,
          limit: request.limit
        });
        answered.push(Object.freeze({ agentId: request.agentId,
          page: withDeliveryReceipts(page, request.agentId, failures) }));
      } catch {
        /* Omitted on purpose -- see the paragraph above. */
      }
    }
    return Object.freeze(answered);
  }

  /* EVERY MESSAGE BETWEEN AGENTS ON THIS COMPUTER, FOR THE PERSON WHO OWNS THEM.
   *
   * The owner-facing communications page reads this journal after the local
   * channel is working; otherwise a valid channel would still have no visible
   * history.
   *
   * IT IS A READ OF A RECORD THAT ALREADY EXISTS, NOT A SECOND COPY. The fabric
   * appends every message to the owner journal stream BEFORE it appends it to
   * the recipient's own stream -- structurally, so a message cannot be delivered
   * without being visible to the owner. Keeping a separate log for the page
   * would be a second truth that could disagree with the first; this asks the
   * one that already exists.
   *
   * THE SENDER'S CIRCLE NAME, NOT ITS DURABLE ID. The journal addresses agents
   * as `tree-<hash>`, which is correct for delivery and useless on a screen. The
   * name is recovered from the directory, and a sender whose session has since
   * ended still resolves, because a stopped node is remembered rather than
   * deleted -- so yesterday's conversation does not turn into a wall of hashes.
   */
  async function ownerJournal({ limit = 100, cursor } = {}) {
    const runtime = runtimeFor([]);
    const pageLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 100, 1), 500);
    let readCursor = cursor === undefined ? 0 : cursor;
    let tailSelected = cursor !== undefined;
    let page;
    // The screen requests a current window, not a read starting at sequence
    // zero forever. Retention is a missing prefix, not an unreadable tail.
    // Bound retries if concurrent writers move the floor during this read.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      page = await runtime.fabric.ownerProjection({ actor: runtime.ownerActor, cursor: readCursor, limit: pageLimit });
      const journal = page?.journal;
      if (!Number.isSafeInteger(journal?.floorSequence) || journal.floorSequence < 1
          || !Number.isSafeInteger(journal?.headSequence) || journal.headSequence < journal.floorSequence - 1) break;
      const next = Math.max(journal.floorSequence - 1,
        !tailSelected ? journal.headSequence - pageLimit : readCursor);
      tailSelected = true;
      if (next <= readCursor) break;
      if (attempt === 3) return Object.freeze({ ok: false, reason: 'the retained message window changed during the read; try again' });
      readCursor = next;
    }
    const known = new Map(tree.listNodes().map(node => [node.agentId, node.nodeName]));
    /* The projection nests its rows under `journal`, and reading `page.records`
       from the top level answered an empty array on a fabric with a full
       journal -- an empty conversation is exactly what this feature looks like
       when it is broken, so a shape mistake here is indistinguishable from the
       defect it is meant to disprove. Measured against a real two-message
       exchange before this line was written the way it now reads. */
    /* An absent or malformed projection is not an empty journal. The fabric is
       the only source that can establish the conversation, so losing its
       `journal` object (or receiving a status this provider does not
       understand) must remain a read refusal rather than become `ok: true`
       with zero messages. */
    const journal = page && page.journal;
    const readableStatuses = new Set(['CAUGHT_UP', 'BACKLOG', 'INCOMPLETE']);
    if (!journal || typeof journal !== 'object' ||
        (journal.status !== 'TRUNCATED' && !readableStatuses.has(journal.status))) {
      return Object.freeze({
        ok: false,
        reason: 'the local message fabric returned an unreadable owner journal projection'
      });
    }
    if (journal.status === 'TRUNCATED') {
      return Object.freeze({
        ok: false,
        reason: 'the retained message window changed during the read; try again'
      });
    }
    if (!Array.isArray(journal.records)) {
      return Object.freeze({
        ok: false,
        reason: 'the local message fabric did not establish the owner journal records'
      });
    }
    const incomplete = Array.isArray(journal.incompleteRecords) ? journal.incompleteRecords : [];
    const records = [...journal.records.map(record => ({ ...record, deliveryState: 'available' })),
      ...incomplete.filter(record => record.message?.message).map(record => ({ ...record, deliveryState: 'unconfirmed' }))]
      .sort((left, right) => left.sequence - right.sequence);
    const notices = [];
    if (journal.floorSequence > 1) notices.push('Showing retained messages. Older messages have expired.');
    if (incomplete.length) notices.push(`${incomplete.length} message${incomplete.length === 1 ? '' : 's'} recorded without a confirmed recipient inbox write.`);
    return Object.freeze({
      ok: true,
      notice: notices.join(' ') || null,
      history: Object.freeze({ floorSequence: journal.floorSequence, headSequence: journal.headSequence,
        nextCursor: journal.nextCursor, startCursor: readCursor }),
      messages: Object.freeze(records.map(record => {
        /* THE JOURNAL WRAPS THE MESSAGE TWICE, and one unwrap is not enough.
         * A journal row is {sequence, appendedAtMs, message:{message, streamId}}
         * -- the outer `message` is the ENVELOPE naming which stream the message
         * was filed on, and the message itself is one level further in. Reading
         * only the outer one produced rows with an empty body and a sender of
         * "an agent": a page that renders as a working feature with nothing in
         * it, which is exactly what the defect looks like. Measured on a real
         * exchange rather than assumed from the field name. */
        const envelope = record.message || record;
        const message = envelope.message || envelope;
        const senderId = message.sender && message.sender.agentId;
        const recipientId = message.audience?.type === 'direct' ? message.audience.agent?.agentId : null;
        return Object.freeze({
          id: String(message.id || `sequence-${record.sequence}`),
          sender: known.get(senderId) || senderId || 'an agent',
          senderId: senderId || null,
          recipient: recipientId ? known.get(recipientId) || recipientId : null,
          recipientId: recipientId || null,
          kind: message.kind || 'notice',
          causalParent: message.causalParent || null,
          sequence: record.sequence,
          deliveryState: record.deliveryState,
          at: new Date(Number(message.issuedAt || record.appendedAtMs) || Date.now()).toISOString(),
          text: String(message.body || ''),
          contentTrust: 'untrusted',
          grantsAuthority: false
        });
      }))
    });
  }

  return Object.freeze({ acknowledge, acknowledgeDeferred, acknowledgeRead, defer, discard, inbox, inboxes, ownerJournal, roster, send, directory: tree });
}

const provider = createLocalAgentMessageProvider();

module.exports = Object.freeze({
  LocalAgentMessageError,
  MAX_BODY_LENGTH,
  createLocalAgentMessageProvider,
  acknowledge: provider.acknowledge,
  acknowledgeDeferred: provider.acknowledgeDeferred,
  acknowledgeRead: provider.acknowledgeRead,
  defer: provider.defer,
  discard: provider.discard,
  inbox: provider.inbox,
  inboxes: provider.inboxes,
  localBrokerFile,
  ownerJournal: provider.ownerJournal,
  roster: provider.roster,
  send: provider.send
});
