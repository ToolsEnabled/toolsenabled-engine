'use strict';

/* A MODEL ON THE USER'S OWN COMPUTER, BEHIND THE SAME SEAM CODEX AND CLAUDE SIT
 * BEHIND.
 *
 * WHY THIS EXISTS. The engine has carried a local runtime for weeks --
 * src/lib/providers/local-node-runtime.js finds Ollama on loopback and
 * completes one prompt; tools/local-node-lane-runner.js is the child process a
 * DISPATCH lane spawns for it. Neither is an interactive engine: nothing spoke
 * engine-contract.js for a local model, so the desktop shell listed the `local`
 * tier in its start menu and refused it by name at press
 * (AGENT_TIER_NO_LAUNCHER, "this copy carries no launcher for it"). The owner's
 * words, 2026-09-04: "why can i still not start a local model". This module is
 * the launcher.
 *
 * WHAT IT SPEAKS. Ollama's native chat route, POST /api/chat with stream:true,
 * MEASURED against Ollama 0.33.3 on this machine 2026-09-04 and against
 * tests/agent-engine/local-node-adapter.test.js's fake of it. The body is
 * newline-delimited JSON and these are the packets:
 *
 *   {"message":{"role":"assistant","thinking":"..."},"done":false}   -> thinking (accumulated,
 *                                                                        emitted once per block)
 *   {"message":{"role":"assistant","content":"..."},"done":false}    -> assistant_text_delta
 *   {"message":{...},"done":true,"done_reason":"stop",
 *    "prompt_eval_count":N,"eval_count":M}                            -> assistant_text, usage,
 *                                                                        turn_completed
 *   HTTP 2xx headers arriving at all                                  -> turn_accepted
 *   {"error":"..."} or a non-2xx status                               -> turn_completed(error)
 *
 * Ollama's OpenAI-compatible route (/v1/chat/completions) is NOT used here:
 * it streams server-sent events with a different
 * frame and reports usage only when asked for it; the native route streams one
 * JSON object per line and always carries the two counts a usage meter needs.
 *
 * The native chat route keeps no transcript, so each request carries history.
 * Sessions save bounded snapshots through local-thread-store.js; the module
 * registry caches them between turns. Resume and fork refuse missing or damaged
 * history rather than silently beginning a new conversation.
 *
 * NO CREDENTIAL, NO PROCESS. A model on the person's own hardware has no API
 * key and this module reads none; it spawns nothing (see local-node-process.js
 * for the HTTP transport). Nothing here touches the vault or the environment.
 *
 * EVERY EMISSION GOES THROUGH validateEngineEvent, like the other two adapters,
 * so a mapping bug here is dropped with a warning rather than reaching a
 * renderer as a malformed event.
 */

const { createHash, randomUUID } = require('node:crypto');
const {
  assertEngineAdapter,
  validateApprovalAnswer,
  validateEngineEvent,
  validateSendTurnRequest,
  validateThreadId,
  validateThreadOptions
} = require('./engine-contract');
const { LocalNodeError, MAX_PROMPT_CHARS, MAX_OUTPUT_TOKENS } = require('../providers/local-node-runtime');
const localOptions = require('../local-model-options');
const { MAX_THREAD_BYTES } = require('./local-thread-store');
const { createLocalToolView, wireTool } = require('./local-tool-discovery');

/* Same generosity as the Claude engine, for the same reason: a local model on
   a slow GPU can take minutes to load and answer, and a timeout that fires on
   honest work kills a session that was succeeding. It exists so a runtime
   that stalls without closing the stream cannot leave a promise pending for
   the life of the application. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
/* How long interrupt() waits for the aborted request to actually settle. */
const INTERRUPT_ANSWER_MS = 10_000;
/* Conversations this process remembers at once, oldest forgotten first. */
const MAX_THREADS_HELD = 256;
/* Messages one conversation may carry before its oldest turns are dropped.
   Ollama windows the context itself; this bound is about this process's
   memory, not the model's. */
const MAX_HISTORY_MESSAGES = 400;
/* What a resume reports, matching the Codex adapter's own cap. */
const MAX_RESUMED_TURNS = 200;
/* How many times one turn may go back to the model after tool results
   before the turn is stopped. A model that keeps calling tools without ever
   answering is looping, and a loop that is also spending the person's GPU
   deserves a sentence rather than a spinner. */
const MAX_TOOL_ROUNDS = 24;
const RECEIPT_STATUSES = Object.freeze(['pending', 'success', 'error', 'interrupted']);
const TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code, message, details = {}) {
  return new LocalNodeError(code, message, details);
}

/* ---------------------------------------------------------------- threads -- */

const THREADS = new Map();

function rememberThread(threadId, record) {
  THREADS.delete(threadId);
  THREADS.set(threadId, record);
  while (THREADS.size > MAX_THREADS_HELD) THREADS.delete(THREADS.keys().next().value);
}

function threadRecord(threadId, store = null) {
  const record = THREADS.get(threadId) || (store ? store.load(threadId) : null);
  if (!record) return null;
  validateRetainedMetadata(record);
  /* Touched threads move to the young end, so the ones dropped are the ones
     nobody has spoken to for longest. */
  rememberThread(threadId, record);
  return record;
}

// These fields come only from the host's structured, saved-state handoff.
// Conversation text is never parsed into instructions, including on upgrade.
function copySessionInstructions(value, code = 'LOCAL_NODE_INSTRUCTIONS_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'rules') || !Object.hasOwn(value, 'role')
    || typeof value.rules !== 'string' || typeof value.role !== 'string'
    || value.rules.length + value.role.length > MAX_PROMPT_CHARS) {
    throw fail(code, 'The local session instructions could not be read safely; nothing was sent.');
  }
  return Object.freeze({ rules: value.rules, role: value.role });
}

function validateRetainedMetadata(record) {
  if (Object.hasOwn(record, 'sessionInstructions')) copySessionInstructions(record.sessionInstructions, 'LOCAL_NODE_THREAD_UNREADABLE');
  if (Object.hasOwn(record, 'turnReceipt')) {
    const receipt = record.turnReceipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).length !== (Object.hasOwn(receipt, 'historySha256') ? 4 : 3) || receipt.version !== 1
      || typeof receipt.turnId !== 'string' || !TURN_ID.test(receipt.turnId) || !RECEIPT_STATUSES.includes(receipt.status)
      || (Object.hasOwn(receipt, 'historySha256') && (typeof receipt.historySha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(receipt.historySha256) || !['error', 'interrupted'].includes(receipt.status)))) {
      throw fail('LOCAL_NODE_THREAD_UNREADABLE', 'The saved local turn receipt could not be read. The conversation was preserved.');
    }
    if (['pending', 'success'].includes(receipt.status)
      && !record.messages.some(message => message.turnId === receipt.turnId)) {
      throw fail('LOCAL_NODE_THREAD_UNREADABLE', 'The saved local turn receipt does not match a saved turn. The conversation was preserved.');
    }
  }
}

function historyDigest(record) {
  return createHash('sha256').update(JSON.stringify(record.messages), 'utf8').digest('hex');
}

// Called only at actual settlement, after the final history mutation. A
// removed question needs this boundary to establish where its receipt belongs.
// Neither load, fork nor an ordinary save may certify a new history for it.
function settledReceipt(record, turnId, status) {
  return { version: 1, turnId, status,
    ...(!record.messages.some(message => message.turnId === turnId) ? { historySha256: historyDigest(record) } : {}) };
}

function detachedReceipt(record) {
  const receipt = record.turnReceipt;
  if (!receipt || record.messages.some(message => message.turnId === receipt.turnId)) return null;
  if (receipt.historySha256 === historyDigest(record)) return receipt;
  // Keep newer observed dialogue last. With no dialogue at all, an explicit
  // unknown boundary prevents the controller's empty-history ready fallback.
  return turnIdsOf(record).length === 0 ? { ...receipt, status: 'unknown' } : null;
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function newThreadRecord({ cwd = null, model = null, systemText = null } = {}) {
  const messages = [];
  if (typeof systemText === 'string' && systemText.trim()) {
    messages.push({ role: 'system', content: systemText, turnId: null });
  }
  return { messages, cwd, model, usage: null };
}

/* The system message, if a caller gave instructions. Neither desktop engine
   path passes these today (the brief travels as the first turn); honoured
   when present so an embedder that does is not silently ignored. */
function systemTextOf(threadOptions) {
  const parts = [];
  for (const key of ['baseInstructions', 'developerInstructions']) {
    if (typeof threadOptions[key] === 'string' && threadOptions[key].trim()) parts.push(threadOptions[key]);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/* What goes on the wire: role and content only. `turnId` is this module's own
   bookkeeping and the runtime must never see it. */
function wireMessages(record) {
  const messages = record.messages.map(message => {
    const wire = { role: message.role, content: message.content };
    if (Array.isArray(message.tool_calls)) wire.tool_calls = message.tool_calls;
    if (typeof message.tool_name === 'string') wire.tool_name = message.tool_name;
    return wire;
  });
  const instructions = record.sessionInstructions;
  const content = instructions ? [instructions.rules, instructions.role].filter(Boolean).join('\n\n') : '';
  if (content) {
    // Retained host context remains user-level guidance. Keep the current
    // question and tool rounds in their original order after this snapshot.
    const currentTurn = record.messages.at(-1)?.turnId;
    const first = record.messages.findIndex(message => message.turnId === currentTurn);
    messages.splice(first < 0 ? messages.length : first, 0, { role: 'user', content });
  }
  return messages;
}

/* Drop whole turns from the front until the conversation fits, keeping a
   leading system message. A turn is every message sharing one turnId, so a
   question is never kept without its answer or the reverse. */
function boundHistory(record) {
  while (record.messages.length > MAX_HISTORY_MESSAGES || Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_THREAD_BYTES - 1024) {
    const first = record.messages.findIndex(message => message.role !== 'system');
    if (first < 0) return;
    const turnId = record.messages[first].turnId;
    if (!record.messages.some(message => message.role !== 'system' && message.turnId !== turnId)) return;
    const survivors = record.messages.filter((message, index) => index < first || message.turnId !== turnId);
    if (survivors.length === record.messages.length) return;
    record.messages = survivors;
  }
}

function turnIdsOf(record) {
  const ids = [];
  for (const message of record.messages) {
    if (message.turnId && !ids.includes(message.turnId)) ids.push(message.turnId);
  }
  return ids;
}

/* The restored conversation, in the shape the Codex adapter already reports
   (`{ id, said: [{ who, text }] }`) so the surface that re-renders a resumed
   thread needs no second reader. Tool exchanges are not "said" by anybody and
   are left out, exactly as parseThreadTurn() leaves out non-message items. */
function turnsOf(record) {
  const turns = [];
  for (const turnId of turnIdsOf(record).slice(-MAX_RESUMED_TURNS)) {
    const said = [];
    for (const message of record.messages) {
      if (message.turnId !== turnId || typeof message.content !== 'string' || !message.content) continue;
      if (message.role === 'user') said.push({ who: 'you', text: message.content });
      else if (message.role === 'assistant') said.push({ who: 'agent', text: message.content });
    }
    turns.push(Object.freeze({ id: turnId, said: Object.freeze(said.map(Object.freeze)),
      ...(record.turnReceipt?.turnId === turnId ? { status: record.turnReceipt.status } : {}) }));
  }
  // An unanswered failure can remove its question from history. Its exact
  // receipt must still supersede the preceding successful answer on resume.
  const detached = detachedReceipt(record);
  if (detached) {
    turns.push(Object.freeze({ id: detached.turnId, said: Object.freeze([]), status: detached.status }));
  }
  if (turns.length > MAX_RESUMED_TURNS) turns.shift();
  return Object.freeze(turns);
}

function usageOfPacket(packet) {
  const input = Number.isInteger(packet.prompt_eval_count) ? packet.prompt_eval_count : null;
  const output = Number.isInteger(packet.eval_count) ? packet.eval_count : null;
  if (input === null && output === null) return null;
  const inputTokens = input === null ? 0 : input;
  const outputTokens = output === null ? 0 : output;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function addUsage(total, last) {
  return {
    inputTokens: total.inputTokens + last.inputTokens,
    outputTokens: total.outputTokens + last.outputTokens,
    totalTokens: total.totalTokens + last.totalTokens
  };
}

/* The one sentence a failed turn carries. The runtime's own message when it
   gave one (Ollama answers {"error":"model 'x' not found"}); otherwise the
   LocalNodeError's, which is already written for a person. */
function failureSentence(error) {
  if (!error) return 'The local model stopped before finishing its answer.';
  const runtimeSaid = error.details && typeof error.details.error === 'string' && error.details.error.trim();
  if (runtimeSaid) return `The local model runtime answered: ${runtimeSaid.trim()}`;
  return typeof error.message === 'string' && error.message ? error.message : 'The local model could not answer.';
}

class LocalNodeAdapter {
  constructor({ transport, model, runtimeOptions = localOptions.DEFAULTS, threadStore = null, clientInfo = null, tools = null, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, maxOutputTokens = MAX_OUTPUT_TOKENS } = {}) {
    if (!transport || typeof transport.chat !== 'function') {
      throw new TypeError('LocalNodeAdapter requires a transport with chat()');
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('LocalNodeAdapter requires the resolved model name');
    }
    if (tools !== null && (typeof tools.list !== 'function' || typeof tools.call !== 'function')) {
      throw new TypeError('LocalNodeAdapter tools must offer list() and call()');
    }
    this.transport = transport;
    this.model = model;
    this.runtimeOptions = localOptions.resolveOptions({}, runtimeOptions);
    this.threadStore = threadStore;
    /* The circle's tool surface (local-node-tools.js), or null for a session
       with no tools. Null means NO `tools` field on the request at all, so a
       model with nothing to call is never shown an empty list. */
    this.tools = tools;
    this.clientInfo = clientInfo;
    this.turnTimeoutMs = turnTimeoutMs;
    this.maxOutputTokens = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= MAX_OUTPUT_TOKENS
      ? maxOutputTokens
      : MAX_OUTPUT_TOKENS;
    this.threadId = null;
    this.listeners = new Set();
    this.closed = false;
    /* ONE TURN AT A TIME, like the other engines: the conversation is one
       ordered history and two concurrent requests would each carry a history
       missing the other's answer. */
    this.activeTurn = null;
  }

  /* ------------------------------------------------------------ events -- */

  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('onEvent requires a listener function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    let validated;
    try {
      validated = validateEngineEvent(event);
    } catch (error) {
      this.emitDiagnostic(error);
      return;
    }
    for (const listener of this.listeners) {
      try { listener(validated); } catch { /* one bad listener is not the turn's problem */ }
    }
  }

  emitDiagnostic(error) {
    if (typeof process !== 'undefined' && process.emitWarning) {
      process.emitWarning(`local-node-adapter dropped a malformed event: ${error && error.message}`);
    }
  }

  /* ------------------------------------------------------------ thread -- */

  saveThread(threadId, record) {
    if (this.threadStore) this.threadStore.save(threadId, record);
  }

  async startThread(threadOptions = {}) {
    const options = validateThreadOptions(threadOptions);
    if (this.closed) throw fail('LOCAL_NODE_CLOSED', 'This local model session is closed.');
    const threadId = randomUUID();
    const record = newThreadRecord({
      cwd: options.cwd || null,
      model: this.model,
      systemText: systemTextOf(options)
    });
    record.ephemeral = options.ephemeral === true;
    this.saveThread(threadId, record);
    rememberThread(threadId, record);
    this.threadId = threadId;
    return Object.freeze({ threadId });
  }

  async resumeThread(threadId, threadOptions = {}) {
    validateThreadOptions(threadOptions);
    const id = validateThreadId(threadId);
    const record = threadRecord(id, this.threadStore);
    if (!record) {
      throw fail('LOCAL_NODE_THREAD_UNKNOWN',
        'This local conversation is no longer available in memory or in saved recovery history. Start a new agent instead.',
        { threadId: id });
    }
    /* The person's current model choice wins over the one the thread began
       on: they changed it on purpose, and the history is words either can read. */
    record.model = this.model;
    this.saveThread(id, record);
    this.threadId = id;
    return Object.freeze({
      threadId: id,
      turns: turnsOf(record),
      turnCount: turnIdsOf(record).length + (detachedReceipt(record) ? 1 : 0),
      cwd: record.cwd,
      model: record.model
    });
  }

  /* A FORK IS A COPY OF THE HISTORY UP TO ONE TURN, under a new name. The
     original is untouched; the shell's rewind moves the session onto the copy
     and the person keeps steering from there. */
  async forkThread(threadId, threadOptions = {}) {
    const options = validateThreadOptions(threadOptions);
    const id = validateThreadId(threadId);
    const record = threadRecord(id, this.threadStore);
    if (!record) throw fail('LOCAL_NODE_THREAD_UNKNOWN', 'That conversation is not one this copy still holds.', { threadId: id });
    if (this.activeTurn) throw fail('LOCAL_NODE_TURN_ACTIVE', 'This session is still working on a turn; stop it before rewinding.');
    let messages = record.messages;
    if (options.lastTurnId !== undefined) {
      const ids = turnIdsOf(record);
      const position = ids.indexOf(options.lastTurnId);
      if (position < 0) throw fail('LOCAL_NODE_TURN_UNKNOWN', 'That turn is not in this conversation.', { turnId: options.lastTurnId });
      const kept = new Set(ids.slice(0, position + 1));
      messages = record.messages.filter(message => message.turnId === null || kept.has(message.turnId));
    }
    const forkId = randomUUID();
    const fork = {
      messages: JSON.parse(JSON.stringify(messages)),
      cwd: options.cwd || record.cwd,
      model: record.model,
      ephemeral: options.ephemeral ?? record.ephemeral,
      localToolNames: Array.isArray(record.localToolNames) ? record.localToolNames.slice() : [],
      ...(record.sessionInstructions ? { sessionInstructions: copySessionInstructions(record.sessionInstructions) } : {}),
      ...(record.turnReceipt && (options.lastTurnId === undefined || messages.some(message => message.turnId === record.turnReceipt.turnId))
        ? { turnReceipt: { ...record.turnReceipt } } : {}),
      usage: record.usage ? { total: { ...record.usage.total }, last: { ...record.usage.last } } : null
    };
    this.saveThread(forkId, fork);
    rememberThread(forkId, fork);
    return Object.freeze({ threadId: forkId });
  }

  /* -------------------------------------------------------------- turn -- */

  async sendTurn(request) {
    return this.sendTurnWithSessionInstructions(request);
  }

  // Internal owner-host seam; no engine-contract/IPC field exposes it to
  // chat, peers or tool calls. Undefined retains explicitly saved metadata.
  async sendTurnWithSessionInstructions(request, sessionInstructions) {
    const { threadId, text, images } = validateSendTurnRequest(request);
    if (this.closed) throw fail('LOCAL_NODE_CLOSED', 'This local model session is closed.');
    if (this.activeTurn) throw fail('LOCAL_NODE_TURN_ACTIVE', 'This session is already working on a turn.');
    const record = threadRecord(threadId, this.threadStore);
    if (!record) throw fail('LOCAL_NODE_THREAD_UNKNOWN', 'That conversation is not one this session holds.', { threadId });
    if (images.length > 0) {
      /* Refused rather than dropped: answering the words alone would answer a
         question about a picture the model never received. */
      throw fail('LOCAL_NODE_IMAGES_UNSUPPORTED', 'This local model session cannot take images yet, so nothing was sent.');
    }
    if (!text.trim() || text.length > MAX_PROMPT_CHARS) {
      throw fail('LOCAL_NODE_INPUT_INVALID', `A turn for a local model must contain 1 through ${MAX_PROMPT_CHARS} characters.`, {
        characters: text.length, limit: MAX_PROMPT_CHARS
      });
    }
    const instructions = sessionInstructions === undefined ? undefined : copySessionInstructions(sessionInstructions);
    this.threadId = threadId;

    const turnId = randomUUID();
    const turn = {
      turnId,
      threadId,
      controller: new AbortController(),
      text: '',
      /* One ROUND is one request to the model. A turn with tool calls is
         several rounds; the text and calls of the round in flight live here
         until the round is committed to the history. */
      roundText: '',
      roundToolCalls: [],
      roundUsage: null,
      roundPending: false,
      thinking: '',
      thinkingEmitted: false,
      accepted: false,
      done: null,
      usage: null,
      runtimeError: null,
      error: null,
      timedOut: false,
      closing: false,
      settled: false,
      waiters: [],
      timer: null,
      resolve: null,
      reject: null
    };
    const promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    turn.timer = setTimeout(() => {
      if (this.activeTurn === turn) {
        turn.timedOut = true;
        turn.controller.abort();
      }
    }, this.turnTimeoutMs);
    if (turn.timer.unref) turn.timer.unref();
    this.activeTurn = turn;

    /* The question joins the history before the request is made, so an
       interrupted answer is remembered beside what it was answering. */
    if (instructions !== undefined) record.sessionInstructions = instructions;
    record.turnReceipt = { version: 1, turnId, status: 'pending' };
    record.messages.push({ role: 'user', content: text, turnId });
    boundHistory(record);
    try { this.saveThread(threadId, record); } catch (error) {
      this.finishTurn(turn, record, { threadId, turnId }, 'error', error);
      return promise;
    }
    this.runTurn(turn, record);
    return promise;
  }

  /* The tools the model is offered, in Ollama's function-calling shape --
     the servers' own names, descriptions and input schemas, verbatim. */
  toolsForModel(surface = this.tools) {
    return surface ? surface.list().map(wireTool) : [];
  }

  /* ONE TURN IS ONE OR MORE ROUNDS. Each round streams one reply. A reply
     that names tools is committed to the history with its calls, every call
     is made through the surface and answered into the history as a `tool`
     message, and the model is asked again with those answers in front of
     it; a reply that names none is the answer, and the turn ends. The
     rounds are bounded (MAX_TOOL_ROUNDS) so a looping model ends in a
     sentence. */
  async runTurn(turn, record) {
    const base = { threadId: turn.threadId, turnId: turn.turnId };
    const signal = turn.controller.signal;
    let outcome;
    try {
      const surface = createLocalToolView(this.tools, record, this.runtimeOptions.contextTokens);
      for (let round = 1; ; round += 1) {
        const toolsForModel = this.toolsForModel(surface);
        turn.roundText = '';
        turn.roundToolCalls = [];
        turn.roundUsage = null;
        turn.roundPending = true;
        turn.thinking = '';
        turn.thinkingEmitted = false;
        turn.done = null;
        await this.transport.chat({
          model: record.model,
          messages: wireMessages(record),
          stream: true,
          ...localOptions.requestFields(this.runtimeOptions, this.maxOutputTokens),
          ...(toolsForModel.length ? { tools: toolsForModel } : {})
        }, {
          signal,
          onAccepted: () => {
            if (turn.accepted || turn.settled) return;
            turn.accepted = true;
            this.emit({ type: 'turn_accepted', ...base });
          },
          onPacket: packet => this.handlePacket(turn, packet, base)
        });
        if (turn.roundUsage) turn.usage = turn.usage ? addUsage(turn.usage, turn.roundUsage) : turn.roundUsage;
        if (signal.aborted) { outcome = 'interrupted'; break; }
        if (turn.runtimeError) {
          outcome = 'error';
          turn.error = fail('LOCAL_NODE_HTTP', 'The local model runtime reported a failure.', { error: turn.runtimeError });
          break;
        }
        if (!turn.done) {
          outcome = 'error';
          turn.error = fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model runtime closed the stream before finishing the answer.');
          break;
        }
        if (turn.roundToolCalls.length === 0 || !this.tools) {
          if (!turn.roundText.trim()) {
            outcome = 'error';
            turn.error = turn.done.reason === 'length' && turn.thinking.trim()
              ? fail('LOCAL_NODE_OUTPUT_BUDGET_SPENT', 'The local model spent its output budget on reasoning before it could answer. Choose Fast in local model settings or increase the output budget.')
              : fail('LOCAL_NODE_RESPONSE_INVALID', 'The local model finished without returning an answer.');
          } else outcome = 'success';
          break;
        }

        /* A TOOL ROUND. The reply goes into the history WITH its calls, so
           the model's next request shows it what it asked for. */
        this.commitRound(turn, record, base, turn.roundToolCalls);
        let stopped = false;
        for (const call of turn.roundToolCalls) {
          this.emit({ type: 'tool_call', ...base, toolCallId: call.id, tool: call.name, payload: call.arguments });
          let result;
          try {
            result = await surface.call(call.name, call.arguments, { signal });
          } catch (error) {
            if (signal.aborted) { stopped = true; break; }
            result = { text: failureSentence(error), isError: true };
          }
          const status = result.isError ? 'error' : 'ok';
          this.emit({
            type: 'tool_result', ...base, toolCallId: call.id, tool: call.name,
            text: result.text, payload: { text: result.text, status }, status
          });
          record.messages.push({ role: 'tool', content: result.text, turnId: turn.turnId, tool_name: call.name });
          boundHistory(record);
          this.saveThread(turn.threadId, record);
        }
        if (stopped || signal.aborted) { outcome = 'interrupted'; break; }
        if (round >= MAX_TOOL_ROUNDS) {
          outcome = 'error';
          turn.error = fail('LOCAL_NODE_TOOL_ROUNDS_EXCEEDED',
            `The local model called tools ${round} times in one turn without finishing its answer, so the turn was stopped.`,
            { rounds: round });
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) outcome = 'interrupted';
      else { outcome = 'error'; turn.error = error; }
    }
    this.finishTurn(turn, record, base, outcome);
  }

  /* The round's reply, said and remembered: one assistant_text when it had
     words, one assistant message in the history (carrying its tool calls
     when it made any). */
  commitRound(turn, record, base, toolCalls = []) {
    if (!turn.roundPending) return;
    turn.roundPending = false;
    this.flushThinking(turn, base);
    if (turn.roundText) {
      this.emit({ type: 'assistant_text', ...base, text: turn.roundText });
      turn.text = turn.text ? `${turn.text}\n${turn.roundText}` : turn.roundText;
    }
    if (turn.roundText || toolCalls.length) {
      record.messages.push({
        role: 'assistant',
        content: turn.roundText,
        turnId: turn.turnId,
        ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) } : {})
      });
    }
  }

  handlePacket(turn, packet, base) {
    if (turn.settled || !packet || typeof packet !== 'object') return;
    if (typeof packet.error === 'string' && packet.error) {
      turn.runtimeError = packet.error;
      return;
    }
    const message = packet.message;
    if (message && typeof message === 'object') {
      if (typeof message.thinking === 'string' && message.thinking) turn.thinking += message.thinking;
      if (typeof message.content === 'string' && message.content) {
        this.flushThinking(turn, base);
        turn.roundText += message.content;
        this.emit({ type: 'assistant_text_delta', ...base, text: message.content });
      }
      /* MEASURED shape (Ollama 0.33): message.tool_calls[].function = { name,
         arguments } with `arguments` already an object; some builds add an
         `id`. A string is parsed; an unreadable one is handed over whole so
         the model sees what it produced. */
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const fn = call && typeof call === 'object' ? call.function : null;
          if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = { input: args }; }
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
          turn.roundToolCalls.push({
            id: typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}`,
            name: fn.name,
            arguments: args
          });
        }
      }
    }
    if (packet.done === true) {
      turn.done = { reason: typeof packet.done_reason === 'string' ? packet.done_reason : null };
      turn.roundUsage = usageOfPacket(packet);
    }
  }

  /* One thinking event per block, forwarded as its own type and never as
     assistant speech -- the same rule the Claude adapter keeps. */
  flushThinking(turn, base) {
    if (turn.thinkingEmitted || !turn.thinking) return;
    turn.thinkingEmitted = true;
    this.emit({ type: 'thinking', ...base, text: turn.thinking });
  }

  finishTurn(turn, record, base, outcome, initialError = null) {
    if (turn.settled) return;
    turn.settled = true;
    if (initialError) turn.error = initialError;
    clearTimeout(turn.timer);
    if (this.activeTurn === turn) this.activeTurn = null;
    const waiters = turn.waiters;
    turn.waiters = [];

    if (turn.closing) {
      if (!record.messages.some(message => message.turnId === turn.turnId && message.role !== 'user')) {
        record.messages = record.messages.filter(message => message.turnId !== turn.turnId);
      }
      record.turnReceipt = settledReceipt(record, turn.turnId, 'interrupted');
      try { this.saveThread(turn.threadId, record); } catch (error) { this.emitDiagnostic(error); }
      for (const waiter of waiters) waiter.reject(fail('LOCAL_NODE_CLOSED', 'This local model session was closed while a stop request was pending.'));
      turn.reject(fail('LOCAL_NODE_CLOSED', 'This local model session was closed while a turn was running.'));
      return;
    }
    if (turn.timedOut) {
      if (!record.messages.some(message => message.turnId === turn.turnId && message.role !== 'user')) {
        record.messages = record.messages.filter(message => message.turnId !== turn.turnId);
      }
      record.turnReceipt = settledReceipt(record, turn.turnId, 'interrupted');
      try { this.saveThread(turn.threadId, record); } catch (error) { this.emitDiagnostic(error); }
      for (const waiter of waiters) waiter.reject(fail('LOCAL_NODE_TURN_TIMEOUT', 'The local model did not finish this turn in time.'));
      turn.reject(fail('LOCAL_NODE_TURN_TIMEOUT', 'The local model did not finish this turn in time.'));
      return;
    }

    /* The round in flight -- the final one on success, a partial one on an
       interrupt -- is said and remembered like every round before it. Tool
       calls it named but never ran are dropped: nothing was called. */
    this.commitRound(turn, record, base, []);
    const answered = record.messages.some(message => message.turnId === turn.turnId && message.role !== 'user');
    if (outcome === 'error' && !answered) {
      /* An unanswered question is not left for the next turn to repeat. */
      record.messages = record.messages.filter(message => message.turnId !== turn.turnId);
    }
    boundHistory(record);
    record.turnReceipt = settledReceipt(record, turn.turnId, outcome);

    /* USAGE BEFORE COMPLETION, and the figures are the runtime's own or
       absent -- never synthesised. An interrupted stream carries no done
       packet and therefore no counts. */
    if (turn.usage) {
      record.usage = {
        total: addUsage(record.usage ? record.usage.total : zeroUsage(), turn.usage),
        last: { ...turn.usage }
      };
      this.emit({ type: 'usage', ...base, usage: { total: { ...record.usage.total }, last: { ...record.usage.last } } });
    }
    try { this.saveThread(turn.threadId, record); } catch (error) {
      outcome = 'error';
      turn.error = error;
      // The disk still has pending custody. A warm resume must not read a
      // successful in-memory receipt for a completion we could not save.
      record.turnReceipt = settledReceipt(record, turn.turnId, 'error');
    }
    const failureText = outcome === 'error' ? failureSentence(turn.error) : null;
    this.emit({ type: 'turn_completed', ...base, status: outcome, ...(failureText ? { text: failureText } : {}) });

    for (const waiter of waiters) waiter.resolve({ turnId: turn.turnId, status: outcome });
    turn.resolve(Object.freeze({
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: outcome,
      isError: outcome === 'error',
      text: turn.text || null,
      usage: turn.usage ? Object.freeze({ ...turn.usage }) : null,
      ...(failureText ? { failure: failureText } : {})
    }));
  }

  /* AN INTERRUPT ABORTS THE HTTP REQUEST AND KEEPS THE THREAD. Destroying the
     request is what stops the runtime generating (Ollama stops on a closed
     connection); the conversation, with the words already streamed, stays in
     the registry for the next turn. Resolves once the turn has actually
     settled, so a caller that continues afterwards never races the abort. */
  // Cancellation ownership does not assert provider acceptance.
  pendingTurnForInterrupt({ threadId } = {}) {
    const turn = this.activeTurn;
    if (this.closed || !turn || turn.settled || turn.threadId !== threadId) return null;
    return Object.freeze({ threadId, turnId: turn.turnId });
  }

  async interrupt(request = {}) {
    const turn = this.activeTurn;
    if (!turn) throw fail('LOCAL_NODE_NO_TURN', 'There is nothing running in this session to stop.');
    if ((request.threadId !== undefined && request.threadId !== turn.threadId)
        || (request.turnId !== undefined && request.turnId !== turn.turnId)) {
      throw fail('LOCAL_NODE_NO_TURN', 'That turn is not the one this session is running.', { turnId: request.turnId });
    }
    const answered = new Promise((resolve, reject) => {
      turn.waiters.push({ resolve, reject });
      const timer = setTimeout(() => {
        const index = turn.waiters.findIndex(waiter => waiter.resolve === resolve);
        if (index >= 0) {
          turn.waiters.splice(index, 1);
          reject(fail('LOCAL_NODE_INTERRUPT_UNANSWERED', 'The local model runtime did not let go of the request in time.'));
        }
      }, INTERRUPT_ANSWER_MS);
      if (timer.unref) timer.unref();
    });
    turn.controller.abort();
    return answered;
  }

  /* NO APPROVALS, AND THE REFUSAL IS THE SAFE DIRECTION: a local model session
     asks nobody for permission because it is given nothing that needs one. An
     unconfigured approval path denies, it never permits. */
  async answerApproval(answer) {
    validateApprovalAnswer(answer);
    throw fail('LOCAL_NODE_APPROVALS_UNSUPPORTED', 'This local model session does not ask for approvals.');
  }

  /* The runtime's own counts for the thread, accumulated across its turns, or
     null when no turn has completed. Never zeroes for "unknown". */
  getUsage(threadId) {
    const id = threadId === undefined ? this.threadId : validateThreadId(threadId);
    const record = id ? THREADS.get(id) : null;
    if (!record || !record.usage) return null;
    return Object.freeze({ total: Object.freeze({ ...record.usage.total }), last: Object.freeze({ ...record.usage.last }) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const turn = this.activeTurn;
    if (turn) {
      turn.closing = true;
      turn.controller.abort();
    }
  }
}

module.exports = {
  DEFAULT_TURN_TIMEOUT_MS,
  LocalNodeAdapter,
  MAX_HISTORY_MESSAGES,
  MAX_THREADS_HELD,
  MAX_TOOL_ROUNDS,
  assertLocalNodeAdapter: adapter => assertEngineAdapter(adapter),
  /* For tests and diagnostics only: whether this process still holds a thread. */
  holdsThread: threadId => THREADS.has(threadId),
  savedThread: (threadId, store) => threadRecord(threadId, store)
};
