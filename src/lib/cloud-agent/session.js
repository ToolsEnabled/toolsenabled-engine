'use strict';

// The provider-neutral cloud-agent core: one CloudAgentSession binds exactly
// one validated request to exactly one dependency-injected adapter and
// enforces the contract (src/lib/cloud-agent/contract.js) and state machine
// (src/lib/cloud-agent/state-machine.js) around every call. It never touches
// fs, network, or a child process itself -- an adapter is required at
// construction and every external effect goes through it.
//
// Safety invariants a reader should be able to check by inspection:
//   - adapter.submit is called from exactly one place (submit()), guarded by
//     a strict READY precondition and an idempotent early return; nothing in
//     this file calls it again after a timeout or from reconcile()/inspect().
//   - a timed-out call from an IN-FLIGHT state is absorbed into state
//     UNKNOWN, never guessed toward SUCCEEDED or FAILED, and the original
//     (possibly still in-flight) promise is never awaited into the session's
//     own result. From a TERMINAL state (a fixed point in the state machine)
//     a timed-out observation refuses with CLOUD_AGENT_OBSERVE_TIMEOUT and
//     changes nothing — absorbing it would regress a terminal state.
//   - `reconciled` is set true in exactly one place (#evaluateReconciliation,
//     called only from reconcile()) and is invalidated whenever a new result
//     is stored — every successful inspect()/cancel()/reconcile() observation
//     and every absorbed UNKNOWN. A consumer that inspects after reconciling
//     must reconcile again before advancing; a bare provider-reported
//     SUCCEEDED is never enough.

const contract = require('./contract');
const stateMachine = require('./state-machine');
const { CloudAgentError } = require('./errors');

const REQUIRED_ADAPTER_METHODS = Object.freeze(['capabilities', 'bindEnvironment', 'submit', 'inspect', 'fetchChangeManifest', 'reconcile']);
const OPTIONAL_ADAPTER_METHODS = Object.freeze(['cancel']);

function assertAdapterShape(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new CloudAgentError('CLOUD_AGENT_ADAPTER_INVALID', 'A cloud-agent adapter object is required.');
  }
  for (const name of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[name] !== 'function') {
      throw new CloudAgentError('CLOUD_AGENT_ADAPTER_INVALID', `Adapter is missing required operation "${name}".`);
    }
  }
  for (const name of OPTIONAL_ADAPTER_METHODS) {
    if (adapter[name] !== undefined && typeof adapter[name] !== 'function') {
      throw new CloudAgentError('CLOUD_AGENT_ADAPTER_INVALID', `Adapter's optional operation "${name}" must be a function when present.`);
    }
  }
}

// A raced-out promise keeps running after this resolves "timed out"; its
// eventual settlement is still awaited here (so a rejection can never become
// an unhandled rejection) but is deliberately never fed into session state.
function settleWithinBudget(promise, timeoutMs) {
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
    guarded.then(
      value => { clearTimeout(timer); resolve({ timedOut: false, value }); },
      error => { clearTimeout(timer); resolve({ timedOut: false, error }); }
    );
  });
}

class CloudAgentSession {
  #adapter;
  #now;
  #state = 'UNBOUND';
  #request = null;
  #result = null;
  #reconciled = false;

  constructor({ adapter, now } = {}) {
    assertAdapterShape(adapter);
    this.#adapter = adapter;
    this.#now = typeof now === 'function' ? now : () => new Date().toISOString();
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      request: this.#request,
      result: this.#result,
      reconciled: this.#reconciled,
      canAdvance: stateMachine.canAdvance({ state: this.#state, reconciled: this.#reconciled })
    });
  }

  async capabilities() {
    const raw = await this.#adapter.capabilities();
    return contract.validateCapabilities(raw);
  }

  async bindEnvironment(requestInput) {
    if (this.#state !== 'UNBOUND') {
      throw new CloudAgentError('CLOUD_AGENT_ALREADY_BOUND', 'bindEnvironment may only be called once per session.');
    }
    const request = contract.validateRequest(requestInput);
    const ack = await this.#adapter.bindEnvironment(request);
    contract.validateEnvironmentAck(ack);
    this.#request = request;
    this.#state = stateMachine.afterBind(this.#state);
    return this.snapshot();
  }

  async submit() {
    this.#assertBound();
    if (this.#state !== 'READY') {
      // Idempotent replay: this session already submitted this exact bound
      // request. Return the cached outcome instead of calling the adapter
      // (and therefore the provider) a second time.
      if (this.#result) return this.snapshot();
      throw new CloudAgentError('CLOUD_AGENT_INVALID_STATE', `submit requires state READY, was ${this.#state}.`);
    }
    const outcome = await settleWithinBudget(
      Promise.resolve().then(() => this.#adapter.submit(this.#request)),
      this.#request.timeBudgetMs
    );
    if (outcome.timedOut) return this.#absorbUnknown('submit');
    // Promise rejections may legally carry a falsy reason. Test for the
    // settlement branch rather than the reason's truthiness so rejection
    // with undefined/null/false is not misreported as an invalid result.
    if (Object.prototype.hasOwnProperty.call(outcome, 'error')) throw outcome.error;
    const result = contract.validateResult(outcome.value);
    contract.assertResultMatchesRequest(this.#request, result);
    this.#state = stateMachine.afterSubmit(this.#state, result.state);
    this.#result = result;
    this.#reconciled = false;
    return this.snapshot();
  }

  async inspect() {
    return this.#observe(providerTaskId => this.#adapter.inspect(providerTaskId, this.#request), 'inspect');
  }

  async cancel() {
    this.#assertBound();
    if (typeof this.#adapter.cancel !== 'function') {
      throw new CloudAgentError('CLOUD_AGENT_CANCEL_UNSUPPORTED', 'This adapter does not support cancel.');
    }
    if (this.#state !== 'SUBMITTED' && this.#state !== 'RUNNING') {
      throw new CloudAgentError('CLOUD_AGENT_INVALID_STATE', `cancel requires SUBMITTED or RUNNING, was ${this.#state}.`);
    }
    return this.#observe(providerTaskId => this.#adapter.cancel(providerTaskId, this.#request), 'cancel');
  }

  // Only reconcile() may set `reconciled = true`, and only when the
  // provider-reported state is SUCCEEDED, the served model matches the
  // request's exact required model, and evidence hashes are actually
  // present -- a bare SUCCEEDED from inspect()/submit() is never enough.
  async reconcile() {
    await this.#observe(providerTaskId => this.#adapter.reconcile(providerTaskId, this.#request), 'reconcile');
    this.#reconciled = this.#evaluateReconciliation();
    return { ...this.snapshot(), blockedReason: this.#reconciled ? null : this.#blockedReason() };
  }

  async fetchChangeManifest() {
    this.#assertSubmitted();
    const raw = await this.#adapter.fetchChangeManifest(this.#taskId(), this.#request);
    const manifest = contract.validateManifest(raw);
    contract.assertManifestWithinBudget(this.#request, manifest);
    return manifest;
  }

  async #observe(call, opLabel) {
    this.#assertSubmitted();
    const outcome = await settleWithinBudget(
      Promise.resolve().then(() => call(this.#taskId())),
      this.#request.timeBudgetMs
    );
    if (outcome.timedOut) return this.#absorbUnknown(opLabel);
    if (Object.prototype.hasOwnProperty.call(outcome, 'error')) throw outcome.error;
    const result = contract.validateResult(outcome.value);
    contract.assertResultMatchesRequest(this.#request, result);
    this.#assertSameTask(result);
    this.#state = stateMachine.afterObserve(this.#state, result.state, opLabel);
    this.#result = result;
    // A new observation replaces the evidence `reconciled` was earned on, so
    // it must be re-earned against the CURRENT result. Without this reset a
    // post-reconcile inspect() that stored a weaker SUCCEEDED result (e.g.
    // empty evidenceHashes) left canAdvance() true on evidence nobody had
    // checked — the exact bypass the reconcile() gate exists to prevent.
    // reconcile() itself recomputes the flag immediately after this returns.
    this.#reconciled = false;
    return this.snapshot();
  }

  #absorbUnknown(opLabel) {
    // A terminal state is a fixed point (see OBSERVE_TRANSITIONS): absorbing
    // a timeout as UNKNOWN would regress it, and the ILLEGAL_TRANSITION that
    // used to escape from afterObserve here blamed the state machine instead
    // of naming the real event. Refuse with the truth — the observation timed
    // out, and the session's terminal state and result are unchanged.
    if (this.#state === 'SUCCEEDED' || this.#state === 'FAILED' || this.#state === 'CANCELLED') {
      throw new CloudAgentError('CLOUD_AGENT_OBSERVE_TIMEOUT',
        `${opLabel} timed out after ${this.#request.timeBudgetMs}ms; the session remains ${this.#state} and its result was not replaced.`);
    }
    const synthetic = contract.buildUnknownResult({ request: this.#request, previous: this.#result, now: this.#now });
    this.#state = this.#state === 'READY'
      ? stateMachine.afterSubmit(this.#state, 'UNKNOWN')
      : stateMachine.afterObserve(this.#state, 'UNKNOWN', opLabel);
    this.#result = synthetic;
    this.#reconciled = false;
    return this.snapshot();
  }

  #evaluateReconciliation() {
    const result = this.#result;
    if (!result || result.state !== 'SUCCEEDED') return false;
    if (result.servedModel !== this.#request.requiredModel) return false;
    if (result.evidenceHashes.length === 0) return false;
    return true;
  }

  #blockedReason() {
    const result = this.#result;
    if (!result) return 'NOT_SUBMITTED';
    if (result.state === 'UNKNOWN') return 'STATE_UNKNOWN';
    if (result.state === 'SUCCEEDED' && result.servedModel !== this.#request.requiredModel) return 'MODEL_MISMATCH';
    if (result.state === 'SUCCEEDED' && result.evidenceHashes.length === 0) return 'EVIDENCE_MISSING';
    if (result.state === 'FAILED' || result.state === 'CANCELLED') return 'NOT_SUCCEEDED';
    return 'NOT_TERMINAL';
  }

  #taskId() { return this.#result ? this.#result.providerTaskId : null; }

  #assertBound() {
    if (this.#state === 'UNBOUND') throw new CloudAgentError('CLOUD_AGENT_NOT_BOUND', 'bindEnvironment must be called first.');
  }

  #assertSubmitted() {
    this.#assertBound();
    if (!this.#result) throw new CloudAgentError('CLOUD_AGENT_NOT_SUBMITTED', 'submit must be called first.');
  }

  #assertSameTask(result) {
    const previousId = this.#taskId();
    if (previousId && result.providerTaskId && result.providerTaskId !== previousId) {
      throw new CloudAgentError('CLOUD_AGENT_TASK_ID_CHANGED', 'Adapter reported a different providerTaskId for the same session.');
    }
  }
}

module.exports = Object.freeze({ CloudAgentSession, assertAdapterShape });
