'use strict';

/* THE OFFICIAL claude CLI, BEHIND THE SAME SEAM CODEX SITS BEHIND.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT claude-adapter.js. That file speaks the
 * Agent Client Protocol to `npx @agentclientprotocol/claude-agent-acp` -- a
 * THIRD-PARTY wrapper -- and claude-process.js gives that child a throwaway
 * CLAUDE_CONFIG_DIR with no login state. Both of those are deliberate and both
 * are a licence fence (docs/design/NATIVE-CLAUDE-TRANSPORT-CONTRACT.md,
 * TE-L-0006): a product shipped to other people may not ride a subscription
 * through somebody else's wrapper. The consequence is that the ACP path cannot
 * authenticate at all -- its `-32000 Authentication required` is the fence
 * working, not a bug -- so it can never run a tree agent.
 *
 * This module is the other path, and the recorded council reading of TE-L-0006
 * is that it is the compliant one: launching the OFFICIAL binary on the user's
 * own sign-in is first-party use. Nothing here reads, copies, stores or
 * forwards a credential. It spawns `claude` and `claude` authenticates itself,
 * exactly as it does when the person runs it in their own terminal. There is no
 * config directory override anywhere in this file, and that absence is the
 * whole design: the child uses the person's real sign-in because it is their
 * computer and their subscription.
 *
 * EVERY MAPPING BELOW WAS MEASURED AGAINST claude 2.1.186, not read off a
 * document. The stream is newline-delimited JSON and these are the shapes that
 * actually came out of it:
 *
 *   system/init                                   -> the session id, then turn_accepted
 *   stream_event/content_block_delta text_delta   -> assistant_text_delta
 *   assistant   content[].type === 'text'         -> assistant_text
 *   assistant   content[].type === 'tool_use'     -> tool_call
 *   assistant   content[].type === 'thinking'     -> thinking
 *   user        content[].type === 'tool_result'  -> tool_result
 *   result                                        -> usage, then turn_completed
 *
 * THINKING REACHES THE HOST AS ITS OWN TYPE, NEVER AS ASSISTANT SPEECH. The
 * owner's ruling, 2026-09-03: "more event types are fine we should be showing
 * the user when the model is thinking anyway." A thinking block arrives with
 * a `signature` field and is not addressed to the reader, so forwarding it as
 * assistant_text would still put the model's private working into the
 * transcript as though the agent had said it -- that half of the old rule
 * still holds. What changed is that the contract may now grow a type for it
 * instead of the only choices being "assistant speech" or "dropped".
 *
 * TURN_ACCEPTED EXISTS BECAUSE THIS CLI OFFERS NO EARLIER SIGNAL. sendTurn()'s
 * own promise settles at the turn's COMPLETION on this engine (see its header
 * below) -- unlike codex, which acknowledges a turn immediately -- so a caller
 * with no other signal has nothing to watch for "the turn began" until the
 * model is already finished answering. `system/init` is the earliest true
 * receipt this CLI ever sends (see claudeArgs() below: it does not arrive
 * until a user message is sent), so it is forwarded as turn_accepted the
 * moment it is seen. This is additive only: sendTurn()'s promise is untouched,
 * and everything that promise already guarantees (see its own header) still
 * holds exactly as before.
 */

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const {
  assertEngineAdapter,
  validateApprovalAnswer,
  validateEngineEvent,
  validateSendTurnRequest,
  validateThreadId,
  validateThreadOptions
} = require('./engine-contract');

/* PASTED PICTURES.
 *
 * The app hands this adapter a PATH, and only ever one it can prove a person
 * put there: agent:paste-attachment writes the file itself and agent:send
 * refuses any path outside that session's own attachment allowlist. So the
 * question here is not "may this file be read" -- that was settled two
 * boundaries up -- it is "what does the CLI have to receive for the person's
 * picture to be IN the message". `--input-format stream-json` takes a user
 * message whose `content` is an array of blocks, so a picture is one more
 * block beside the words, in the shape the provider already defines for
 * base64 image input.
 *
 * The read itself is in its own module, and deliberately so.
 * tests/agent-engine/claude-cli-process.test.js asserts against this file's
 * SOURCE TEXT that it names no file-reading call and no credential store --
 * "The child authenticates itself" -- and that gate is right, is untouched,
 * and is the reason this comment does not spell those names either. See
 * turn-image-bytes.js for the magic-byte check that makes it impossible for
 * anything that is not a picture to come back from it. */
const { readTurnImage, imageMimeTypeFor } = require('./turn-image-bytes');

class ClaudeCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeCliError';
    this.code = code;
  }
}

/* Maximum silence while a turn is active. Real text, reasoning and tool
   activity refresh this timer so a productive long turn keeps its context.
   A silent child still cannot leave a promise pending for the life of the app. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/* WHAT A PERMISSION LEVEL MEANS TO THIS CLI, and the reason the table is here
 * rather than at the call site. The shell hands us the codex vocabulary,
 * because that is what the confinement plan has always spoken. Translating it
 * once, in the module that owns this engine, is what keeps a level meaning the
 * same thing whichever provider a person picks.
 *
 * The mapping matches src/orchestration-controls.js in the app, which already
 * had it for the LANE path -- read-only/plan, workspace-write/acceptEdits,
 * danger-full-access/bypassPermissions -- so the two surfaces cannot disagree
 * about what a level allows.
 *
 * IT FAILS CLOSED. An unrecognised sandbox value resolves to 'plan', the most
 * restrictive mode this CLI has, and never to a permissive default. A level
 * this module does not understand must not become a wider one. */
const SANDBOX_TO_PERMISSION_MODE = Object.freeze({
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions'
});

// Native permission choices may narrow, then return within the original launch ceiling.
const NATIVE_PERMISSION_MODES = Object.freeze(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
function nativeModePolicyFor(permissionMode) {
  const initialMode = permissionMode === 'manual' ? 'default' : permissionMode;
  const ceiling = NATIVE_PERMISSION_MODES.indexOf(initialMode);
  return ceiling < 0 ? null : Object.freeze({ initialMode,
    allowedModes: Object.freeze(NATIVE_PERMISSION_MODES.slice(0, ceiling + 1)) });
}

function permissionModeFor(threadOptions) {
  const sandbox = threadOptions && threadOptions.sandbox;
  if (typeof sandbox !== 'string') return 'plan';
  return SANDBOX_TO_PERMISSION_MODE[sandbox] || 'plan';
}

/* The model name this CLI takes, from the model the tier names.
 *
 * The product's tiers are `claude/fable`, `claude/sonnet`, `claude/opus`; the
 * CLI wants the bare alias. Splitting on the slash rather than keeping a second
 * lookup table means a tier added upstream needs no edit here, and an
 * unrecognised value is passed through for the CLI to reject BY NAME -- which
 * is a better failure than this module silently choosing a different model than
 * the person picked. Silently substituting a model is the exact defect the tier
 * menu was repaired for. */
function cliModelFor(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const slash = model.indexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/* The product's tool surface, as argv. Absent means ABSENT: no flag at all,
 * which is the argv this engine has always produced, and the session runs with
 * the CLI's own built-in tools only.
 *
 * `--strict-mcp-config` ALWAYS rides with the file, and that pairing is the
 * point. Established from `claude --help` on 2.1.186: "Only use MCP servers
 * from --mcp-config, ignoring all other MCP configurations." Without it the
 * session would ALSO load whatever MCP servers the working directory's own
 * project files declare, and the tool surface the recorded level decided would
 * vary with which folder the person pointed the session at. The plan's servers
 * are the session's servers, deterministically, or the flag is not passed.
 *
 * A PATH THAT COULD RESOLVE ANYWHERE BUT THE PLAN'S FILE IS REFUSED, not
 * repaired: a relative path resolves against the child's working directory --
 * the person's project folder -- and on Windows a rooted-but-driveless path
 * (`\x\.mcp.json`) resolves against whatever drive the child happens to be on.
 * Either would load an `.mcp.json` the plan never wrote, under the product's
 * own name. What survives is resolved through the same path.resolve() the
 * sign-in folder gets in configDirEnvironment(), so one engine does not carry
 * two normalization styles for one kind of fact. (The two call sites are a
 * known, deliberate duplication -- a shared helper is a refactor for another
 * night.) */
function mcpConfigArgs(mcpConfig) {
  if (mcpConfig === null || mcpConfig === undefined) return [];
  const named = typeof mcpConfig === 'string' ? mcpConfig.trim() : '';
  if (named.length === 0) {
    throw new ClaudeCliError('CLAUDE_CLI_MCP_CONFIG_INVALID',
      'The tool configuration for this session is not a file path, so the session was not started with it.');
  }
  const driveless = process.platform === 'win32' && /^[\\/](?![\\/])/.test(named);
  if (!path.isAbsolute(named) || driveless) {
    throw new ClaudeCliError('CLAUDE_CLI_MCP_CONFIG_RELATIVE',
      'The tool configuration has to be named by a full path, so the session reads the file the plan wrote and not one from the project folder.');
  }
  return ['--mcp-config', path.resolve(named), '--strict-mcp-config'];
}

/* THE GRANT, AS ARGV. Established from `claude --help` on 2.1.186:
 * "--settings <file-or-json>  Path to a settings JSON file or a JSON string".
 *
 * It rides beside --mcp-config for one reason, MEASURED on that build: a
 * --print session has nobody to ask for permission, so the servers the tool
 * file configures CONNECT and then refuse every call as
 * permission-not-granted. The grant file is what turns an advertised tool into
 * a callable one. Configuring tools without it is the worse of the two
 * failures, because it looks like it worked.
 *
 * Refused, never repaired, on exactly the grounds mcpConfigArgs() gives for the
 * tool file: a relative path resolves against the child's working directory --
 * the person's project folder -- and on Windows a rooted-but-driveless path
 * resolves against whatever drive the child is on. Either would load a grant
 * the plan never wrote, under the product's own name. A grant is the one file
 * where reading somebody else's copy is worst. */
function settingsArgs(settings) {
  if (settings === null || settings === undefined) return [];
  const named = typeof settings === 'string' ? settings.trim() : '';
  if (named.length === 0) {
    throw new ClaudeCliError('CLAUDE_CLI_SETTINGS_INVALID',
      'The permission grant for this session is not a file path, so the session was not started with it.');
  }
  const driveless = process.platform === 'win32' && /^[\\/](?![\\/])/.test(named);
  if (!path.isAbsolute(named) || driveless) {
    throw new ClaudeCliError('CLAUDE_CLI_SETTINGS_RELATIVE',
      'The permission grant has to be named by a full path, so the session reads the file the plan wrote and not one from the project folder.');
  }
  return ['--settings', path.resolve(named)];
}

/* The CLI's permission rule that allows every tool one MCP server offers.
 * MEASURED off claude 2.1.186: with `{"permissions":{"allow":["mcp__<name>"]}}`
 * in the pointed home's settings.json, a --print session CALLS the server's
 * tools (memory set/get round-tripped, 0 permission_denials); without it,
 * every call is denied, because a --print session has no one to ask.
 *
 * It lives HERE, beside the flag pairs and the mode table, because it is a
 * fact about this CLI's grammar and nothing else: when a CLI bump changes the
 * rule syntax, the person updating this file must find every CLI-coupled
 * string in one place rather than discover one of them a module away, after
 * shipping sessions whose servers advertise and then refuse every call. */
function claudeServerPermissionRule(serverName) {
  return `mcp__${serverName}`;
}

/* Native-tool flags are separate from the MCP server configuration and its
 * permission grants. Only removes the native action tools; Enabled and
 * Disabled leave native availability to the role and permission level.
 * Legacy booleans retain their meaning: true is Only, false is Enabled. */
function agentApiToolArgs(agentApi) {
  if (agentApi === false) return [];
  const { agentApiArgs } = require('../agent-api-policy');
  return typeof agentApi === 'string' ? agentApiArgs({ mode: agentApi })
    : agentApiArgs({ enabled: agentApi === true ? true : null });
}

function selectedAgentApiMode(agentApi, roleFunctionsOnly = false) {
  const policy = require('../agent-api-policy');
  const mode = agentApi === null
    ? roleFunctionsOnly === true ? 'Only' : policy.agentApiMode()
    : policy.normalizeAgentApiMode(agentApi);
  if (!mode) throw new ClaudeCliError('CLAUDE_API_MODE_INVALID', 'Unknown agent API mode.');
  return mode;
}

/* The flags every session gets, whichever way the conversation begins. The
 * naming flag is deliberately NOT here: a start names a NEW session
 * (--session-id) and a resume names an EXISTING one (--resume), the two are
 * mutually exclusive, and building them apart is what makes it impossible for
 * a resume to also declare a fresh id -- the old implementation FILTERED the
 * start argv positionally instead, and a model string literally equal to
 * '--session-id' would have deleted the wrong pair.
 *
 * `permissionMode` is the confinement plan's own word when the caller has a
 * plan, so the one recorded level has one reader; without it the mode is
 * derived from the sandbox word, failing closed to 'plan'. */
function baseClaudeArgs({ threadOptions = {}, permissionMode = null, mcpConfig = null, settings = null, agentApi = null, roleFunctionsOnly = false, extraArgs = [] }) {
  const apiMode = selectedAgentApiMode(agentApi, roleFunctionsOnly);
  roleFunctionsOnly = roleFunctionsOnly || apiMode === 'Only';
  if (typeof roleFunctionsOnly !== 'boolean' || (roleFunctionsOnly && extraArgs.length)) {
    throw new ClaudeCliError('CLAUDE_ROLE_TOOLS_INVALID', 'Role-scoped tools cannot be overridden by native CLI arguments.');
  }
  const model = cliModelFor(threadOptions.model);
  const requestedEffort = typeof threadOptions.effort === 'string' ? threadOptions.effort.trim() : '';
  /* Claude calls its highest reasoning setting `max`. The cross-provider UI
     also offers Codex's `ultra`, whose extra meaning is automatic delegation;
     Claude has no distinct value for that, so the documented top-depth
     equivalent is explicit rather than an invalid argv word. Values below
     Claude's supported range refuse instead of silently becoming a default. */
  const effort = requestedEffort === 'ultra' ? 'max' : requestedEffort;
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new ClaudeCliError(
      'CLAUDE_CLI_EFFORT_UNSUPPORTED',
      `Claude does not support the requested effort "${requestedEffort}".`
    );
  }
  return [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    /* Required for stream-json output to carry anything but the final result. */
    '--verbose',
    /* Token-by-token text. Without it a person watches nothing happen for a
       minute and then a wall of text appears at once. */
    '--include-partial-messages',
    '--permission-mode', typeof permissionMode === 'string' && permissionMode.length > 0
      ? permissionMode
      : permissionModeFor(threadOptions),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(apiMode === 'Disabled'
      ? ['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config']
      : mcpConfigArgs(mcpConfig)),
    ...settingsArgs(settings),
    ...(roleFunctionsOnly
      ? ['--tools', '', '--setting-sources', '', '--disable-slash-commands']
      : agentApiToolArgs(apiMode)),
    ...extraArgs
  ];
}

/**
 * The argv for one NEW session.
 *
 * `--session-id` IS THE WHOLE REASON A THREAD CAN EXIST BEFORE A TURN. Measured:
 * `system/init` does NOT arrive until a user message is sent, so there is no id
 * to read at spawn time and startThread() would have to spend a turn -- and
 * real money -- to learn what to call the thread it just made. Passing an id we
 * generated inverts that: the thread has a name immediately, at no cost, and it
 * is the same name `--resume` accepts later.
 *
 * `--print` with stream-json BOTH WAYS is what makes the child long-lived and
 * multi-turn. Measured twice: asked to remember a number, it answered that
 * number on a second turn down the same stdin, one session id, exit 0.
 *
 * `mcpConfig` is the file the confinement plan generated for this session's
 * tier and account, or null. See mcpConfigArgs() for why strictness rides
 * with it and why null means no flag rather than an empty one.
 */
function claudeArgs({ threadId, threadOptions = {}, permissionMode = null, mcpConfig = null, settings = null, agentApi = null, roleFunctionsOnly = false, extraArgs = [] }) {
  const apiMode = selectedAgentApiMode(agentApi, roleFunctionsOnly);
  if (extraArgs.length && (roleFunctionsOnly || apiMode !== 'Enabled')) {
    throw new ClaudeCliError('CLAUDE_ROLE_TOOLS_INVALID', 'The selected tool restrictions cannot be overridden by extra CLI arguments.');
  }
  return [
    ...baseClaudeArgs({ threadOptions, permissionMode, mcpConfig, settings, agentApi: apiMode, roleFunctionsOnly, extraArgs: [] }),
    '--session-id', threadId,
    ...extraArgs
  ];
}

/* Same session flags, continuing a conversation the CLI already has on disk.
 *
 * `--resume <id>` and `--session-id <id>` are mutually exclusive: the first
 * names an existing conversation, the second names a new one. The start flag
 * is never added and never filtered out -- see baseClaudeArgs().
 *
 * The MCP config travels through unchanged: a resumed conversation continues
 * under the same plan, and dropping it here would be a session whose tools
 * vanish between turns of one conversation. */
function claudeResumeArgs({ threadId, threadOptions = {}, permissionMode = null, mcpConfig = null, settings = null, agentApi = null, roleFunctionsOnly = false, extraArgs = [] }) {
  const apiMode = selectedAgentApiMode(agentApi, roleFunctionsOnly);
  if (extraArgs.length && (roleFunctionsOnly || apiMode !== 'Enabled')) {
    throw new ClaudeCliError('CLAUDE_ROLE_TOOLS_INVALID', 'The selected tool restrictions cannot be overridden by extra CLI arguments.');
  }
  return [
    ...baseClaudeArgs({ threadOptions, permissionMode, mcpConfig, settings, agentApi: apiMode, roleFunctionsOnly, extraArgs: [] }),
    '--resume', threadId,
    ...extraArgs
  ];
}

// A latest-history copy is a new process, unlike forkThread's unsupported
// past-turn rewind. The official CLI accepts a chosen new id only alongside
// --fork-session. Its system/init must confirm that id before any output is
// accepted (see expectedFork below).
function claudeForkArgs({ sourceThreadId, threadId, ...options }) {
  const source = validateThreadId(sourceThreadId);
  const target = validateThreadId(threadId);
  if (source === target || options.extraArgs?.length) {
    throw new ClaudeCliError('CLAUDE_EDITOR_FORK_INVALID', 'A conversation copy requires its own new identity and the generated argument list.');
  }
  return [...claudeResumeArgs({ ...options, threadId: source }), '--fork-session', '--session-id', target];
}

/* One engine-contract image -> one provider content block, or a refusal that
   says WHICH picture and why. Never a text block apologising for a missing
   picture: answering the words alone would answer a question about something
   the model never received, which is what the old blanket refusal existed to
   prevent and what this keeps preventing. */
function imageContentBlock(image, imageLoader) {
  if (!Object.hasOwn(image, 'path')) {
    throw new ClaudeCliError('CLAUDE_CLI_IMAGE_REMOTE_UNSUPPORTED',
      'A Claude session can send a picture from this computer, not one named by URL, so nothing was sent.');
  }
  let loaded;
  try {
    loaded = imageLoader(image.path);
  } catch (error) {
    /* The reader's own code is carried through, because "too large", "not a
       picture" and "could not be read" are three different things to a person
       looking at their own file, and collapsing them makes the message
       useless. */
    const code = typeof error?.code === 'string' && error.code.startsWith('TURN_IMAGE_')
      ? `CLAUDE_CLI_IMAGE_${error.code.slice('TURN_IMAGE_'.length)}`
      : 'CLAUDE_CLI_IMAGE_UNREADABLE';
    throw new ClaudeCliError(code,
      `${error && error.message ? error.message : 'That picture could not be read.'} Nothing was sent.`);
  }
  const bytes = loaded && Buffer.isBuffer(loaded.bytes) ? loaded.bytes : null;
  const mimeType = bytes ? imageMimeTypeFor(bytes) : null;
  if (!bytes || !mimeType) {
    /* A loader that answered with something other than picture bytes is a
       mistake in the injection, not in the person's file -- refuse here rather
       than let an unchecked blob reach the model. */
    throw new ClaudeCliError('CLAUDE_CLI_IMAGE_INVALID',
      `That file is not a picture Claude can read (${path.basename(image.path)}), so nothing was sent.`);
  }
  return { type: 'image', source: { type: 'base64', media_type: mimeType, data: bytes.toString('base64') } };
}

class ClaudeCliAdapter {
  constructor({ transport, clientInfo = null, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, expectedFork = null, expectedResumeThreadId = null, imageLoader = null, modePolicy = null, modeTimeoutMs = 10_000 } = {}) {
    if (!transport || typeof transport.send !== 'function' || typeof transport.onData !== 'function') {
      throw new TypeError('ClaudeCliAdapter requires a transport with send() and onData()');
    }
    if (imageLoader !== null && typeof imageLoader !== 'function') {
      throw new TypeError('ClaudeCliAdapter imageLoader must be a function or null');
    }
    /* Defaulted here rather than demanded from the caller. A picture that
       travels only when a second wiring step remembered to pass a reader stops
       travelling the first time someone builds an adapter the short way --
       which is exactly how the ACP adapter's image path came to be
       unreachable: its imageLoader defaults to null and nothing injects one. */
    // Host-owned launch evidence; never accept a mode policy from renderer input.
    const launchPolicy = nativeModePolicyFor(modePolicy?.initialMode);
    if (modePolicy !== null && (!launchPolicy
        || !Array.isArray(modePolicy.allowedModes) || !modePolicy.allowedModes.length
        || modePolicy.allowedModes.some(mode => !launchPolicy.allowedModes.includes(mode)))) {
      throw new ClaudeCliError('CLAUDE_MODE_POLICY_INVALID', 'Native modes require a trusted launch confinement policy.');
    }
    if (!Number.isFinite(modeTimeoutMs) || modeTimeoutMs <= 0 || modeTimeoutMs > 60_000) {
      throw new TypeError('Mode timeout must be positive and at most 60000 milliseconds.');
    }
    this.allowedModes = modePolicy === null ? null : Object.freeze([...new Set(modePolicy.allowedModes)]);
    this.modeTimeoutMs = modeTimeoutMs;
    this.currentModeId = null;
    this.modeRevision = 0;
    this.modeSelecting = false;
    this.modeUncertain = false;
    this.imageLoader = imageLoader || readTurnImage;
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.turnTimeoutMs = turnTimeoutMs;
    this.threadId = null;
    this.expectedFork = expectedFork;
    this.expectedResumeThreadId = expectedResumeThreadId === null ? null : validateThreadId(expectedResumeThreadId);
    this.resumeIdentityVerified = false;
    this.forkIdentityVerified = false;
    this.listeners = new Set();
    this.closed = false;

    /* The turn in flight, or null. ONE AT A TIME IS NOT A SIMPLIFICATION -- the
       CLI reads user messages off one stdin and answers them in order, so a
       second concurrent turn would interleave two conversations on one stream
       and neither caller could tell which events were theirs. */
    this.activeTurn = null;
    this.thinkingStream = null;
    /* Usage from the last completed turn, for getUsage(). Kept rather than
       recomputed because the figures are the PROVIDER'S and must never be
       synthesised; if none arrived, getUsage answers null. */
    this.lastUsage = null;
    this.pendingControl = new Map();
    this.exitInfo = null;

    this.transport.onData((packet, exitInfo) => {
      if (packet === null) return this.handleExit(exitInfo);
      return this.handlePacket(packet);
    });
  }

  /* ------------------------------------------------------------ events -- */

  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('onEvent requires a listener function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* EVERY EMISSION GOES THROUGH validateEngineEvent AND NOTHING BYPASSES IT.
     The contract owns what an event may contain, and an adapter that hand-built
     a "close enough" object would be the one place the rule is not enforced --
     which is where a malformed event would reach a renderer. A listener that
     throws must not stop the others or kill the turn, so each is called in its
     own try. */
  emit(event) {
    let validated;
    try {
      validated = validateEngineEvent(event);
    } catch (error) {
      /* A mapping bug here is ours, not the child's. Dropping the event is
         right -- forwarding an invalid one is what the contract exists to
         prevent -- but it must not be silent, or a whole event type could go
         missing with nothing to show for it. */
      this.emitDiagnostic(error);
      return;
    }
    const turn = this.activeTurn;
    const textActivity = ['assistant_text_delta', 'assistant_text', 'thinking'].includes(validated.type)
      && typeof validated.text === 'string' && validated.text.length > 0;
    const toolActivity = validated.toolCallId && ((validated.type === 'tool_call' && validated.tool)
      || (validated.type === 'tool_result' && (validated.text !== undefined || validated.payload !== undefined)));
    if (turn && validated.turnId === turn.turnId && (textActivity || toolActivity)) {
      // Unknown packets, empty output and control acknowledgments cannot keep
      // a stalled model alive. Explicit close still clears this same timer.
      turn.timer.refresh();
    }
    for (const listener of this.listeners) {
      try { listener(validated); } catch { /* one bad listener is not the turn's problem */ }
    }
  }

  emitDiagnostic(error) {
    if (typeof process !== 'undefined' && process.emitWarning) {
      process.emitWarning(`claude-cli-adapter dropped a malformed event: ${error && error.message}`);
    }
  }

  /* ----------------------------------------------------------- packets -- */

  handlePacket(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (this.closed) return;
    if (this.expectedResumeThreadId && (typeof packet.session_id === 'string' && packet.session_id !== this.expectedResumeThreadId
        || (!this.resumeIdentityVerified && ['assistant', 'stream_event', 'result'].includes(packet.type)))) {
      const error = new ClaudeCliError('CLAUDE_RESUME_IDENTITY_MISMATCH',
        'The Claude program did not confirm the saved conversation identity. Its continuation was stopped.');
      const turn = this.activeTurn;
      if (turn) { this.activeTurn = null; clearTimeout(turn.timer); turn.reject(error); }
      this.close(); this.transport.close(); return;
    }
    if (this.expectedFork && (typeof packet.session_id === 'string'
        && packet.session_id !== this.expectedFork.threadId
        || (!this.forkIdentityVerified && ['assistant', 'stream_event', 'result'].includes(packet.type)))) {
      const error = new ClaudeCliError('CLAUDE_EDITOR_FORK_INVALID',
        'The Claude program did not confirm a separate conversation identity. Its copy was stopped.');
      const turn = this.activeTurn;
      if (turn) { this.activeTurn = null; clearTimeout(turn.timer); turn.reject(error); }
      this.close();
      this.transport.close();
      return;
    }

    /* A control_response answers initialization or an interrupt. Measured: the CLI replies
       {"type":"control_response","response":{"subtype":"success","request_id":...}} */
    if (packet.type === 'control_response') {
      const requestId = packet.response && packet.response.request_id;
      const pending = this.pendingControl.get(requestId);
      if (pending) {
        this.pendingControl.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(packet.response);
      }
      return;
    }

    if (packet.type === 'system' && ['init', 'status'].includes(packet.subtype)
        && packet.session_id === this.threadId && typeof packet.permissionMode === 'string') {
      const mode = packet.permissionMode === 'manual' ? 'default' : packet.permissionMode;
      this.currentModeId = this.allowedModes?.includes(mode) ? mode : null;
      this.modeRevision++;
    }
    const turn = this.activeTurn;
    const turnId = turn ? turn.turnId : undefined;
    const threadId = this.threadId || undefined;
    const base = { ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) };

    switch (packet.type) {
      case 'system':
        /* init carries the CLI's own session id. We passed one in, so this is a
           CONFIRMATION rather than news -- and if it ever disagrees, the child's
           answer is the truth, because that is the id its transcript is under
           and the id --resume will want.

           IT IS ALSO EMITTED AS turn_accepted, on 'init' only -- never on the
           other system subtypes (e.g. thinking_tokens), which name a different
           fact and are not this one. See the file header for why this engine
           needs a separate early signal at all. This is a NEW EMISSION, not a
           new resolution: sendTurn()'s own promise is untouched below. */
        if (packet.subtype === 'init' && typeof packet.session_id === 'string') {
          if (this.expectedResumeThreadId) this.resumeIdentityVerified = true;
          if (this.expectedFork) this.forkIdentityVerified = true;
          if (this.threadId !== packet.session_id) { this.currentModeId = null; this.modeRevision++; }
          this.threadId = packet.session_id;
          this.emit({ type: 'turn_accepted', ...base, threadId: this.threadId });
        }
        return;

      case 'stream_event':
        return this.handleStreamEvent(packet, base);

      case 'assistant':
        return this.handleAssistant(packet, base);

      case 'user':
        return this.handleUser(packet, base);

      case 'result':
        return this.handleResult(packet, base);

      default:
        /* rate_limit_event and anything added upstream later. Deliberately
           ignored rather than mapped to a type it is not: the contract's own
           types are the vocabulary, and an unknown packet is not one of them. */
        return;
    }
  }

  handleStreamEvent(packet, base) {
    const event = packet.event;
    if (!event) return;
    // Current --include-partial-messages forwards the provider's message/block
    // stream. Only supplied thinking text is readable; signatures and redacted
    // blocks never become text. https://platform.claude.com/docs/en/build-with-claude/streaming
    if (event.type === 'message_start') {
      this.thinkingStream = base.turnId && typeof event.message?.id === 'string'
        ? { messageId: event.message.id, turnId: base.turnId, blocks: new Map() } : null;
      return;
    }
    if (event.type === 'message_stop') { this.thinkingStream = null; return; }
    const stream = this.thinkingStream;
    const index = event.index;
    if (stream && stream.turnId === base.turnId && Number.isSafeInteger(index) && index >= 0 && index < 128) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        const text = typeof event.content_block.thinking === 'string' ? event.content_block.thinking : '';
        stream.blocks.set(index, { text: text.slice(0, 1_000_000), truncated: text.length > 1_000_000 });
      }
      const block = stream.blocks.get(index);
      const thinkingDelta = event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta'
        && typeof event.delta.thinking === 'string' && event.delta.thinking.length > 0;
      if (block && thinkingDelta) {
        const next = block.text + event.delta.thinking;
        block.text = next.slice(0, 1_000_000);
        block.truncated ||= next.length > 1_000_000;
      }
      if (block && (['content_block_start', 'content_block_stop'].includes(event.type) || thinkingDelta)) {
        if (block.text) this.emit({ type: 'thinking', ...base,
          itemId: `thinking:${JSON.stringify([stream.messageId, index])}`, text: block.text,
          ...(event.type !== 'content_block_stop' ? { status: 'inProgress' } : {}),
          ...(block.truncated ? { payload: { truncated: true } } : {}) });
        if (event.type === 'content_block_stop') stream.blocks.delete(index);
        return;
      }
    }
    if (event.type !== 'content_block_delta') return;
    const delta = event.delta;
    if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string') return;
    // Provider content-block identity joins each stream to its own final.
    // Equal words in different blocks are distinct speech, not replay.
    const itemId = stream && stream.turnId === base.turnId && Number.isSafeInteger(index) && index >= 0
      ? `text:${JSON.stringify([stream.messageId, index])}` : null;
    this.emit({ type: 'assistant_text_delta', ...base, ...(itemId ? { itemId } : {}), text: delta.text });
  }

  handleAssistant(packet, base) {
    const content = packet.message && Array.isArray(packet.message.content) ? packet.message.content : [];
    const itemId = packet.message && typeof packet.message.id === 'string' ? packet.message.id : undefined;
    for (const [index, part] of content.entries()) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        this.emit({ type: 'assistant_text', ...base, ...(itemId ? { itemId: `text:${JSON.stringify([itemId, index])}` } : {}), text: part.text });
      } else if (part.type === 'tool_use') {
        this.emit({
          type: 'tool_call',
          ...base,
          ...(typeof part.id === 'string' ? { toolCallId: part.id } : {}),
          ...(typeof part.name === 'string' ? { tool: part.name } : {}),
          ...(part.input === undefined ? {} : { payload: part.input })
        });
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        /* MEASURED shape: { type: 'thinking', thinking: '...', signature: '...' }.
           `signature` is the provider's own proof of the block and carries no
           reader-facing content, so it is never read here. See the file header
           for why this rides the contract's own `thinking` type rather than
           assistant_text. */
        this.emit({ type: 'thinking', ...base, ...(itemId ? { itemId: `thinking:${JSON.stringify([itemId, index])}` } : {}),
          text: part.thinking.slice(0, 1_000_000), ...(part.thinking.length > 1_000_000 ? { payload: { truncated: true } } : {}) });
      }
    }
  }

  handleUser(packet, base) {
    const content = packet.message && Array.isArray(packet.message.content) ? packet.message.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || part.type !== 'tool_result') continue;
      /* The CLI returns tool output as a string OR as an array of blocks. Both
         are carried whole on `payload`; `text` gets the string form only when
         there is genuinely one, because a JSON blob rendered as an agent's
         words is worse than no text at all. */
      const raw = part.content;
      this.emit({
        type: 'tool_result',
        ...base,
        ...(typeof part.tool_use_id === 'string' ? { toolCallId: part.tool_use_id } : {}),
        ...(typeof raw === 'string' ? { text: raw } : {}),
        ...(raw === undefined ? {} : { payload: raw }),
        status: part.is_error === true ? 'error' : 'ok'
      });
    }
  }

  handleResult(packet, base) {
    this.thinkingStream = null;
    /* USAGE FIRST, THEN COMPLETION, and the order is load-bearing: a listener
       that tears down its turn state on turn_completed would never see figures
       emitted after it. */
    if (packet.usage && typeof packet.usage === 'object') {
      this.lastUsage = packet.usage;
      this.emit({ type: 'usage', ...base, usage: packet.usage });
    }
    const status = packet.is_error === true
      ? 'error'
      : (typeof packet.subtype === 'string' ? packet.subtype : 'success');
    /* A FAILED TURN'S SENTENCE RIDES ITS COMPLETION, on the contract's own
       `text` field. MEASURED (walkthrough 2026-08-16, re-measured 2026-08-19
       on claude 2.1.186): a refused turn arrives as is_error:true with the one
       human sentence in the whole stream in `result` -- "You're out of usage
       credits · resets Aug 25, 12am"; "There's an issue with the selected
       model (claude-fable)..." -- and NO assistant text before it. Keeping
       that sentence out of the event stream meant every surface above printed
       "finished without any words back" while this module held the reason.
       ONLY on failure: a successful result's text duplicates the assistant
       text already delivered, and carrying it twice invites double printing. */
    const failureText = packet.is_error === true && typeof packet.result === 'string' && packet.result.length > 0
      ? packet.result
      : null;
    this.emit({ type: 'turn_completed', ...base, status, ...(failureText ? { text: failureText } : {}) });

    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    clearTimeout(turn.timer);
    /* MEASURED: an INTERRUPTED turn produces a result packet with NO `result`
       field at all. An early version of the probe assumed it was always a string
       and threw. So the text is optional here, and its absence is a normal
       outcome rather than a malformed packet. */
    turn.resolve(Object.freeze({
      threadId: this.threadId,
      turnId: turn.turnId,
      status,
      isError: packet.is_error === true,
      text: typeof packet.result === 'string' ? packet.result : null,
      usage: packet.usage && typeof packet.usage === 'object' ? packet.usage : null
    }));
  }

  handleExit(exitInfo) {
    this.thinkingStream = null;
    this.exitInfo = exitInfo || null;
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      clearTimeout(turn.timer);
      /* A child that dies mid-turn must REJECT rather than resolve. A resolved
         turn with no answer reads to every caller as a successful empty reply,
         which is the silence this project keeps paying for. */
      turn.reject(new ClaudeCliError(
        'CLAUDE_CLI_EXITED',
        `The Claude program stopped before finishing the turn (exit ${exitInfo && exitInfo.code}).`
      ));
    }
    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ClaudeCliError('CLAUDE_CLI_EXITED', 'The Claude program stopped.'));
    }
    this.pendingControl.clear();
  }

  /* ------------------------------------------------------------ thread -- */

  async startThread(threadOptions = {}) {
    validateThreadOptions(threadOptions);
    if (!this.threadId) this.threadId = randomUUID();
    return Object.freeze({ threadId: this.threadId });
  }

  // The official stream protocol acknowledges initialize without a user
  // turn. A missing --resume conversation exits before acknowledging it.
  // Waiting here prevents the host from handing a doomed session to a sender.
  async initialize({ timeoutMs = 60_000 } = {}) {
    if (this.closed || this.exitInfo) {
      throw new ClaudeCliError('CLAUDE_CLI_EXITED', 'The Claude program stopped before opening the conversation.');
    }
    const requestId = randomUUID();
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControl.delete(requestId)) {
          reject(new ClaudeCliError('CLAUDE_CLI_INITIALIZE_TIMEOUT', 'The Claude program did not confirm that it opened the conversation.'));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pendingControl.set(requestId, { resolve, reject, timer });
    });
    try {
      this.transport.send({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } });
    } catch (error) {
      const pending = this.pendingControl.get(requestId);
      if (!pending) throw error;
      this.pendingControl.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const response = await answered;
    if (response?.subtype !== 'success') {
      throw new ClaudeCliError('CLAUDE_CLI_INITIALIZE_REFUSED', 'The Claude program could not open the conversation.');
    }
    if (this.closed || this.exitInfo) {
      throw new ClaudeCliError('CLAUDE_CLI_EXITED', 'The Claude program stopped before opening the conversation.');
    }
    return response;
  }

  getSessionModes(threadId) {
    if (!this.allowedModes || threadId !== this.threadId || this.closed || this.exitInfo) return null;
    return Object.freeze({ currentModeId: this.currentModeId,
      availableModes: Object.freeze(this.allowedModes.map(id => Object.freeze({ id,
        name: ({ plan: 'Plan', default: 'Default', acceptEdits: 'Accept edits', bypassPermissions: 'Unrestricted' })[id] }))) });
  }

  async selectMode(threadId, modeId) {
    if (this.closed || this.exitInfo) throw new ClaudeCliError('CLAUDE_CLI_CLOSED', 'This Claude session is closed.');
    if (threadId !== this.threadId || !this.threadId) throw new ClaudeCliError('CLAUDE_CLI_INVALID_THREAD', 'That conversation is not held by this session.');
    if (!this.allowedModes?.includes(modeId)) throw new ClaudeCliError('CLAUDE_MODE_NOT_ALLOWED', 'The trusted launch confinement does not allow that native mode.');
    if (this.activeTurn || this.modeSelecting) throw new ClaudeCliError('CLAUDE_MODE_BUSY', 'Wait for the current turn or mode selection to finish.');
    this.modeSelecting = true;
    const revision = this.modeRevision;
    const requestId = randomUUID();
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControl.delete(requestId)) reject(new ClaudeCliError('CLAUDE_MODE_TIMEOUT', 'Claude did not confirm the native mode.'));
      }, this.modeTimeoutMs);
      this.pendingControl.set(requestId, { resolve, reject, timer });
    });
    try {
      try {
        this.transport.send({ type: 'control_request', request_id: requestId,
          request: { subtype: 'set_permission_mode', mode: modeId } });
      } catch (error) {
        const pending = this.pendingControl.get(requestId);
        if (pending) { this.pendingControl.delete(requestId); clearTimeout(pending.timer); pending.reject(error); }
      }
      const response = await answered;
      if (this.closed || this.exitInfo || this.threadId !== threadId) throw new ClaudeCliError('CLAUDE_MODE_UNCONFIRMED', 'The session changed before mode confirmation.');
      if (response?.subtype === 'error') throw new ClaudeCliError('CLAUDE_MODE_REFUSED', 'Claude refused the requested native mode.');
      if (response?.subtype !== 'success' || response.response?.mode !== modeId
          || (this.modeRevision !== revision && this.currentModeId !== modeId)) {
        throw new ClaudeCliError('CLAUDE_MODE_UNCONFIRMED', 'Claude did not confirm the requested current native mode.');
      }
      this.currentModeId = modeId;
      this.modeUncertain = false;
      return Object.freeze({ threadId, currentModeId: modeId, appliesOn: 'subsequent-turns' });
    } catch (error) {
      if (error.code !== 'CLAUDE_MODE_REFUSED') { this.currentModeId = null; this.modeUncertain = true; }
      throw error;
    } finally { this.modeSelecting = false; }
  }

  async resumeThread(threadId, threadOptions = {}) {
    validateThreadOptions(threadOptions);
    this.threadId = validateThreadId(threadId);
    /* The CLI restores the conversation itself from `--resume`; it does not
       report the history back over this stream, so `turns` is empty rather than
       fabricated. Claiming a turn count we did not receive would put invented
       history on a screen. */
    return Object.freeze({ threadId: this.threadId, turns: Object.freeze([]), turnCount: 0 });
  }

  /* FORKING IS REFUSED, BY NAME, AND THAT IS THE HONEST ANSWER.
   *
   * The contract requires the METHOD; it does not require this CLI to have a
   * feature it does not have. There is no flag that branches a conversation at
   * a chosen turn -- `--resume` continues one, and copying a transcript on disk
   * would be this product reaching into the CLI's private storage, which is the
   * boundary the whole design keeps. So it refuses with a code a caller can
   * show, rather than silently returning the parent thread and letting a person
   * believe they are on a branch while they overwrite the original. */
  async forkThread() {
    throw new ClaudeCliError(
      'CLAUDE_CLI_FORK_UNSUPPORTED',
      'The Claude program cannot branch a conversation at a past turn. Start a new agent instead.'
    );
  }

  /* -------------------------------------------------------------- turn -- */

  async sendTurn(request) {
    if (this.modeSelecting || this.modeUncertain) {
      throw new ClaudeCliError('CLAUDE_MODE_UNCONFIRMED', 'Confirm the pending native mode before starting a turn.');
    }
    const { threadId, text, images } = validateSendTurnRequest(request);
    if (this.closed) throw new ClaudeCliError('CLAUDE_CLI_CLOSED', 'This Claude session is closed.');
    if (this.activeTurn) {
      throw new ClaudeCliError('CLAUDE_CLI_TURN_ACTIVE', 'This session is already working on a turn.');
    }
    if (this.threadId && threadId !== this.threadId) {
      throw new ClaudeCliError('CLAUDE_CLI_INVALID_THREAD', 'That conversation is not the one this session holds.');
    }
    /* THE PICTURES, BUILT BEFORE THE TURN IS INSTALLED. A picture that cannot
       be read still refuses and still sends nothing -- the words alone would
       answer a question about something the model never received -- but the
       refusal now names which picture and why, instead of saying this session
       cannot take pictures at all. Building here, before activeTurn exists,
       means a refused picture leaves no turn behind to time out. */
    const imageBlocks = images.map(image => imageContentBlock(image, this.imageLoader));

    const turnId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.activeTurn && this.activeTurn.turnId === turnId) {
          this.activeTurn = null;
          reject(new ClaudeCliError('CLAUDE_CLI_TURN_TIMEOUT', 'The Claude program stopped reporting activity before finishing this turn.'));
          // Result packets carry no request identity. Reusing this stream
          // would let the timed-out request's late result complete a later
          // turn. End the session and its owned process before accepting work.
          this.close();
          try { this.transport.close?.(); } catch (error) { this.emitDiagnostic(error); }
        }
      }, this.turnTimeoutMs);
      if (timer.unref) timer.unref();
      this.activeTurn = { turnId, resolve, reject, timer };
    });

    try {
      this.transport.send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }, ...imageBlocks] }
      });
    } catch (error) {
      /* Installing the turn before writing is necessary because a transport may
         synchronously deliver data from send(). If the write itself fails,
         undo that installation so the failed message does not keep the session
         busy until the turn timeout. */
      if (this.activeTurn && this.activeTurn.turnId === turnId) {
        const turn = this.activeTurn;
        this.activeTurn = null;
        clearTimeout(turn.timer);
        turn.reject(error);
        return promise;
      }
      throw error;
    }
    return promise;
  }

  /* AN INTERRUPT IS A PROTOCOL MESSAGE, NOT A KILL, and that was measured
   * rather than hoped: sending
   *   {"type":"control_request","request_id":...,"request":{"subtype":"interrupt"}}
   * mid-answer produced
   *   {"type":"control_response","response":{"subtype":"success","request_id":...}}
   * and the turn ended with a result packet carrying no text.
   *
   * That matters because the alternative -- killing the child -- would end the
   * SESSION to stop a TURN, and the person would lose the conversation they were
   * steering. Stopping the work and keeping the thread is the whole point of the
   * control. */
  // A local ownership receipt for cancellation, never provider acceptance.
  pendingTurnForInterrupt({ threadId } = {}) {
    if (this.closed || !this.activeTurn || threadId !== this.threadId) return null;
    return Object.freeze({ threadId: this.threadId, turnId: this.activeTurn.turnId });
  }

  async interrupt({ threadId, turnId } = {}) {
    if ((threadId !== undefined && threadId !== this.threadId)
        || (turnId !== undefined && turnId !== this.activeTurn?.turnId)) {
      throw new ClaudeCliError('CLAUDE_CLI_TURN_UNKNOWN', 'The turn selected for cancellation is no longer active.');
    }
    if (!this.activeTurn) {
      throw new ClaudeCliError('CLAUDE_CLI_NO_TURN', 'There is nothing running in this session to stop.');
    }
    const requestId = randomUUID();
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControl.delete(requestId)) {
          reject(new ClaudeCliError('CLAUDE_CLI_INTERRUPT_UNANSWERED', 'The Claude program did not answer the request to stop.'));
        }
      }, 10_000);
      if (timer.unref) timer.unref();
      this.pendingControl.set(requestId, { resolve, reject, timer });
    });
    try {
      this.transport.send({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    } catch (error) {
      // The stop promise is installed before send so synchronous replies work.
      // A failed write must settle that same promise; throwing past it leaves
      // an unobserved rejection waiting for the timeout or session close.
      const pending = this.pendingControl.get(requestId);
      if (!pending) throw error;
      this.pendingControl.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    const response = await answered;
    if (response?.subtype !== 'success') {
      throw new ClaudeCliError(response?.subtype === 'error' ? 'CLAUDE_CLI_INTERRUPT_REFUSED' : 'CLAUDE_CLI_INTERRUPT_UNCONFIRMED',
        'The Claude program did not confirm the request to stop.');
    }
    return response;
  }

  /* APPROVALS ARE NOT WIRED, AND THE REFUSAL IS THE SAFE DIRECTION.
   *
   * Routing them would mean running the child with `--permission-prompt-tool`
   * pointed at an MCP tool of ours, so every permission question came back here
   * to be answered. That is a real design and it is not this pass's.
   *
   * Until it is, the confinement does the work instead: the permission mode is
   * bound at spawn from the recorded level, so a session cannot exceed it
   * whether or not anybody is listening for approvals. This throwing is
   * therefore the fail-closed branch -- an unconfigured approval path denies,
   * it never permits, which is rule 4 of the transport contract. */
  async answerApproval(answer) {
    validateApprovalAnswer(answer);
    throw new ClaudeCliError(
      'CLAUDE_CLI_APPROVALS_UNSUPPORTED',
      'This Claude session does not ask for approvals; native mode changes remain bounded by its original launch confinement.'
    );
  }

  /* The provider's own figures from the last completed turn, or null.
     NEVER SYNTHESISED -- rule 2 of the transport contract, and the reason this
     returns null instead of zeroes. A zero is a number a person can read as a
     fact; null is the absence it actually is. */
  getUsage() {
    return this.lastUsage;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.thinkingStream = null;
    this.listeners.clear();
    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      clearTimeout(turn.timer);
      turn.reject(new ClaudeCliError('CLAUDE_CLI_CLOSED', 'This Claude session was closed while a turn was running.'));
    }
    for (const pending of this.pendingControl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ClaudeCliError('CLAUDE_CLI_CLOSED', 'This Claude session was closed while a stop request was pending.'));
    }
    this.pendingControl.clear();
  }
}

module.exports = {
  ClaudeCliAdapter,
  ClaudeCliError,
  SANDBOX_TO_PERMISSION_MODE,
  DEFAULT_TURN_TIMEOUT_MS,
  assertClaudeCliAdapter: adapter => assertEngineAdapter(adapter),
  claudeArgs,
  claudeResumeArgs,
  claudeForkArgs,
  claudeServerPermissionRule,
  cliModelFor,
  permissionModeFor,
  nativeModePolicyFor
};
