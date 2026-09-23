'use strict';

const defaultLimits = require('./loop-limits');
const { isMediatedAgentToolExecutor } = require('../lib/tool-registry');

const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});
const COMPLETE_FINISH_REASONS = new Set(['stop', 'completed', 'end_turn']);
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return String(error || 'Unknown error');
}

function makeAbortError(reason) {
  const error = new Error(errorMessage(reason || 'Operation aborted'));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function validateLimits(limits) {
  const integerLimits = ['maxCycles', 'maxToolCalls', 'maxConsecutiveFailures'];
  for (const key of integerLimits) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1) {
      throw new TypeError(`${key} must be a positive integer`);
    }
  }
  if (!Number.isFinite(limits.maxWallClockMs) || limits.maxWallClockMs <= 0) {
    throw new TypeError('maxWallClockMs must be a positive number');
  }
}

function validateProviderResponse(response) {
  if (!isPlainObject(response)) {
    return { ok: false, message: 'Provider response must be an object' };
  }
  if (typeof response.text !== 'string') {
    return { ok: false, message: 'Provider response text must be a string' };
  }

  const toolCalls = response.toolCalls === undefined ? [] : response.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return { ok: false, message: 'Provider response toolCalls must be an array' };
  }

  const normalizedCalls = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    if (!isPlainObject(call)) {
      return { ok: false, message: `Tool call at index ${index} must be an object` };
    }
    if (typeof call.name !== 'string' || !call.name.trim()) {
      return { ok: false, message: `Tool call at index ${index} must have a non-empty name` };
    }
    if (!isPlainObject(call.args)) {
      return { ok: false, message: `Tool call '${call.name}' args must be an object` };
    }
    let serializedArgs;
    try {
      serializedArgs = JSON.stringify(call.args);
    } catch {
      return { ok: false, message: `Tool call '${call.name}' args must be JSON serializable` };
    }
    normalizedCalls.push({
      ...call,
      name: call.name.trim(),
      args: JSON.parse(serializedArgs)
    });
  }

  if (toolCalls.length === 0 && !response.text.trim()) {
    return { ok: false, message: 'Provider response must contain text or at least one tool call' };
  }
  if (
    response.finishReason !== undefined &&
    response.finishReason !== null &&
    (typeof response.finishReason !== 'string' || !response.finishReason.trim())
  ) {
    return { ok: false, message: 'Provider response finishReason must be a non-empty string' };
  }

  return {
    ok: true,
    value: {
      ...response,
      text: response.text,
      toolCalls: normalizedCalls,
      finishReason: typeof response.finishReason === 'string'
        ? response.finishReason.trim().toLowerCase()
        : null
    }
  };
}

function serializeToolResult(result) {
  if (result === undefined) {
    throw new TypeError('Tool returned undefined');
  }
  if (typeof result === 'string') return result;
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new TypeError('Tool result is not JSON serializable');
  }
  return serialized;
}

// "Not supplied" is undefined or null, and nothing else.
//
// This used to skip on `!executor`, which also waved through 0, '', NaN and
// false. No falsy value can carry a callable .execute, so that was never a live
// bypass -- dispatch failed closed one line later at TOOL_EXECUTOR_UNAVAILABLE.
// But it made a wiring bug (a config read that returned '' or 0 where an
// executor belonged) indistinguishable from "this worker has no executor", and
// it surfaced as a mid-run terminal reason instead of at the wiring site. A
// non-nullish value in an executor slot is always a mistake, so it is refused
// here, where the mistake was made.
function assertMediatedToolExecutor(executor, source) {
  if (executor === undefined || executor === null) return;
  if (isMediatedAgentToolExecutor(executor)) return;
  const error = new TypeError(
    `${source} must be created by createAgentToolExecutor() so every dispatch reaches executeTool()`
  );
  error.code = 'UNMEDIATED_TOOL_EXECUTOR';
  throw error;
}

function createAbortContext(externalSignal, maxWallClockMs) {
  const controller = new AbortController();
  let abortKind = null;

  const abort = (kind, reason) => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort(makeAbortError(reason));
  };

  const onExternalAbort = () => abort('external', externalSignal.reason || 'AbortSignal requested');
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timeout = setTimeout(() => {
    abort('deadline', `Wall clock budget of ${maxWallClockMs}ms exceeded`);
  }, maxWallClockMs);

  return {
    signal: controller.signal,
    getAbortKind: () => abortKind,
    cleanup() {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
}

async function awaitWithSignal(factory, signal) {
  if (signal.aborted) throw makeAbortError(signal.reason);

  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(makeAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      aborted
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs one bounded in-memory agent session.
 *
 * Tool executor contract:
 *   execute(name, args, { signal }) -> JSON-serializable result
 *
 * An executor must check `signal` before committing a side effect and honor it
 * during cancellable work. AgentWorker races every await so the run terminates
 * promptly, but JavaScript cannot undo side effects from an executor that
 * ignores its signal.
 */
class AgentWorker {
  constructor(options = {}) {
    this.limits = { ...defaultLimits, ...(options.limits || {}) };
    validateLimits(this.limits);
    assertMediatedToolExecutor(options.toolRegistry, 'toolRegistry');
    assertMediatedToolExecutor(options.toolExecutor, 'toolExecutor');
    this.toolRegistry = options.toolRegistry || null;
    this.toolExecutor = options.toolExecutor || null;
  }

  async runCycle(input = {}, externalSignal) {
    const prompt = input.prompt;
    const provider = input.provider;
    const onEvent = typeof input.onEvent === 'function' ? input.onEvent : () => {};
    assertMediatedToolExecutor(input.toolExecutor, 'input.toolExecutor');
    const executor = input.toolExecutor || this.toolExecutor || this.toolRegistry;
    const history = [];
    let cycleCount = 0;
    let totalToolCalls = 0;
    let consecutiveProviderFailures = 0;
    let consecutiveToolFailures = 0;

    const emit = event => {
      try {
        onEvent(event);
      } catch {
        // Observers must not be able to terminate or alter a run.
      }
    };

    const terminal = (status, code, message, extra = {}) => {
      const result = {
        status,
        reason: message,
        terminalReason: { code, message },
        history,
        cycleCount,
        totalToolCalls,
        ...extra
      };

      if (status === STATUS.COMPLETED) {
        emit({ type: 'run_completed', result: result.result, terminalReason: result.terminalReason });
      } else if (status === STATUS.CANCELLED) {
        emit({ type: 'run_cancelled', reason: message, terminalReason: result.terminalReason });
      } else if (status === STATUS.BLOCKED) {
        emit({ type: 'budget_exceeded', reason: message, terminalReason: result.terminalReason });
      } else {
        emit({ type: 'run_failed', reason: message, terminalReason: result.terminalReason });
      }

      return result;
    };

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return terminal(STATUS.FAILED, 'INVALID_RUN_INPUT', 'prompt must be a non-empty string');
    }
    history.push({ role: 'user', content: prompt });

    if (!provider || typeof provider.generate !== 'function') {
      return terminal(STATUS.FAILED, 'PROVIDER_UNAVAILABLE', 'provider.generate must be available');
    }
    const abortContext = createAbortContext(externalSignal, this.limits.maxWallClockMs);
    const runSignal = abortContext.signal;
    emit({ type: 'run_started', prompt });

    const abortTerminal = () => {
      if (abortContext.getAbortKind() === 'deadline') {
        return terminal(
          STATUS.BLOCKED,
          'WALL_CLOCK_BUDGET_EXCEEDED',
          `Wall clock budget of ${this.limits.maxWallClockMs}ms exceeded`
        );
      }
      return terminal(STATUS.CANCELLED, 'RUN_CANCELLED', 'AbortSignal requested');
    };

    try {
      while (cycleCount < this.limits.maxCycles) {
        if (runSignal.aborted) return abortTerminal();

        cycleCount += 1;
        emit({ type: 'cycle_started', cycle: cycleCount });

        let rawResponse;
        try {
          rawResponse = await awaitWithSignal(
            () => provider.generate(
              { messages: JSON.parse(JSON.stringify(history)) },
              runSignal
            ),
            runSignal
          );
        } catch (error) {
          if (runSignal.aborted) return abortTerminal();

          consecutiveProviderFailures += 1;
          const message = errorMessage(error);
          emit({
            type: 'provider_error',
            error: message,
            consecutiveFailures: consecutiveProviderFailures
          });
          if (consecutiveProviderFailures >= this.limits.maxConsecutiveFailures) {
            return terminal(
              STATUS.FAILED,
              'PROVIDER_FAILURE_LIMIT',
              `Provider failed ${consecutiveProviderFailures} consecutive times: ${message}`
            );
          }
          continue;
        }

        const validated = validateProviderResponse(rawResponse);
        if (!validated.ok) {
          consecutiveProviderFailures += 1;
          emit({
            type: 'provider_response_invalid',
            error: validated.message,
            consecutiveFailures: consecutiveProviderFailures
          });
          if (consecutiveProviderFailures >= this.limits.maxConsecutiveFailures) {
            return terminal(
              STATUS.FAILED,
              'PROVIDER_RESPONSE_INVALID',
              `Provider returned ${consecutiveProviderFailures} consecutive invalid responses: ${validated.message}`
            );
          }
          continue;
        }

        consecutiveProviderFailures = 0;
        const response = validated.value;
        history.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls
        });

        if (response.toolCalls.length === 0) {
          if (TRUNCATED_FINISH_REASONS.has(response.finishReason)) {
            return terminal(
              STATUS.BLOCKED,
              'MODEL_OUTPUT_TRUNCATED',
              `Model stopped before completion with finishReason '${response.finishReason}'`
            );
          }
          if (!COMPLETE_FINISH_REASONS.has(response.finishReason)) {
            return terminal(
              STATUS.FAILED,
              'MODEL_FINISH_REASON_INVALID',
              response.finishReason
                ? `Model returned non-terminal finishReason '${response.finishReason}'`
                : 'Model terminal response is missing finishReason'
            );
          }
          return terminal(
            STATUS.COMPLETED,
            'MODEL_COMPLETED',
            'Model returned a terminal response',
            { result: response.text }
          );
        }

        if (!executor || typeof executor.execute !== 'function') {
          return terminal(
            STATUS.FAILED,
            'TOOL_EXECUTOR_UNAVAILABLE',
            'A real tool registry or executor with execute(name, args, options) is required for tool calls'
          );
        }

        for (const call of response.toolCalls) {
          if (runSignal.aborted) return abortTerminal();
          if (totalToolCalls >= this.limits.maxToolCalls) {
            return terminal(
              STATUS.BLOCKED,
              'TOOL_CALL_BUDGET_EXCEEDED',
              `Tool call budget of ${this.limits.maxToolCalls} reached`
            );
          }

          totalToolCalls += 1;
          emit({ type: 'tool_executing', name: call.name, args: call.args });

          let result;
          let toolFailed = false;
          try {
            // Executors receive the run signal and must honor it before any side
            // effect and while awaiting cancellable work. The race below makes
            // this worker return promptly, but cannot undo a non-cooperative
            // executor's side effects after cancellation.
            result = await awaitWithSignal(
              () => executor.execute(call.name, call.args, { signal: runSignal }),
              runSignal
            );
            serializeToolResult(result);
            if (
              isPlainObject(result) &&
              (result.ok === false || result.success === false)
            ) {
              toolFailed = true;
            }
          } catch (error) {
            if (runSignal.aborted) return abortTerminal();
            toolFailed = true;
            result = {
              ok: false,
              error: {
                code: error && error.code ? String(error.code) : 'TOOL_EXECUTION_FAILED',
                message: errorMessage(error)
              }
            };
          }

          let content;
          try {
            content = serializeToolResult(result);
          } catch (error) {
            toolFailed = true;
            result = {
              ok: false,
              error: {
                code: 'TOOL_RESULT_INVALID',
                message: errorMessage(error)
              }
            };
            content = JSON.stringify(result);
          }

          history.push({
            role: 'tool',
            name: call.name,
            content
          });

          if (toolFailed) {
            consecutiveToolFailures += 1;
            const failure = isPlainObject(result) && result.error
              ? result.error
              : { code: 'TOOL_REPORTED_FAILURE', message: 'Tool reported ok=false' };
            emit({
              type: 'tool_error',
              name: call.name,
              error: typeof failure === 'string' ? failure : failure.message,
              result,
              consecutiveFailures: consecutiveToolFailures
            });
            if (consecutiveToolFailures >= this.limits.maxConsecutiveFailures) {
              return terminal(
                STATUS.FAILED,
                'TOOL_FAILURE_LIMIT',
                `Tool execution failed ${consecutiveToolFailures} consecutive times`
              );
            }
          } else {
            consecutiveToolFailures = 0;
            emit({ type: 'tool_result', name: call.name, result });
          }
        }
      }

      return terminal(
        STATUS.BLOCKED,
        'CYCLE_BUDGET_EXCEEDED',
        `Cycle budget of ${this.limits.maxCycles} reached`
      );
    } finally {
      abortContext.cleanup();
    }
  }
}

AgentWorker.STATUS = STATUS;
AgentWorker.validateProviderResponse = validateProviderResponse;

module.exports = AgentWorker;
