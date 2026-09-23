'use strict';

// The official agy stream-json protocol. Native conversation/model/tool
// identities must arrive before a prompt is admitted. It has no ACP or control
// messages; cancellation closes the owned process and resume opens that exact
// conversation in a fresh process.
const { randomUUID } = require('node:crypto');
const { assertEngineAdapter, validateEngineEvent, validateSendTurnRequest,
  validateThreadId, validateThreadOptions, validateApprovalAnswer } = require('./engine-contract');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const ANTIGRAVITY_MAX_TURN_MS = 24 * 60 * 60_000;
const ANTIGRAVITY_MAX_TRANSIENT_ERROR_STEPS = 2;

function turnLimitFailure() {
  return failure('AGY_CLI_TURN_TIMEOUT', 'Antigravity reached the maximum time for one turn.');
}

class AntigravityCliAdapter {
  constructor({ transport, model, tools, servers = [], assertBoundary = () => {}, agent, cwd, resumeThreadId = null,
    turnTimeoutMs = 30 * 60_000, maxTurnDurationMs = ANTIGRAVITY_MAX_TURN_MS }) {
    if (!transport || typeof transport.closeForStartupFailure !== 'function') throw new TypeError('Confirmed process cleanup is required');
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !tool)) throw new TypeError('Exact tool names are required');
    for (const limit of [turnTimeoutMs, maxTurnDurationMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > ANTIGRAVITY_MAX_TURN_MS) {
        throw new RangeError('Antigravity turn limits must be positive milliseconds, at most 24 hours.');
      }
    }
    this.transport = transport;
    this.expected = { model, tools: [...tools].sort(), servers, agent, cwd, resumeThreadId };
    this.assertBoundary = assertBoundary;
    this.turnTimeoutMs = turnTimeoutMs;
    this.maxTurnDurationMs = maxTurnDurationMs;
    this.listeners = new Set();
    this.buffer = '';
    this.threadId = null;
    this.activeTurn = null;
    this.closed = false;
    this.closingTurn = null;
    this.interruptRequested = false;
    this.capturedTerminalError = null;
    this.pendingCloseError = null;
    this.allowTerminalRefine = false;
    this.lastTurnNumber = null;
    this.lastUsage = null;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.unsubscribe = transport.onData((chunk, exit) => {
      if (chunk === null) {
        if (this.closingTurn) return;
        this.fail(failure('AGY_CLI_EXITED', 'Antigravity stopped before completing the conversation.'), false); return;
      }
      if (this.closed && !this.closingTurn) return;
      try {
        this.buffer += chunk;
        if (this.buffer.length > 4_000_000) throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity sent an oversized stream message.');
        let end;
        while ((end = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, end).trim();
          this.buffer = this.buffer.slice(end + 1);
          if (line) this.receive(JSON.parse(line));
        }
      } catch (error) { this.fail(error.code ? error : failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity sent an invalid stream message.')); }
    });
    assertEngineAdapter(this);
  }

  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value) {
    const event = validateEngineEvent(value);
    for (const listener of this.listeners) { try { listener(event); } catch { /* observer */ } }
  }
  terminalResultError(value) {
    const detail = typeof value.error === 'string' ? value.error.slice(0, 2000) : '';
    const limited = /quota|rate.?limit|resource.?exhausted|exhausted your|usage.?limit|too many requests|\b429\b|capacity/i.test(detail);
    return failure(limited ? 'AGY_CLI_RATE_LIMITED' : 'AGY_CLI_TURN_ERROR', (limited
      ? 'The Antigravity account has reached a provider usage limit.' : 'Antigravity reported an error for this turn.') + (detail ? ` ${detail}` : ''));
  }
  finishClose(error) {
    if (this.closingTurn == null && this.closed) return;
    this.closed = true;
    const turn = this.closingTurn;
    this.closingTurn = null;
    let chosen = this.pendingCloseError || error;
    if (this.interruptRequested) {
      chosen = failure('AGY_CLI_CLOSED', 'This Antigravity process is closed.');
    } else if (this.allowTerminalRefine && this.capturedTerminalError) {
      chosen = this.capturedTerminalError;
    }
    if (turn) turn.reject(chosen);
  }
  fail(error, cleanup = true) {
    if (this.closed && !this.closingTurn) return;
    if (this.closingTurn) {
      if (this.interruptRequested) {
        this.pendingCloseError = failure('AGY_CLI_CLOSED', 'This Antigravity process is closed.');
      }
      return;
    }
    this.closed = true;
    this.pendingCloseError = error;
    this.rejectReady(error);
    const turn = this.activeTurn;
    this.activeTurn = null;
    this.closingTurn = turn;
    if (turn) { clearTimeout(turn.timer); clearTimeout(turn.limitTimer); }
    if (!cleanup) {
      this.finishClose(error);
      return;
    }
    this.cleanupPromise = this.transport.closeForStartupFailure().catch(cause => {
      this.cleanupError = cause;
      throw cause;
    }).finally(() => this.finishClose(error));
    this.cleanupPromise.catch(() => {});
  }

  receive(packet) {
    if (this.closed && !this.closingTurn) return;
    if (packet.event === 'init') {
      const init = packet.init;
      if (this.threadId || !init || !Array.isArray(init.tools)
        || init.model !== this.expected.model || init.agent !== this.expected.agent
        || init.cwd !== this.expected.cwd || init.permission_mode !== 'request-review') {
        throw failure('AGY_CLI_BOUNDARY_UNCONFIRMED', 'Antigravity did not confirm the selected model and Research tool boundary.');
      }
      // init.tools is an advertised catalog. The generated native agent and
      // fixed MCP registration enforce the effective tool surface.
      this.assertBoundary();
      const id = validateThreadId(packet.conversation_id);
      if (this.expected.resumeThreadId && id !== this.expected.resumeThreadId) {
        throw failure('AGY_CLI_RESUME_MISMATCH', 'Antigravity opened a different conversation from the one selected.');
      }
      this.threadId = id;
      this.resolveReady(Object.freeze({ threadId: id }));
      return;
    }
    if (!this.threadId) throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity did not identify its conversation before sending output.');
    const value = packet[packet.event];
    if (!value || value.conversation_id !== this.threadId) {
      if (this.closingTurn) return;
      throw failure('AGY_CLI_RESUME_MISMATCH', 'Antigravity output belongs to a different conversation.');
    }
    if (this.closingTurn) {
      if (packet.event === 'result' && value.status === 'ERROR'
        && Number.isSafeInteger(value.num_turns) && value.num_turns >= 1
        // A resumed process has no observed counter baseline until its first
        // result. Use the same native counter rule as normal terminal results.
        && (this.lastTurnNumber === null || value.num_turns === this.lastTurnNumber + 1)) {
        this.capturedTerminalError = this.terminalResultError(value);
      }
      return;
    }
    const turn = this.activeTurn;
    if (!turn) throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity sent turn output without an active request.');
    // Also check elapsed time here: a delayed event loop must not admit a
    // queued native SUCCESS ahead of the deadline timer's cleanup callback.
    if (performance.now() >= turn.deadline) throw turnLimitFailure();
    const base = { threadId: this.threadId, turnId: turn.turnId };
    if (packet.event === 'step_update') {
      if (!Number.isSafeInteger(value.step_index) || value.step_index < 0 || !['ACTIVE', 'DONE', 'ERROR'].includes(value.state)) {
        throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity sent an invalid turn step.');
      }
      if (value.step_type === 'user_input') {
        if (!turn.accepted) { turn.accepted = true; turn.timer.refresh?.(); this.emit({ type: 'turn_accepted', ...base }); }
        return;
      }
      if (!turn.accepted) throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity sent output before accepting the current request.');
      if (value.step_type === 'error_message') {
        if (!turn.errorStepIndexes.has(value.step_index)) {
          turn.errorStepIndexes.add(value.step_index);
          turn.consecutiveErrorSteps += 1;
          if (turn.consecutiveErrorSteps >= ANTIGRAVITY_MAX_TRANSIENT_ERROR_STEPS) {
            this.allowTerminalRefine = true;
            this.fail(failure('AGY_CLI_TURN_ERROR', 'Antigravity reported an error for this turn.'));
          }
        }
        return;
      }
      if (value.step_type === 'agent_response' && typeof value.text_delta === 'string') {
        // Real written output renews the silence limit; empty deltas cannot.
        if (value.text_delta) {
          turn.timer.refresh?.();
          turn.consecutiveErrorSteps = 0;
        }
        this.emit({ type: 'assistant_text_delta', ...base, text: value.text_delta });
        return;
      }
      if (value.step_type === 'tool') {
        turn.timer.refresh?.();
        const tool = value.tool_name || value.tool_info?.name;
        if (!this.expected.tools.includes(tool) || !this.expected.servers.includes(value.tool_info?.parameters?.ServerName)) throw failure('AGY_CLI_BOUNDARY_UNCONFIRMED', 'Antigravity attempted a tool outside the Research boundary.');
        const itemId = String(value.step_index);
        if (!turn.tools.has(itemId)) {
          turn.tools.add(itemId);
          turn.consecutiveErrorSteps = 0;
          this.emit({ type: 'tool_call', ...base, itemId, toolCallId: itemId, tool,
            ...(value.tool_info?.parameters === undefined ? {} : { payload: value.tool_info.parameters }) });
        }
        if (['DONE', 'ERROR'].includes(value.state) && !turn.completedTools.has(itemId)) {
          turn.completedTools.add(itemId);
          this.emit({ type: 'tool_result', ...base, itemId, toolCallId: itemId, tool,
            status: value.state === 'ERROR' || value.tool_info?.error ? 'error' : 'ok', payload: value.tool_info || {} });
        }
      }
      return;
    }
    if (packet.event !== 'result' || !['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID'].includes(value.status)
      || !Number.isSafeInteger(value.num_turns) || value.num_turns < 1
      || (this.lastTurnNumber !== null && value.num_turns !== this.lastTurnNumber + 1)
      || (!turn.accepted && value.status === 'SUCCESS')) {
      throw failure('AGY_CLI_PROTOCOL_INVALID', 'Antigravity did not confirm a terminal result for the current request.');
    }
    this.lastTurnNumber = value.num_turns;
    if (value.usage && typeof value.usage === 'object') {
      this.lastUsage = value.usage;
      // Native counters are cumulative. Emit the native total once per result;
      // never sum step counters into it or relabel it as per-turn consumption.
      this.emit({ type: 'usage', ...base, usage: value.usage });
    }
    if (typeof value.response === 'string' && value.response) this.emit({ type: 'assistant_text', ...base, text: value.response });
    const status = value.status === 'SUCCESS' ? 'completed'
      : ['CANCELED', 'INTERRUPTED'].includes(value.status) ? 'interrupted' : 'error';
    this.activeTurn = null;
    clearTimeout(turn.timer);
    clearTimeout(turn.limitTimer);
    if (status === 'error') {
      // A provider error result is a failed turn, not a completion. Reject it
      // with a typed code: the host then reports turn_completed {failed, code},
      // so an exhausted allowance is recognizable without parsing prose later.
      turn.reject(this.terminalResultError(value));
      return;
    }
    this.emit({ type: 'turn_completed', ...base, status,
      ...(typeof value.error === 'string' ? { text: value.error } : {}) });
    turn.resolve(Object.freeze({ ...base, status, isError: status === 'error', text: value.response || null, usage: this.lastUsage }));
  }

  async startThread(options = {}) { validateThreadOptions(options); return this.ready; }
  async resumeThread(threadId, options = {}) {
    validateThreadOptions(options);
    if (validateThreadId(threadId) !== this.expected.resumeThreadId) throw failure('AGY_CLI_RESUME_MISMATCH', 'This process was not opened for that conversation.');
    const started = await this.ready;
    return Object.freeze({ ...started, turns: Object.freeze([]) });
  }
  async forkThread() { throw failure('AGY_CLI_FORK_UNSUPPORTED', 'Antigravity does not expose conversation forks through its stream interface.'); }
  async sendTurn(request) {
    const { threadId, text, images, options } = validateSendTurnRequest(request);
    if (Object.keys(options).length) throw failure('AGY_CLI_OPTIONS_UNSUPPORTED', 'Choose Antigravity model and effort when starting a conversation; no turn settings were changed.');
    if (this.closed || this.closingTurn || !this.threadId) throw failure('AGY_CLI_CLOSED', 'Antigravity has not opened this conversation.');
    if (threadId !== this.threadId) throw failure('AGY_CLI_RESUME_MISMATCH', 'That conversation is not held by this process.');
    if (this.activeTurn) throw failure('AGY_CLI_TURN_ACTIVE', 'Antigravity is already working on a turn.');
    if (images.length) throw failure('AGY_CLI_IMAGES_UNSUPPORTED', 'Antigravity stream input supports text only; nothing was sent.');
    this.assertBoundary();
    const turnId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(failure('AGY_CLI_TURN_TIMEOUT', 'Antigravity did not finish this turn in time.')), this.turnTimeoutMs);
      const limitTimer = setTimeout(() => this.fail(turnLimitFailure()), this.maxTurnDurationMs);
      timer.unref?.();
      limitTimer.unref?.();
      this.activeTurn = { turnId, resolve, reject, timer, limitTimer,
        deadline: performance.now() + this.maxTurnDurationMs,
        accepted: false, errorStepIndexes: new Set(), consecutiveErrorSteps: 0,
        tools: new Set(), completedTools: new Set() };
    });
    try { this.transport.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n'); }
    catch (error) { this.fail(error); }
    return promise;
  }
  async interrupt() {
    if (!this.activeTurn && !this.closingTurn) throw failure('AGY_CLI_NO_TURN', 'There is no Antigravity turn to stop.');
    this.interruptRequested = true;
    const base = { threadId: this.threadId, turnId: (this.activeTurn || this.closingTurn).turnId };
    // No control_request is supported by this protocol. Do not report Stop
    // until the existing process custodian proves the whole job has closed.
    await this.close();
    this.emit({ type: 'turn_completed', ...base, status: 'interrupted' });
    return Object.freeze({ ...base, status: 'interrupted', requiresResume: true });
  }
  async answerApproval(answer) {
    validateApprovalAnswer(answer);
    throw failure('AGY_CLI_APPROVALS_UNSUPPORTED', 'Research permissions are fixed when Antigravity starts.');
  }
  async getUsage() { return this.lastUsage; }
  async close() {
    this.fail(failure('AGY_CLI_CLOSED', 'This Antigravity process is closed.'), false);
    this.unsubscribe?.();
    if (this.cleanupPromise) {
      try { await this.cleanupPromise; return; } catch { this.cleanupPromise = null; }
    }
    this.cleanupPromise = this.transport.closeForStartupFailure();
    await this.cleanupPromise;
  }
}

module.exports = { AntigravityCliAdapter, ANTIGRAVITY_MAX_TURN_MS, ANTIGRAVITY_MAX_TRANSIENT_ERROR_STEPS, failure };
