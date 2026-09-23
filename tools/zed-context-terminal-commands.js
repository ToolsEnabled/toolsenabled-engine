'use strict';

// Pure command-surface contract for the Zed context-terminal wrapper.
//
// This module deliberately does not read a terminal, a native CLI session, a
// log, or the filesystem.  The eventual terminal integration can use its
// result to consume wrapper-owned controls locally.  Anything not recognized
// as an exact wrapper control is returned as byte-preserving native input.

const CONTROL_NAMESPACE = '//';
const DEFAULT_PREVIEW_MS = 500;
const MIN_PREVIEW_MS = 50;
const MAX_PREVIEW_MS = 5_000;
const MAX_COMMAND_BYTES = 16 * 1024;

const CONTROL_SPECS = Object.freeze([
  Object.freeze({ name: 'help', usage: 'help', description: 'list local controls' }),
  Object.freeze({ name: 'preview', usage: 'preview [on|off|milliseconds]', description: 'inspect or tune the bounded native preview' }),
  Object.freeze({ name: 'context', usage: 'context', description: 'restore the durable context-only view' }),
  Object.freeze({ name: 'session', usage: 'session', description: 'show safe session and persistence metadata' }),
  Object.freeze({ name: 'logs', usage: 'logs', description: 'show raw-log paths without opening raw logs' }),
  Object.freeze({ name: 'new', usage: 'new', description: 'request a new native session; confirmation is required' }),
  Object.freeze({ name: 'export-context', usage: 'export-context [path]', description: 'export context-only text, never raw terminal output' })
]);
const CONTROL_NAMES = new Set(CONTROL_SPECS.map(spec => spec.name));

class CommandSurfaceError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'CommandSurfaceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommandSurfaceError(code, message);
}

function assertNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${label} must be a non-empty trimmed string`);
  }
  return value;
}

function normalizeAgent(agent) {
  if (agent !== 'codex' && agent !== 'claude') fail('AGENT_INVALID', 'agent must be codex or claude');
  return agent;
}

function normalizeNativeCommandName(value) {
  if (typeof value !== 'string') fail('NATIVE_COMMAND_INVALID', 'native command names must be strings');
  let name = value.trim();
  if (name.startsWith('//')) fail('NATIVE_COMMAND_INVALID', 'native command names cannot use the wrapper namespace');
  if (name.startsWith('/')) name = name.slice(1);
  if (!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(name)) {
    fail('NATIVE_COMMAND_INVALID', 'native command names must be slash-command identifiers');
  }
  return name.toLowerCase();
}

function inventoryNativeCommands({ agent, version, commands } = {}) {
  normalizeAgent(agent);
  assertNonEmptyString(version, 'NATIVE_VERSION_INVALID', 'native version');
  if (!Array.isArray(commands)) fail('NATIVE_COMMANDS_INVALID', 'native commands must be an array');
  const normalized = commands.map(normalizeNativeCommandName);
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) fail('NATIVE_COMMAND_DUPLICATE', 'native command inventory contains duplicates');
  return Object.freeze({
    agent,
    version,
    commands: Object.freeze(unique)
  });
}

function createCommandSurface({ agent, version, nativeCommands = [], preferSingleSlash = false } = {}) {
  const inventory = inventoryNativeCommands({ agent, version, commands: nativeCommands });
  const collisions = CONTROL_SPECS
    .map(spec => spec.name)
    .filter(name => inventory.commands.includes(name));
  const useSingleSlash = preferSingleSlash === true && collisions.length === 0;
  const namespace = useSingleSlash ? '/' : CONTROL_NAMESPACE;
  const fallbackReason = useSingleSlash
    ? null
    : preferSingleSlash && collisions.length > 0
      ? 'native-command-collision'
      : 'stable-wrapper-namespace';
  return Object.freeze({
    agent: inventory.agent,
    version: inventory.version,
    nativeCommands: inventory.commands,
    nativeCollisions: Object.freeze(collisions),
    namespace,
    fallbackReason,
    controls: CONTROL_SPECS
  });
}

function assertSurface(surface) {
  if (!surface || (surface.namespace !== '/' && surface.namespace !== CONTROL_NAMESPACE)
    || !Array.isArray(surface.nativeCommands) || !Array.isArray(surface.controls)) {
    fail('SURFACE_INVALID', 'command surface is malformed');
  }
  normalizeAgent(surface.agent);
  assertNonEmptyString(surface.version, 'NATIVE_VERSION_INVALID', 'native version');
  return surface;
}

function inputBuffer(input) {
  let bytes;
  if (Buffer.isBuffer(input)) bytes = Buffer.from(input);
  else if (typeof input === 'string') bytes = Buffer.from(input, 'utf8');
  else fail('COMMAND_INPUT_INVALID', 'command input must be a string or Buffer');
  if (bytes.length > MAX_COMMAND_BYTES) fail('COMMAND_INPUT_TOO_LARGE', 'command input exceeds the local bound');
  return bytes;
}

function exactUtf8(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function withoutOneLineEnding(text) {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1);
  return text;
}

// Quotes are only a local tokenizer feature.  Outside quotes, backslashes are
// retained so Windows paths work without shell interpretation.  Inside quotes
// only a matching quote can be escaped; no command is ever executed here.
function tokenize(line) {
  if (typeof line !== 'string') fail('COMMAND_TEXT_INVALID', 'command text must be a string');
  const tokens = [];
  let current = '';
  let hasToken = false;
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\0' || character === '\r' || character === '\n') {
      fail('COMMAND_CONTROL_CHARACTER', 'command text contains a forbidden control character');
    }
    if (quote) {
      if (character === quote) {
        quote = null;
        hasToken = true;
      } else if (character === '\\' && line[index + 1] === quote) {
        current += quote;
        index += 1;
        hasToken = true;
      } else {
        current += character;
        hasToken = true;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      hasToken = true;
    } else if (/\s/.test(character)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += character;
      hasToken = true;
    }
  }
  if (quote) fail('COMMAND_QUOTE_UNTERMINATED', 'command text has an unterminated quote');
  if (hasToken) tokens.push(current);
  return tokens;
}

function nativeResult(raw, kind = 'native') {
  return {
    kind,
    raw: Buffer.from(raw),
    forward: Buffer.from(raw),
    localOnly: false,
    recordInNative: true,
    durable: true,
    wrapperCommand: null,
    operation: null
  };
}

function wrapperResult(raw, command, operation, extra = {}) {
  return {
    kind: 'wrapper',
    raw: Buffer.from(raw),
    forward: null,
    localOnly: true,
    recordInNative: false,
    durable: false,
    wrapperCommand: command,
    operation,
    ...extra
  };
}

function invalidWrapperResult(raw, code, command = null) {
  return {
    kind: 'invalid-wrapper',
    raw: Buffer.from(raw),
    forward: null,
    localOnly: true,
    recordInNative: false,
    durable: false,
    wrapperCommand: command,
    operation: null,
    errorCode: code
  };
}

function controlNameFromToken(token, namespace) {
  if (namespace === '/') {
    if (!token.startsWith('/') || token.startsWith('//')) return null;
    return token.slice(1).toLowerCase();
  }
  if (!token.startsWith(CONTROL_NAMESPACE)) return null;
  return token.slice(CONTROL_NAMESPACE.length).toLowerCase();
}

function parsePreview(raw, args) {
  if (args.length === 0) {
    return wrapperResult(raw, 'preview', 'preview', {
      previewMode: 'inspect',
      enabled: null,
      milliseconds: DEFAULT_PREVIEW_MS
    });
  }
  if (args.length !== 1) return invalidWrapperResult(raw, 'PREVIEW_ARGUMENTS', 'preview');
  const value = args[0].toLowerCase();
  if (value === 'on' || value === 'off') {
    return wrapperResult(raw, 'preview', 'preview', {
      previewMode: 'set-enabled',
      enabled: value === 'on',
      milliseconds: DEFAULT_PREVIEW_MS
    });
  }
  if (!/^\d+$/.test(value)) return invalidWrapperResult(raw, 'PREVIEW_VALUE', 'preview');
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)
    || milliseconds < MIN_PREVIEW_MS || milliseconds > MAX_PREVIEW_MS) {
    return invalidWrapperResult(raw, 'PREVIEW_BOUNDS', 'preview');
  }
  return wrapperResult(raw, 'preview', 'preview', {
    previewMode: 'set-duration',
    enabled: true,
    milliseconds
  });
}

function noArguments(raw, command, operation, args) {
  return args.length === 0
    ? wrapperResult(raw, command, operation)
    : invalidWrapperResult(raw, `${command.toUpperCase()}_ARGUMENTS`, command);
}

function exportTarget(raw, args) {
  if (args.length > 1) return invalidWrapperResult(raw, 'EXPORT_PATH_ARGUMENTS', 'export-context');
  if (args.length === 0) {
    return wrapperResult(raw, 'export-context', 'export-context', {
      targetPath: null,
      includeRaw: false
    });
  }
  const targetPath = args[0];
  if (targetPath.length === 0) return invalidWrapperResult(raw, 'EXPORT_PATH_EMPTY', 'export-context');
  if (targetPath.startsWith('-')) return invalidWrapperResult(raw, 'EXPORT_PATH_OPTION', 'export-context');
  if (targetPath.length > 4096) return invalidWrapperResult(raw, 'EXPORT_PATH_TOO_LONG', 'export-context');
  if (/(?:^|[\\/])logs(?:[\\/]|$)/i.test(targetPath)
    || /\.(?:log|stdout|stderr)$/i.test(targetPath)) {
    return invalidWrapperResult(raw, 'EXPORT_TARGET_RAW_LOG', 'export-context');
  }
  return wrapperResult(raw, 'export-context', 'export-context', {
    targetPath,
    includeRaw: false
  });
}

function parseKnownWrapper(raw, name, args) {
  switch (name) {
    case 'help':
      return noArguments(raw, 'help', 'help', args);
    case 'preview':
      return parsePreview(raw, args);
    case 'context':
      return noArguments(raw, 'context', 'restore-context', args);
    case 'session':
      return args.length === 0
        ? wrapperResult(raw, 'session', 'inspect-session', {
          safeFields: Object.freeze(['agent', 'sessionId', 'resumeSource', 'persistenceHealth'])
        })
        : invalidWrapperResult(raw, 'SESSION_ARGUMENTS', 'session');
    case 'logs':
      return args.length === 0
        ? wrapperResult(raw, 'logs', 'inspect-logs', {
          pathsOnly: true,
          includeRawContent: false
        })
        : invalidWrapperResult(raw, 'LOGS_ARGUMENTS', 'logs');
    case 'new':
      return args.length === 0
        ? wrapperResult(raw, 'new', 'new-session', {
          confirmation: Object.freeze({ required: true, status: 'pending' })
        })
        : invalidWrapperResult(raw, 'NEW_ARGUMENTS', 'new');
    case 'export-context':
      return exportTarget(raw, args);
    default:
      return invalidWrapperResult(raw, 'WRAPPER_COMMAND_UNKNOWN', name);
  }
}

function parseCommand(input, surface) {
  assertSurface(surface);
  const raw = inputBuffer(input);
  const decoded = exactUtf8(raw);
  if (decoded === null) return nativeResult(raw);
  const line = withoutOneLineEnding(decoded);
  if (!line.startsWith('/')) return nativeResult(raw, 'input');

  const startsWrapperNamespace = surface.namespace === CONTROL_NAMESPACE
    ? line.startsWith(CONTROL_NAMESPACE)
    : line.startsWith('/') && !line.startsWith('//');
  if (!startsWrapperNamespace) return nativeResult(raw);

  let tokens;
  try {
    tokens = tokenize(line);
  } catch (error) {
    // Tokenizer refusals for a known single-slash control must not turn that
    // control into native input merely because its arguments could not be
    // parsed. Unknown single-slash commands still belong to the native CLI.
    if (!(error instanceof CommandSurfaceError)) throw error;
    if (surface.namespace === '/') {
      const firstToken = line.match(/^\S+/)?.[0] || '';
      const candidateName = controlNameFromToken(firstToken, surface.namespace);
      if (!candidateName || !CONTROL_NAMES.has(candidateName)) return nativeResult(raw);
    }
    return invalidWrapperResult(raw, error.code);
  }
  if (tokens.length === 0) return nativeResult(raw);
  const name = controlNameFromToken(tokens[0], surface.namespace);
  if (!name) return nativeResult(raw);
  if (!CONTROL_NAMES.has(name)) {
    return surface.namespace === CONTROL_NAMESPACE
      ? invalidWrapperResult(raw, 'WRAPPER_COMMAND_UNKNOWN', name)
      : nativeResult(raw);
  }
  if (surface.namespace === '/' && surface.nativeCollisions.includes(name)) return nativeResult(raw);
  return parseKnownWrapper(raw, name, tokens.slice(1));
}

class LocalInputRouter {
  constructor(surface) {
    assertSurface(surface);
    // A byte-stream router can reserve the double-slash prefix with only one
    // byte of look-ahead.  Reserving a single slash would hold native TUI
    // typing until Enter, so a controller must not install that mode here.
    if (surface.namespace !== CONTROL_NAMESPACE) {
      fail('INPUT_ROUTER_NAMESPACE_UNSAFE', 'byte-stream routing requires the double-slash namespace');
    }
    this.surface = surface;
    this.lineStart = true;
    this.pendingSlash = false;
    this.wrapperBuffer = null;
    this.discardWrapperLine = false;
    this.suppressNextLf = false;
  }

  feed(input) {
    const bytes = inputBuffer(input);
    const events = [];
    let forwarded = [];
    const flushForwarded = () => {
      if (!forwarded.length) return;
      events.push({
        kind: 'forward',
        bytes: Buffer.from(forwarded),
        localOnly: false,
        recordInNative: true,
        durable: true
      });
      forwarded = [];
    };
    const forwardByte = byte => {
      forwarded.push(byte);
      this.lineStart = byte === 0x0a || byte === 0x0d;
    };
    const completeWrapper = () => {
      flushForwarded();
      const candidate = Buffer.from(this.wrapperBuffer);
      this.wrapperBuffer = null;
      this.lineStart = true;
      events.push(parseCommand(candidate, this.surface));
    };

    for (const byte of bytes) {
      if (this.suppressNextLf) {
        this.suppressNextLf = false;
        if (byte === 0x0a) continue;
      }
      if (this.discardWrapperLine) {
        if (byte === 0x0d || byte === 0x0a) {
          this.discardWrapperLine = false;
          this.lineStart = true;
          if (byte === 0x0d) this.suppressNextLf = true;
        }
        continue;
      }
      if (this.wrapperBuffer) {
        this.wrapperBuffer = Buffer.concat([this.wrapperBuffer, Buffer.from([byte])]);
        if (byte === 0x0d || byte === 0x0a) {
          if (byte === 0x0d) this.suppressNextLf = true;
          completeWrapper();
        } else if (this.wrapperBuffer.length > MAX_COMMAND_BYTES) {
          flushForwarded();
          const candidate = Buffer.from(this.wrapperBuffer);
          this.wrapperBuffer = null;
          this.discardWrapperLine = true;
          this.lineStart = false;
          events.push(invalidWrapperResult(candidate, 'COMMAND_INPUT_TOO_LARGE'));
        }
        continue;
      }
      if (this.pendingSlash) {
        this.pendingSlash = false;
        if (byte === 0x2f) {
          this.wrapperBuffer = Buffer.from('//');
          continue;
        }
        forwardByte(0x2f);
      }
      if (this.lineStart && byte === 0x2f) {
        this.pendingSlash = true;
        continue;
      }
      forwardByte(byte);
    }
    flushForwarded();
    return events;
  }

  cancel() {
    if (!this.pendingSlash && !this.wrapperBuffer && !this.discardWrapperLine) return null;
    if (this.discardWrapperLine) {
      this.discardWrapperLine = false;
      this.suppressNextLf = false;
      this.lineStart = true;
      return null;
    }
    const raw = this.wrapperBuffer ? Buffer.from(this.wrapperBuffer) : Buffer.from('/');
    this.pendingSlash = false;
    this.wrapperBuffer = null;
    this.suppressNextLf = false;
    this.lineStart = true;
    return {
      kind: 'cancelled-wrapper',
      raw,
      forward: null,
      localOnly: true,
      recordInNative: false,
      durable: false,
      errorCode: 'COMMAND_CANCELLED'
    };
  }

  flush() {
    const events = [];
    if (this.discardWrapperLine) {
      this.discardWrapperLine = false;
      this.lineStart = true;
    }
    if (this.pendingSlash) {
      this.pendingSlash = false;
      this.lineStart = false;
      events.push({
        kind: 'forward',
        bytes: Buffer.from('/'),
        localOnly: false,
        recordInNative: true,
        durable: true
      });
    }
    if (this.wrapperBuffer) {
      const raw = Buffer.from(this.wrapperBuffer);
      this.wrapperBuffer = null;
      this.lineStart = true;
      events.push({
        kind: 'incomplete-wrapper',
        raw,
        forward: null,
        localOnly: true,
        recordInNative: false,
        durable: false,
        errorCode: 'COMMAND_INCOMPLETE'
      });
    }
    this.suppressNextLf = false;
    return events;
  }

  pendingBytes() {
    if (this.wrapperBuffer) return this.wrapperBuffer.length;
    return this.pendingSlash ? 1 : 0;
  }
}

function createInputRouter(surface) {
  return new LocalInputRouter(surface);
}

function decideNewSession(request, decision) {
  if (!request || request.kind !== 'wrapper' || request.wrapperCommand !== 'new'
    || request.operation !== 'new-session' || request.confirmation?.status !== 'pending') {
    fail('NEW_CONFIRMATION_INVALID', 'request is not a pending new-session control');
  }
  if (decision !== 'confirm' && decision !== 'cancel') {
    fail('NEW_CONFIRMATION_DECISION', 'decision must be confirm or cancel');
  }
  return {
    ...request,
    confirmation: Object.freeze({ required: true, status: decision === 'confirm' ? 'confirmed' : 'cancelled' }),
    accepted: decision === 'confirm',
    cancelled: decision === 'cancel'
  };
}

function discoverableCommands(surface) {
  assertSurface(surface);
  return surface.controls.map(spec => Object.freeze({
    command: `${surface.namespace}${spec.usage}`,
    description: spec.description
  }));
}

function formatDiscoverability(surface) {
  return [
    `Local Zed context-terminal controls (${surface.agent} ${surface.version}):`,
    ...discoverableCommands(surface).map(item => `  ${item.command} — ${item.description}`),
    `Native single-slash commands pass through byte-for-byte; wrapper namespace: ${surface.namespace}`,
    `Native command inventory: ${surface.nativeCommands.length}; collisions: ${surface.nativeCollisions.length}`
  ].join('\n');
}

module.exports = {
  CONTROL_NAMESPACE,
  CONTROL_SPECS,
  DEFAULT_PREVIEW_MS,
  MAX_PREVIEW_MS,
  MIN_PREVIEW_MS,
  CommandSurfaceError,
  createCommandSurface,
  createInputRouter,
  decideNewSession,
  discoverableCommands,
  formatDiscoverability,
  inventoryNativeCommands,
  parseCommand,
  tokenize
};
