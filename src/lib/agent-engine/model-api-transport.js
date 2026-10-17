'use strict';

// Shared Chat Completions, Responses and Messages transport for hosted or local
// endpoints. It implements LocalNodeAdapter's chat callbacks, not a tool
// executor. Subscription-native CLIs keep their separate engine adapters.
// Initial version requests one bounded, non-streaming completion per round.
// Protocol references:
// https://platform.claude.com/docs/en/api/messages/create
// https://developers.openai.com/api/docs/guides/function-calling
// https://docs.ollama.com/api/openai-compatibility
// https://docs.nvidia.com/nim/large-language-models/2.0.11/advanced-use-cases/tool-calling-and-mcp.html
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_MESSAGES = 1000;
const MAX_TOOLS = 1024;
const MAX_CALLS = 128;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;
const ID = /^[\x21-\x7e]{1,256}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(suffix, message) { return Object.assign(new Error(message), { code: `MODEL_API_${suffix}` }); }
function invalid() { throw fail('INPUT_INVALID', 'The model API request contains unsupported or ambiguous data. Nothing was sent.'); }
function responseInvalid() { throw fail('RESPONSE_INVALID', 'The model API returned an incomplete or invalid completion. No tool calls were delivered.'); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

// Copy plain JSON without invoking getters/toJSON, with finite traversal and
// encoded-size budgets before serialization. No source object is mutated.
function jsonData(value, maximum, bad = invalid) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const charge = amount => { bytes += amount; if (bytes > maximum) bad(); };
  function visit(item, depth) {
    if (++nodes > 50_000 || depth > 64) bad();
    if (item === null || typeof item === 'boolean') { charge(5); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) bad(); charge(32); return item; }
    if (typeof item === 'string') {
      if (item.length > maximum) bad();
      charge(Buffer.byteLength(JSON.stringify(item))); return item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) bad();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) bad();
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) bad();
    if (array && (item.length > 50_000 || keys.length !== item.length + 1)) bad();
    const output = array ? [] : Object.create(null);
    ancestors.add(item); charge(2);
    for (const key of array ? Array.from({ length: item.length }, (_, i) => String(i)) : keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) bad();
      charge(Buffer.byteLength(JSON.stringify(key)) + 2);
      output[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return output;
  }
  return visit(value, 0);
}

function endpointOf(value, protocol) {
  if (typeof value !== 'string') invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (typeof value !== 'string' || value.length > 4096 || value !== value.trim()
    || /[\x00-\x20\\]/.test(value) || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith(protocol === 'responses' ? '/responses' : protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions') || /%/.test(url.pathname)
    || !['http:', 'https:'].includes(url.protocol)) invalid();
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'host.openshell.internal'].includes(url.hostname)) {
    throw fail('ENDPOINT_INVALID', 'Model API HTTP endpoints must be loopback or host.openshell.internal; use HTTPS for hosted endpoints.');
  }
  return url;
}

function authorization(tokenEnv, placeholder, env) {
  if (tokenEnv === undefined && placeholder === undefined) return null;
  // A named host variable must be an own data property; never invoke an
  // accessor or fall back to another credential source.
  const descriptor = tokenEnv === undefined ? null : Object.getOwnPropertyDescriptor(env, tokenEnv);
  const token = tokenEnv === undefined ? placeholder : descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (typeof token !== 'string' || token.length < 1 || token.length > 8192 || /[^\x21-\x7e]/.test(token)) {
    throw fail('AUTH_INVALID', 'The explicitly configured model API credential is unavailable or invalid.');
  }
  if (token.startsWith('openshell:') && !/^openshell:resolve:env:[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(token)) {
    throw fail('AUTH_INVALID', 'The configured OpenShell model API placeholder is invalid.');
  }
  return token;
}

function responseItems(items, bad) {
  if (!Array.isArray(items) || items.length > MAX_MESSAGES) bad();
  const content = [], calls = [], ids = new Set();
  for (const item of items) {
    if (!item || (item.status !== undefined && item.status !== 'completed')) bad();
    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) bad();
      ids.add(item.id);
    }
    if (item.type === 'function_call') {
      if (Object.keys(item).some(key => !['type', 'id', 'status', 'call_id', 'name', 'arguments'].includes(key))) bad();
      calls.push({ type: 'function', id: item.call_id, function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)
        || Object.keys(item).some(key => !['type', 'id', 'status', 'role', 'content'].includes(key))) bad();
      for (const part of item.content) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') bad();
        content.push(part.text);
      }
    } else if (item.type === 'reasoning') {
      if (typeof item.id !== 'string' || !Array.isArray(item.summary)
        || item.summary.some(part => part?.type !== 'summary_text' || typeof part.text !== 'string')
        || (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string')
        || (item.content !== undefined && (!Array.isArray(item.content)
          || item.content.some(part => part?.type !== 'reasoning_text' || typeof part.text !== 'string')))
        || Object.keys(item).some(key => !['type', 'id', 'summary', 'encrypted_content', 'status', 'content'].includes(key))) bad();
    } else bad();
  }
  return { content: content.join(''), calls };
}

function prepare(body, config) {
  const source = jsonData(body, config.maxRequestBytes);
  if (!source || Array.isArray(source) || typeof source !== 'object'
    || Object.keys(source).some(key => !['model', 'messages', 'tools', 'stream', 'options', 'keep_alive', 'think',
      'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'tool_choice', 'parallel_tool_calls'].includes(key))
    || (source.model !== undefined && source.model !== config.model)
    || !Array.isArray(source.messages) || source.messages.length < 1 || source.messages.length > MAX_MESSAGES) invalid();
  const names = new Map(), offered = new Map();
  function wireName(name) {
    if (typeof name !== 'string' || !NAME.test(name)) invalid();
    const wire = `te_${hash(name).slice(0, 60)}`;
    if (names.has(wire) && names.get(wire) !== name) invalid();
    names.set(wire, name);
    return wire;
  }
  const tools = source.tools === undefined ? [] : source.tools;
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) invalid();
  const wireTools = tools.map(tool => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || !fn || typeof fn !== 'object' || Array.isArray(fn)
      || (fn.description !== undefined && typeof fn.description !== 'string')
      || !fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)
      || (fn.strict !== undefined && typeof fn.strict !== 'boolean')) invalid();
    const name = wireName(fn.name);
    if (offered.has(name)) invalid();
    offered.set(name, fn.name);
    return { type: 'function', function: { name, parameters: fn.parameters,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      ...(fn.strict === undefined ? {} : { strict: fn.strict }) } };
  });
  let pending = [];
  const ids = new Set();
  const messages = source.messages.map((message, index) => {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
      || Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id', 'tool_name', 'name', 'response_items'].includes(key))) invalid();
    const content = message.content;
    if (typeof content !== 'string' && !(message.role === 'assistant' && content === null)) invalid();
    if (message.response_items !== undefined && (config.protocol !== 'responses' || message.role !== 'assistant'
      || !Array.isArray(message.response_items) || message.response_items.length > MAX_MESSAGES)) invalid();
    if (message.role === 'tool') {
      if (message.tool_calls !== undefined || !pending.length) invalid();
      const resultName = message.tool_name ?? message.name;
      let position;
      if (message.tool_call_id !== undefined) {
        if (!ID.test(message.tool_call_id)) invalid();
        position = pending.findIndex(call => call.id === message.tool_call_id);
      } else {
        // Old Ollama histories have only tool_name. Their adapter executed
        // calls sequentially; preserve that declared order without guessing.
        if (pending[0].legacy !== true) invalid();
        position = 0;
      }
      const call = pending[position];
      if (!call || (resultName !== undefined && resultName !== call.name)) invalid();
      pending.splice(position, 1);
      return { role: 'tool', content, tool_call_id: call.id };
    }
    if (pending.length || message.tool_call_id !== undefined || message.tool_name !== undefined) invalid();
    const output = { role: message.role, content };
    if (message.name !== undefined) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(message.name)) invalid(); output.name = message.name; }
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)
        || !message.tool_calls.length || message.tool_calls.length > MAX_CALLS) invalid();
      output.tool_calls = message.tool_calls.map((call, ordinal) => {
        if (!call?.function || (call.type !== undefined && call.type !== 'function')) invalid();
        const name = call.function.name, wire = wireName(name);
        let args = call.function.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { invalid(); } }
        if (!args || typeof args !== 'object' || Array.isArray(args)) invalid();
        args = jsonData(args, config.maxRequestBytes);
        const legacy = call.id === undefined;
        const id = legacy ? `legacy_${hash(JSON.stringify([index, ordinal, name, args])).slice(0, 48)}` : call.id;
        if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) invalid();
        ids.add(id); pending.push({ id, name, legacy });
        return { id, type: 'function', function: { name: wire, arguments: JSON.stringify(args) } };
      });
    }
    if (message.response_items !== undefined) {
      const replay = responseItems(message.response_items, invalid), calls = output.tool_calls || [];
      if (replay.content !== (content || '') || replay.calls.length !== calls.length) invalid();
      for (let index = 0; index < calls.length; index++) {
        const candidate = replay.calls[index], expected = calls[index];
        let args;
        try { args = JSON.stringify(JSON.parse(candidate.function.arguments)); } catch { invalid(); }
        if (candidate.id !== expected.id || candidate.function.name !== expected.function.name || args !== expected.function.arguments) invalid();
      }
      output.response_items = message.response_items;
    }
    return output;
  });
  if (pending.length) invalid();
  if (source.options !== undefined && (!source.options || typeof source.options !== 'object' || Array.isArray(source.options)
    || Object.keys(source.options).some(key => !['num_ctx', 'num_gpu', 'num_predict'].includes(key)))) invalid();
  const limits = [source.max_tokens, source.max_completion_tokens, source.options?.num_predict].filter(value => value !== undefined);
  if (limits.length > 1 || limits.some(value => !integer(value, 1, config.maxOutputTokens))) invalid();
  const outputTokens = limits[0] ?? config.maxOutputTokens;
  const output = { model: config.model, messages, stream: false, [config.tokenParameter]: outputTokens };
  for (const [key, maximum] of [['temperature', 2], ['top_p', 1]]) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'number' || source[key] < 0 || source[key] > maximum) invalid();
      output[key] = source[key];
    }
  }
  if (wireTools.length) {
    output.tools = wireTools;
    if (source.tool_choice !== undefined) {
      if (!['auto', 'none', 'required'].includes(source.tool_choice)) invalid();
      output.tool_choice = source.tool_choice;
    }
    if (source.parallel_tool_calls !== undefined) {
      if (typeof source.parallel_tool_calls !== 'boolean') invalid();
      output.parallel_tool_calls = source.parallel_tool_calls;
    }
  } else if (source.tool_choice !== undefined || source.parallel_tool_calls !== undefined) invalid();
  if (config.protocol === 'responses') {
    output.store = false;
    output.include = ['reasoning.encrypted_content'];
    delete output[config.tokenParameter];
    output.max_output_tokens = outputTokens;
    delete output.messages;
    output.input = messages.flatMap(message => {
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
      // Validated replay exactly matches normalized history, retaining item
      // order, IDs and opaque reasoning state without adding any actions.
      if (message.response_items !== undefined) return message.response_items;
      const items = [];
      if (message.content || !message.tool_calls) items.push({ role: message.role, content: message.content || '' });
      for (const call of message.tool_calls || []) items.push({ type: 'function_call', call_id: call.id,
        name: call.function.name, arguments: call.function.arguments });
      return items;
    });
    // Explicit false retains Fleet's optional arguments: Responses otherwise
    // attempts to normalize an omitted strict field to a stricter schema.
    if (wireTools.length) output.tools = wireTools.map(tool => ({ type: 'function', strict: false, ...tool.function }));
  }
  if (config.protocol === 'anthropic-messages') {
    const system = [], conversation = [];
    for (const message of messages) {
      if (message.name !== undefined) invalid();
      if (['system', 'developer'].includes(message.role)) {
        // Moving instructions out of the middle of history would change their meaning.
        if (conversation.length) invalid();
        if (message.content) system.push({ type: 'text', text: message.content });
        continue;
      }
      const role = message.role === 'tool' ? 'user' : message.role;
      const content = message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
        : [...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...(message.tool_calls || []).map(call => ({ type: 'tool_use', id: call.id,
            name: call.function.name, input: JSON.parse(call.function.arguments) }))];
      if (!content.length) invalid();
      if (conversation.at(-1)?.role === role) conversation.at(-1).content.push(...content);
      else conversation.push({ role, content });
    }
    if (!conversation.length || conversation[0].role !== 'user') invalid();
    output.messages = conversation;
    if (system.length) output.system = system;
    if (wireTools.length) {
      output.tools = wireTools.map(({ function: fn }) => ({ name: fn.name,
        ...(fn.description === undefined ? {} : { description: fn.description }), input_schema: fn.parameters }));
      output.tool_choice = { type: source.tool_choice === 'required' ? 'any' : source.tool_choice || 'auto',
        ...(source.parallel_tool_calls === undefined || source.tool_choice === 'none'
          ? {} : { disable_parallel_tool_use: !source.parallel_tool_calls }) };
      delete output.parallel_tool_calls;
    }
  }
  const data = Buffer.from(JSON.stringify(output));
  if (data.length > config.maxRequestBytes) invalid();
  return { data, offered, ids, outputTokens, requireTool: source.tool_choice === 'required', forbidTools: source.tool_choice === 'none', maxToolCalls: config.maxToolCalls };
}

function parsedCalls(calls, request) {
  if (!Array.isArray(calls)) responseInvalid();
  if (request.forbidTools && calls.length) responseInvalid();
  if (calls.length > request.maxToolCalls) throw fail('TOOL_LIMIT', 'The model API exceeded the tool-call limit. No tool calls were delivered.');
  const seen = new Set(request.ids);
  const result = calls.map(call => {
    const fn = call?.function;
    if (call?.type !== 'function' || typeof call.id !== 'string' || !ID.test(call.id) || seen.has(call.id)
      || !fn || !request.offered.has(fn.name) || typeof fn.arguments !== 'string') responseInvalid();
    seen.add(call.id);
    let args;
    try { args = JSON.parse(fn.arguments); } catch { responseInvalid(); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) responseInvalid();
    args = jsonData(args, DEFAULT_MAX_BYTES, responseInvalid);
    return { id: call.id, type: 'function', function: { name: request.offered.get(fn.name), arguments: args } };
  });
  // Measured 2026-10-07: qwen3.5:9b on Ollama's default 4,096-token context answered
  // without calling a tool; the same model with a 32,768-token context called it.
  if (request.requireTool && !result.length) throw fail('TOOL_UNSUPPORTED',
    'The model API did not return a required function call. Choose an endpoint and model with tool calling support. For a local model server, also give the model a context window of at least 16,000 tokens: Fleet\'s tool definitions do not fit a 4,096-token window, which is Ollama\'s default.');
  return result;
}

function addUsage(packet, usage, request, protocol) {
  if (usage === undefined || usage === null) return packet;
  const input = protocol === 'chat-completions' ? usage.prompt_tokens : usage.input_tokens;
  const output = protocol === 'chat-completions' ? usage.completion_tokens : usage.output_tokens;
  if (!integer(input, 0, Number.MAX_SAFE_INTEGER) || !integer(output, 0, Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(input + output)
    || (usage.total_tokens !== undefined && (!integer(usage.total_tokens, 0, Number.MAX_SAFE_INTEGER) || usage.total_tokens !== input + output))) responseInvalid();
  if (output > request.outputTokens) throw fail('OUTPUT_LIMIT', 'The model API exceeded the requested output-token limit. No tool calls were delivered.');
  packet.prompt_eval_count = input;
  packet.eval_count = output;
  return packet;
}

function finalPacket(value, request) {
  if (!value || !Array.isArray(value.choices) || value.choices.length !== 1) responseInvalid();
  const choice = value.choices[0], message = choice?.message;
  if (!message || message.role !== 'assistant' || message.function_call
    || !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)
    || (message.content !== null && message.content !== undefined && typeof message.content !== 'string')
    || (message.refusal !== null && message.refusal !== undefined)) responseInvalid();
  if (choice.finish_reason === 'content_filter') responseInvalid();
  if (choice.finish_reason === 'length') throw fail('OUTPUT_LIMIT', 'The model API reached its output-token limit before completing. No tool calls were delivered.');
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || (calls.length && choice.finish_reason !== 'tool_calls')
    || (!calls.length && choice.finish_reason === 'tool_calls')) responseInvalid();
  const toolCalls = parsedCalls(calls, request);
  const packet = { message: { role: 'assistant', content: message.content || '',
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true, done_reason: choice.finish_reason };
  if (typeof message.reasoning_content === 'string') packet.message.thinking = message.reasoning_content;
  return addUsage(packet, value.usage, request, 'chat-completions');
}

function responsesPacket(value, request) {
  if (value?.status === 'incomplete' && value.incomplete_details?.reason === 'max_output_tokens') {
    throw fail('OUTPUT_LIMIT', 'The model API reached its output-token limit before completing. No tool calls were delivered.');
  }
  if (!value || value.object !== 'response' || value.status !== 'completed' || !Array.isArray(value.output)
    || value.output.length > MAX_MESSAGES || value.error) responseInvalid();
  const { content, calls } = responseItems(value.output, responseInvalid);
  const toolCalls = parsedCalls(calls, request);
  const packet = { message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    response_items: value.output },
    done: true, done_reason: toolCalls.length ? 'tool_calls' : 'stop' };
  return addUsage(packet, value.usage, request, 'responses');
}

function messagesPacket(value, request) {
  if (value?.stop_reason === 'max_tokens') {
    throw fail('OUTPUT_LIMIT', 'The model API reached its output-token limit before completing. No tool calls were delivered.');
  }
  if (value?.type !== 'message' || value.role !== 'assistant' || !Array.isArray(value.content)
    || value.content.length > MAX_MESSAGES || !['end_turn', 'tool_use', 'stop_sequence'].includes(value.stop_reason)) responseInvalid();
  const text = [], calls = [];
  for (const block of value.content) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'tool_use' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)) {
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    } else responseInvalid();
  }
  if ((value.stop_reason === 'tool_use') !== (calls.length > 0)) responseInvalid();
  const toolCalls = parsedCalls(calls, request);
  return addUsage({ message: { role: 'assistant', content: text.join(''),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true,
    done_reason: toolCalls.length ? 'tool_calls' : 'stop' }, value.usage, request, 'anthropic-messages');
}

function createModelApiTransport(input = {}, dependencies = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => !['endpoint', 'model', 'tokenEnv', 'placeholder', 'env', 'timeoutMs', 'protocol', 'maxToolCalls',
      'maxRequestBytes', 'maxResponseBytes', 'maxOutputTokens', 'tokenParameter'].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) invalid();
  const { endpoint, model, tokenEnv, placeholder, env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxRequestBytes = DEFAULT_MAX_BYTES, maxResponseBytes = DEFAULT_MAX_BYTES,
    maxOutputTokens = 4096, maxToolCalls = MAX_CALLS,
    protocol = typeof endpoint === 'string' && endpoint.endsWith('/responses') ? 'responses' : 'chat-completions',
    tokenParameter = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens' } = input;
  if (!['chat-completions', 'responses', 'anthropic-messages'].includes(protocol)) invalid();
  const url = endpointOf(endpoint, protocol);
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(model) || !integer(timeoutMs, 1, 60 * 60_000)
    || !integer(maxRequestBytes, 1024, 16 * 1024 * 1024) || !integer(maxResponseBytes, 1024, 16 * 1024 * 1024)
    || !integer(maxOutputTokens, 1, 131_072) || !integer(maxToolCalls, 1, MAX_CALLS)
    || !(protocol === 'responses' ? tokenParameter === 'max_output_tokens' : protocol === 'anthropic-messages'
      ? tokenParameter === 'max_tokens' : ['max_tokens', 'max_completion_tokens'].includes(tokenParameter))
    || (tokenEnv !== undefined && (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(tokenEnv)))
    || (placeholder !== undefined && (typeof placeholder !== 'string' || !/^openshell:resolve:env:[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(placeholder)))
    || (tokenEnv !== undefined && placeholder !== undefined)
    || !env || typeof env !== 'object') invalid();
  const config = { model, maxRequestBytes, maxOutputTokens, tokenParameter, protocol, maxToolCalls };
  const active = new Set();
  let closed = false;
  function chat(body, { signal = null, onAccepted = null, onPacket = null } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(fail('CLOSED', 'This model API transport is closed.'));
      if (active.size) return reject(fail('BUSY', 'This model API transport already has a request in progress.'));
      if ((onAccepted !== null && typeof onAccepted !== 'function') || (onPacket !== null && typeof onPacket !== 'function')
        || (signal !== null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) return reject(fail('INPUT_INVALID', 'Model API callbacks or cancellation signal are invalid.'));
      if (signal?.aborted) return reject(fail('INTERRUPTED', 'The model API request was stopped.'));
      let prepared, bearer;
      try {
        prepared = prepare(body, config);
        // The production session binds this trusted callback to the saved
        // operator decision. Check each round, immediately before reading
        // the named credential; no model callback or await intervenes.
        if (dependencies.authorizeCredential !== undefined) {
          if (typeof dependencies.authorizeCredential !== 'function') invalid();
          dependencies.authorizeCredential();
        }
        bearer = authorization(tokenEnv, placeholder, env);
      }
      catch (error) { return reject(error); }
      let settled = false, request, response, timer;
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(stop);
        if (error) { response?.destroy(); request?.destroy(); reject(error); } else resolve(value);
      }
      const abort = () => finish(fail('INTERRUPTED', 'The model API request was stopped.'));
      const stop = () => finish(fail('CLOSED', 'This model API transport was closed.'));
      active.add(stop);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(fail('TIMEOUT', 'The model API request did not settle before its deadline. It was not retried.')), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      const headers = { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(prepared.data.length),
        ...(protocol === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01', ...(bearer ? { 'x-api-key': bearer } : {}) }
          : bearer ? { authorization: `Bearer ${bearer}` } : {}) };
      try {
        const implementation = url.protocol === 'https:' ? dependencies.https || https : dependencies.http || http;
        request = implementation.request(url, { method: 'POST', headers, agent: false }, incoming => {
          response = incoming;
          if (settled) { response.destroy(); return; }
          response.on('error', () => finish(fail('UNAVAILABLE', 'The model API response connection failed. No retry was attempted.')));
          response.pause();
          const status = response.statusCode;
          const toolRejection = prepared.offered.size && [400, 422].includes(status);
          if (!integer(status, 200, 299) && !toolRejection) {
            finish(fail('HTTP_REFUSED', `The model API returned HTTP ${integer(status, 100, 599) ? status : 'error'}. No retry or redirect was attempted.`)); return;
          }
          if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(String(response.headers['content-type'] || ''))
            || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            finish(fail('RESPONSE_INVALID', 'The model API did not return an uncompressed JSON completion.')); return;
          }
          (async () => {
            if (!toolRejection && onAccepted) await onAccepted();
            if (settled) return;
            const chunks = []; let bytes = 0;
            for await (const chunk of response) {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > maxResponseBytes) throw fail('RESPONSE_TOO_LARGE', 'The model API completion exceeded its response limit.');
              chunks.push(chunk);
            }
            if (settled) return;
            let value;
            try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
            catch {
              if (toolRejection) throw fail('HTTP_REFUSED', `The model API returned HTTP ${status}. No retry was attempted.`);
              responseInvalid();
            }
            value = jsonData(value, maxResponseBytes, responseInvalid);
            if (toolRejection) {
              // Classify a bounded provider error without forwarding its text,
              // headers, endpoint or credentials into Fleet events or logs.
              const details = [value?.error?.code, value?.error?.param, value?.error?.message]
                .filter(item => typeof item === 'string').join(' ');
              if (/(tool|function)/i.test(details) && /(not.support|unsupported|not.available|does.not.*support|not.implement)/i.test(details)) {
                throw fail('TOOL_UNSUPPORTED', 'The model API rejected tool calling. Choose an endpoint and model with tool calling support.');
              }
              throw fail('HTTP_REFUSED', `The model API returned HTTP ${status}. No retry was attempted.`);
            }
            const packet = protocol === 'responses' ? responsesPacket(value, prepared)
              : protocol === 'anthropic-messages' ? messagesPacket(value, prepared) : finalPacket(value, prepared);
            if (onPacket) await onPacket(packet);
            if (!settled) finish(null, { status });
          })().catch(error => finish(error?.code?.startsWith('MODEL_API_') ? error
            : fail('RESPONSE_FAILED', 'The model API response or its consumer did not complete. No retry was attempted.')));
        });
        request.on('error', () => finish(fail('UNAVAILABLE', 'The model API connection failed. No retry was attempted.')));
        request.end(prepared.data);
      } catch { finish(fail('UNAVAILABLE', 'The model API connection could not be opened. No retry was attempted.')); }
    });
  }
  return Object.freeze({ preserveToolCallIds: true, chat,
    // Pure admission estimate of the actual encoded request, including wire
    // names and Responses replay expansion. It never resolves credentials.
    requestInputBytes(body) { return prepare(body, config).data.length; }, close() {
    if (closed) return;
    closed = true; for (const stop of [...active]) stop();
  } });
}
module.exports = Object.freeze({ createModelApiTransport, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS });
