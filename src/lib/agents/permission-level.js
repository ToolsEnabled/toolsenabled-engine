'use strict';

/* FLEET SETS NO PERMISSIONS. IT ONLY MAKES SURE A WORKER NEVER GETS MORE.
 *
 * The person starts their lead agent however they like -- normal mode, an
 * auto-edit mode, or with every prompt and limit off. Fleet reads which of four
 * levels that is from the lead's own command line, and every worker below it
 * starts at that level or lower (its role can lower it further):
 *
 *   1 read only   2 asks   3 edits on its own   4 everything
 *
 * "Asks" is the agent's normal mode. A worker has no one to ask, so whatever
 * would prompt is declined. When the lead's level cannot be read, Fleet uses 2:
 * it declines what would prompt and never widens.
 *
 * Lead detection reads only the command line (/proc/<pid>/cmdline), never an
 * agent's settings. A versioned binary under <command>/versions/<version> is
 * that command. Claude's session image and bg-pty-host / daemon run plumbing
 * are walked through; the level still comes only from the lead's own flags.
 * When that lead cannot be read, the level stays 2. Native tool removals may
 * preserve system settings in a private worker overlay; sign-in files are
 * never a source for that overlay. */

const fs = require('node:fs');
const path = require('node:path');

const LEVEL = Object.freeze({ READ_ONLY: 1, ASKS: 2, EDITS: 3, EVERYTHING: 4 });
const DEFAULT_LEVEL = LEVEL.ASKS;
const LEVEL_NAMES = Object.freeze({ 1: 'read only', 2: 'asks', 3: 'edits on its own', 4: 'everything' });
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3']);
// Programs that only start another program. Fleet looks through these to the
// agent that started it, and stops at anything else.
const WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'env', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'timeout', 'nice', 'setsid', 'stdbuf']);
const WRAPPER_SCRIPTS = new Set(['npx-cli.js', 'npm-cli.js', 'npx', 'npm']);
const MAX_ANCESTORS = 6;

function isLevel(value) {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** The lower of the given levels; anything that is not a level is ignored. */
function narrowest(...levels) {
  const valid = levels.filter(isLevel);
  return valid.length ? Math.min(...valid) : DEFAULT_LEVEL;
}

/** Options and flags in an argument list: `--opt value`, `--opt=value`, `--flag`. */
function parseArgv(argv, aliases = {}) {
  const options = new Map();
  const flags = new Set();
  const canonical = word => (Object.hasOwn(aliases, word) ? aliases[word] : word);
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (typeof word !== 'string' || !word.startsWith('-') || word === '-' || word === '--') continue;
    const equals = word.indexOf('=');
    if (equals > 0) {
      options.set(canonical(word.slice(0, equals)), word.slice(equals + 1));
      continue;
    }
    const name = canonical(word);
    const next = argv[index + 1];
    flags.add(name);
    if (typeof next === 'string' && !next.startsWith('-')) options.set(name, next);
  }
  return { options, flags };
}

/** The level an agent's own command line starts it at, by its descriptor's rules. */
function levelFromArgv(descriptor, argv) {
  const { options, flags } = parseArgv(argv, descriptor.permissions.aliases);
  for (const rule of descriptor.permissions.lead) {
    const matches = Object.entries(rule.when).every(([option, value]) => (value === true
      ? flags.has(option)
      : options.get(option) === value));
    if (matches) return rule.level;
  }
  return DEFAULT_LEVEL;
}

/* The executable and the arguments after it. Node heap-limit relaunches are
   skipped only for that numeric option; arbitrary arguments are not searched. */
function programToken(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { path: '', args: [] };
  const first = String(argv[0]);
  const firstBase = path.basename(first);
  let index = 1;
  if (firstBase === 'node' || firstBase === 'nodejs') {
    while (/^--max[-_]old[-_]space[-_]size=\d+$/.test(argv[index] || '')) index += 1;
    if (/^--max[-_]old[-_]space[-_]size$/.test(argv[index] || '') && /^\d+$/.test(argv[index + 1] || '')) index += 2;
  }
  if (INTERPRETERS.has(firstBase) && argv.length > index) return { path: String(argv[index]), args: argv.slice(index + 1) };
  return { path: first, args: argv.slice(1) };
}

/* Claude's native installer execs a file whose basename is the version:
   <...>/<command>/versions/<major.minor.patch>. That file is the same program
   as <command>. A basename that is not a numeric version, or a versions
   directory under any other name, is not an agent. */
function versionedCommandName(programPath) {
  if (typeof programPath !== 'string' || programPath.length === 0) return null;
  const version = path.basename(programPath);
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (path.basename(path.dirname(programPath)) !== 'versions') return null;
  const command = path.basename(path.dirname(path.dirname(programPath)));
  if (!command || command === 'versions' || command === '.' || command === '..') return null;
  return command;
}

function safeProgramName(program) {
  return typeof program === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(program) ? program : null;
}

/** Which described agent a process's argv belongs to, or null. */
function agentOfArgv(registry, argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const token = programToken(argv);
  const program = path.basename(token.path);
  const versioned = versionedCommandName(token.path);
  return registry.agents.find(agent => program === agent.command || program === `${agent.command}.js` || versioned === agent.command) || null;
}

/* An agent's own session image and internal launchers are not the lead. The
   agent's descriptor names them (permissions.leadPlumbing): subcommands that
   are background launchers, and the flag that marks a versioned binary as the
   image exec'd for a session (Claude's native install runs one with only
   --session-id). The walk continues past them to the process the person
   actually started. A versioned binary whose own flags select a level is that
   lead: an ancestor must not widen it. An agent with no declared plumbing is
   never treated as plumbing. */
function isInternalPlumbing(agent, argv) {
  const plumbing = agent && agent.permissions && agent.permissions.leadPlumbing;
  if (!plumbing) return false;
  const token = programToken(argv);
  const words = token.args.filter(word => typeof word === 'string' && !word.startsWith('-'));
  if (plumbing.subcommands.some(command => command.every((word, index) => words[index] === word))) return true;
  if (plumbing.sessionImageFlag && versionedCommandName(token.path) === agent.command
    && parseArgv(token.args, agent.permissions.aliases || {}).flags.has(plumbing.sessionImageFlag)
    && levelFromArgv(agent, token.args) === DEFAULT_LEVEL) return true;
  return false;
}

function readCmdline(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  return raw.split('\0').filter((word, index, all) => index < all.length - 1 || word !== '');
}

function readParent(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[1]);
}

function isWrapper(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const first = path.basename(String(argv[0]));
  if (WRAPPERS.has(first)) return true;
  return INTERPRETERS.has(first) && argv.length > 1 && WRAPPER_SCRIPTS.has(path.basename(String(argv[1])));
}

/* The lead agent that started this process: the parent, looking through
   launch wrappers (sh -c, env, npx, ...) and Claude's internal plumbing,
   whose program is a described agent, and the level its own flags start it
   at. Null when whatever started Fleet is not an agent (another MCP client,
   a test runner, a platform without /proc). stoppedAt names the program the
   walk could see and did not treat as a lead; it is a basename, never a path. */
function inspectLead({ registry, startPid = process.ppid, read = readCmdline, parent = readParent } = {}) {
  let pid = startPid;
  let stoppedAt = null;
  for (let step = 0; step < MAX_ANCESTORS && Number.isInteger(pid) && pid > 1; step += 1) {
    let argv;
    try { argv = read(pid); } catch {
      return { lead: null, stoppedAt: { pid, program: null, kind: 'cmdline-unreadable' } };
    }
    const agent = agentOfArgv(registry, argv);
    if (agent && !isInternalPlumbing(agent, argv)) {
      return { lead: Object.freeze({ agentId: agent.id, pid, level: levelFromArgv(agent, argv.slice(1)) }), stoppedAt: null };
    }
    const program = safeProgramName(path.basename(programToken(argv).path));
    stoppedAt = { pid, program, kind: agent ? 'internal-plumbing' : 'non-agent' };
    if (!agent && !isWrapper(argv)) return { lead: null, stoppedAt };
    try { pid = parent(pid); } catch {
      return { lead: null, stoppedAt: { pid, program, kind: 'parent-unreadable' } };
    }
  }
  return { lead: null, stoppedAt: stoppedAt ? { ...stoppedAt, kind: 'ancestor-limit' } : { pid, program: null, kind: 'ancestor-limit' } };
}

function findLead(options = {}) {
  return inspectLead(options).lead;
}

/* The level the lead runs at, for this process. A lead Fleet cannot identify is
   level 2. TOOLSENABLED_LEVEL_CAP can only lower it: an environment variable is
   never a way to widen what the lead was started with. */
function leadLevel({ registry, env = process.env, ...options } = {}) {
  const lead = findLead({ registry, ...options });
  const detected = lead ? lead.level : DEFAULT_LEVEL;
  const cap = Number(env.TOOLSENABLED_LEVEL_CAP);
  return Object.freeze({
    agentId: lead ? lead.agentId : null,
    detected,
    level: isLevel(cap) ? narrowest(detected, cap) : detected
  });
}

// Diagnostics are separate from the long-standing leadLevel return contract.
// An unknown GUI/remote parent is not proof of the default level: label the
// fallback explicitly and never manufacture a wider inherited permission.
function fallbackReason(stoppedAt) {
  if (!stoppedAt || !stoppedAt.program || stoppedAt.kind === 'cmdline-unreadable') return 'parent-cli-not-observable';
  return `stopped-at:${stoppedAt.program}`;
}

function leadPermissionContext(options = {}) {
  const inspected = inspectLead(options);
  const lead = inspected.lead;
  const detected = lead ? lead.level : DEFAULT_LEVEL;
  const cap = Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP);
  const result = { agentId: lead ? lead.agentId : null, detected,
    level: isLevel(cap) ? narrowest(detected, cap) : detected };
  return Object.freeze({ ...result,
    source: lead ? 'ancestor-cli' : 'unknown-parent-fallback',
    verifiedParent: Boolean(lead),
    permissionPolicyVerified: false,
    reason: lead ? 'level-derived-from-cli-arguments' : fallbackReason(inspected.stoppedAt),
    stoppedAtProgram: lead ? null : (inspected.stoppedAt && inspected.stoppedAt.program) || null,
    fallback: !lead,
    cap: isLevel(Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP))
      ? Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP) : null,
  });
}

/** How to start this agent as a worker at a level, from its descriptor. */
/* The exact options that start a lead at level 4, read from its own
   descriptor, for refusal text only: the lead Fleet found, or every described
   agent when it found none (another MCP client, a test runner). Fleet changes
   no option; the person restarts their own lead if they choose to. */
function noPromptsHint({ registry, lead } = {}) {
  if (!registry) return 'start your lead with its no-prompts setting';
  if (lead === undefined) lead = findLead({ registry })?.agentId || null;
  const options = agent => agent.permissions.lead.filter(rule => rule.level === 4)
    .map(rule => Object.entries(rule.when).map(([name, value]) => value === true ? name : `${name} ${value}`).join(' '));
  const agents = lead && registry.get(lead) ? [registry.get(lead)] : registry.agents;
  const named = agents.map(agent => [agent.name, options(agent)]).filter(([, rows]) => rows.length)
    .map(([name, rows]) => `${name}: ${rows.join(' or ')}`);
  return named.length ? `start your lead with its no-prompts setting (${named.join('; ')})` : 'start your lead with its no-prompts setting';
}

/** Refuse a worker below its agent's described minimum level; never widen. */
function assertWorkerLevel(descriptor, level, { registry, lead } = {}) {
  const minimum = descriptor.permissions.workerMinimum;
  if (minimum && level < minimum.level) {
    throw Object.assign(new Error(`${minimum.reason} This worker inherited level ${level} (${LEVEL_NAMES[level]}) and ${descriptor.name} workers need level ${minimum.level} (${LEVEL_NAMES[minimum.level]}), so it was not started; Fleet never widens a level. Choose another agent for this worker, or ${noPromptsHint({ registry, lead })}.`),
      { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
  }
}

function workerSettings(descriptor, level) {
  if (!isLevel(level)) throw Object.assign(new Error('A worker level must be 1 to 4.'), { code: 'AGENT_LEVEL_INVALID' });
  return descriptor.permissions.worker[level];
}

// Roles name categories, not vendor tool names. Inheritance can only add removals.
const NATIVE_TOOL_CATEGORIES = Object.freeze(['shell', 'web', 'subagents']);
function nativeToolRemovals(...lists) {
  for (const list of lists) {
    if (list !== undefined && (!Array.isArray(list) || list.some(value => !NATIVE_TOOL_CATEGORIES.includes(value)))) {
      throw Object.assign(new Error('removeNativeTools must contain only shell, web or subagents.'), { code: 'AGENT_NATIVE_TOOLS_INVALID' });
    }
  }
  return Object.freeze(NATIVE_TOOL_CATEGORIES.filter(category => lists.some(list => list?.includes(category))));
}

function nativeRemovalSettings(descriptor, removals = []) {
  // Native delegation is never a role choice: only Fleet may grow the tree.
  const categories = nativeToolRemovals(removals, ['subagents']);
  const args = [], overrides = {}, rejectKinds = [], settings = [];
  let env = {};
  for (const category of categories) {
    const removal = descriptor.permissions.remove?.[category];
    if (!removal || removal.unavailable) throw Object.assign(new Error(`${descriptor.name} cannot remove native ${category} tools, so this worker was not started.${removal?.unavailable ? ` ${removal.unavailable}` : ''}`),
      { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
    args.push(...(removal.args || []));
    for (const [key, value] of Object.entries(removal.overrides || {})) {
      if (Object.hasOwn(overrides, key) && overrides[key] !== value) {
        throw Object.assign(new Error(`${descriptor.name} has conflicting native ${category} removals, so this worker was not started.`),
          { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
      }
      overrides[key] = value;
    }
    rejectKinds.push(...(removal.rejectKinds || []));
    env = require('./native-removal-environment').mergeRemovalEnvironment(env, removal.env || {});
    if (removal.settings) settings.push(removal.settings);
  }
  return Object.freeze({ args: Object.freeze(args), overrides: Object.freeze(overrides),
    ...(descriptor.permissions.workerAgent ? { workerAgent: descriptor.permissions.workerAgent } : {}),
    env: Object.freeze(env), settings: Object.freeze(settings), rejectKinds: Object.freeze([...new Set(rejectKinds)]) });
}

module.exports = Object.freeze({
  LEVEL, LEVEL_NAMES, DEFAULT_LEVEL, isLevel, narrowest,
  NATIVE_TOOL_CATEGORIES, nativeToolRemovals, nativeRemovalSettings,
  parseArgv, levelFromArgv, agentOfArgv, findLead, leadLevel, leadPermissionContext, workerSettings, assertWorkerLevel, noPromptsHint
});
