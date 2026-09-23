'use strict';

// P15's closed, transport-safe failure boundary.  It deliberately retains no
// provider prose in its public shape: callers decide retry/block/fail from the
// code and classification alone.  Legacy detailed errors stay available to
// their originating protected audit path, never as cross-process authority.

const POLICY = require('../../schemas/platform/error-policy.json');

const SCHEMA_VERSION = '1.0.0';
const CLASSIFICATIONS = Object.freeze(['terminal', 'retry-after-input', 'retry-after-time']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const RETRY_CEILING_KEYS = Object.freeze(['default', 'external-read', 'external-write', 'local-read', 'local-write']);
const PROTECTED_DETAILS = new WeakMap();

function freeze(value) { return Object.freeze(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatePolicy(policy) {
  const requiredPolicy = ['policyVersion', 'policyAuthority', 'codes', 'globalRetryCeiling', 'operationRetryCeilings'];
  if (!plain(policy) || requiredPolicy.some(key => !own(policy, key))
    || policy.policyVersion !== SCHEMA_VERSION || policy.policyAuthority !== 'toolsenabled'
    || !Array.isArray(policy.codes) || policy.codes.length < 15
    || !Number.isSafeInteger(policy.globalRetryCeiling) || policy.globalRetryCeiling < 1 || policy.globalRetryCeiling > 10
    || !plain(policy.operationRetryCeilings)) {
    throw new Error('The shared error taxonomy policy is invalid.');
  }
  const codes = new Set();
  for (const item of policy.codes) {
    const requiredCode = ['code', 'classification', 'retryable', 'defaultRetryAfterMs', 'safeSummary'];
    if (!plain(item) || requiredCode.some(key => !own(item, key)) || !CODE_PATTERN.test(item.code) || codes.has(item.code)
      || !CLASSIFICATIONS.includes(item.classification) || typeof item.retryable !== 'boolean'
      || typeof item.safeSummary !== 'string' || item.safeSummary.length < 1 || item.safeSummary.length > 240
      || !(item.defaultRetryAfterMs === null || (Number.isSafeInteger(item.defaultRetryAfterMs)
        && item.defaultRetryAfterMs >= 0 && item.defaultRetryAfterMs <= 3_600_000))) {
      throw new Error('The shared error taxonomy code table is invalid.');
    }
    if (item.retryable !== (item.classification === 'retry-after-time')
      || (item.retryable && !Number.isSafeInteger(item.defaultRetryAfterMs))
      || (!item.retryable && item.defaultRetryAfterMs !== null)) {
      throw new Error(`The retryability for ${item.code} conflicts with its closed classification.`);
    }
    codes.add(item.code);
  }
  for (const required of [
    'INVALID_REQUEST', 'POLICY_DENIED', 'APPROVAL_REQUIRED', 'INPUT_REQUIRED', 'AUTH_EXPIRED',
    'QUOTA_EXHAUSTED', 'UNAVAILABLE', 'TIMEOUT', 'MALFORMED_OUTPUT', 'VERIFICATION_FAILED',
    'STALE_DATA', 'RESOURCE_PRESSURE', 'INJECTION_DETECTED', 'SANDBOX_VIOLATION', 'EXTERNAL_CHANGE', 'INTERNAL_ERROR', 'OPERATION_CANCELLED'
  ]) if (!codes.has(required)) throw new Error(`The shared error taxonomy is missing ${required}.`);
  if (JSON.stringify(Object.keys(policy.operationRetryCeilings).sort()) !== JSON.stringify([...RETRY_CEILING_KEYS].sort())) {
    throw new Error('The shared error taxonomy retry ceiling keys are invalid.');
  }
  for (const value of Object.values(policy.operationRetryCeilings)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > policy.globalRetryCeiling) {
      throw new Error('The shared error taxonomy retry ceilings are invalid.');
    }
  }
}

validatePolicy(POLICY);
const BY_CODE = new Map(POLICY.codes.map(item => [item.code, freeze({ ...item })]));
const ERROR_CODES = freeze(Object.fromEntries([...BY_CODE].map(([code, item]) => [code, item])));
const ERROR_CODE_VALUES = freeze([...BY_CODE.keys()]);
const RETRY_CEILINGS = freeze({ global: POLICY.globalRetryCeiling, ...POLICY.operationRetryCeilings });

function isCode(value) { return typeof value === 'string' && BY_CODE.has(value); }
function policyFor(code) { return BY_CODE.get(code) || BY_CODE.get('INTERNAL_ERROR'); }

function sourceCode(error) {
  const value = error && typeof error === 'object' && own(error, 'code') ? error.code : undefined;
  return typeof value === 'string' && value.length <= 200 ? value.toUpperCase() : '';
}

function sourceStatus(error) {
  const value = error && typeof error === 'object'
    ? (own(error, 'statusCode') ? error.statusCode : (own(error, 'status') ? error.status : (own(error, 'httpStatus') ? error.httpStatus : undefined)))
    : undefined;
  return Number.isInteger(value) ? value : null;
}

// THE CONTAINMENT RULE (the class fix for the 2026-08-19 sweep's 65 blanketed
// refusals; tests/error-taxonomy-refusal-rescue.test.js is its measured proof).
//
// This tree composes source codes as `<subsystem noun phrase>_<condition
// phrase>` with the condition at the TAIL: VAULT_SECRET_UNAVAILABLE,
// TASK_RUN_NOT_FOUND, MODEL_PROVIDER_NOT_CONFIGURED. The original
// `includesCode` matched a policy value only as the code's HEAD (exact or
// `VALUE_` prefix), so every one of those honest refusals fell through to
// INTERNAL_ERROR -- and the file's own history shows two prior one-code
// patches (the OWNER_PROMPT_* pair, 2026-08-11) treating single symptoms of
// exactly this class.
//
// The rule now: a policy value matches when its whole `_`-segment sequence
// appears in the code with BOTH ends on segment boundaries -- as head, tail,
// or interior. Partial words can never match (RESOURCE never matches
// RESOURCEFUL; UNAVAILABLE never matches UNAVAILABLEX), because both ends of
// the value must land on an underscore or a string edge. Values are CONDITION
// phrases, possibly multi-segment ('SECRET_UNAVAILABLE', 'NOT_AUTHORIZED'),
// which is what lets a rule speak about a condition wherever a subsystem
// composed it.
//
// TWO PASSES, so yesterday's classifications cannot move. Pass 1 runs the
// ladder with the historical head-anchored match; only when it answers
// INTERNAL_ERROR does pass 2 re-run the same ladder with whole-segment
// containment. Measured over the 3,287 distinct source codes in this tree on
// 2026-08-19: bare containment would have rescued 1,450 codes but MOVED 18
// already-classified ones between classes (INVALID_AUTH_KEY to AUTH_EXPIRED,
// SCHEDULER_ACTION_INVALID off its family rule, and so on); the two-pass form
// rescues the same codes and moves none. The fail-closed direction stays: a
// code no rule speaks about still answers INTERNAL_ERROR in both passes, and
// classification still consumes the structured `code` field only -- prose is
// never matched.
function includesCode(code, values) { return values.some(value => code === value || code.startsWith(`${value}_`)); }
function includesCodeSegments(code, values) {
  return values.some(value => code === value
    || code.startsWith(`${value}_`) || code.endsWith(`_${value}`) || code.includes(`_${value}_`));
}

// This mapping intentionally consumes structured source fields only.  It
// never decides a controller action by regexing provider prose.
function classifySourceCode(code, status, timedOut, matches) {
  if (isCode(code)) return code;
  // Losing an interactive transport does not prove a click or keypress failed.
  // Require inspection/input rather than automatically replaying that action.
  if (['PLAYWRIGHT_CALL_TIMEOUT', 'PLAYWRIGHT_CALL_TRANSPORT_CLOSED',
    'PLAYWRIGHT_CALL_TRANSPORT_FAILED', 'PLAYWRIGHT_CALL_RESPONSE_INVALID',
    'PLAYWRIGHT_CALL_RESPONSE_TOO_LARGE', 'BROWSER_SESSION_CHANGED',
    'SCREEN_ACTION_UNCERTAIN'].includes(code)) return 'EXTERNAL_CHANGE';
  // A queued action from a released screen turn needs a fresh observation,
  // never automatic replay. Keep this exact refusal within the closed taxonomy.
  if (code === 'SCREEN_CONTROL_CHANGED') return 'EXTERNAL_CHANGE';
  if (code === 'SCREEN_ACTION_INTERRUPTED') return 'OPERATION_CANCELLED';
  if (['SCREEN_ACCESS_OFF', 'SCREEN_ACCESS_CHANGED', 'SCREEN_PLATFORM_UNAVAILABLE',
    'SCREEN_HOST_UNAVAILABLE', 'SCREEN_INPUT_RELEASE_FAILED', 'PLAYWRIGHT_CALL_SESSION_CLOSED'].includes(code)) return 'INPUT_REQUIRED';
  // A valid request cannot supply a missing operating-system backend. Keep
  // these exact platform prerequisites out of the invalid-input fallback for
  // unsupported request options; waiting alone cannot install that backend.
  if (['DESKTOP_PLATFORM_UNSUPPORTED', 'WORKSTATION_PLATFORM_UNSUPPORTED',
    'SCHEDULER_PLATFORM_UNSUPPORTED', 'SECRET_VAULT_PLATFORM_UNSUPPORTED',
    'DUO_DESKTOP_PLATFORM_UNSUPPORTED', 'OVERNIGHT_ADVISORY_WORKER_PLATFORM_UNSUPPORTED',
    'OWNER_PROMPT_PLATFORM_UNSUPPORTED'].includes(code)) return 'INPUT_REQUIRED';
  // A missing declared controller cannot be repaired by waiting for RAM/CPU.
  // Keep this identity prerequisite ahead of the broad RESOURCE family.
  if (code === 'RESOURCE_CONTROLLER_REQUIRED') return 'INPUT_REQUIRED';
  if (code === 'ACCESSIBILITY_OFF') return 'INPUT_REQUIRED';
  // Resource advice cites one measured sample. An old sample needs a new
  // status read; elapsed time cannot make the old observation current again.
  if (code === 'RESOURCE_ADVICE_STALE') return 'STALE_DATA';
  // Generic task tools cannot act on a domain-owned queue. Preserve the
  // provider's direction to that domain's controls across the host proxy.
  if (code === 'TASK_QUEUE_RESERVED') return 'POLICY_DENIED';
  if (code === 'QUEUE_PHASE_UNKNOWN') return 'INVALID_REQUEST';
  if (code === 'QUEUE_CONCURRENT_EDIT') return 'STALE_DATA';
  // These require account setup or an installed CLI. Waiting cannot install
  // a command, and a one-time tool approval cannot authorize a Google account.
  if (['GOOGLE_ACCOUNT_NOT_AUTHORIZED', 'GCLOUD_LOGIN_UNAVAILABLE',
    'FIREBASE_UNAVAILABLE'].includes(code)) return 'INPUT_REQUIRED';
  if (['CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE', 'CODEX_CLI_TASK_NOT_VISIBLE'].includes(code)) return 'INPUT_REQUIRED';
  // Exact coordination outcomes must not be inferred from words such as
  // CLOSED or MISSING: retrying a revoked scope cannot restore its authority,
  // and a lost database is not permission to initialize empty history.
  if (['BYTE_STATE_CORRUPT', 'BYTE_STATE_MISSING'].includes(code)) return 'VERIFICATION_FAILED';
  if (code === 'BYTE_SCOPE_CLOSED' || code === 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED') return 'AUTH_EXPIRED';
  if (code === 'BYTE_SCOPE_MISMATCH') return 'POLICY_DENIED';
  if (['BYTE_PUBLICATION_UNCONFIRMED', 'BYTE_PUBLICATION_COMMITTED_SCOPE_REVOKED',
    'BYTE_RECOVERY_UNRESOLVED', 'BYTE_AUTHORITY_RELEASE_FAILED', 'REPO_FILE_CHANGED_BEFORE_WRITE'].includes(code)) return 'EXTERNAL_CHANGE';
  if (code === 'REPO_FILE_CHANGED_DURING_READ') return 'STALE_DATA';
  if (['REPO_FILE_PATCH_MISMATCH', 'REPO_FILE_PATCH_AMBIGUOUS'].includes(code)) return 'INVALID_REQUEST';
  // Exact exception: this 403 is an organisation-policy decision, not an
  // expired sign-in. Keep every other historical 403 on the existing path.
  if (code === 'BRIDGE_ACTOR_REFUSED') return 'POLICY_DENIED';
  // These exact settings decisions must retain the sentence naming the
  // disabled standing-rule control in the public MCP result.
  if (code === 'R_LEDGER_AGENT_FILING_OFF' || code === 'R_LEDGER_AGENT_FILING_PROPOSE_ONLY') return 'POLICY_DENIED';
  // A reset marker keeps the retained row out of product readers. Calls that
  // name it need a fresh list, never a retry against that historical id.
  if (['R_LEDGER_ENTRY_RESET', 'R_LEDGER_RESET_EMPTY', 'BRIDGE_LEDGER_TARGET_RESET', 'OWNER_PROMPT_RESET_PENDING', 'OWNER_PROMPT_RESET_UNKNOWN'].includes(code)) return 'STALE_DATA';
  // These are rejected input contents, not a broken memory database or an
  // expired sign-in. Keep the secret-field filters and protected prose intact.
  if (code === 'MEMORY_SECRET_REJECTED' || code === 'TASK_SECRET_REJECTED') return 'INVALID_REQUEST';
  if (matches(code, ['INJECTION', 'SSRF', 'PROMPT_INJECTION'])) return 'INJECTION_DETECTED';
  if (matches(code, ['SANDBOX', 'CONTAINER_ESCAPE'])) return 'SANDBOX_VIOLATION';
  if (code === 'HTTP_RESPONSE_DECODE_FAILED'
    || matches(code, ['MALFORMED_OUTPUT', 'PROVIDER_OUTPUT', 'OUTPUT_PARSE', 'OUTPUT_SCHEMA'])) return 'MALFORMED_OUTPUT';
  if (matches(code, ['VERIFY', 'VERIFICATION', 'INTEGRITY', 'SIGNATURE'])) return 'VERIFICATION_FAILED';
  // Deliberately exact, in BOTH passes: HTTP_TIMEOUT_INVALID and its siblings
  // are bad *arguments named "timeout"*, not timeouts, so a containment match
  // here would tell a caller to retry a permanently invalid request.
  if (timedOut || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'TIMEOUT'].includes(code)) return 'TIMEOUT';
  // The registry's explicit cancellation is a terminal outcome, not an
  // internal fault or a request to retry. Do not infer it from AbortError's
  // name (also used for HTTP deadlines), source prose, or code containment.
  if (code === 'ABORT_ERR') return 'OPERATION_CANCELLED';
  // 'SECRET_UNAVAILABLE' / 'CREDENTIAL_UNAVAILABLE' / 'ACCOUNT_INVALID' state
  // "the owner's stored sign-in material is absent or wrong here" (the sweep's
  // VAULT_SECRET_UNAVAILABLE and AGENT_COMMS_RELAY_CREDENTIAL_UNAVAILABLE
  // families), which is owner-refreshable auth, not a transient outage --
  // they sit in this rule so the later UNAVAILABLE rule cannot claim them.
  if (status === 401 || status === 403 || matches(code, ['AUTH', 'UNAUTHORIZED', 'INVALID_GRANT', 'SIGN_IN_REQUIRED',
    'SECRET_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIALS_UNAVAILABLE', 'ACCOUNT_INVALID', 'NOT_AUTHENTICATED'])) return 'AUTH_EXPIRED';
  if (status === 429 || matches(code, ['QUOTA', 'RATE_LIMIT', 'RATE_LIMITED', 'BILLING_REQUIRED'])) return 'QUOTA_EXHAUSTED';
  // WAITING ON A PERSON. Not an `OWNER_PROMPT` prefix rule, because most of
  // that family is not owner input at all: OWNER_PROMPT_QUEUE_BUSY and
  // OWNER_PROMPT_RUNNER_UNAVAILABLE are availability, OWNER_PROMPT_INVALID is a
  // bad request, and each keeps its own honest classification below. The two
  // exact codes are the 2026-08-11 patches; the three condition phrases beside
  // them were added 2026-08-19, for the members of this family that no rule in
  // the ladder spoke about at all and which therefore still answered
  // INTERNAL_ERROR after the containment fix rescued their siblings.
  //
  // PROMPT_QUEUE_FULL sits HERE while bare QUEUE_FULL sits with RESOURCE_
  // PRESSURE below, and that split is load-bearing. Five other full queues in
  // this tree (TASK_, SHADOWMANAGER_, OVERNIGHT_ADVISORY_, HOME_NODE_LOCAL_,
  // ONLINE_MAINTENANCE_) drain by themselves, so capacity is their honest
  // story; the owner-prompt queue empties only when a person answers a dialog.
  // Collapsing the two would either tell five subsystems that a human must act,
  // or tell the one that genuinely needs a human to just wait. CAPTURE_IN_
  // PROGRESS and PROMPT_IN_PROGRESS split from the generic IN_PROGRESS for the
  // same reason: an open dialog is waiting for somebody, an already-running
  // browser start is not.
  //
  // Without these, `mapSource` matches by exact code or `CODE_` prefix, no rule
  // covers OWNER_PROMPT_*, and both fall through to INTERNAL_ERROR -- so the
  // only sentence an MCP client renders for "one unanswered owner prompt is
  // holding the single active slot" is "The operation stopped safely because of
  // an internal error.", classified terminal. That is what made a stale prompt
  // look like a broken tool to every agent that hit it for eight hours on
  // 2026-08-11 (owner-prompt-189a7e9f, vault key github_pat).
  if (matches(code, ['OWNER_PROMPT_DIFFERENT_ACTIVE', 'OWNER_PROMPT_QUEUED',
    'PROMPT_IN_PROGRESS', 'CAPTURE_IN_PROGRESS', 'PROMPT_QUEUE_FULL'])) return 'INPUT_REQUIRED';
  // THE REFUSAL THAT COST A LANE ITS RE-DIAGNOSIS. A card or identity form
  // asked for by a caller that named no requester is a POLICY decision, and
  // `includesCode` matched none of its words, so it fell to INTERNAL_ERROR and
  // the only sentence the caller ever read was "The operation stopped safely
  // because of an internal error." -- indistinguishable from the queue deadlock
  // that had just been fixed, which is exactly how it was misdiagnosed on
  // 2026-08-11. Terminal is still right; pretending it is a bug is not.
  if (code === 'OWNER_PROMPT_ATTRIBUTION_REQUIRED') return 'POLICY_DENIED';
  // 'NOT_AUTHORIZED' states "nobody with the standing to allow this has done
  // so yet" (PURCHASE_NOT_AUTHORIZED, BRIDGE_CLOUD_ENVIRONMENT_NOT_AUTHORIZED)
  // -- an approval to obtain, not an expired sign-in, so it lives here rather
  // than with AUTH above.
  if (matches(code, ['APPROVAL', 'CONFIRMATION', 'NOT_AUTHORIZED'])) return 'APPROVAL_REQUIRED';
  // 'QUEUE_FULL' is capacity: the work is admissible, there is just no room for
  // it yet. The owner-prompt queue's own full state was claimed by the
  // waiting-on-a-person rule above, before this line can see it.
  if (matches(code, ['RESOURCE', 'ENOMEM', 'ENOSPC', 'THERMAL', 'HEADROOM', 'OVERLOADED', 'QUEUE_FULL'])) return 'RESOURCE_PRESSURE';
  if (code === 'MC_TREE_COMMAND_SESSION_CHANGED') return 'STALE_DATA';
  if (code === 'MC_TREE_COMMAND_SESSION_ENDED') return 'INVALID_REQUEST';
  if (matches(code, ['STALE', 'EXPIRED', 'FENCE_LOST']) || /(?:^|_)FENCE_LOST$/.test(code)) return 'STALE_DATA';
  if (matches(code, ['EXTERNAL_CHANGE', 'CONFLICT', 'OWNERSHIP_CHANGED', 'FOREIGN_TASK', 'MUTATION_CHANGED'])
    || /(?:^|_)(?:FOREIGN|OWNERSHIP_CHANGED|MUTATION_CHANGED)(?:_|$)/.test(code)) return 'EXTERNAL_CHANGE';
  // 'DISABLED' is a switch somebody turned off (TOOL_DISABLED_BY_OWNER_DECISION,
  // RESEARCH_PIPELINE_DISABLED); 'PERMISSION' is the tier policy's own refusal
  // family. Both are decisions, not faults.
  // 'PROTECTED' joins this rule 2026-09-12: HOST_PATH_WRITE_PROTECTED and
  // REPO_FILE_WRITE_PROTECTED (host-control.js / repo-files.js's own write
  // guards for src/lib and other integrity anchors) are permanent, deliberate
  // write refusals -- the same category as FORBIDDEN/DENIED/DISABLED above --
  // and no rule in this ladder recognized either code, so both fell through
  // to INTERNAL_ERROR and every caller read the opaque internal-error
  // sentence instead of the real one the tool had already worked out.
  // tests/error-taxonomy-refusal-rescue.test.js section 6 is this fix's proof.
  if (matches(code, ['POLICY', 'KILLSWITCH', 'PROVIDER_DISABLED', 'ALLOWLIST', 'DENIED', 'FORBIDDEN', 'DISABLED', 'PERMISSION', 'PROTECTED'])) return 'POLICY_DENIED';
  // The condition phrases of "something this installation needs has not been
  // supplied yet": a missing registry or language pack ('MISSING'), an absent
  // precondition ('REQUIRED', after the more specific AUTH/QUOTA/APPROVAL
  // rules above have had their turn), and unprovisioned or unconfigured
  // capability ('NOT_CONFIGURED', 'UNCONFIGURED', 'UNPROVISIONED',
  // 'NOT_PROVISIONED', and the NO_<thing>_CONFIGURED composition the model
  // providers use). Deliberately NOT bare 'CONFIGURED': the tree also names
  // ALREADY_CONFIGURED states, which are not absences.
  if (matches(code, ['INPUT_REQUIRED', 'INPUT_MISSING', 'MISSING_INPUT', 'MISSING', 'REQUIRED',
    'NOT_CONFIGURED', 'UNCONFIGURED', 'UNPROVISIONED', 'NOT_PROVISIONED'])
    || /(?:^|_)NO_(?:[A-Z0-9]+_)+CONFIGURED(?:_|$)/.test(code)) return 'INPUT_REQUIRED';
  if (matches(code, ['INPUT', 'INVALID', 'UNKNOWN_TOOL', 'NOT_FOUND', 'NOT_ENABLED', 'INVALID_ARGUMENT', 'SCHEMA'])) return 'INVALID_REQUEST';
  // 'CLOSED' is a transport or session that went away (PLAYWRIGHT_CALL_
  // TRANSPORT_CLOSED, CLAUDE_CLI_CLOSED): reopening is a
  // retry-after-time story, the same as the rest of this rule. 'BUSY' is a
  // contended lock or seat (SQLITE_BUSY, BRIDGE_ALL_SEATS_BUSY,
  // OWNER_PROMPT_QUEUE_BUSY) and 'IN_PROGRESS' is an equivalent operation
  // already running (BRIDGE_TERMINATE_IN_PROGRESS,
  // BROWSER_OWNER_START_IN_PROGRESS) -- both clear themselves, which is what
  // separates them from the two IN_PROGRESS dialogs claimed above.
  /* A DELIBERATE REFUSAL IS NOT AN OUTAGE, AND SAYING IT IS COSTS HOURS.
   *
   * 'SPAWN' below is meant for a child process that failed to start, which is
   * a real retry-after-time story. It also matches every deterministic refusal
   * whose code happens to contain the word: AGENT_SPAWN_TREE_BRIEF_TOO_LONG,
   * AGENT_SPAWN_TREE_ARGUMENT_REFUSED, AGENT_SPAWN_TREE_ROLE_UNKNOWN,
   * MC_TREE_SPAWN_PARENT_NOT_RUNNING. Those are answers, not outages, and no
   * amount of waiting changes them.
   *
   * MEASURED 2026-09-03 on the owner's own fleet: agent.spawn was refused 41
   * times out of 51 attempts in three hours, and every refusal reached the
   * agent as "The required service is temporarily unavailable. Try again
   * later." A manager retried on that sentence eleven times across half an
   * hour and reported "agent.spawn is unavailable, so neither lane has a
   * worker"; the Controller concluded "Blocked and staying blocked. No worker
   * can be created by anyone." The real sentences -- a contract 817 characters
   * over the ceiling, an argument that belongs to another surface -- were sat
   * in the audit log the whole time, each one telling the agent exactly what
   * to change.
   *
   * So a code that names its own refusal is classified by that, ahead of the
   * transport rule. Ordering is the whole mechanism: PROCESS_SPAWN_FAILED
   * still falls through to UNAVAILABLE and still retries. */
  // THE TREE-COMMAND REFUSAL FAMILY, same incident class as the two rules
  // above it. A circle's own ownership/removal rule (src/agent-removal-rule.js
  // in the app repo) answers these six as plain, deliberate refusals with a
  // real sentence attached -- "that circle is not below yours on the tree",
  // "the person has sent it a message" -- and none of their words matched
  // anything else in this ladder, so they fell to INTERNAL_ERROR exactly like
  // OWNER_PROMPT_ATTRIBUTION_REQUIRED did. Measured 2026-09-07 on
  // node-1-11bbb999 (an orphaned tree circle, parentId null): agent.remove
  // and agent.restart both answered "The operation stopped safely because of
  // an internal error." while the real sentence sat in the audit ledger the
  // whole time, reachable only there. MC_TREE_COMMAND_REMOVE_REFUSED and
  // MC_TREE_COMMAND_REMOVE_UNAVAILABLE are deliberately not listed here: they
  // already classify correctly through the REFUSED and UNAVAILABLE rules.
  if (matches(code, ['REFUSED', 'TOO_LONG', 'TOO_LARGE', 'TOO_MANY', 'NOT_ALLOWED', 'UNSUPPORTED',
    'ROLE_UNKNOWN', 'PARENT_NOT_BOUND', 'PARENT_NOT_RUNNING', 'NOT_A_TREE_AGENT', 'ROUTE_CLOSED',
    'NOT_BELOW_CALLER', 'CALLER_UNKNOWN', 'PERSON_SPOKE', 'NOT_AGENT_MADE'])) return 'INVALID_REQUEST';
  if (matches(code, ['UNAVAILABLE', 'UNREACHABLE', 'SPAWN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'ADAPTER_FAILED', 'TEMPORARY', 'CLOSED',
    'IN_PROGRESS', 'BUSY'])
    || code.startsWith('SCHEDULER_')) return 'UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

function mapSource(error, options = {}) {
  // Explicit adapter observations are authoritative structured facts. In
  // particular, a detected injection/sandbox breach must not be downgraded by
  // a provider's arbitrary legacy code.
  if (options.injectionDetected === true) return 'INJECTION_DETECTED';
  if (options.sandboxViolation === true) return 'SANDBOX_VIOLATION';
  if (options.malformedOutput === true) return 'MALFORMED_OUTPUT';
  if (options.verificationFailed === true) return 'VERIFICATION_FAILED';
  if (options.timedOut === true) return 'TIMEOUT';
  const code = sourceCode(error);
  const status = sourceStatus(error);
  const timedOut = Boolean(error) && typeof error === 'object' && own(error, 'timedOut') && error.timedOut === true;
  const head = classifySourceCode(code, status, timedOut, includesCode);
  if (head !== 'INTERNAL_ERROR') return head;
  return classifySourceCode(code, status, timedOut, includesCodeSegments);
}

function protectedDetail(error, source) {
  // This object is intentionally held in a WeakMap, excluded from JSON and
  // from the public failure model.  A source-specific audit/evidence adapter
  // may retain it in a protected channel; a transport cannot accidentally
  // serialize it by spreading an Error instance.
  return freeze({
    source: typeof source === 'string' ? source.slice(0, 80) : 'tool',
    sourceCode: sourceCode(error) || undefined,
    message: error && typeof error.message === 'string' ? error.message : undefined,
    details: error && plain(error.details) ? error.details : undefined
  });
}

class TypedOperationalError extends Error {
  constructor(code, { cause, source = 'tool', retryAfterMs } = {}) {
    const policy = policyFor(code);
    super(policy.safeSummary);
    this.name = 'TypedOperationalError';
    this.code = policy.code;
    this.classification = policy.classification;
    this.retryable = policy.retryable;
    // Constructor callers cannot smuggle an out-of-schema retry delay into a
    // cross-process envelope.  Omitting an invalid hint deterministically
    // falls back to the policy's closed default in publicFailure().
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 3_600_000) {
      this.retryAfterMs = retryAfterMs;
    }
    if (cause !== undefined) PROTECTED_DETAILS.set(this, protectedDetail(cause, source));
  }
}

function adaptError(error, options = {}) {
  if (error instanceof TypedOperationalError) return error;
  const code = mapSource(error, options);
  const retryAfterMs = Number.isSafeInteger(options.retryAfterMs) && options.retryAfterMs >= 0 && options.retryAfterMs <= 3_600_000
    ? options.retryAfterMs : undefined;
  return new TypedOperationalError(code, { cause: error, source: options.source || 'tool', retryAfterMs });
}

function adaptProviderError(error, options = {}) { return adaptError(error, { ...options, source: 'provider' }); }
function adaptToolError(error, options = {}) { return adaptError(error, { ...options, source: 'tool' }); }

function publicFailure(value, options = {}) {
  const error = value instanceof TypedOperationalError ? value : adaptError(value, options);
  const policy = policyFor(error.code);
  // Error instances are mutable JavaScript objects. Revalidate at the final
  // serialization boundary as well as at construction so a later assignment
  // cannot produce a schema-invalid cross-process envelope.
  const retryAfterMs = policy.retryable && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 3_600_000
    ? error.retryAfterMs : policy.defaultRetryAfterMs;
  return freeze({
    schemaVersion: SCHEMA_VERSION,
    code: policy.code,
    classification: policy.classification,
    retryable: policy.retryable,
    safeSummary: policy.safeSummary,
    ...(retryAfterMs === null ? {} : { retryAfterMs })
  });
}

function assertPublicFailure(value) {
  const required = ['schemaVersion', 'code', 'classification', 'retryable', 'safeSummary'];
  if (!plain(value) || required.some(key => !own(value, key))
    || Object.keys(value).some(key => !['schemaVersion', 'code', 'classification', 'retryable', 'safeSummary', 'retryAfterMs'].includes(key))
    || value.schemaVersion !== SCHEMA_VERSION || !isCode(value.code) || !CLASSIFICATIONS.includes(value.classification)
    || typeof value.retryable !== 'boolean' || typeof value.safeSummary !== 'string' || value.safeSummary.length < 1 || value.safeSummary.length > 240
    || (own(value, 'retryAfterMs') && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 3_600_000))) {
    throw new TypedOperationalError('INVALID_REQUEST', { source: 'error-contract' });
  }
  const policy = policyFor(value.code);
  if (value.classification !== policy.classification || value.retryable !== policy.retryable || value.safeSummary !== policy.safeSummary
    || (policy.retryable && !own(value, 'retryAfterMs'))
    || (!policy.retryable && own(value, 'retryAfterMs'))) {
    throw new TypedOperationalError('INVALID_REQUEST', { source: 'error-contract' });
  }
  return freeze({ ...value });
}

function operationCeiling(operation = {}) {
  const requested = plain(operation) && own(operation, 'effect') && typeof operation.effect === 'string' ? operation.effect : 'default';
  const configured = own(RETRY_CEILINGS, requested) ? RETRY_CEILINGS[requested] : RETRY_CEILINGS.default;
  return Math.min(RETRY_CEILINGS.global, configured);
}

function stableIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

// A closed retry result is intentionally distinct from an exception message.
// `attempt` is the already-completed attempt, so a ceiling of two permits one
// retry after the first retry-after-time failure and stops after the second.
function decideRetry(value, operation = {}) {
  const failure = value && value.schemaVersion === SCHEMA_VERSION ? assertPublicFailure(value) : publicFailure(value);
  const trustedOperation = plain(operation) ? operation : {};
  const attempt = own(trustedOperation, 'attempt') && Number.isSafeInteger(trustedOperation.attempt) && trustedOperation.attempt >= 1 ? trustedOperation.attempt : 1;
  const maxAttempts = operationCeiling(operation);
  const sideEffect = own(trustedOperation, 'sideEffect') && trustedOperation.sideEffect === true
    || own(trustedOperation, 'effect') && trustedOperation.effect === 'external-write';
  if (failure.classification === 'terminal') return freeze({ disposition: 'failed', code: failure.code, attempt, maxAttempts, reason: 'terminal' });
  if (failure.classification === 'retry-after-input') return freeze({ disposition: 'blocked', code: failure.code, attempt, maxAttempts, reason: 'input-required' });
  if (attempt >= maxAttempts) return freeze({ disposition: 'failed', code: failure.code, attempt, maxAttempts, reason: 'retry-ceiling-reached' });
  if (sideEffect && (!own(trustedOperation, 'idempotencyKey') || !stableIdempotencyKey(trustedOperation.idempotencyKey))) {
    return freeze({ disposition: 'uncertain', code: failure.code, attempt, maxAttempts, reason: 'idempotency-key-required' });
  }
  if (sideEffect && (!own(trustedOperation, 'reconcile') || trustedOperation.reconcile !== true)) {
    return freeze({ disposition: 'uncertain', code: failure.code, attempt, maxAttempts, reason: 'reconciliation-required' });
  }
  // A caller-supplied retryable envelope with no measured/policy delay used to
  // reach this line as a confident zero-delay retry. assertPublicFailure now
  // refuses that incomplete observation; preserve an explicitly measured zero.
  return freeze({ disposition: 'retry', code: failure.code, attempt, maxAttempts, retryAfterMs: failure.retryAfterMs });
}

// This helper never guesses that a timed-out side effect did not happen.  A
// retryable side effect must use a stable provider idempotency key and resolve
// its exact key before a repeat invocation.  It therefore provides a small
// deterministic bridge for existing provider adapters without enabling global
// automatic retries in the registry.
async function runIdempotentSideEffect(input = {}) {
  if (!plain(input)) throw new TypedOperationalError('INVALID_REQUEST', { source: 'idempotent-side-effect' });
  const idempotencyKey = own(input, 'idempotencyKey') ? input.idempotencyKey : undefined;
  const execute = own(input, 'execute') ? input.execute : undefined;
  const reconcile = own(input, 'reconcile') ? input.reconcile : undefined;
  const maxAttempts = own(input, 'maxAttempts') ? input.maxAttempts : undefined;
  const effect = own(input, 'effect') ? input.effect : 'external-write';
  if (!stableIdempotencyKey(idempotencyKey) || typeof execute !== 'function' || typeof reconcile !== 'function') {
    throw new TypedOperationalError('INVALID_REQUEST', { source: 'idempotent-side-effect' });
  }
  const ceiling = Math.min(operationCeiling({ effect }), Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : operationCeiling({ effect }));
  for (let attempt = 1; attempt <= ceiling; attempt += 1) {
    try {
      const value = await execute({ idempotencyKey, attempt });
      return freeze({ value, replayed: false, attempt });
    } catch (error) {
      const failure = publicFailure(adaptProviderError(error));
      const decision = decideRetry(failure, { effect, sideEffect: true, idempotencyKey, reconcile: true, attempt });
      if (decision.disposition !== 'retry') throw new TypedOperationalError(failure.code, { cause: error, source: 'provider' });
      let observed;
      try { observed = await reconcile({ idempotencyKey, attempt }); }
      catch (reconciliationError) {
        // A failed reconciliation is itself an ambiguous external outcome.
        // Never leak it raw or repeat the side effect.
        throw new TypedOperationalError('TIMEOUT', { cause: reconciliationError, source: 'provider' });
      }
      if (!plain(observed) || !['succeeded', 'not-started', 'unknown'].includes(observed.status)) {
        throw new TypedOperationalError('VERIFICATION_FAILED', { source: 'idempotent-side-effect' });
      }
      if (observed.status === 'succeeded') return freeze({ value: observed.value, replayed: true, attempt });
      if (observed.status === 'unknown') throw new TypedOperationalError('TIMEOUT', { cause: error, source: 'provider' });
      // only an explicit not-started verification permits the bounded retry
    }
  }
  throw new TypedOperationalError('TIMEOUT', { source: 'idempotent-side-effect' });
}

module.exports = freeze({
  CLASSIFICATIONS, ERROR_CODES, ERROR_CODE_VALUES, RETRY_CEILINGS, SCHEMA_VERSION,
  TypedOperationalError, adaptError, adaptProviderError, adaptToolError, assertPublicFailure,
  decideRetry, isCode, operationCeiling, policyFor, publicFailure, runIdempotentSideEffect,
  stableIdempotencyKey
});
