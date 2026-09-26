'use strict';

const ModelProviderInterface = require('../../src/providers/provider-interface');

function abortError(signal) {
  const reason = signal && signal.reason;
  const error = new Error(reason instanceof Error ? reason.message : 'Operation aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

function abortableDelay(delayMs, signal) {
  if (!delayMs) return Promise.resolve();
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Scripted fake model provider for deterministic agent testing.
 *
 * A script entry may be a normal normalized provider response, or use:
 * - `{ error, code?, delayMs? }` to reject.
 * - `{ response, delayMs? }` to return any raw value, including malformed data.
 */
class ScriptedFakeProvider extends ModelProviderInterface {
  constructor(scriptedResponses = []) {
    super();
    if (!Array.isArray(scriptedResponses)) {
      throw new TypeError('scriptedResponses must be an array');
    }
    this.scriptedResponses = [...scriptedResponses];
    this.receivedRequests = [];
  }

  async listModels() {
    return [
      { id: 'fake-model-8b', name: 'Fake Model 8B', capabilities: ['chat', 'tools'] }
    ];
  }

  async testCapability(model, capability) {
    return { ok: true, capability };
  }

  nextEntry() {
    if (this.scriptedResponses.length === 0) {
      const error = new Error('Scripted provider exhausted');
      error.code = 'SCRIPT_EXHAUSTED';
      throw error;
    }
    return this.scriptedResponses.shift();
  }

  async generate(request, signal) {
    throwIfAborted(signal);
    this.receivedRequests.push(request);
    const entry = this.nextEntry();
    await abortableDelay(entry && entry.delayMs, signal);
    throwIfAborted(signal);

    if (entry && Object.prototype.hasOwnProperty.call(entry, 'error')) {
      const error = entry.error instanceof Error ? entry.error : new Error(String(entry.error));
      if (entry.code) error.code = entry.code;
      throw error;
    }
    if (entry && Object.prototype.hasOwnProperty.call(entry, 'response')) {
      return entry.response;
    }
    return entry;
  }

  async *stream(request, signal) {
    throwIfAborted(signal);
    this.receivedRequests.push(request);
    const entry = this.nextEntry();
    await abortableDelay(entry && entry.delayMs, signal);
    throwIfAborted(signal);

    if (entry && Object.prototype.hasOwnProperty.call(entry, 'error')) {
      const error = entry.error instanceof Error ? entry.error : new Error(String(entry.error));
      if (entry.code) error.code = entry.code;
      throw error;
    }

    const response = entry && Object.prototype.hasOwnProperty.call(entry, 'response')
      ? entry.response
      : entry;
    if (!response || typeof response !== 'object') {
      throw new TypeError('Scripted stream response must be an object');
    }

    const chunks = typeof response.text === 'string' && response.text
      ? response.text.split(' ')
      : [];
    for (const chunk of chunks) {
      throwIfAborted(signal);
      yield { type: 'chunk', text: `${chunk} ` };
    }

    if (Array.isArray(response.toolCalls)) {
      for (const call of response.toolCalls) {
        throwIfAborted(signal);
        yield { type: 'tool_call', call };
      }
    }

    throwIfAborted(signal);
    yield { type: 'finish', finishReason: response.finishReason || 'stop' };
  }
}

module.exports = ScriptedFakeProvider;
