'use strict';

// R1175's onboarding boundary. This module only reads bounded local state and
// returns a versioned snapshot. It never assigns a role, grants authority, or
// mutates the coordination stores it observes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const agentOrg = require('./agent-org');
const { ROLE_LIBRARY, storedRoleDefinition } = require('./agent-roles');
const { createInstalledAgentOrgStores } = require('./agent-org-store');
const presence = require('./agent-presence');
const { parseQueuePhases } = require('./build-queue-projection');
const { NON_CANONICAL_GUIDANCE, normalizeRoot, treeIdentity, treeIdentityHeadline } = require('./tree-identity');
const { safeLaunchEnvironment } = require('./providers/subscription-launch-env');
// WHOSE NAME MAY THIS SESSION ACT UNDER. Read from the same shipped module that
// tools/agent-preflight.js uses -- not a second copy of the wording -- so the
// grant and its reservations cannot say different things on the two surfaces an
// agent actually reads. The record is an owner statement about ATTRIBUTION; it
// grants this packet no authority and widens no capability. See
// src/lib/owner-authorization.js.
const { authorizationHeadline, authorizationProjection, readAuthorization } = require('./owner-authorization');
// The state database this READS is the one the product WRITES. See
// src/lib/runtime-state-root.js for why that is not the program directory.
const { programOrStatePath } = require('./runtime-state-root');

const MODULE_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 1;
const PACKET_VERSION = 'toolsenabled.agent-onboarding.v1';
const PACKET_BEGIN = 'BEGIN TOOLSENABLED DYNAMIC ONBOARDING PACKET v1';
const PACKET_END = 'END TOOLSENABLED DYNAMIC ONBOARDING PACKET v1';
const SCOPES = Object.freeze(['minimal', 'task', 'full']);
const PROFILES = Object.freeze(['agent', 'builder', 'planner', 'reviewer', 'checker', 'text-only']);
const IDENTITY_BINDINGS = Object.freeze(['none', 'hook-event-unverified', 'cli-argument-unverified', 'launcher-bound', 'verified-launch']);

// THE HARD BYTE CEILING, AND WHY THESE NUMBERS.
//
// Boot context is spent before the agent has read its task, and spent again for
// every subagent. It is the most expensive context in a session because none of
// it is chosen.
//
// Measured on 2026-08-12 against this checkout: minimal 12,650 rendered bytes,
// task 13,738, full 14,914. The ceilings they were allowed to grow into were
// 16,384 / 49,152 / 98,304 -- a 6x gap at full scope. A 6x gap is where drift
// hides: nobody notices a packet doubling, and the first symptom is a session
// with no room left to work. One real directive is already enough to reach it --
// a 60 KB owner verbatim with 40 gates renders 48 KB of packet today, and
// nothing stops it.
//
// RE-MEASURED the same evening, after the `recent` section was added: minimal
// 10,794 / task 16,900 / full 18,467. Read those as a range, not as constants --
// two consecutive runs minutes apart differed by over 3 KB at minimal scope,
// because presence and claims are live and this checkout had forty agents on it.
// That variance is the packet working as intended; it is also why the figure is
// printed in every packet's footer rather than trusted from a comment.
//
// The `recent` section costs 2.4-3.2 KB rendered, the largest single non-fence
// claim on the packet. The ceilings above absorb it at every scope and were NOT
// raised to make room for it: if a busy day pushes a packet over, the budget
// trims and says which section it took, which is the outcome this design wants.
//
// 2026-08-13, AND THE SAME ANSWER AGAIN. The feature line was being dropped at
// minimal scope. Measured on this checkout: the minimal body came to 17,757
// bytes against a 15,360-byte body limit, so it was genuinely over and the
// budget was genuinely right to trim. The ceilings were NOT raised. Two blocks
// alone -- `ownerAuthorization` at 4,996 bytes and `settings` at 4,003 -- were
// 59% of the minimal body limit, so what a bigger ceiling would have bought is
// room for those to keep growing unwatched. What was wrong was WHICH rank the
// feature line held, and it was moved to rank 1 for 258 pinned bytes. The
// packet's body got SMALLER doing it -- 17,757 to 17,598 at minimal -- because
// the same line had been stored TWICE, once in `contextRoutes.features` and
// again in `capabilities.features`, and now it is stored once. The rendered
// packet grew 164 bytes at minimal (14,084 to 14,248 against a 16,384 ceiling),
// which is what the line costs and what it is worth.
//
// So: roughly 2x the measured packet per scope. Ordinary growth fits; a doubling
// does not, and announces itself instead. In tokens (~4 bytes per token for this
// JSON-dense text) the largest is ~8k -- about 4% of the smallest context an
// agent here may be running with, which is the share a boot packet is worth.
// This is a ceiling, not a target to fill.
//
// The ladder still rises with scope (minimal < task < full) because a full
// session boot legitimately carries more directive text and more of the queue
// than a task-scoped child does.
//
// These are HARD. Over the ceiling, content is dropped and the packet SAYS SO
// -- see PACKET_PRIORITY, applyByteBudget, and renderPacket. A packet that fits
// by cutting quietly is worse than a small one: the agent cannot tell "this was
// not reported" from "this is not happening".
const MAX_RENDERED_BYTES = Object.freeze({ minimal: 16 * 1024, task: 24 * 1024, full: 32 * 1024 });

// The ordinary context budget includes a 4 KB role sheet. Explicitly authored
// larger sheets get their own bounded allowance, so accepting a 6,000-character
// field in the editor cannot cause the hook to drop the agent's role wholesale.
// Other context retains its existing budget and omission accounting.
function renderByteLimit(scope, roleDefinition) {
  const roleBytes = compactBytes(roleDefinition || null);
  if (roleBytes > 96_000) fail('AGENT_ONBOARDING_PACKET_INVALID', 'The role directions exceed the supported onboarding size.');
  return MAX_RENDERED_BYTES[scope] + Math.max(0, roleBytes - 4096);
}

// Trimming happens twice, and the first pass has to do nearly all of the work.
// applyByteBudget trims the BODY, precisely, one field at a time in priority
// order. renderPacket can only drop a whole section, which is blunt, so it is a
// backstop and not the mechanism.
//
// The body is measured as compact JSON and judged against the render ceiling
// less this allowance. That works because the compact body is a CONSERVATIVE
// proxy for the rendered text: the renderer prints labels and a footer but omits
// several body fields, and the two effects do not cancel. So a body inside the
// ceiling renders inside the ceiling with room to spare.
//
// RE-MEASURED 2026-08-12 EVENING, because the figure this comment used to carry
// stopped being true. It said the body ran 2,450 bytes larger than its own
// rendering at all three scopes. Measured now on this checkout: minimal +986,
// task +1,468, full +1,465. Two things moved it, and only one of them is the
// budget's business:
//
//   - the owner ledger was reset to a 1,219-byte file, so the directive -- the
//     single most body-heavy field -- stopped dominating the gap;
//   - the recent-work section (rank `recent`) renders its headline as prose
//     ABOVE its JSON, which costs about 360 rendered bytes that the body does
//     not carry. That is the one place in this packet where rendering is
//     deliberately larger than the body, and it is worth it: a warning that a
//     held fact has expired is worth nothing if it is skimmed past inside a blob.
//
// The gap is still positive at every scope, so the proxy still holds. Anyone
// widening that prose has to re-measure this: renderPacket fails closed over the
// ceiling, so the failure would be loud, but loud at session boot is expensive.
//
// 1 KB, not 4: an allowance larger than the real gap would trim content that
// would have fit, which is its own kind of dishonesty -- announcing a drop that
// the budget did not actually require. 1 KB is also what the packet can absorb
// if the gap ever inverts, which is the direction the prose line pushes it.
const RENDER_FRAME_BYTES = 1024;

// WHAT IS GIVEN UP FIRST, AND WHY THAT ORDER.
//
// Ranked by the damage an agent does when it does NOT have the item, not by how
// interesting the item is. Rank 1 is surrendered last.
//
//  1 identity      Which checkout this is, whose name work is taken under, and
//                  what this session can actually reach. Wrong here and every
//                  other fact in the packet is a statement about a different
//                  program: on 2026-08-10 a whole status report was written
//                  against a retired tree. Never dropped; it rides in the
//                  always-rendered first block.
//                  The FEATURE LINE is here, not under routes, and the
//                  distinction is damage and not subject matter. Routes are an
//                  accelerator -- without them an agent greps. The feature line
//                  is the one statement in this packet resolved against the
//                  session's OWN tool surface, so losing it does not slow an
//                  agent down, it tells it that capabilities it holds do not
//                  exist, and it will build around them. Measured 2026-08-13 on
//                  this checkout, pinning it costs the body 258 bytes at every
//                  scope, and it is bounded at collection so it can never cost
//                  much more.
//  2 budget        The accounting itself. Drop it and the packet looks complete
//                  while being partial, which is the one failure worse than
//                  being small. Never dropped.
//  3 fences        Session assignment, fixed role, resolved roots, and the owner
//                  directive verbatim with its open gates. This is what the
//                  session is JUDGED against. An agent that never sees it cannot
//                  comply with it, and the resulting "deviation" is a reporting
//                  artefact rather than a choice. Shrunk only as a last resort,
//                  and never quietly.
//  4 coordination  Live presence, active claims, and the overlap pairs against
//                  this session's territory. This is the collision surface --
//                  two agents editing one file is the concrete damage the packet
//                  exists to prevent. The overlap PAIRS outrank the rosters: the
//                  pairs are the warning, the rosters are only its evidence, and
//                  the evidence is one command away.
//  5 divergence    Declared-versus-observed mismatches and explicit unknowns.
//                  Losing this does not hide a fact, it hides a DOUBT about the
//                  facts above -- bad, and still strictly less bad than losing
//                  the fact.
//  6 recent        What has actually been DONE here in the last hours, and --
//                  the reason it sits this high -- what is NO LONGER TRUE.
//                  Everything above this line is a fact about now; this is the
//                  only section that retires facts an agent already believes.
//                  Today's two most expensive failures were both an agent acting
//                  on an expired fact (a fix called broken against an
//                  eight-minute-old bundle; a claim about a file that had
//                  moved), and neither was visible in any other section. It
//                  ranks below divergence because divergence doubts the facts
//                  this packet is stating, while this doubts facts the agent
//                  brought with it -- and above goals because a wrong action on
//                  a stale fact costs more than a missing queue phase.
//  7 goals         Queue phases and the org roster. An agent holding its
//                  directive but not the queue still does bounded correct work.
//                  The reverse is not true.
//  8 routes        Grepsaver cards, doc router, tool namespaces. A pure
//                  accelerator: without it the agent greps. That costs time, not
//                  correctness.
//  9 provenance    Source paths, mtimes, hashes. Read after the fact by whoever
//                  audits a packet, not by the agent acting on it in the next
//                  hour.
//
// `where` is not decoration. Every dropped item must name a real command or file
// the agent can go to, or the drop is just a hole.
const PACKET_PRIORITY = Object.freeze([
  Object.freeze({ rank: 1, id: 'identity', title: 'Tree identity and owner authorization', where: 'node tools/agent-preflight.js --topic <area>' }),
  Object.freeze({ rank: 2, id: 'budget', title: 'Onboarding budget', where: 'the "## Onboarding budget" block below' }),
  Object.freeze({ rank: 3, id: 'fences', title: 'Session assignment, roots, and owner directive', where: 'config/agent-org.json and reports/OWNER-REQUEST-LEDGER.json' }),
  Object.freeze({ rank: 4, id: 'coordination', title: 'Live coordination and collision risk', where: 'node tools/agent-roster.js --presence' }),
  Object.freeze({ rank: 5, id: 'divergence', title: 'Declared-versus-observed mismatches and explicit unknowns', where: 'node tools/agent-onboarding.js --json' }),
  Object.freeze({ rank: 6, id: 'recent', title: 'Recent work and what is no longer true', where: 'node tools/recent-work.js' }),
  Object.freeze({ rank: 7, id: 'goals', title: 'Queue goals and enabled assignments', where: 'BUILD-QUEUE.md and config/agent-org.json' }),
  Object.freeze({ rank: 8, id: 'routes', title: 'System map and capabilities', where: 'node tools/grepsaver-orient.js "<topic>"' }),
  Object.freeze({ rank: 9, id: 'provenance', title: 'Provenance and freshness', where: 'node tools/agent-onboarding.js --json' })
]);

const PRIORITY_BY_ID = Object.freeze(Object.fromEntries(PACKET_PRIORITY.map(entry => [entry.id, entry])));

// One step per droppable body field, in the order they are surrendered: the
// reverse of PACKET_PRIORITY, with exactly ONE deliberate exception, named here
// so nobody has to discover it by reading the whole list. Written as DATA rather
// than an if-ladder so the documented order and the executed order are the same
// list and cannot drift apart. The renderer this replaces dropped by section
// POSITION, which put the mismatch/unknown block (a damage signal) behind the
// system map (an accelerator) for no reason except where each happened to sit in
// the file.
//
// THE EXCEPTION: the `fences` directiveShare step sits ahead of the two
// `coordination` steps, so rank 3 gives way before rank 4. It is not a drop --
// it caps one field at a share of the budget, and its own comment below says
// why. Stated up here because the previous wording claimed the list was
// "strictly the reverse" of the priority order while this step had already been
// added, so the guarantee the list exists to make read as broken when it was
// merely under-described. A monotonicity check that knows about this one step is
// in tests/agent-onboarding.js; anything else out of order is drift.
// Each step carries its OWN title rather than borrowing its rank's, because the
// footer lists drops by name and "System map and capabilities" printed twice
// tells a reader nothing about which two things went.
const BODY_TRIM_ORDER = Object.freeze([
  Object.freeze({ priority: 'provenance', container: null, key: 'provenance', title: 'Source provenance and freshness' }),
  Object.freeze({ priority: 'routes', container: null, key: 'capabilities', title: 'Capability guide' }),
  Object.freeze({ priority: 'routes', container: null, key: 'contextRoutes', title: 'Grepsaver system map' }),
  Object.freeze({ priority: 'goals', container: null, key: 'goals', title: 'Queue goals' }),
  Object.freeze({ priority: 'goals', container: 'settings', key: 'enabledAssignments', title: 'Enabled assignments from user settings' }),
  // The recent-work feed is surrendered PIECEWISE rather than whole, and in the
  // same damage order it uses internally. Dropping it as one field would take
  // the retirement list with it -- the one part of the packet that tells an
  // agent a fact it already holds has expired -- to save bytes that the commit
  // list alone would have paid for. `retired`, `lastSuite` and `unknown` are
  // absent from this list on purpose: the packet's budget cannot reach them.
  Object.freeze({ priority: 'recent', container: 'recentWork.landed', key: 'newest', title: 'Recent commit list (the commit count survives)' }),
  Object.freeze({ priority: 'recent', container: 'recentWork', key: 'concluded', title: 'Recent lane report verdicts' }),
  Object.freeze({ priority: 'recent', container: 'recentWork.inFlight', key: 'dirs', title: 'Uncommitted working-tree directories (the counts survive)' }),
  Object.freeze({ priority: 'divergence', container: null, key: 'unknowns', title: 'Explicit unknowns' }),
  Object.freeze({ priority: 'divergence', container: null, key: 'mismatches', title: 'Declared-versus-observed mismatches' }),
  // Bounded BEFORE the collision data goes, not after. A single verbose owner
  // directive is otherwise able to spend the entire packet on itself: measured,
  // a 60 KB verbatim with 40 gates held 29,535 bytes and pushed presence,
  // claims and every overlap pair out of the packet completely. A directive long
  // enough to do that has stopped being a fence and become a document, and the
  // packet already says where to read the whole of it.
  Object.freeze({ priority: 'fences', directiveShare: 0.5, title: 'Tail of the owner directive over its budget share' }),
  Object.freeze({ priority: 'coordination', container: 'coordination.presence', key: 'live', title: 'Observed presence roster' }),
  Object.freeze({ priority: 'coordination', container: 'coordination.claims', key: 'active', title: 'Active agent-coord claim list' })
]);

// Role semantics are product vocabulary. Which agent holds a role, with which
// model/tier, is deliberately absent and comes from session plus user settings.
//
// The definitions themselves live in src/lib/agent-roles.js, the shipped default
// role library, and are projected here rather than restated. This block used to
// hold its own copy of owns/mustNot while custom-role-store.js held a second,
// differently-worded copy of the same nine roles, so the product gave two
// answers to "what is this role for" depending on which surface asked.
//
// `enforced` is deliberately NOT projected into the packet. It records which
// rules the code mechanically guarantees versus which hold by instruction alone,
// which is information for whoever maintains the library, not a hint to an agent
// about which rules carry no mechanism behind them.
const ROLE_DEFINITIONS = Object.freeze(Object.fromEntries(
  ROLE_LIBRARY.map(role => [role.id, Object.freeze({
    name: role.name,
    summary: role.summary,
    owns: role.owns,
    mustNot: role.mustNot,
    handoff: role.handoff,
    rules: role.rules,
    capabilities: role.capabilities
  })])
));

const SPAWN_PATH_COVERAGE = Object.freeze([
  // `local` joined this row when agent-lane learned to spawn a model on the
  // user's own GPU. The manifest is a claim about which spawn paths are
  // covered; leaving it at two providers while the file spawns three would make
  // the claim false in the one direction that matters -- an uncovered path
  // reported as covered.
  Object.freeze({ id: 'agent-lane', providers: Object.freeze(['codex', 'claude', 'local']), strategy: 'prompt', path: 'src/lib/agent-lane.js' }),
  Object.freeze({ id: 'luna-executor', providers: Object.freeze(['codex']), strategy: 'prompt', path: 'src/lib/fleet-supervisor/luna-executor.js' }),
  Object.freeze({ id: 'fleet-planning', providers: Object.freeze(['gemini']), strategy: 'prompt', path: 'src/lib/fleet-supervisor/lane-runner.js' }),
  Object.freeze({ id: 'gemini-fleet', providers: Object.freeze(['gemini']), strategy: 'prompt', path: 'tools/gemini-fleet.js' }),
  Object.freeze({ id: 'gemini-agentic', providers: Object.freeze(['gemini']), strategy: 'prompt', path: 'src/lib/providers/gemini-agentic.js' }),
  Object.freeze({ id: 'codex-session', providers: Object.freeze(['codex']), strategy: 'session-hook', path: '.codex/hooks.json' }),
  Object.freeze({ id: 'claude-session', providers: Object.freeze(['claude']), strategy: 'session-hook', path: '.claude/settings.json' }),
  Object.freeze({ id: 'sealed-reviewer-checker-calls', providers: Object.freeze(['codex', 'claude', 'gemini']), strategy: 'protocol-exception', path: 'docs/AGENT-ONBOARDING.md' })
]);

const SECRET_PATTERNS = Object.freeze([
  /sk_live_[A-Za-z0-9]+/, /sk-[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /xox[a-z]?-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bAKIA[0-9A-Z]{16}\b/
]);

class AgentOnboardingError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentOnboardingError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AgentOnboardingError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function looksSecret(value) {
  return SECRET_PATTERNS.some(pattern => pattern.test(String(value)));
}

function safeText(value, label, unknowns, maximum = 8192) {
  const text = String(value ?? '').replace(/\0/g, '').trim();
  if (!text) return '';
  if (looksSecret(text)) {
    unknowns.push({ code: 'secret-shaped-content-withheld', source: label });
    return '[withheld: secret-shaped content]';
  }
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text;
  unknowns.push({ code: 'bounded-content-truncated', source: label, maximumBytes: maximum });
  let end = Math.min(text.length, maximum);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maximum - 32) end -= 1;
  return `${text.slice(0, end).trimEnd()}\n[truncated at ${maximum} bytes]`;
}

function normalizedRoot(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('AGENT_ONBOARDING_INPUT_INVALID', `${label} must be a non-empty path.`);
  return path.resolve(value.trim());
}

function linkedMainRoot(moduleRoot, fsImpl = fs) {
  const dotGit = path.join(moduleRoot, '.git');
  let stat;
  try { stat = fsImpl.lstatSync(dotGit); } catch (error) {
    // A genuinely absent .git marker identifies an ordinary staged payload,
    // but an unreadable marker does not establish that fact.  Returning the
    // module root for EACCES/EIO used to turn "could not inspect .git" into the
    // definite answer "this is the main root" and could make every subsequent
    // source read come from the wrong namespace.  Let that uncertainty refuse
    // root resolution instead.
    if (error && error.code === 'ENOENT') return moduleRoot;
    throw error;
  }
  if (stat.isDirectory()) return moduleRoot;
  if (!stat.isFile() || stat.isSymbolicLink()) return moduleRoot;
  const match = /^gitdir:\s*(.+)\s*$/i.exec(fsImpl.readFileSync(dotGit, 'utf8'));
  if (!match) return moduleRoot;
  const gitDir = path.resolve(moduleRoot, match[1]);
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`.toLowerCase();
  const at = gitDir.toLowerCase().indexOf(marker);
  if (at < 0) return moduleRoot;
  const candidate = gitDir.slice(0, at);
  return candidate && path.isAbsolute(candidate) ? candidate : moduleRoot;
}

function resolveRuntimeRoot(input = {}, deps = {}) {
  const environment = deps.environment || process.env;
  if (input.runtimeRoot) return normalizedRoot(input.runtimeRoot, 'runtimeRoot');
  if (environment.TOOLSENABLED_RUNTIME_ROOT) return normalizedRoot(environment.TOOLSENABLED_RUNTIME_ROOT, 'TOOLSENABLED_RUNTIME_ROOT');
  return linkedMainRoot(deps.moduleRoot || MODULE_ROOT, deps.fsImpl || fs);
}

function readSource(root, relative, maximum, kind, state) {
  const sourceKey = relative.replace(/\\/g, '/');
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) fail('AGENT_ONBOARDING_PATH_ESCAPE', `${relative} escapes its root.`);
  let stat;
  let text;
  let descriptor;
  try {
    const pathStat = state.fsImpl.lstatSync(file);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maximum) throw Object.assign(new Error('unsafe or oversized source'), { code: 'SOURCE_REFUSED' });

    // Keep the checked object open for both the second metadata check and the
    // read. O_NOFOLLOW refuses a link swapped into the pathname on platforms
    // that provide it; comparing the opened descriptor with the lstat result
    // also closes that race on platforms that do not.
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = state.fsImpl.openSync(file, fs.constants.O_RDONLY | noFollow);
    stat = state.fsImpl.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.size > maximum) {
      throw Object.assign(new Error('unsafe or oversized source'), { code: 'SOURCE_REFUSED' });
    }

    // A regular file can grow after fstat. Read at most one byte beyond the
    // limit from the descriptor so growth is refused without an unbounded read.
    const buffer = Buffer.allocUnsafe(maximum + 1);
    let bytes = 0;
    while (bytes <= maximum) {
      const count = state.fsImpl.readSync(descriptor, buffer, bytes, maximum + 1 - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > maximum) throw Object.assign(new Error('unsafe or oversized source'), { code: 'SOURCE_REFUSED' });
    text = buffer.toString('utf8', 0, bytes);
  } catch (error) {
    state.sourceStatus[sourceKey] = 'unavailable';
    state.unknowns.push({ code: 'source-unavailable', source: sourceKey, cause: String(error && error.code || 'READ_FAILED') });
    return null;
  } finally {
    if (descriptor !== undefined) state.fsImpl.closeSync(descriptor);
  }
  state.sourceStatus[sourceKey] = 'available';
  state.provenance.push({
    source: sourceKey,
    kind,
    observedAt: state.generatedAt,
    mtimeMs: Math.trunc(stat.mtimeMs),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text)
  });
  return text;
}

// WHICH TREE IS THIS PACKET ABOUT, AND WHICH TREE WILL THIS SESSION EDIT.
//
// This runs on EVERY SessionStart/SubagentStart, automatically, because the
// alternative is an agent remembering to run `node tools/agent-preflight.js`
// -- and on 2026-08-10 a whole status report was produced against the retired
// tree by an author who had no mechanical way to know. Two roots are resolved
// separately and both are reported:
//
//   runtime  the checkout every value in this packet was READ FROM
//   project  the session's working directory, where its edits will LAND
//
// They are usually the same. When they are not, saying only one of them is how
// a session gets a confident, canonical-looking packet describing a tree it is
// not working in. The project root is judged against the runtime root's
// registry, because that is the registry already located and read.
//
// Cost: one small JSON read (two if the roots differ). No network, no spawn.
function collectTreeIdentity(runtimeRoot, projectRoot, state) {
  const fsImpl = state.fsImpl;
  const runtime = treeIdentity({ root: runtimeRoot, fsImpl });
  const divergentRoots = normalizeRoot(projectRoot) !== normalizeRoot(runtimeRoot);
  const project = divergentRoots
    ? treeIdentity({ root: projectRoot, registryRoot: runtimeRoot, fsImpl })
    : { ...runtime, repo: path.resolve(projectRoot) };
  const headline = [treeIdentityHeadline(runtime)];
  if (divergentRoots) {
    headline.push(`⚠ TREE DIVERGENCE: this packet was assembled from ${runtime.repo} but this session's working `
      + `directory is ${project.repo} (${project.state}). Your edits land in the working directory, not in the `
      + 'tree this packet describes.');
  }
  if (runtime.state !== 'CANONICAL' || project.state !== 'CANONICAL' || divergentRoots) {
    headline.push(NON_CANONICAL_GUIDANCE);
  }
  if (runtime.state !== 'CANONICAL') {
    state.unknowns.push({ code: 'runtime-tree-not-a-declared-root', source: runtime.repo, treeState: runtime.state });
  }
  if (divergentRoots) {
    state.mismatches.push({
      code: 'project-root-differs-from-runtime-root',
      runtimeRoot: runtime.repo, projectRoot: project.repo, projectTreeState: project.state
    });
  }
  return { runtime, project, divergentRoots, headline };
}

function gitIdentity(projectRoot, state, deps) {
  const run = deps.git || ((cwd, args) => spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env: safeLaunchEnvironment()
  }));
  let result;
  try { result = run(projectRoot, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--show-toplevel']); }
  catch (error) {
    state.unknowns.push({ code: 'project-git-unavailable', cause: String(error && error.code || 'SPAWN_FAILED') });
    return { root: projectRoot, head: null, branch: null, topLevel: null };
  }
  if (!result || result.status !== 0) {
    state.unknowns.push({ code: 'project-git-unavailable', cause: String(result && (result.error?.code || result.status) || 'FAILED') });
    return { root: projectRoot, head: null, branch: null, topLevel: null };
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/);
  return { root: projectRoot, head: lines[0] || null, branch: lines[1] || null, topLevel: lines[2] ? path.resolve(lines[2]) : null };
}

function normalizeOwns(value, unknowns, label) {
  const items = Array.isArray(value) ? value : [];
  return items.slice(0, 8).map((entry, index) => safeText(entry, `${label}[${index}]`, unknowns, 1200)).filter(Boolean);
}

function collectOrg(input, runtimeRoot, state, deps = {}) {
  const text = readSource(runtimeRoot, path.join('config', 'agent-org.json'), 512 * 1024, 'owner-settings', state);
  if (!text) return { revision: null, enabled: [], session: null, roleDefinition: null };
  let raw;
  let model;
  let storedRoles = null;
  try {
    raw = JSON.parse(text);
    let installedStores = deps.agentOrgStores || null;
    if (!installedStores && typeof state.environment.TOOLSENABLED_STATE_ROOT === 'string'
        && state.environment.TOOLSENABLED_STATE_ROOT.trim()) {
      installedStores = createInstalledAgentOrgStores({
        baselineFile: path.join(runtimeRoot, 'config', 'agent-org.json'),
        env: state.environment,
        fileSystem: state.fsImpl
      });
    }
    if (installedStores) {
      const active = installedStores.read();
      model = active.org;
      storedRoles = new Map(active.roles.map(role => [role.id, role]));
      state.provenance.push({
        source: active.source === 'overlay' ? 'installed-agent-org-overlay' : 'installed-agent-org-baseline',
        trust: 'operator settings',
        contentHash: model.contentHash
      });
    } else {
      model = agentOrg.normalizeOrg(raw, { maxAgents: 0 });
    }
  } catch (error) {
    state.unknowns.push({ code: 'agent-org-invalid', cause: String(error && error.code || 'INVALID_JSON') });
    return { revision: null, enabled: [], session: null, roleDefinition: null };
  }

  const environment = state.environment;
  const requestedId = input.agentId || environment.TOOLSENABLED_AGENT_ID || null;
  const identityBinding = input.identityBinding || (requestedId ? 'cli-argument-unverified' : 'none');
  const holderResolutionAllowed = identityBinding === 'launcher-bound' || identityBinding === 'verified-launch';
  // A hook-supplied id is not authority to assume that configured holder's
  // role, but the org's edge is not an authority grant: it is the address the
  // child needs to reach its manager. The old code made both facts depend on
  // holderResolutionAllowed, so every ordinary SubagentStart packet described
  // a configured child as reporting to nobody.
  const configured = requestedId
    ? model.agents.find(agent => agent.id === requestedId) || null
    : null;
  const declared = holderResolutionAllowed ? configured : null;
  if (requestedId && !holderResolutionAllowed) {
    state.unknowns.push({ code: 'session-identity-unverified', source: requestedId, binding: identityBinding });
  }
  if (!requestedId && input.provider) {
    const candidates = model.agents.filter(agent => agent.enabled && agent.provider === input.provider);
    if (candidates.length) state.unknowns.push({
      code: 'provider-is-not-holder-identity', source: `provider:${input.provider}`, candidateCount: candidates.length
    });
  }
  if (requestedId && holderResolutionAllowed && !declared) state.unknowns.push({ code: 'session-agent-not-declared', source: requestedId });

  // Only the validated saved seat can declare an empty selection. A caller's
  // empty input cannot suppress an assigned role, and a Worker hint cannot
  // reintroduce directions the person did not select for this tree node.
  const role = declared?.roleSelection === '' ? '' : input.role || declared?.role || null;
  const definition = role
    ? (storedRoles ? storedRoleDefinition(storedRoles.get(role)) : ROLE_DEFINITIONS[role])
    : null;
  const authorityDefinition = declared?.roleSelection === ''
    ? (storedRoles ? storedRoleDefinition(storedRoles.get(declared.role)) : ROLE_DEFINITIONS[declared.role])
    : definition;
  if (role && !definition) fail('AGENT_ONBOARDING_ROLE_INVALID', `Unknown declared role ${role}.`);
  const provider = input.provider || declared?.provider || null;
  const reportsTo = input.reportsTo || (configured ? agentOrg.managerOf(model, configured.id) : null);
  const rawById = new Map((raw.agents || []).map(agent => [agent.id, agent]));
  const enabled = model.agents.filter(agent => agent.enabled).map(agent => ({
    id: agent.id,
    role: agent.roleSelection === '' ? '' : agent.role,
    provider: agent.provider,
    reportsTo: agentOrg.managerOf(model, agent.id),
    owns: normalizeOwns(rawById.get(agent.id)?.$owns, state.unknowns, `config/agent-org.json:${agent.id}:$owns`)
  }));
  const session = {
    agentId: requestedId || declared?.id || null,
    role,
    provider,
    model: input.model || environment.TOOLSENABLED_AGENT_MODEL || null,
    tier: input.tier || environment.TOOLSENABLED_AGENT_TIER || null,
    reportsTo,
    launchId: input.launchId || environment.TOOLSENABLED_LAUNCH_ID || null,
    identityBinding,
    assignmentSource: requestedId && !holderResolutionAllowed
      ? 'unverified-session-observation'
      : (input.agentId || input.role || input.model || input.tier ? 'session-overlay' : (declared ? 'user-settings' : 'unknown'))
  };
  if (declared && input.role && input.role !== declared.role) state.mismatches.push({ code: 'session-role-differs-from-settings', declared: declared.role, observed: input.role });
  if (declared && input.provider && input.provider !== declared.provider) state.mismatches.push({ code: 'session-provider-differs-from-settings', declared: declared.provider, observed: input.provider });
  return { revision: model.revision, contentHash: model.contentHash, enabled, session, roleDefinition: definition,
    authorityCapabilities: authorityDefinition?.capabilities || null };
}

function territoryEntries(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(';') : []);
  return values.map(entry => String(entry).trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

function pathOverlap(left, right) {
  const a = left.replace(/\*\*?.*$/, '').replace(/\/$/, '').toLowerCase();
  const b = right.replace(/\*\*?.*$/, '').replace(/\/$/, '').toLowerCase();
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function overlapPairs(current, other) {
  const pairs = [];
  for (const left of current) for (const right of other) if (pathOverlap(left, right)) pairs.push([left, right]);
  return pairs;
}

function collectPresence(runtimeRoot, org, input, state) {
  const relative = path.join('state', 'agent-presence.json');
  const text = readSource(runtimeRoot, relative, 4 * 1024 * 1024, 'runtime-observation', state);
  if (!text) return { revision: null, live: [], overlaps: [] };
  let registry;
  try { registry = presence.normalizeRegistry(JSON.parse(text)); }
  catch (error) {
    state.unknowns.push({ code: 'agent-presence-invalid', cause: String(error && error.code || 'INVALID_JSON') });
    return { revision: null, live: [], overlaps: [] };
  }
  const terminal = presence.TERMINAL;
  const now = state.now;
  const live = Object.values(registry.agents)
    .filter(record => !terminal.has(record.status))
    .map(record => ({
      agentId: record.agentId,
      role: record.role,
      kind: record.kind,
      modelOrTier: record.tier,
      reportsTo: record.reportsTo,
      lane: record.lane,
      territory: territoryEntries(record.territory),
      worktree: record.worktree,
      status: record.status,
      lastHeartbeat: record.lastHeartbeat,
      heartbeatAgeMs: Math.max(0, now - record.lastHeartbeat),
      freshness: now - record.lastHeartbeat <= presence.DEFAULT_STALE_MS ? 'fresh' : 'expired'
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  const declaredById = new Map(org.enabled.map(agent => [agent.id, agent]));
  for (const record of live) {
    const declared = declaredById.get(record.agentId);
    if (!declared) state.mismatches.push({ code: 'live-agent-not-enabled-in-settings', agentId: record.agentId, observedRole: record.role });
    else if (declared.role !== record.role) state.mismatches.push({ code: 'live-role-differs-from-settings', agentId: record.agentId, declared: declared.role, observed: record.role });
  }
  const current = territoryEntries(input.territory);
  const overlaps = live.filter(record => record.agentId !== org.session?.agentId).map(record => ({
    agentId: record.agentId,
    pairs: overlapPairs(current, record.territory)
  })).filter(entry => entry.pairs.length);
  return { revision: registry.revision, updatedAt: registry.updatedAt, live, overlaps };
}

function loadDatabaseSync() {
  const original = process.emitWarning;
  process.emitWarning = function suppressSqlite(warning, ...args) {
    const message = warning instanceof Error ? warning.message : String(warning);
    const type = warning instanceof Error ? warning.name : args[0];
    if (type === 'ExperimentalWarning' && message === 'SQLite is an experimental feature and might change at any time') return;
    return Reflect.apply(original, this, [warning, ...args]);
  };
  try { return require('node:sqlite').DatabaseSync; }
  finally { process.emitWarning = original; }
}

function readActiveClaims(runtimeRoot, state) {
  const file = programOrStatePath(runtimeRoot, ['state', 'toolsenabled.sqlite3']);
  if (!state.fsImpl.existsSync(file)) throw Object.assign(new Error('state database missing'), { code: 'ENOENT' });
  const DatabaseSync = loadDatabaseSync();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare("SELECT entry_key, value_json, tags_json, updated_at_ms FROM memory_entries WHERE namespace = 'agent-coord' ORDER BY updated_at_ms DESC, entry_key ASC LIMIT 128").all();
    const result = [];
    for (const row of rows) {
      let value;
      let tags;
      try { value = JSON.parse(row.value_json); tags = JSON.parse(row.tags_json); } catch (error) {
        // Skipping an unreadable row made a partial database scan look like a
        // complete, possibly empty active-claim list.  Reject the whole
        // observation so collectClaims records it as unavailable (and the
        // mutation-context gate refuses it) rather than answering "no claim".
        throw Object.assign(new Error(`agent-coord claim ${row.entry_key} is not valid JSON`, { cause: error }), {
          code: 'INVALID_CLAIM_JSON'
        });
      }
      if (!Array.isArray(tags) || !tags.includes('ad-hoc-claim') || value?.state !== 'active') continue;
      if (value.expiresAt && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) < state.now) continue;
      const candidate = {
        key: row.entry_key,
        actor: value.actor || null,
        checkout: value.checkout || value.worktree || null,
        paths: territoryEntries(value.paths),
        scope: value.scope || null,
        expiresAt: value.expiresAt || null,
        updatedAt: row.updated_at_ms
      };
      if (looksSecret(JSON.stringify(candidate))) {
        state.unknowns.push({ code: 'secret-shaped-claim-withheld', source: row.entry_key });
        continue;
      }
      result.push(candidate);
      if (result.length >= 32) break;
    }
    return result;
  } finally { database.close(); }
}

function collectClaims(runtimeRoot, org, input, state, deps) {
  let claims;
  try {
    claims = deps.readClaims ? deps.readClaims({ runtimeRoot, now: state.now }) : readActiveClaims(runtimeRoot, state);
    if (!Array.isArray(claims)) throw Object.assign(new Error('claim reader returned a non-array'), { code: 'INVALID_CLAIMS' });
  }
  catch (error) {
    state.sourceStatus['agent-coord:claims'] = 'unavailable';
    state.unknowns.push({ code: 'agent-coord-claims-unavailable', cause: String(error && error.code || 'READ_FAILED') });
    return { active: [], overlaps: [] };
  }
  state.sourceStatus['agent-coord:claims'] = 'available';
  const active = claims.slice(0, 32).map(claim => ({
    key: safeText(claim.key, 'claim.key', state.unknowns, 256),
    actor: safeText(claim.actor, 'claim.actor', state.unknowns, 128) || null,
    checkout: safeText(claim.checkout, 'claim.checkout', state.unknowns, 1024) || null,
    paths: territoryEntries(claim.paths).slice(0, 64),
    scope: safeText(claim.scope, 'claim.scope', state.unknowns, 1200) || null,
    expiresAt: claim.expiresAt || null,
    updatedAt: claim.updatedAt || null
  }));
  const current = territoryEntries(input.territory);
  const overlaps = active.filter(claim => claim.actor !== org.session?.agentId).map(claim => ({
    key: claim.key,
    actor: claim.actor,
    pairs: overlapPairs(current, claim.paths)
  })).filter(entry => entry.pairs.length);
  return { active, overlaps };
}

function phaseSummary(phase, unknowns) {
  const detail = phase.body.split(/\r?\n/).map(line => line.trim())
    .find(line => line && !line.startsWith('#') && !/^\*\*Status:/.test(line)) || '';
  return { id: phase.id, title: phase.title, status: phase.status, statusRaw: phase.statusRaw, summary: safeText(detail, `BUILD-QUEUE.md:${phase.id}`, unknowns, 420) };
}

function collectGoals(runtimeRoot, input, state) {
  const text = readSource(runtimeRoot, 'BUILD-QUEUE.md', 4 * 1024 * 1024, 'queue-state', state);
  if (!text) return [];
  const phases = parseQueuePhases(text);
  if (input.directiveId && /^Q\d{1,3}$/.test(input.directiveId)) {
    const phase = phases.find(entry => entry.id === input.directiveId);
    if (!phase) state.unknowns.push({ code: 'directive-queue-phase-not-found', source: input.directiveId });
    return phase ? [phaseSummary(phase, state.unknowns)] : [];
  }
  const selected = phases.filter(phase => ['IN-PROGRESS', 'BLOCKED', 'PARTIAL'].includes(phase.status));
  const firstOpen = phases.find(phase => phase.status === 'OPEN');
  if (firstOpen) selected.push(firstOpen);
  const limit = input.scope === 'full' ? 10 : input.scope === 'minimal' ? 3 : 6;
  return selected.slice(0, limit).map(phase => phaseSummary(phase, state.unknowns));
}

function collectDirective(runtimeRoot, input, state) {
  /* READ THE LEDGER WHERE IT IS WRITTEN. reports/ is runtime state: installed,
     and under the isolated test runner, it lives under the state root, not
     the program root. readSource keeps its escape check, so the root handed
     to it is the parent of the resolved reports/ directory and the relative
     path -- and with it the source key every caller pins -- stays the same. */
  const ledgerRoot = path.dirname(programOrStatePath(runtimeRoot, ['reports']));
  const text = readSource(ledgerRoot, path.join('reports', 'OWNER-REQUEST-LEDGER.json'), 12 * 1024 * 1024, 'owner-ledger', state);
  if (!text) return null;
  let ledger;
  try { ledger = JSON.parse(text); } catch {
    state.sourceStatus['reports/OWNER-REQUEST-LEDGER.json'] = 'invalid';
    state.unknowns.push({ code: 'owner-ledger-invalid-json' });
    return null;
  }
  const requests = Array.isArray(ledger) ? ledger : ledger.requests;
  const { isRequestId } = require('./request-id');
  const explicit = isRequestId(input.directiveId, { family: 'R' });
  const listed = Array.isArray(requests) ? requests.filter(entry => entry && isRequestId(String(entry.id || ''), { family: 'R' })) : [];
  /* ONLY THIS AGENT'S OWN CONTEXT. The one ledger now holds every tier, so a
     record filed for another session or thread must never become this
     session's directive, and a row still waiting for the person, declined or
     removed is not a directive for anyone. */
  const { selectForContext } = require('./owner-request-store');
  const available = selectForContext(listed, {
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
    treeAnchors: Array.isArray(input.treeAnchors) ? input.treeAnchors : [],
    threadId: typeof input.threadId === 'string' && input.threadId ? input.threadId : null
  }).filter(entry => !/^(?:proposed|declined|removed)$/i.test(String(entry.status || '')));
  // 'superseded' (resolve(), 2026-09-07) joins the other terminal statuses
  // here, not in the proposed/declined/removed filter above: an explicit
  // directiveId can still read a superseded record back, the same as a done
  // one, but auto-selection must never pick it as the latest open directive.
  const open = available.filter(entry => !/^(?:done|complete|completed|closed|cancelled|canceled|not-possible-as-asked|superseded)$/i.test(String(entry.status || '')));
  const request = explicit
    ? available.find(entry => entry.id === input.directiveId)
    : (open[open.length - 1] || available[available.length - 1] || null);
  if (!request) {
    state.unknowns.push({ code: 'directive-request-not-found', source: explicit ? input.directiveId : 'latest-open-request' });
    return null;
  }
  const verbatimLimit = input.scope === 'full' ? 16 * 1024 : input.scope === 'minimal' ? 2500 : 8 * 1024;
  const gates = Array.isArray(request.gates) ? request.gates.map((gate, index) => ({ gate, index })).filter(({ gate }) => gate && gate.met === false) : [];
  const gateLimit = input.scope === 'full' ? 18 : input.scope === 'minimal' ? 4 : 10;
  return {
    id: request.id,
    selection: explicit ? 'explicit-directive' : 'latest-open-request',
    status: request.status || null,
    verbatim: safeText(request.verbatim, `${request.id}.verbatim`, state.unknowns, verbatimLimit),
    openGateCount: gates.length,
    openGates: gates.slice(0, gateLimit).map(({ gate, index }) => ({ index, instruction: safeText(gate.instruction, `${request.id}.gates[${index}]`, state.unknowns, 1600) }))
  };
}

/* The owner's standing requests, from the four R ledgers (src/lib/r-ledger.js).
 * /Request (global), /RequestSession, /RequestTree, and /RequestThread file
 * owner-authored text verbatim into files the owner can edit directly; agents
 * READ them at boot. This is that read. The stack is assembled in the order the
 * agent must obey it -- global, its session, every ancestor's tree ledger from
 * the top down, its own thread -- and rendered PINNED: owner rules are the one
 * section the byte budget may never drop, and the files are short by design.
 * A thread rule's whole purpose is surviving THIS agent's compaction, which the
 * SessionStart re-fire delivers mechanically as long as this section rides.
 *
 * Identity comes from the caller: the hook's session_id, and for a spawned
 * child the environment its parent set (TOOLSENABLED_THREAD_ID and the
 * ancestor chain TOOLSENABLED_TREE_ANCESTORS, oldest first, comma-separated).
 * Missing identity is stated, never guessed: an agent that cannot name its
 * session sees the global ledger only, and the packet says so. */
/* THE PINNED BLOCK MUST NEVER KILL THE BOOT. This section rides outside the
 * byte budget on purpose, and renderPacket refuses any packet over its scope
 * ceiling -- which made the ledgers an unguarded path to
 * AGENT_ONBOARDING_PACKET_TOO_LARGE: measured 2026-08-16 on the installed
 * build, ~36 average /Request entries stopped EVERY agent start at every
 * scope, hooks and lanes alike, with nothing on any surface saying why. So
 * the block is capped at a fixed share of the scope ceiling. Over it, whole
 * layers are WITHHELD most-specific-first -- thread, then tree ancestors
 * nearest-first, then session -- and the global layer, last, sheds its OLDEST
 * entries one at a time (newer owner directives amend older ones, so the
 * newest are the ones an agent must not miss). Nothing is deleted: every
 * entry stays in its file, every withheld layer prints the path to read it,
 * and the trim is announced in the packet and in `unknowns`. The newest
 * global entry always survives: every cap exceeds the per-entry word limit.
 *
 * The capper and the renderer MUST share one line builder
 * (ownerRequestLayerLines); a cap measured against different text than the
 * render produces is no cap at all. */
const OWNER_REQUEST_BLOCK_SHARE = 0.4;

function ownerRequestLayerLines(layer) {
  const lines = [];
  const where = `${layer.scope}${layer.key ? ` ${layer.key}` : ''}`;
  if (!layer.exists) {
    lines.push(`[${where}] none filed (${layer.path})`);
    return lines;
  }
  if (layer.withheld && layer.requests.length === 0) {
    lines.push(`[${where}] all ${layer.withheld.count} withheld for space (${layer.withheld.bytes} bytes) — read them: ${layer.path}`);
    for (const warning of layer.warnings) lines.push(`  ledger warning: ${warning}`);
    return lines;
  }
  lines.push(`[${where}] ${layer.count} — applies to ${layer.appliesTo}`);
  for (const request of layer.requests) {
    // A refinement sits indented under the entry it refines and names it, so
    // it still reads right when its parent was withheld for space.
    const pad = '  '.repeat(request.depth || 0);
    lines.push(`${pad}  ${request.id}${request.stamp ? ` (${request.stamp})` : ''}${request.parentId ? ` — refines ${request.parentId}` : ''}:`);
    for (const line of String(request.words || '').split('\n')) lines.push(`${pad}      ${line}`);
  }
  if (layer.withheld && layer.requests.length > 0) {
    lines.push(`  ${layer.withheld.count} older ${layer.withheld.count === 1 ? 'entry' : 'entries'} withheld for space (${layer.withheld.bytes} bytes) — read them all: ${layer.path}`);
  }
  for (const warning of layer.warnings) lines.push(`  ledger warning: ${warning}`);
  return lines;
}

function ownerRequestBlockBytes(layers, withheld = null) {
  // Measure the same complete block renderPacket() emits. The heading,
  // summary, filing instructions, and request-contract paragraph are part of
  // the ledger's share too; counting only layer lines let the rendered block
  // exceed its advertised ceiling even though the capper claimed success.
  const ownerRequests = {
    readOrder: 'global, then session, then each ancestor tree top-down, then thread',
    total: layers.reduce((sum, layer) => sum + layer.count, 0),
    layers,
    ...(withheld ? { withheld } : {})
  };
  return Buffer.byteLength(ownerRequestLines(ownerRequests).join('\n'), 'utf8') + 1;
}

function capOwnerRequestLayers(layers, scopeKey, state) {
  const cap = Math.floor(MAX_RENDERED_BYTES[scopeKey] * OWNER_REQUEST_BLOCK_SHARE);
  let withheldCount = 0;
  let withheldBytes = 0;
  const measuredBytes = () => ownerRequestBlockBytes(layers,
    withheldCount > 0 ? { count: withheldCount, bytes: withheldBytes } : null);
  if (measuredBytes() <= cap) return null;
  const withholdWhole = (layer) => {
    const bytes = Buffer.byteLength(JSON.stringify(layer.requests), 'utf8');
    layer.withheld = { count: layer.requests.length, bytes };
    withheldCount += layer.requests.length;
    withheldBytes += bytes;
    layer.requests = [];
  };
  const dropOrder = [
    ...layers.filter(layer => layer.scope === 'thread'),
    ...[...layers].reverse().filter(layer => layer.scope === 'tree'),
    ...layers.filter(layer => layer.scope === 'session')
  ];
  for (const layer of dropOrder) {
    if (measuredBytes() <= cap) break;
    if (!layer.exists || layer.requests.length === 0) continue;
    withholdWhole(layer);
  }
  const global = layers.find(layer => layer.scope === 'global');
  if (global && global.exists) {
    let dropped = 0;
    let droppedBytes = 0;
    while (global.requests.length > 1 && measuredBytes() > cap) {
      const oldest = global.requests.shift();
      dropped += 1;
      const oldestBytes = Buffer.byteLength(JSON.stringify(oldest), 'utf8');
      droppedBytes += oldestBytes;
      withheldCount += 1;
      withheldBytes += oldestBytes;
      global.withheld = { count: dropped, bytes: droppedBytes };
    }
  }
  state.unknowns.push({
    code: 'owner-requests-trimmed',
    source: `${withheldCount} standing request${withheldCount === 1 ? '' : 's'} (${withheldBytes} bytes) withheld from this packet to keep the boot under its ${cap}-byte ledger share; nothing was deleted — every entry stays in its file, and each withheld layer names its path`
  });
  return { count: withheldCount, bytes: withheldBytes };
}

function collectOwnerRequests(runtimeRoot, input, state) {
  let ledger;
  try { ledger = require('./r-ledger'); } catch (error) {
    state.unknowns.push({ code: 'owner-requests-module-unavailable', source: String(error && error.message || error) });
    return null;
  }
  /* READ THE LEDGERS WHERE THEY ARE WRITTEN. r-ledger.js resolves its files
     through runtime.rootPath, which redirects `state/` and `reports/` to the
     per-user state root when the program root is a read-only staged payload.
     A plain join here read the payload instead, so on an INSTALLED build every
     /Request the owner filed was written to one directory and looked for in
     another: the packet reported "none filed" for all four scopes for ever.
     The state DB three lines below already resolves the same way (:607). */
  const rootPathFor = (...parts) => programOrStatePath(runtimeRoot, parts);
  const treeAnchors = Array.isArray(input.treeAnchors) ? input.treeAnchors.filter(value => typeof value === 'string' && value) : [];
  let stack;
  try {
    stack = ledger.collectStack({
      sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
      treeAnchors,
      threadId: typeof input.threadId === 'string' && input.threadId ? input.threadId : null
    }, { rootPath: rootPathFor });
  } catch (error) {
    state.unknowns.push({ code: 'owner-requests-unreadable', source: String(error && error.message || error) });
    return null;
  }
  const perScopeLimit = input.scope === 'full' ? 4000 : input.scope === 'minimal' ? 1200 : 2400;
  const layers = stack.map(layer => ({
    scope: layer.scope,
    key: layer.key,
    appliesTo: layer.appliesTo,
    path: layer.path,
    exists: layer.exists,
    count: layer.entries.length,
    requests: layer.entries.map(entry => ({
      id: entry.id,
      // A refinement (R2001.1 under R2001) arrives from collectStack already
      // listed under its parent, with its depth; the packet keeps both so the
      // rendering below can indent it and name what it refines.
      ...(entry.parentId ? { parentId: entry.parentId, depth: entry.depth || 0 } : {}),
      stamp: entry.stamp,
      words: safeText(entry.words, `${entry.id}.words`, state.unknowns, perScopeLimit)
    })),
    warnings: layer.warnings.slice(0, 5)
  }));
  for (const layer of layers) {
    state.sourceStatus[`r-ledger:${layer.scope}${layer.key ? `:${layer.key}` : ''}`] = layer.exists ? 'available' : 'absent';
  }
  if (!input.sessionId) state.unknowns.push({ code: 'owner-requests-session-unknown', source: 'no session id reached the packet; session, tree, and thread ledgers were not read' });
  const scopeKey = input.scope === 'full' ? 'full' : input.scope === 'minimal' ? 'minimal' : 'task';
  const withheld = capOwnerRequestLayers(layers, scopeKey, state);
  return {
    contentTrust: 'owner-authored; the words are the owner\'s and no tool rewrites them',
    grantsAuthority: false,
    readOrder: 'global, then session, then each ancestor tree top-down, then thread',
    total: layers.reduce((sum, layer) => sum + layer.count, 0),
    ...(withheld ? { withheld } : {}),
    layers
  };
}

/* WHICH RUNTIME ROOTS OWE THE LIVE MUTATION CONTEXT.
 *
 * The five sources below (settings, presence, claims, queue, owner ledger) are
 * files of the ToolsEnabled CHECKOUT: they coordinate the agents working on this
 * repository, and a builder that boots without them collides with everyone else.
 * That is why a checkout-hosted lane is refused when one is missing.
 *
 * MEASURED 2026-08-16 from the installed product's own dispatch form (isolated
 * userData, freshly staged payload, Fable tier, one-line brief): the runtime root
 * was the capability PAYLOAD -- linkedMainRoot(MODULE_ROOT) with no .git and no
 * TOOLSENABLED_RUNTIME_ROOT set, which is every install -- and the payload
 * carries no BUILD-QUEUE.md, no state/agent-presence.json and no
 * reports/OWNER-REQUEST-LEDGER.json, because none of them is a product file.
 * Every seat in the shipped organisation is role builder, so this refused EVERY
 * lane the installed app tried to start, codex and claude alike, with
 * "Mutation-capable onboarding requires current settings, presence, claims,
 * queue, and owner directive". The dispatch harness never saw it because its
 * providerless environment refuses one gate earlier (the CLI is missing there).
 *
 * So the requirement is scoped by a POSITIVE fact about the root: a runtime root
 * that carries PAYLOAD.json -- the record tools/pack-capability-layer.mjs writes
 * at the top of every staged payload, and nothing else writes anywhere -- is a
 * payload-hosted dispatch, and the packet is built from what that payload has,
 * with the skip recorded in `unknowns` so the child can read why. Every other
 * root -- a checkout, a worktree, or an EMPTY or WRONG directory a hook was
 * pointed at -- is held to exactly the rule above, unchanged by one bit. The
 * marker is deliberately not "a checkout marker is absent": an empty temp
 * directory has no checkout marker either, and tests/agent-onboarding-hook-
 * contract.js rightly requires a builder hook aimed at one to fail closed. */
const PAYLOAD_RECORD_FILE = 'PAYLOAD.json';

function runtimeRootIsStagedPayload(runtimeRoot, fsImpl) {
  try { return fsImpl.lstatSync(path.join(runtimeRoot, PAYLOAD_RECORD_FILE)).isFile(); }
  catch { return false; }
}

function requireLiveMutationContext(input, state, org, presenceView, claims, directive, runtimeRoot) {
  const mutationCapable = input.profile === 'builder'
    || org.authorityCapabilities?.requiresMutationContext === true;
  if (!mutationCapable) return;
  if (runtimeRootIsStagedPayload(runtimeRoot, state.fsImpl)) {
    state.unknowns.push({
      code: 'live-mutation-context-not-required',
      source: `runtime root is a staged capability payload (${PAYLOAD_RECORD_FILE} present); the checkout coordination files are not product files and were not required`
    });
    return;
  }
  const required = [
    ['config/agent-org.json', org.revision !== null && state.sourceStatus['config/agent-org.json'] === 'available'],
    ['state/agent-presence.json', presenceView.revision !== null && state.sourceStatus['state/agent-presence.json'] === 'available'],
    ['agent-coord:claims', state.sourceStatus['agent-coord:claims'] === 'available'],
    ['BUILD-QUEUE.md', state.sourceStatus['BUILD-QUEUE.md'] === 'available'],
    /* AVAILABLE, not NON-EMPTY. This used to also require Boolean(directive) --
       an actual directive object -- which conflated two different questions:
       "can I read the owner's record" (an integrity requirement, and rightly
       fatal) with "does it have anything in it right now" (a fact about this
       machine, not about the software).
       A fresh install has an empty ledger. So did this one on 2026-08-12 after
       the owner reset it to zero, and the conflation refused EVERY
       mutation-capable dispatch in the tree -- codex, claude and local alike --
       with a message about a file that was readable the whole time. An
       unreadable or stale ledger still fails here, which is the property that
       was actually wanted. */
    ['reports/OWNER-REQUEST-LEDGER.json', state.sourceStatus['reports/OWNER-REQUEST-LEDGER.json'] === 'available']
  ];
  const missing = required.filter(([, available]) => !available).map(([source]) => source);
  if (missing.length) fail('AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED',
    `Mutation-capable onboarding requires current settings, presence, claims, queue, and owner directive: ${missing.join(', ')}.`,
    { missing });
}

/* The feature line the owner asked for: `[filekeeper] [grepsaver] ...`.
 *
 * Resolved from the tool surface THIS SESSION actually has, never from a flag --
 * see src/lib/capability-features.js for why that distinction is the whole
 * point. A confined tier shrinks listTools, so this line shrinks with it and
 * an agent is told what it can reach rather than what the product ships.
 *
 * Failure here is a missing line, never a failed packet. Orientation that
 * refuses to render because one of its accelerators could not be measured would
 * cost more than the line is worth, so the unknown is recorded and the packet
 * goes out.
 *
 * RANK 1, AND BOUNDED BECAUSE OF IT. This used to live inside `contextRoutes`
 * and `capabilities`, both rank 8, so the budget's SECOND and THIRD steps took
 * it: measured 2026-08-13 at minimal scope, the packet rendered "FEATURES YOU
 * HAVE: could not be resolved this run" from a run in which they had resolved
 * perfectly. That is not a missing line, it is a false one, and it is the single
 * failure the header comment on MAX_RENDERED_BYTES says this packet must never
 * commit -- the agent could not tell "not reported" from "not happening".
 *
 * It now rides in the always-rendered header block with the tree identity and
 * the owner authorization. Nothing pinned there can be trimmed, so everything
 * pinned there must be bounded HERE instead: renderPacket fails closed over the
 * ceiling, and a hard failure at session boot is the most expensive failure this
 * module can produce. Eleven features are declared today and the widest tag is
 * `[purchase-cart: degraded]`, so the line measures ~285 bytes at its worst.
 * A cap of 512 leaves the manifest room to grow and still refuses to let it grow
 * without limit. */
const FEATURE_LINE_MAX_BYTES = 512;
/* Degraded reasons are pinned too, so they are capped by COUNT as well as by
 * width. The ones not shown are COUNTED rather than dropped: "2 more are
 * degraded" is orientation, and silence about them is the same lie in miniature
 * that this whole block exists to stop. */
const FEATURE_DEGRADED_MAX = 4;
const FEATURE_REASON_MAX_BYTES = 120;

function collectFeatures(runtimeRoot, state, deps) {
  try {
    const capabilityFeatures = deps.capabilityFeatures
      || require(path.join(runtimeRoot, 'src', 'lib', 'capability-features.js'));
    const listTools = deps.listTools
      || require(path.join(runtimeRoot, 'src', 'lib', 'tool-registry.js')).listTools;
    const toolNames = (listTools() || []).map(tool => tool?.name || tool?.id || tool).filter(Boolean);
    const resolved = capabilityFeatures.resolveFeatures({ toolNames, root: runtimeRoot });
    const line = capabilityFeatures.featureLine(resolved);
    const degraded = resolved.filter(feature => feature.state === 'degraded');
    // Collapsed to one line each, because these are printed as PROSE in the
    // header rather than inside a JSON blob, and safeText's own truncation
    // marker arrives on a newline. A pinned block that can sprout line breaks
    // from content is a pinned block whose shape depends on its input.
    const oneLine = (value, label, maximum) => safeText(value, label, state.unknowns, maximum).replace(/\s+/g, ' ').trim();
    return {
      line: line ? oneLine(line, 'capability-features:line', FEATURE_LINE_MAX_BYTES) || null : null,
      // Degraded features are carried separately so the renderer can say WHY
      // without spending bytes on the ones that are simply fine.
      degraded: degraded.slice(0, FEATURE_DEGRADED_MAX).map(feature => ({
        id: feature.id,
        reason: oneLine(feature.reason, `capability-features:${feature.id}.reason`, FEATURE_REASON_MAX_BYTES)
      })),
      degradedNotShown: Math.max(0, degraded.length - FEATURE_DEGRADED_MAX)
    };
  } catch (error) {
    state.unknowns.push({ code: 'capability-features-unavailable', cause: String(error && error.code || 'FAILED') });
    // The feature set was not measured, so neither was its degraded count.
    // Keep the rendering bounded while carrying that uncertainty in the model
    // instead of reporting the definite count zero.
    return { line: null, degraded: [], degradedNotShown: null };
  }
}

function collectRoutes(runtimeRoot, input, state, deps) {
  const topic = safeText(input.topic || input.directiveId || input.profile || 'agent onboarding', 'topic', state.unknowns, 512);
  let packet;
  try {
    const orient = deps.orient || require(path.join(runtimeRoot, 'tools', 'grepsaver-orient.js')).orient;
    packet = orient(topic, { limit: input.scope === 'full' ? 5 : 3 });
  } catch (error) {
    state.unknowns.push({ code: 'grepsaver-orientation-unavailable', cause: String(error && error.code || 'FAILED') });
    return { topic, cards: [], docRouter: [], antiRoutes: [], toolNamespaces: [], coverage: null, trust: 'unavailable' };
  }
  const cards = (packet.cards || []).slice(0, 5).map(card => ({ id: card.id || card.system || null, path: card.path || null, status: card.status || null }));
  const docRouter = (packet.docRouter || []).slice(0, input.scope === 'full' ? 8 : 4).map((line, index) => safeText(line, `grepsaver.docRouter[${index}]`, state.unknowns, 1200));
  const antiRoutes = (packet.antiRoutes || []).slice(0, 4).map((line, index) => safeText(line, `grepsaver.antiRoutes[${index}]`, state.unknowns, 800));
  const toolNamespaces = (packet.toolNamespaces || []).slice(0, 10).map(entry => ({ namespace: entry.namespace, toolCount: entry.toolCount }));
  return { topic, cards, docRouter, antiRoutes, toolNamespaces, coverage: packet.coverage || null, trust: packet.trust || 'Cards are maps, not authority.' };
}

// WHAT HAS ACTUALLY BEEN DONE HERE, AND WHAT HAS STOPPED BEING TRUE.
//
// The owner ledger records what was requested; the recent-work feed separately
// records what was done so a new session does not have to rediscover the tree
// from scratch or repeat another lane's measurement.
//
// It is collected from the RUNTIME root -- the tree every other value in this
// packet was read from -- so the feed and the facts it retires describe one
// program. Reading it from the project root would produce retirements about a
// different checkout, which is worse than no retirements at all.
//
// The feed carries its own budget and has already trimmed itself before this
// returns; applyByteBudget can trim it further, piecewise, and never reaches its
// retirement list. A total failure is recorded as an unknown and the packet
// continues: a boot packet must not fail closed because `git log` did not run.
// EVERY STRING IN THE FEED IS UNTRUSTED TEXT FROM OUTSIDE THIS MODULE.
//
// Commit subjects, branch names, file paths and lane report names are all
// author-controlled, and renderPacket refuses to emit a packet containing
// secret-shaped content -- correctly. Without this scrub, one commit subject
// reading "revoke ghp_<twenty characters>" would not redact a line, it would
// take down SESSION BOOT: AGENT_ONBOARDING_SECRET_REJECTED, hook `continue:
// false`, every child refused. A fast, confident, wrong failure at the one
// moment an agent has no context with which to diagnose it.
//
// Scrubbed HERE rather than inside agent-recent-work.js on purpose. The pattern
// list is one list, in this file, next to the rule it enforces; a second copy in
// the feed module is the drift this codebase keeps paying for. safeText replaces
// the offending text with a marker and records an unknown, so a redaction is
// visible as a redaction and never as an absence.
const RECENT_WORK_SCRUB_DEPTH = 6;
function scrubRecentWork(value, state, label = 'recentWork', depth = 0) {
  if (depth > RECENT_WORK_SCRUB_DEPTH) return null;
  if (typeof value === 'string') return safeText(value, label, state.unknowns, 4096);
  if (Array.isArray(value)) return value.map((item, index) => scrubRecentWork(item, state, `${label}[${index}]`, depth + 1));
  if (plain(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubRecentWork(item, state, `${label}.${key}`, depth + 1);
    return out;
  }
  return value;
}

function collectRecentWork(runtimeRoot, input, state, deps) {
  try {
    const collect = deps.collectRecentWork || require('./agent-recent-work').collectRecentWork;
    const feed = collect({
      root: runtimeRoot,
      now: state.now,
      scope: input.scope,
      fsImpl: state.fsImpl,
      ...(deps.git ? { git: deps.git } : {})
    });
    // The feed's own `unknown` array is deliberately NOT copied up into the
    // packet's. It would double the bytes to say the same thing, and it would
    // say it in the WORSE place: the packet's unknowns are rank 5 and are
    // trimmed before this section is, so the copy is the one that disappears
    // first. Inside the feed the record is protected from both budgets.
    //
    // A redaction, by contrast, DOES belong in the packet's unknowns: it is a
    // statement about this packet, not about the tree the feed describes.
    return scrubRecentWork(feed, state);
  } catch (error) {
    state.unknowns.push({ code: 'recent-work-feed-unavailable', cause: String(error && error.code || 'FAILED') });
    return {
      undetermined: 'the recent-work feed did not run; you have NO information here about what changed recently or about which facts have expired',
      readItAt: 'node tools/recent-work.js'
    };
  }
}

function normalizeInput(input = {}) {
  if (!plain(input)) fail('AGENT_ONBOARDING_INPUT_INVALID', 'input must be an object.');
  const scope = input.scope === undefined ? 'task' : String(input.scope);
  const profile = input.profile === undefined ? 'agent' : String(input.profile);
  const identityBinding = input.identityBinding === undefined
    ? (input.agentId ? 'cli-argument-unverified' : 'none')
    : String(input.identityBinding);
  if (!SCOPES.includes(scope)) fail('AGENT_ONBOARDING_INPUT_INVALID', `scope must be one of: ${SCOPES.join(', ')}.`);
  if (!PROFILES.includes(profile)) fail('AGENT_ONBOARDING_INPUT_INVALID', `profile must be one of: ${PROFILES.join(', ')}.`);
  if (!IDENTITY_BINDINGS.includes(identityBinding)) fail('AGENT_ONBOARDING_INPUT_INVALID', `identityBinding must be one of: ${IDENTITY_BINDINGS.join(', ')}.`);
  return { ...input, scope, profile, identityBinding };
}

function compactBytes(value) {
  return Buffer.byteLength(JSON.stringify(value === undefined ? null : value), 'utf8');
}

function resolveContainer(body, containerPath) {
  if (!containerPath) return body;
  return containerPath.split('.').reduce((node, key) => (plain(node) ? node[key] : undefined), body);
}

// A dropped field is REPLACED, never deleted. An absent key reads as "there was
// nothing to report"; this marker reads as "there was something and you were not
// shown it, here is how big it was and where it lives".
function omissionMarker(bytes, entry) {
  return { omitted: true, reason: 'onboarding-byte-budget', bytes, readItAt: entry.where };
}

// LAST RESORT ONLY. The owner directive is rank 3 and is never dropped whole,
// because a session that cannot see what it is judged against is the exact
// failure this packet exists to prevent. When one directive alone will not fit
// -- a 60 KB verbatim with 40 gates is not hypothetical -- it is shortened in
// three steps, each of which states its own cut in the text it leaves behind.
//
// The VERBATIM gives way before the GATES. A verbatim is continuous prose whose
// tail can be cut and replaced with a pointer to the whole of it; each gate is a
// separate instruction, and surrendering instructions wholesale is precisely how
// a session ends up not knowing what it is required to do. So the verbatim is
// first cut back to about half of whatever the directive may hold, then gates go
// from the end, and only if the gates are exhausted does the verbatim give up
// the rest. Both survive in part rather than one surviving whole.
function cutVerbatim(directive, maxBytes) {
  if (typeof directive.verbatim !== 'string' || !directive.verbatim) return 0;
  const before = Buffer.byteLength(directive.verbatim, 'utf8');
  if (before <= maxBytes) return 0;
  const identifier = directive.id ? ` entry ${directive.id}` : '';
  const suffix = `
[verbatim cut here by the onboarding byte budget; read the whole thing in reports/OWNER-REQUEST-LEDGER.json${identifier}]`;
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let end = directive.verbatim.length;
  while (end > 0 && Buffer.byteLength(directive.verbatim.slice(0, end), 'utf8') > target) end -= 1;
  directive.verbatim = `${directive.verbatim.slice(0, end).trimEnd()}${suffix}`;
  return before - Buffer.byteLength(directive.verbatim, 'utf8');
}

function shrinkDirective(body, bodyTarget, omitted, title) {
  const directive = body.directive;
  const entry = PRIORITY_BY_ID.fences;
  if (!plain(directive)) return compactBytes(body);
  let measured = compactBytes(body);
  if (measured <= bodyTarget) return measured;
  const verbatimLabel = title || 'Tail of the owner directive verbatim';
  let verbatimLost = 0;

  // 1. Verbatim down to roughly half of what the directive is allowed to keep,
  //    so the gates have somewhere to live.
  const held = compactBytes(directive);
  const allowed = Math.max(0, held - (measured - bodyTarget));
  verbatimLost += cutVerbatim(directive, Math.max(512, Math.trunc(allowed / 2)));
  measured = compactBytes(body);

  // 2. Gates from the end. The count that went is stated, against the number the
  //    ledger actually holds open -- not against the number this packet happened
  //    to be carrying, which would understate the loss.
  if (Array.isArray(directive.openGates) && directive.openGates.length && measured > bodyTarget) {
    const before = directive.openGates.length;
    const openInLedger = Number.isFinite(directive.openGateCount) ? directive.openGateCount : before;
    while (measured > bodyTarget && directive.openGates.length) {
      directive.openGates = directive.openGates.slice(0, -1);
      measured = compactBytes(body);
    }
    const lost = before - directive.openGates.length;
    if (lost > 0) {
      directive.openGatesWithheldForBudget = { count: lost, openInLedger, reason: 'onboarding-byte-budget', readItAt: entry.where };
      omitted.push({
        field: 'directive.openGates', priority: 'fences', bytes: null, readItAt: entry.where,
        title: `${lost} open gate instruction(s) of the ${openInLedger} the ledger holds open`
      });
      measured = compactBytes(body);
    }
  }

  // 3. Only now does the verbatim give up the remainder.
  if (measured > bodyTarget) {
    verbatimLost += cutVerbatim(directive, Math.max(0, Buffer.byteLength(String(directive.verbatim || ''), 'utf8') - (measured - bodyTarget)));
    measured = compactBytes(body);
  }
  if (verbatimLost > 0) omitted.push({ field: 'directive.verbatim', priority: 'fences', title: verbatimLabel, bytes: verbatimLost, readItAt: entry.where });
  return measured;
}

// THE CEILING buildPacket CANNOT EXCEED.
//
// Runs after every collector and after the mutation-context gate, so the gate
// still judges what was actually READ rather than what survived the budget.
//
// `measuredBytes` deliberately excludes this budget block and the contentHash:
// a number that counts its own digits cannot be stated exactly, and a number
// that is nearly right is the kind of thing that gets quoted as if it were.
// The exact figure an agent pays is the RENDERED byte count, which renderPacket
// measures and prints.
function applyByteBudget(body, scope) {
  const limitBytes = renderByteLimit(scope, body.roleDefinition);
  const bodyLimitBytes = Math.max(2048, limitBytes - RENDER_FRAME_BYTES);
  const omitted = [];
  let measuredBytes = compactBytes(body);
  for (const step of BODY_TRIM_ORDER) {
    if (measuredBytes <= bodyLimitBytes) break;
    // The directive is capped at a SHARE of the budget here, ahead of the
    // coordination rosters, so that no single owner request can hold the packet
    // and leave the session blind to who else is in its files.
    if (step.directiveShare) {
      const share = Math.trunc(bodyLimitBytes * step.directiveShare);
      const held = compactBytes(body.directive);
      if (held > share) measuredBytes = shrinkDirective(body, measuredBytes - (held - share), omitted, step.title);
      continue;
    }
    const container = resolveContainer(body, step.container);
    const current = plain(container) ? container[step.key] : undefined;
    if (current === undefined || (plain(current) && current.omitted === true)) continue;
    const entry = PRIORITY_BY_ID[step.priority];
    const before = compactBytes(current);
    const marker = omissionMarker(before, entry);
    // An empty array costs fewer bytes than the marker explaining its absence.
    // Replacing it would grow the packet AND claim something was withheld when
    // nothing was -- a false alarm is its own kind of dishonesty.
    if (compactBytes(marker) >= before) continue;
    container[step.key] = marker;
    measuredBytes = compactBytes(body);
    omitted.push({
      field: step.container ? `${step.container}.${step.key}` : step.key,
      priority: step.priority,
      title: step.title,
      bytes: before,
      readItAt: entry.where
    });
  }
  if (measuredBytes > bodyLimitBytes) measuredBytes = shrinkDirective(body, bodyLimitBytes, omitted);
  body.budget = {
    scope,
    limitBytes,
    bodyLimitBytes,
    measuredBytes,
    measures: 'collected body, compact JSON, excluding this budget block and contentHash',
    complete: omitted.length === 0 && measuredBytes <= bodyLimitBytes,
    withinBodyLimit: measuredBytes <= bodyLimitBytes,
    priorityOrder: PACKET_PRIORITY.map(entry => entry.id),
    omitted
  };
  return body;
}

function buildPacket(rawInput = {}, deps = {}) {
  const input = normalizeInput(rawInput);
  const fsImpl = deps.fsImpl || fs;
  const environment = deps.environment || process.env;
  const now = Number((deps.clock || Date.now)());
  if (!Number.isFinite(now)) fail('AGENT_ONBOARDING_CLOCK_INVALID', 'clock must return epoch milliseconds.');
  const generatedAt = new Date(now).toISOString();
  const runtimeRoot = resolveRuntimeRoot(input, { ...deps, fsImpl, environment });
  const projectRoot = normalizedRoot(input.projectRoot || environment.TOOLSENABLED_PROJECT_ROOT || process.cwd(), 'projectRoot');
  const state = { fsImpl, environment, now, generatedAt, unknowns: [], mismatches: [], provenance: [], sourceStatus: Object.create(null) };
  // First, deliberately: everything collected below is read out of one of these
  // two roots, and a packet is not slightly wrong when it names the wrong tree,
  // it is about a different program.
  const tree = collectTreeIdentity(runtimeRoot, projectRoot, state);
  // Read from the runtime root -- the checkout every other value in this packet
  // was read from -- so the authorization and the tree it describes agree.
  const authorizationView = readAuthorization({ root: runtimeRoot, fsImpl });
  if (authorizationView.state !== 'AUTHORIZED') {
    state.unknowns.push({ code: 'owner-authorization-not-on-file', source: authorizationView.state });
  }
  const org = collectOrg(input, runtimeRoot, state, deps);
  const observedPresence = collectPresence(runtimeRoot, org, input, state);
  const claims = collectClaims(runtimeRoot, org, input, state, deps);
  const goals = collectGoals(runtimeRoot, input, state);
  const directive = collectDirective(runtimeRoot, input, state);
  const ownerRequests = collectOwnerRequests(runtimeRoot, input, state);
  const routes = collectRoutes(runtimeRoot, input, state, deps);
  // Rank 1, beside the tree identity and the owner authorization, and for the
  // same reason all three are pinned: each is a fact about THIS SESSION rather
  // than about the world the session is looking at. Which tree it stands in,
  // whose name it acts under, and what it can actually reach. Collected once,
  // here, and stored at the TOP LEVEL rather than inside a section, because a
  // field is only as durable as the container the budget can replace.
  const sessionFeatures = collectFeatures(runtimeRoot, state, deps);
  const recentWork = collectRecentWork(runtimeRoot, input, state, deps);
  requireLiveMutationContext(input, state, org, observedPresence, claims, directive, runtimeRoot);
  state.unknowns.push({ code: 'client-tool-advertisement-unobserved', source: 'current child/session; tool namespaces below are routes, not proof of loaded tools' });
  const body = {
    schemaVersion: SCHEMA_VERSION,
    packetVersion: PACKET_VERSION,
    generatedAt,
    scope: input.scope,
    profile: input.profile,
    contentTrust: 'mixed; owner settings/ledger plus untrusted observed runtime content',
    grantsAuthority: false,
    roots: { runtimeRoot, projectRoot },
    treeIdentity: tree,
    ownerAuthorization: authorizationProjection(authorizationView),
    sessionFeatures,
    project: gitIdentity(projectRoot, state, deps),
    session: org.session,
    roleDefinition: org.roleDefinition,
    settings: { revision: org.revision, contentHash: org.contentHash || null, enabledAssignments: org.enabled },
    directive,
    ownerRequests,
    goals,
    coordination: { presence: observedPresence, claims },
    recentWork,
    contextRoutes: routes,
    // Everything in here is a ROUTE the client may or may not honour, which is
    // what makes the whole block rank 8: without it an agent greps, and that
    // costs time rather than correctness. The feature line used to sit here too
    // and does not any more -- it was the one verified statement in a section of
    // advertisements, and it inherited the section's rank instead of its own.
    // It is `sessionFeatures` above.
    capabilities: {
      state: 'route-only-client-advertisement-unverified',
      toolNamespaces: routes.toolNamespaces,
      guide: 'Use context/toolsenabled-tools.md for names/effects; verify the current client namespace before relying on a tool.'
    },
    mismatches: state.mismatches,
    unknowns: state.unknowns,
    provenance: state.provenance
  };
  // Budget BEFORE hashing, so the hash covers what a reader actually receives:
  // a hash of the pre-trim packet would identify content nobody was given.
  applyByteBudget(body, input.scope);
  body.contentHash = sha256(`toolsenabled.agent-onboarding.v${SCHEMA_VERSION}\0${canonical(body)}`);
  return deepFreeze(body);
}

function jsonLine(label, value) {
  return `${label}: ${JSON.stringify(value)}`;
}

function treeAddressName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 120).split('"').join('').split('\n').join(' ').split('\r').join(' ');
}

/* Tree position and the local channel are prose because an agent must form the
 * intent to contact its manager before capability recall can help it. Keep the
 * first line byte-for-byte compatible with the app's anchored address parser.
 * reportsTo remains in the packet model for consumers and hashing, but is
 * removed from the rendered session JSON below: repeating the edge as a buried
 * field recreates the failure this block exists to fix. */
function treeCommsLines(session) {
  const selfName = treeAddressName(session?.agentId);
  const managerName = treeAddressName(session?.reportsTo);
  if (selfName && managerName) return [
    `Tree address: you are "${selfName}", and your manager is "${managerName}".`,
    `You can message ${managerName} directly: call agent_comms.send_local with from "${selfName}", to "${managerName}", and what you want to say. It arrives in ${managerName}'s own session and ${managerName} can answer you the same way.`,
    `That reaches ${managerName} and any agents that report to you, and nobody else. If the tool is not offered to you, this computer's permission level does not allow it -- say so rather than trying another route.`,
    `Replies come to you as new messages in this conversation. Do not call agent_comms.read to look for one -- that reads a different, cross-machine channel and will not find it. After you send, finish what you have to say and stop; ${managerName}'s reply will arrive on its own.`
  ];
  if (selfName) return [
    `If agents are started under you, you can message them and they can message you: call agent_comms.send_local with from "${selfName}", to their circle's name, and what you want to say.`,
    "Messages from them arrive as new messages in this conversation, and only between your turns. When you have nothing to do, say so briefly and stop; do not wait inside a turn. Do not call agent_comms.read to look for them; that reads a different, cross-machine channel."
  ];
  return [
    'Local agent messages use agent_comms.send_local; agent_comms.local_roster lists the manager or agents that report to you when that tool is offered.',
    'Replies arrive as new messages in this conversation. Do not call agent_comms.read for them; that reads a different, cross-machine channel.'
  ];
}

function renderedSession(session) {
  if (!plain(session)) return session;
  const { reportsTo: _reportsTo, ...rest } = session;
  return rest;
}

/* The owner's standing requests as an agent should read them: one heading,
 * one line per scope layer naming what it applies to, then each request with
 * its id and the owner's words indented under it. */
function ownerRequestLines(ownerRequests) {
  const lines = ["## Owner requests (standing; the owner's words, verbatim — obey until the owner edits or deletes them)"];
  if (!ownerRequests) {
    lines.push('OWNER REQUESTS: the ledgers could not be read this boot. Run `node tools/r-ledger.js list` before acting.');
    return lines;
  }
  let summary = `Read order: ${ownerRequests.readOrder}. ${ownerRequests.total} standing request${ownerRequests.total === 1 ? '' : 's'} across ${ownerRequests.layers.length} layer${ownerRequests.layers.length === 1 ? '' : 's'}.`;
  if (ownerRequests.withheld) summary += ` ${ownerRequests.withheld.count} withheld for space; each layer below names where to read them in full.`;
  lines.push(summary);
  for (const layer of ownerRequests.layers) lines.push(...ownerRequestLayerLines(layer));
  lines.push('File a new one: /Request <words> (global) · /RequestSession · /RequestTree · /RequestThread. Nothing here widens authority.');
  /* The same contract paragraph the product host hands its agents, chosen by
     the same module from the same settings row, so the packet and the host
     cannot tell an agent two different things about filing rules. An engine
     session here is not a confined product session, so the tools are assumed
     reachable; the gate module absent or unreadable means today's text. */
  try {
    const gate = require('./r-ledger-agent-gate');
    const decision = gate.loadAgentFilingMode();
    lines.push(gate.requestContractParagraph(decision.mode, {
      canFile: true, askWhenUnsure: decision.askWhenUnsure === true, needsApproval: decision.needsApproval === true
    }));
  } catch { /* the packet stands without it */ }
  return lines;
}

// The recent-work headline is rendered as its own prose line, so the object
// beneath it drops the duplicate. Everything else -- including the feed's own
// budget accounting and its `unknown` record -- is printed in full.
function recentWorkBody(feed) {
  if (!plain(feed) || feed.headline === undefined) return feed;
  const { headline: _headline, ...rest } = feed;
  return rest;
}

/* THE FEATURE LINE, AS PROSE, IN THE BLOCK THAT ALWAYS RENDERS.
 *
 * Same treatment as the recent-work headline and for the same reason: an agent
 * acts on what it can read at a glance, and a tag list buried in a JSON blob is
 * not read at a glance. It is stored ONCE, in `sessionFeatures`, and printed
 * once, here.
 *
 * The fallback sentence is the point of the whole rank-1 move. It says the
 * features could not be RESOLVED, which is a statement about this machine. While
 * the line lived in a rank-8 section the budget could produce that sentence from
 * a run where resolution had succeeded and only the bytes had run out -- the
 * packet lying about the world to describe its own accounting. Pinned, the
 * sentence is printed only when collectFeatures actually failed, and then it is
 * simply true. */
function featureLines(packet) {
  const features = plain(packet.sessionFeatures) ? packet.sessionFeatures : { line: null, degraded: [] };
  const lines = [typeof features.line === 'string' && features.line
    ? `FEATURES YOU HAVE: ${features.line}`
    : 'FEATURES YOU HAVE: could not be resolved this run; treat no feature as guaranteed and check before relying on one.'];
  // A degraded feature is worth its one line: an agent told a feature exists
  // will route to it, and being sent to an empty index costs the very lookup the
  // feature was supposed to save.
  for (const feature of Array.isArray(features.degraded) ? features.degraded : []) {
    lines.push(`  ${feature.id} is installed but ${feature.reason}`);
  }
  if (Number(features.degradedNotShown) > 0) {
    lines.push(`  ...and ${features.degradedNotShown} further degraded feature(s), named in `
      + 'node tools/agent-onboarding.js --json (sessionFeatures)');
  }
  return lines;
}

// The rendered byte count has to appear inside the text it is counting. Padding
// the number to a fixed width makes the line's byte length independent of the
// digits that land in it, so ONE pass produces a figure that is exactly right
// rather than a fixed point chased over several passes -- or, worse, a round
// number nobody checked.
// Seven digits covers any ceiling this module will ever hold -- the largest is
// 32,768 -- so the padded field is always exactly BYTE_FIELD_WIDTH bytes wide.
const BYTE_FIELD_WIDTH = 7;
const RENDERED_BYTES_SLOT = '#'.repeat(BYTE_FIELD_WIDTH);

function omissionNotice(entry, maximum, scope) {
  const size = Number.isFinite(entry.bytes) ? `${entry.bytes} bytes` : 'content';
  return `[OMITTED — ${entry.title}: ${size} did not fit the ${maximum}-byte onboarding budget for scope "${scope}". `
    + `You have NOT been shown this. Read it yourself: ${entry.readItAt}]`;
}

function renderPacket(packet) {
  if (!plain(packet) || packet.packetVersion !== PACKET_VERSION) fail('AGENT_ONBOARDING_PACKET_INVALID', 'packet has an unsupported version.');
  const maximum = renderByteLimit(packet.scope, packet.roleDefinition);
  const budget = plain(packet.budget) ? packet.budget : { complete: true, omitted: [] };
  const bodyOmissions = Array.isArray(budget.omitted) ? budget.omitted : [];
  const sections = [];
  // The tree headline goes in the FIRST block, not a section of its own. The
  // byte-cap loop below replaces any section that does not fit with an omission
  // marker; the one fact a session must never be silently missing is which
  // checkout it is standing in, so it rides with the header that always renders.
  const treeHeadline = Array.isArray(packet.treeIdentity?.headline) && packet.treeIdentity.headline.length
    ? packet.treeIdentity.headline
    : [treeIdentityHeadline(packet.treeIdentity?.runtime)];
  // The owner authorization rides in this same always-rendered block, for the
  // same reason as the tree headline: the byte-cap loop below replaces any
  // section that does not fit with an omission marker, and a session must never
  // silently lose either the grant or its reservations. The two facts are
  // adjacent on purpose -- this packet confers nothing, while the record is a
  // durable owner statement about whose name an action is taken under. Keeping
  // them next to each other is what stops "this snapshot grants no authority"
  // being misread as "you are not authorized".
  //
  // The feature line completes the trio, and the block now reads in the order an
  // agent needs it: which tree this is, whose name it acts under, what it can
  // actually reach. All three are bounded at collection, because nothing here is
  // trimmable and an unbounded pinned line would turn the ceiling into a wish.
  const header = [
    PACKET_BEGIN,
    jsonLine('Snapshot', { generatedAt: packet.generatedAt, scope: packet.scope, profile: packet.profile, contentHash: packet.contentHash }),
    ...treeHeadline,
    ...treeCommsLines(packet.session),
    'This read-only snapshot grants no authority. The enforced lane scope and supplied brief remain the work boundary.',
    authorizationHeadline(packet.ownerAuthorization),
    ...featureLines(packet)
  ];
  // Body-level drops are already decided by the time we render, so the warning
  // can lead rather than trail. It is stated at the top AND at the bottom on
  // purpose: an agent that reads only the first block still learns that what it
  // is holding is partial.
  if (budget.complete === false) {
    header.push(`⚠ INCOMPLETE PACKET: ${bodyOmissions.length} item(s) were dropped to stay inside the ${maximum}-byte `
      + 'onboarding budget. This is not your full context. Every drop is named in "## Onboarding budget" at the end.');
  }
  // Each section is tagged with its PACKET_PRIORITY id, and the fit loop below
  // gives sections up by RANK. Sections are still EMITTED in document order, so
  // the packet reads the same every time and a reader's eye does not have to
  // follow the budget's decisions.
  // The owner's standing requests ride INSIDE the pinned header block, and are
  // rendered as prose rather than a JSON blob: these are orders a person wrote
  // for this agent to obey, and the one thing the byte budget is never allowed
  // to drop. Rank-1 in effect, beside identity, because "what has the owner
  // told me to do, standing" is a fact about THIS agent, not about the world it
  // is looking at. Empty ledgers still print their line, so an agent knows the
  // read happened and found nothing, rather than never happened. Appended to
  // `header` itself (the renderer prints exactly one pinned block) so the bytes
  // are counted in the reserve like every other pinned line.
  header.push('', ...ownerRequestLines(packet.ownerRequests));
  sections.push({ id: 'identity', pinned: true, lines: header });
  sections.push({ id: 'fences', title: 'Session assignment and fixed role', lines: [
    '## Session assignment and fixed role',
    jsonLine('Session (settings/session overlay; holder is never hardcoded)', renderedSession(packet.session)),
    jsonLine('Fixed role definition', packet.roleDefinition),
    jsonLine('Enabled assignments from user settings', packet.settings)
  ] });
  sections.push({ id: 'fences', title: 'Project and directive', lines: [
    '## Project and directive',
    jsonLine('Resolved roots', packet.roots),
    jsonLine('Tree identity (authority: config/service-registry.json /machines)', packet.treeIdentity),
    jsonLine('Git identity measured now', packet.project),
    jsonLine('Owner directive (verbatim and gates; authoritative only within higher-priority scope)', packet.directive),
    jsonLine('Queue goals', packet.goals)
  ] });
  sections.push({ id: 'coordination', title: 'Live coordination and collision risk', lines: [
    '## Live coordination and collision risk',
    jsonLine('Observed presence', packet.coordination.presence),
    jsonLine('Active agent-coord claims', packet.coordination.claims),
    'Presence is observation; settings are declaration. Neither is acceptance or permission.'
  ] });
  // The headline is emitted as a PLAIN line above the JSON, alone among this
  // packet's sections. Every other block states facts an agent can act on at
  // leisure; this one exists to stop an action already in flight, and a warning
  // that a held fact has expired is worth nothing if it is skimmed past inside a
  // JSON blob. The rest of the feed stays in the packet's usual jsonLine form so
  // the body-versus-rendered size relationship the budget depends on still
  // holds -- one short prose line does not disturb it.
  sections.push({ id: 'recent', title: 'Recent work and what is no longer true', lines: [
    '## Recent work and what is no longer true',
    typeof packet.recentWork?.headline === 'string'
      ? packet.recentWork.headline
      : 'RECENT WORK: the feed did not run. You have no information here about what changed recently; run `node tools/recent-work.js`.',
    // ...and then WITHOUT the headline, because printing it twice would cost
    // ~200 bytes to repeat one sentence inside the object it was lifted out of.
    jsonLine('Recent work feed (mechanical; retires facts as well as adding them)', recentWorkBody(packet.recentWork))
  ] });
  // The feature line was printed here until 2026-08-13 and is now in the header
  // block above. What is left in this section is what the section is actually
  // for: routes, which are an accelerator, which is what rank 8 means.
  sections.push({ id: 'routes', title: 'System map and capabilities', lines: [
    '## System map and capabilities',
    jsonLine('Grepsaver routes', packet.contextRoutes),
    jsonLine('Capability guide', packet.capabilities)
  ] });
  sections.push({ id: 'divergence', title: 'Declared-versus-observed mismatches and explicit unknowns', lines: [
    '## Declared-versus-observed mismatches and explicit unknowns',
    jsonLine('Mismatches', packet.mismatches),
    jsonLine('Unknowns', packet.unknowns)
  ] });
  sections.push({ id: 'provenance', title: 'Provenance and freshness', lines: [
    '## Provenance and freshness',
    jsonLine('Sources', packet.provenance)
  ] });

  const optional = sections.filter(section => !section.pinned);
  const renderOmissions = [];
  const footerFor = (renderedBytesField, dropped) => {
    const total = optional.length;
    const lines = [dropped.length || bodyOmissions.length
      ? '## Onboarding budget — THIS PACKET IS INCOMPLETE'
      : '## Onboarding budget'];
    lines.push(`Budget ${maximum} bytes for scope "${packet.scope}"; rendered ${renderedBytesField} bytes. `
      + `Sections ${total - dropped.length} of ${total}. Priority order (last given up first): ${PACKET_PRIORITY.map(entry => entry.id).join(' > ')}.`);
    if (!dropped.length && !bodyOmissions.length) {
      lines.push('Nothing was dropped. If this figure starts climbing, the packet is drifting -- that is what it is here to show.');
    } else {
      lines.push('DROPPED to stay inside the budget. You were NOT shown these; do not read this packet as your full context:');
      for (const entry of bodyOmissions) {
        lines.push(`  - ${entry.title}${Number.isFinite(entry.bytes) ? ` (${entry.bytes} bytes)` : ''} — read it: ${entry.readItAt}`);
      }
      for (const entry of dropped) {
        lines.push(`  - ${entry.title} (${entry.bytes} bytes, whole section) — read it: ${entry.readItAt}`);
      }
    }
    lines.push(PACKET_END);
    return lines.join('\n');
  };

  // The footer's own size depends on how many sections were dropped, and the
  // drop decisions depend on how much room the footer leaves. Reserving the
  // WORST case (every optional section listed as dropped) breaks the circle in
  // the only direction that is safe: it can waste a few hundred bytes, never
  // overrun the ceiling.
  //
  // The reserve uses each section's REAL byte count, not a placeholder: a
  // five-digit size prints four bytes wider than a zero, and six of those is a
  // hole in the very guarantee this reserve exists to make.
  const reserved = Buffer.byteLength(`${footerFor(RENDERED_BYTES_SLOT, optional.map(section => ({
    title: section.title,
    bytes: Buffer.byteLength(section.lines.join('\n'), 'utf8'),
    readItAt: PRIORITY_BY_ID[section.id].where
  })))}\n\n`, 'utf8');
  const headerText = header.join('\n');
  let used = Buffer.byteLength(`${headerText}\n\n`, 'utf8') + reserved;
  // Ascending rank = most important first, so the cheapest thing to give up is
  // whatever is left when the room runs out. Stable within a rank: two sections
  // that share a priority keep their document order.
  const byRank = optional.map((section, index) => ({ section, index }))
    .sort((a, b) => PRIORITY_BY_ID[a.section.id].rank - PRIORITY_BY_ID[b.section.id].rank || a.index - b.index);
  const kept = new Map();
  for (const { section, index } of byRank) {
    const entry = PRIORITY_BY_ID[section.id];
    const text = section.lines.join('\n');
    const cost = Buffer.byteLength(`${text}\n\n`, 'utf8');
    if (used + cost <= maximum) {
      kept.set(index, text);
      used += cost;
      continue;
    }
    const dropEntry = { title: section.title, bytes: Buffer.byteLength(text, 'utf8'), readItAt: entry.where };
    const notice = omissionNotice({ ...dropEntry, bytes: dropEntry.bytes }, maximum, packet.scope);
    const noticeCost = Buffer.byteLength(`${notice}\n\n`, 'utf8');
    renderOmissions.push(dropEntry);
    // The marker is announced inline, in the place the section would have stood,
    // so the gap is visible while reading rather than only in the footer. If even
    // the marker will not fit, the footer still names the section: the packet
    // never loses the fact that it lost something.
    if (used + noticeCost <= maximum) {
      kept.set(index, notice);
      used += noticeCost;
    }
  }
  const ordered = optional.map((section, index) => kept.get(index)).filter(Boolean);
  const blocks = [headerText, ...ordered];
  const withoutFooter = `${blocks.join('\n\n')}\n\n`;
  const footerBase = Buffer.byteLength(withoutFooter, 'utf8')
    + Buffer.byteLength(`${footerFor('', renderOmissions)}\n`, 'utf8');
  const rendered = `${withoutFooter}${footerFor(String(footerBase + BYTE_FIELD_WIDTH).padStart(BYTE_FIELD_WIDTH), renderOmissions)}\n`;
  if (Buffer.byteLength(rendered, 'utf8') > maximum) fail('AGENT_ONBOARDING_PACKET_TOO_LARGE', `Rendered packet exceeds ${maximum} bytes.`);
  if (looksSecret(rendered)) fail('AGENT_ONBOARDING_SECRET_REJECTED', 'Rendered packet contains secret-shaped content.');
  return rendered;
}

function buildOnboardingText(input = {}, deps = {}) {
  return renderPacket(buildPacket(input, deps));
}

module.exports = Object.freeze({
  AgentOnboardingError,
  // Exported so a test can pin what this list must never reach. The list is
  // written as data precisely so the documented order and the executed order
  // cannot drift; that guarantee is only worth something if something checks it.
  BODY_TRIM_ORDER,
  MAX_RENDERED_BYTES,
  IDENTITY_BINDINGS,
  MODULE_ROOT,
  PACKET_BEGIN,
  PACKET_END,
  PACKET_PRIORITY,
  PACKET_VERSION,
  PROFILES,
  RENDER_FRAME_BYTES,
  ROLE_DEFINITIONS,
  SCHEMA_VERSION,
  SCOPES,
  SPAWN_PATH_COVERAGE,
  buildOnboardingText,
  buildPacket,
  linkedMainRoot,
  looksSecret,
  overlapPairs,
  // Exported so the scrub can be tested directly. It is the only thing standing
  // between an author-controlled commit subject and a failed session boot.
  scrubRecentWork,
  renderPacket,
  resolveRuntimeRoot
});
