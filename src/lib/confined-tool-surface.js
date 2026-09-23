'use strict';

// WHAT A CONFINED PERMISSION LEVEL MAY REACH. DENY BY DEFAULT.
//
// THE DEFECT THIS REPLACES, MEASURED 2026-08-11 ON THE INSTALLED PACKAGED BUILD
// (the installed application's own resources/capability payload, not a checkout):
//
//     Standard (confined/workspace)   REFUSED 9 tools, ADMITTED 252 of 261.
//     Of those 252, 208 were gated by neither the tier nor the approval policy.
//
// The nine refusals were the FRA manifest's permanent exclusion set. Everything
// else was admitted because nothing said otherwise. That is an inverted fence:
// the surface was "the whole registry minus nine names", so EVERY TOOL ADDED IN
// FUTURE SHIPPED ADMITTED AT STANDARD BY SILENCE. This project has now found
// that absence-read-as-consent shape nine times; this was its most consequential
// location, because Standard is the level whose own words are that an agent
// "cannot reach off the workspace through a tool", and it is the level a
// cautious user picks.
//
// Three escapes were demonstrated end to end through admitted, ungated tools
// before this file existed:
//
//     extension.package  outputPath -> %TEMP%\FENCE-ESCAPE\escaped.zip   WROTE
//     extension.package  outputPath -> <workspace>\..\..\x.zip           WROTE
//     search.index       root       -> a secret dir outside the root     READ
//     launch.detect      cwd        -> outside the recorded root         LISTED
//
// A CORRECTION TO THE ORIGINAL REPORT, because it matters for where the fix
// goes. The reported route was `launch.execute` running `npm install` with an
// npm preinstall script. `launch.execute` IS admitted by the tier, but on the
// shipped default policy it is `external-write` and `approvals.externalWrites`
// is true, so it stops at APPROVAL_REQUIRED and the npm escape does not
// complete through that tool. The escape is real; the specific door was
// mis-identified. The doors that are actually open are the ones gated by
// NEITHER control -- `local-read`/`local-write` tools and tools declaring
// `approvalEligible: false` -- which is why the routes above use those instead.
// Fixing only `launch.execute` would have fixed the one tool that was not the
// problem.
//
// ---------------------------------------------------------------------------
// THE MODEL.
//
// A confined level admits a tool only if this table names it. Absence is a
// REFUSAL, so a tool added tomorrow is refused at Standard until somebody
// decides otherwise, and tests/confined-tool-surface.test.js fails until they
// record which class it is. That is the whole point: the decision cannot be
// made by forgetting.
//
// Three classes, decided by what a tool can REACH on this computer, not by its
// effect word. Effect answers "does this write?"; confinement answers "can what
// it writes leave the folder the user granted?", and those are different
// questions with different answers.
//
//   CONTAINED     Its local reach is fixed by the installation -- its own state
//                 directory, the service root, the audit log, a leased sandbox,
//                 or a remote API. It takes no caller-supplied local path, so
//                 there is nothing for a workspace fence to check.
//
//   WORKSPACE     It performs bounded filesystem I/O on path arguments the
//                 caller names. Admitted ONLY with every argument listed here
//                 resolved and checked against the recorded workspace roots by
//                 src/lib/workspace-boundary.js. The argument list is part of
//                 the security decision: an unlisted path argument is an
//                 unchecked one, which is how this class of fence usually fails.
//
//   UNCONFINABLE  It executes caller-influenced code, installs or launches other
//                 software, or takes an argument shape no fence can inspect. A
//                 path fence CANNOT bound these, and this is the class insight
//                 the original report asked for: the escape was never really
//                 `launch.execute`, it is that a spawned child process inherits
//                 no workspace confinement at all. Fencing `cwd` to the
//                 workspace does not help when the thing being run is the
//                 workspace's own package.json scripts -- and at Standard the
//                 agent may WRITE to the workspace, so it can author what runs.
//                 These belong to Unrestricted, and saying so plainly is the
//                 honest answer rather than shipping a fence that only appears
//                 to work.
//
// NOTHING IS DROPPED FROM THE PRODUCT. Every tool here still exists and still
// runs at Unrestricted, which is unchanged byte for byte. What changes is which
// of them a user who asked to be confined can reach.
//
// The permanent exclusions (host.*, repo.*, clipboard.*) are NOT repeated here.
// They are read at runtime from the one module that owns that decision, exactly
// as permission-tier-policy.js already does, because a second copy of a
// security list is a list that silently stops agreeing with the first.

const workspaceBoundary = require('./workspace-boundary');

class ConfinedSurfaceRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfinedSurfaceRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// --- the reviewed table -----------------------------------------------------

// Reach fixed by the installation. No caller-supplied local path.
const CONTAINED = Object.freeze(new Set([
  // Fixed app-owned metadata, no caller-supplied path, query, script or URL.
  'app.context', 'app.navigate', 'accessibility.status',
  // Fixed capability index only. The actual registry handler intersects query
  // results with the current role, allowlist and permission-tier surface.
  'capability.find',
  // Video jobs use the fixed fal queue and installation-owned receipts.
  // Downloads accept a job ID and size bound, never a local path; the provider
  // publishes exclusively beneath its fixed video artifact directory.
  'video.models', 'video.generate', 'video.jobs', 'video.status', 'video.cancel', 'video.download',
  /* agent.stop / agent.restart / agent.remove (added 2026-09-03, owner:
     "THE AGENTS NEED TO BE ABLE TO DELETE AND START AND RESTART AGENTS UNDER
     THEM") take nodeId/treeId/expectedSessionId -- identifiers into the local
     agent tree, never a filesystem path -- and their shared handler,
     treeLifecycle() in src/lib/tool-registry.js, forwards exactly those three
     strings to agent-tree-spawn.js#commandOnTree. The circle acting is read
     from the session's own principal, not from any caller-supplied argument.
     Same shape as agent_comms.send_local below, for the same reason: reach
     fixed by the installation, nothing here for a workspace fence to check.
     Measured 2026-09-03 on this checkout: unclassified, all three were
     silently refused at every confined level (Guided AND Standard) with
     PERMISSION_CONFINED_UNCLASSIFIED_REFUSED, and silently absent from
     confined tool-surface enumeration -- the owner's own request, shipped,
     unreachable by anyone who chose to be confined. This line is the review.

     agent_comms.send_local and .local_roster sit beside their cross-machine
     siblings for the same reason those three do: the reach is fixed by the
     installation. The caller names a circle on this computer's own agent tree
     and the recipient is resolved from a directory the app writes -- there is
     no caller-supplied path, host or endpoint anywhere in either call, and the
     local route opens no socket at all. Left unclassified they were refused at
     every confined level (PERMISSION_CONFINED_UNCLASSIFIED_REFUSED), which is
     this table working: a tool nobody reviewed does not ship into a confined
     session. This line is the review. */
  'agent.remove', 'agent.stop',
  'agent_comms.acknowledge', 'agent_comms.local_roster', 'agent_comms.read',
  'agent_comms.send', 'agent_comms.send_local', 'audit.flush',
  'audit.status', 'audit.tail', 'audit.verify',
  'billing.checkout_status', 'billing.webhook_verify', 'browser.playwright_status',
  'browser.playwright_tools', 'browser.start', 'browser.status', 'browser.stop',
  'browser.web_inspector_status', 'browser.web_inspector_close',
  /* Queue tools accept document fields and identifiers, never a path. Their
     shared handler selects the session's recorded workspace and the bridge
     confines writes to its BUILD-QUEUE.md, with actor, role, hash and audit
     gates intact. Read-only sessions still refuse their local-write effect. */
  'build_queue.open', 'build_queue.claim', 'build_queue.close',
  /* cloud.account_add/remove can select only a validated account name below
     the installation-owned Codex profile root.  They accept no path, host,
     repository, credential or provider-side operation; remove also preserves
     the profile directory.  Standard may therefore reach the fixed local
     registry, while Guided still refuses their local-write effect. */
  'calendar.create', 'calendar.list', 'cloud.account_add', 'cloud.account_list',
  'cloud.account_remove', 'cloud.task_launch',
  'cloud.task_diff', 'cloud.task_list',
  'cloud.task_status', 'drive.delete', 'drive.find', 'duo.desktop_status', 'duo.ucr_login',
  'firebase.account_login', 'firebase.app_create', 'firebase.doctor',
  'firebase.firestore_create', 'firebase.project_create', 'firebase.project_enable',
  'gcloud.account_inspect', 'gcloud.account_login', 'gcloud.doctor', 'gcloud.project_create',
  'gcloud.service_account_create', 'gcloud.service_account_key_to_vault',
  'gcloud.services_enable', 'github.issue_comment_create', 'github.issue_create',
  'github.issue_get', 'github.issue_list', 'github.pull_request_create',
  'github.pull_request_get', 'github.pull_request_list', 'github.release_create',
  'github.release_list', 'github.repo_get', 'github.repository_dispatch', 'gmail.list',
  'google.accounts', 'host.list_processes', 'http.request', 'ide.consent_import',
  'ide.consent_read', 'ide.consent_remove', 'instagram.publish_image', 'instagram.verify',
  'iphone.handoff_status', 'memory.get', 'memory.search', 'memory.set',
  'model.complete', 'model.customer_complete', 'model.quick_edit', 'model.role_complete',
  'ocr.read', 'overnight_advisory.lifecycle', 'overnight_advisory.lifecycle_status',
  'overnight_advisory.list', 'overnight_advisory.status', 'overnight_advisory.submit',
  'owner_forms.describe', 'owner_prompts.cancel',
  'owner_prompts.events', 'owner_prompts.start', 'owner_prompts.status', 'paddle.catalog_list',
  'paddle.doctor', 'paddle.subscription_cancel', 'paddle.subscription_get',
  'paddle.transaction_cancel', 'paddle.transaction_get', 'paddle.transaction_verify',
  'paddle.webhook_verify', 'pay.check', 'pay.record', 'payment_method.card_register',
  'payment_method.card_status', 'personal_calendar.capture', 'personal_calendar.complete',
  'personal_calendar.create', 'personal_calendar.due', 'personal_calendar.list',
  'purchase.decision', 'purchase.request',
  /* r_ledger.file / r_ledger.propose: the reach is the installation's own
     state root (reports/R-LEDGER.md, state/r-ledger/<scope>-<key>.md); the
     only caller-supplied value that touches a path is the key, validated as
     an id by r-ledger.js SAFE_KEY before it is joined. Whether an agent may
     write at all is the settings row's decision (r-ledger-agent-gate.js);
     Guided's read-only profile refuses both by effect with no line here. */
  'r_ledger.file', 'r_ledger.propose',
  // Fixed installation store, no path argument; available to read-only agents
  // as well as the agents that can file tasks and asks.
  'ledger.read',
  /* t_ledger.file/progress/complete/remove, a_ledger.file/answer/decline,
     p_ledger.decide: the SAME owner-request ledger and the SAME reach as
     r_ledger.file/propose immediately above -- the installation's own state
     root, with only `key`/`id` caller-supplied and validated as an id (id
     against the store's own KIND_ID_RE, checked before the store; key
     against r-ledger.js SAFE_KEY) before either is joined. No settings row
     gates these (LEDGER-KINDS-INTERFACE-20260907.md: a task or an ask is the
     agent's own, not a claim about what the person said; the owner's
     2026-09-07 ruling "asks and purchases: agent closable" extends the same
     posture to answering/declining an ask and deciding a purchase's ledger
     mirror), so unlike r_ledger there is no second door to note here -- the
     audit requirement (src/lib/minor-ledger-agent-gate.js) is not a
     confinement question, it is answered the same way at every tier.
     p_ledger.decide never reaches purchase-authority.js or providers/pay.js:
     it moves only the ledger mirror, so it carries no spend reach beyond
     what a_ledger.file already has. */
  // Explicit task reviews use this same fixed ledger, identity validation and
  // audit boundary. Grading controls regrade policy, not factual review access.
  't_ledger.file', 't_ledger.progress', 't_ledger.review', 't_ledger.complete', 't_ledger.remove',
  'a_ledger.file', 'a_ledger.answer', 'a_ledger.decline', 'p_ledger.decide',
  'research.finding_list', 'research.finding_save',
  'research.hermes_complete', 'research.lifecycle', 'research.lifecycle_status',
  'research.local_tiers_status', 'research.project_list', 'research.result_list',
  'research.run_list', 'research.run_status', 'research.run_submit',
  'research.session_assign', 'research.session_context', 'research.strong_complete',
  'sandbox.artifacts', 'sandbox.artifact_read',
  'sandbox.auth_profile_create', 'sandbox.auth_profile_heartbeat',
  'sandbox.auth_profile_lease', 'sandbox.auth_profile_release', 'sandbox.auth_profile_revoke',
  'sandbox.auth_profile_status', 'sandbox.cleanup', 'sandbox.create', 'sandbox.doctor',
  'sandbox.exec', 'sandbox.heartbeat', 'sandbox.reap', 'sandbox.status',
  'sandbox.workspace_read', 'sandbox.workspace_write', 'scheduler.create', 'scheduler.list',
  'scheduler.reconcile', 'scheduler.remove', 'screen.capture', 'screen.capture_monitor',
  'screen.capture_region', 'screen.capture_window', 'screen.list_monitors',
  'screen.read_capture', 'screen.status', 'search.status', 'settings.read', 'sound.play',
  'stripe.cardholder_create', 'stripe.virtual_card_create', 'system.ask',
  'system.credential_remove', 'system.credential_request', 'system.doctor', 'system.kill_switch_activate',
  'system.kill_switch_status', 'system.notify', 'system.status', 'system.resource_status', 'system.resource_advice', 'task.cancel',
  'task.checkpoint', 'task.claim', 'task.complete', 'task.fail', 'task.get', 'task.heartbeat',
  'task.list', 'task.start', 'task.submit', 'tts.speak', 'web.expand',
  'web.extract', 'web.fetch', 'web.lookup', 'web.search', 'window.close', 'window.focus',
  'window.list', 'workstation.status',
]));

// Bounded filesystem I/O. The array is the EXACT set of arguments that must be
// inside a recorded workspace root; anything not listed is not checked.
const WORKSPACE_FENCED = Object.freeze(new Map([
  ['deployment.detect', ['cwd']],
  ['drive.upload', ['filePath']],
  ['extension.package', ['cwd', 'outputPath']],
  ['extension.validate', ['cwd']],
  ['launch.detect', ['cwd']],
  ['launch.plan', ['cwd']],
  ['search.index', ['root']],
  ['search.query', ['root']],
  ['terraform.validate', ['cwd']],
]));

// The same WORKSPACE class, for the one tool whose path argument does not sit
// at the top level of its arguments: gmail.send's `attachments` is an array
// of { path, filename, contentType } (providers/google.js's
// normalizeAttachments() resolves and reads each entry's `path` from disk
// with no containment check of its own), so there is no flat argument name
// WORKSPACE_FENCED above can list. Each entry names the array argument and
// which field inside every element is the path to check; assertArgumentsConfined
// below applies the identical workspace-root check to it that a flat entry
// gets, just once per array element instead of once per call.
//
// MEASURED 2026-09-03, through the real dispatch chokepoint
// (registry.executeTool): before this table said so, gmail.send was CONTAINED
// on the theory that it "takes no caller-supplied local path". A Standard
// (confined/workspace) session calling it with
// attachments: [{ path: 'C:\\Windows\\win.ini' }] and zero recorded workspace
// roots passed assertToolAllowed and assertConfinedArgumentsAllowed with no
// objection, and failed only later on EGRESS_GATES_REQUIRED -- an unrelated
// owner-request-ledger gate that does not examine the attachment path and
// does not run on every dispatch path. No PERMISSION_CONFINED_* code was ever
// raised: the workspace fence had nothing to say about it.
//
// gmail.send cannot simply move to UNCONFINABLE instead: it is one of
// SUPPORTED_SCHEDULED_ACTIONS (src/lib/scheduled-actions.js) that
// src/lib/dispatch-permission-session.js's UNATTENDED_CEILING deliberately
// admits so a scheduled job can send mail with nobody present
// (tests/permission-session-chokepoint.test.js), and
// tests/install-tier-enforcement.test.js pins it as Standard's own proof that
// the level "really can still write". Refusing it outright at every confined
// level would trade one real defect for the loss of a real, tested,
// deliberately-shipped capability -- fixing the argument the fence could not
// see is the smaller, correct repair.
const WORKSPACE_FENCED_ARRAY = Object.freeze(new Map([
  ['gmail.send', { argument: 'attachments', pathField: 'path' }],
]));

// Refused at every confined level, with the reason recorded so the refusal can
// be explained to a user and re-argued by a future reviewer on the merits.
const UNCONFINABLE = Object.freeze(new Map([
  // These opt-in controls can replace an agent's execution configuration.
  // treeConfiguration passes confined=true, and commandOnTree deliberately
  // has no confined set-* adapter (only resume/restart). A slot identifier
  // alone does not prove the replacement preserves a workspace ceiling.
  // Keep that existing refusal; Full still requires the selected role
  // function, bound parent session and the app's managed-subtree admission.
  ['agent.set_model', 'changes a managed agent model through a replacement path without a confined model-change adapter'],
  ['agent.set_effort', 'changes a managed agent execution choice without a confined effort-change adapter'],
  ['agent.set_account', 'changes provider account custody through a replacement path without a confined account-change adapter'],
  ['agent.set_provider', 'selects another provider execution environment without a confined provider-change adapter'],
  ['agent.set_role', 'changes a managed agent role and function surface without a confined role-change adapter'],

  ['browser.web_inspector_open', 'opens an authenticated mobile browser outside the granted workspace'],
  ['browser.web_inspector_call', 'executes page JavaScript and native input on an owned mobile browser outside the granted workspace'],
  ['screen.control', 'temporary screen takeover reaches applications outside a granted workspace and requires an explicit local screen grant'],
  ['accessibility.inspect', 'desktop control inspection reaches other applications outside a granted workspace; explicit local opt-in is additionally required'],
  ['accessibility.propose', 'confirmed UI actions may reach outside a granted workspace; the local owner must opt in and confirm each exact action'],
  ["browser.playwright_call",
    "forwards an opaque tool name and argument object to Playwright, which reaches the filesystem"],
  ["code.diagnostics",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["code.document_symbols",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["code.find_references",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["code.goto_definition",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["code.hover",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["code.status",
    "executes a language-server binary resolved from the CALLER-supplied root's node_modules"],
  ["code.workspace_symbols",
    "executes a language-server binary resolved from the caller-supplied root"],
  ["deployment.execute",
    "runs the project's deploy toolchain and its lifecycle hooks"],
  ["firebase.deploy",
    "runs firebase.json predeploy hooks, which are arbitrary shell commands"],
  ["launch.execute",
    "runs the project's own npm/yarn/pnpm lifecycle scripts, which are arbitrary code"],
  ["terraform.apply",
    "executes provider plugins and local-exec provisioners"],
  ["terraform.init",
    "downloads and executes provider plugins"],
  ["terraform.plan",
    "executes provider plugins and can run local-exec provisioners"],
  ["workstation.configure_agent_clients",
    "rewrites another program's machine-wide configuration"],
  ["workstation.initialize_cursor_state",
    "writes another program's state outside any workspace"],
  ["workstation.install_cursor",
    "installs software machine-wide"],
  ["workstation.launch_cursor",
    "launches another program, which inherits no confinement"],
  ["workstation.sync_cursor_extensions",
    "installs editor extensions machine-wide"],
]));

// Structurally Full-Remote-Access-only, so refused by EVERY local session --
// Guided, Standard, and Unrestricted alike -- not only the confined levels.
//
// These tools exist to serve a PEER COMPUTER through the FRA transport. Their
// broker (src/lib/providers/fra-workspace-handles.js) refuses every call that
// arrives without a bound FRA session context, with
// WORKSPACE_FRA_CONTEXT_REQUIRED, and no local session ever carries that
// binding. Measured on the 2026-08-19 sweep: both were advertised locally at
// every level, answered every local call with that refusal, and the taxonomy
// blanket of the day rendered it as "internal error" -- a tool that can never
// work here, offered here, reading as broken here. Nothing is dropped from
// the product: the reviewed FRA manifest
// (config/fra-capability-manifest.*.json) still carries both for the
// transport they belong to, which resolves through the Manifest tier and is
// not narrowed by this class.
const FRA_ONLY = Object.freeze(new Map([
  ['workspace.list',
    "lists a connected computer's files through the Full Remote Access session"],
  ['workspace.read',
    "reads a connected computer's files through the Full Remote Access session"],
]));

// --- the decision -----------------------------------------------------------

const CLASSES = Object.freeze(['contained', 'workspace', 'unconfinable', 'fra-only', 'tree-confined', 'tree-lifecycle-confined']);

/** Which class a tool is in, or null when the table does not name it at all. */
function classify(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name === 'agent.spawn') return 'tree-confined';
  if (name === 'agent.resume' || name === 'agent.restart') return 'tree-lifecycle-confined';
  if (CONTAINED.has(name)) return 'contained';
  if (WORKSPACE_FENCED.has(name) || WORKSPACE_FENCED_ARRAY.has(name)) return 'workspace';
  if (UNCONFINABLE.has(name)) return 'unconfinable';
  if (FRA_ONLY.has(name)) return 'fra-only';
  return null;
}

/** Every tool the table names, for the coverage test and for surface listing. */
function classifiedToolNames() {
  return Object.freeze([...CONTAINED, ...WORKSPACE_FENCED.keys(), ...WORKSPACE_FENCED_ARRAY.keys(),
    ...UNCONFINABLE.keys(), ...FRA_ONLY.keys(), 'agent.spawn'].sort());
}

// Flat top-level path arguments only; WORKSPACE_FENCED_ARRAY's nested entries
// have no single argument name to report and are not read by any caller of
// this function today.
function fencedArgumentNames(name) {
  const declared = WORKSPACE_FENCED.get(name);
  return declared ? Object.freeze([...declared]) : null;
}

function unconfinableReason(name) {
  return UNCONFINABLE.get(name) || null;
}

function fraOnlyReason(name) {
  return FRA_ONLY.get(name) || null;
}

/**
 * May a confined session carry this tool AT ALL?
 *
 * This is the tool-name half of the decision. The path half runs later, at
 * dispatch, because it needs the arguments -- see assertArgumentsConfined.
 *
 * DENY BY DEFAULT. A name this table does not carry is refused with a code that
 * says exactly that, so an operator reading the log sees "nobody classified
 * this tool" rather than a generic denial.
 */
function assertToolConfinable(name, { tier = 'confined', profile = null } = {}) {
  const decided = classify(name);
  if (decided === 'tree-lifecycle-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeLifecycle())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Resuming or restarting a Standard circle requires a compatible application with retained tree authority.',
      { tool: name, tier, profile });
  }
  // This advertises only the paired application's one-use, scoped tree path.
  // Dispatch additionally proves the particular parent and excludes lanes.
  if (decided === 'tree-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeSpawn())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Agent delegation requires a Standard tree session in a compatible application.',
      { tool: name, tier, profile });
  }
  if (decided === null) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
      `Tool '${name}' has no recorded confinement class, so a confined permission level refuses it.`,
      { tool: name, tier, profile });
  }
  if (decided === 'unconfinable') {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      `Tool '${name}' cannot be confined to a workspace (${unconfinableReason(name)}), so it is available only at the Unrestricted level.`,
      { tool: name, tier, profile, reason: unconfinableReason(name) });
  }
  if (decided === 'fra-only') {
    throw new ConfinedSurfaceRefusal('PERMISSION_LOCAL_FRA_ONLY_REFUSED',
      `Tool '${name}' works between connected computers; this computer has none connected, so a local session refuses it.`,
      { tool: name, tier, profile, reason: fraOnlyReason(name) });
  }
  return decided;
}

// Shared by the flat argument loop and the nested-array loop below: check one
// candidate path VALUE (already read out of the caller's arguments, at
// whatever label identifies where it came from) against the recorded
// workspace roots. An absent value is not an escape -- the provider
// substitutes its own installation-owned default, never a caller choice,
// which is the reason this checks arguments rather than resolved paths.
function assertPathValueInsideRoots(name, label, value, workspaceRoots, { tier, profile }) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
      `Tool '${name}' was given a '${label}' this permission level cannot check.`,
      { tool: name, argument: label, tier, profile });
  }
  try {
    workspaceBoundary.assertInsideRoots(value, workspaceRoots, { label, tool: name });
  } catch (error) {
    // A DELIBERATE REFUSAL MUST NOT BE REPORTED AS AN UNREADABLE INPUT.
    // WORKSPACE_PATH_REFUSED is the boundary saying "this shape can never be
    // inside a workspace root" -- a UNC path, a `\\?\` device path, an
    // alternate data stream. Those are decisions, and folding them into the
    // "cannot check" code would have told an operator the fence was confused
    // when in fact it was working, and would have hidden three closed bypasses
    // behind a word that invites someone to go and "fix" the parser.
    // Only a genuinely uncheckable path keeps the unreadable code.
    const boundaryCode = error && error.code;
    const refused = boundaryCode === 'WORKSPACE_BOUNDARY_REFUSED'
      || boundaryCode === 'WORKSPACE_PATH_REFUSED'
      || boundaryCode === 'WORKSPACE_ROOTS_ABSENT'
      || boundaryCode === 'WORKSPACE_ROOTS_UNREADABLE';
    throw new ConfinedSurfaceRefusal(
      refused ? 'PERMISSION_CONFINED_WORKSPACE_REFUSED' : 'PERMISSION_CONFINED_PATH_UNREADABLE',
      error.message,
      { tool: name, argument: label, tier, profile, boundaryCode: boundaryCode || null });
  }
}

/**
 * The path half: every declared path argument must be inside a recorded root.
 *
 * Called for EVERY confined dispatch, not only for `workspace`-class tools, so
 * that a tool moved between classes cannot lose its checking silently. A
 * `contained` tool simply has no declared arguments and passes without touching
 * the filesystem.
 *
 * An absent or unusable root set REFUSES rather than admitting: a workspace
 * fence with no workspace is not a wider fence, it is a broken one.
 */
function assertArgumentsConfined(name, argumentsValue, workspaceRoots, { tier = 'confined', profile = null } = {}) {
  const declared = WORKSPACE_FENCED.get(name);
  const declaredArray = WORKSPACE_FENCED_ARRAY.get(name);
  if (!declared && !declaredArray) return true;
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
      `Tool '${name}' was given arguments this permission level cannot check.`,
      { tool: name, tier, profile });
  }
  if (declared) {
    for (const argument of declared) {
      const value = argumentsValue[argument];
      // launch.detect resolves an omitted cwd to the application root and then
      // reads project metadata there. That effective path is not necessarily in
      // the recorded workspace, so confined callers must name a cwd that this
      // fence can actually check.
      if (name === 'launch.detect' && argument === 'cwd'
        && (value === undefined || value === null || value === '')) {
        throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
          `Tool '${name}' requires a '${argument}' this permission level can check.`,
          { tool: name, argument, tier, profile });
      }
      assertPathValueInsideRoots(name, argument, value, workspaceRoots, { tier, profile });
    }
  }
  if (declaredArray) {
    const { argument, pathField } = declaredArray;
    const entries = argumentsValue[argument];
    // Absent/null is not an escape, same reasoning as an absent flat argument.
    if (entries !== undefined && entries !== null) {
      if (!Array.isArray(entries)) {
        throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
          `Tool '${name}' was given a '${argument}' this permission level cannot check.`,
          { tool: name, argument, tier, profile });
      }
      entries.forEach((entry, index) => {
        // A non-object element is not this fence's decision to make -- the
        // tool's own schema requires objects here (gmail.send's `attachments`
        // items are `type: 'object'`) and refuses a bad shape before the
        // handler ever runs. Nothing this fence would compute from a
        // malformed element could be a real caller-named path.
        const value = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry[pathField] : undefined;
        assertPathValueInsideRoots(name, `${argument}[${index}].${pathField}`, value, workspaceRoots, { tier, profile });
      });
    }
  }
  return true;
}

module.exports = Object.freeze({
  CLASSES,
  CONTAINED,
  WORKSPACE_FENCED,
  WORKSPACE_FENCED_ARRAY,
  UNCONFINABLE,
  FRA_ONLY,
  ConfinedSurfaceRefusal,
  classify,
  classifiedToolNames,
  fencedArgumentNames,
  unconfinableReason,
  fraOnlyReason,
  assertToolConfinable,
  assertArgumentsConfined
});
