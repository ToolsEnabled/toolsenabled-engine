'use strict';

// Pure, append-only lifecycle model for owner directives (R*) and queue
// phases (Q*).  It deliberately has no filesystem dependency: capture and
// queue writing remain the existing system's jobs.  A caller supplies the
// immutable historical records; this module only derives lineage and leaves.

const {
  normalizeScopeRule,
  resolveScopeRules
} = require('../owner-request-scope');
const {
  REQUEST_ID_RE,
  parseRequestId,
  isRequestId
} = require('../request-id');

const RULE_KEY_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const KINDS = Object.freeze(['request', 'phase']);
const builtChains = new WeakSet();

class VersionChainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VersionChainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new VersionChainError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, allowed, required, label) {
  if (!plain(value)
      || Reflect.ownKeys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    fail('VERSION_ENTRY_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    fail('VERSION_ENTRY_INVALID', `${label} must be text.`);
  }
  // Do not trim, normalize, or otherwise rewrite this string.  In particular,
  // verbatim owner text is intentionally returned byte-for-byte as supplied.
  return value;
}

function parseVersionId(value, label = 'version id') {
  const parsed = parseRequestId(value);
  if (!parsed) fail('VERSION_ID_INVALID', `${label} "${value}" is invalid.`);
  return parsed;
}

function assertKindMatchesId(kind, parsed, id) {
  const expectedFamily = kind === 'request' ? 'R' : 'Q';
  if (!KINDS.includes(kind) || parsed.family !== expectedFamily) {
    fail('VERSION_KIND_MISMATCH', `${id} does not match kind "${kind}".`, { id, kind });
  }
}

function normalizeParentIds(value, id) {
  if (!Array.isArray(value) || value.length > 32) {
    fail('VERSION_PARENTS_INVALID', `${id} parents are invalid.`);
  }
  const seen = new Set();
  const parents = value.map(parentId => {
    const parsed = parseVersionId(parentId, `${id} parent id`);
    if (seen.has(parsed.id)) fail('VERSION_PARENTS_INVALID', `${id} names a parent more than once.`);
    seen.add(parsed.id);
    return parsed.id;
  });
  return Object.freeze(parents);
}

function normalizeSupersession(value, id, hasParents) {
  if (!hasParents) {
    if (value !== null && value !== undefined) {
      fail('VERSION_ROOT_SUPERSESSION_INVALID', `${id} is a root and cannot carry supersession provenance.`);
    }
    return null;
  }
  exact(value, ['kind', 'actor', 'recorded', 'directiveId', 'directiveVerbatim'],
    ['kind', 'actor', 'recorded', 'directiveId', 'directiveVerbatim'], `${id} supersession`);
  if (value.actor !== 'owner') {
    // This deliberately has its own error code: a caller cannot downgrade an
    // agent-authored amendment into ordinary malformed data.
    fail('VERSION_AGENT_SUPERSESSION_REFUSED', `${id} may be superseded only by a recorded owner directive.`, { id, actor: value.actor });
  }
  if (value.kind !== 'owner-directive' || value.recorded !== true) {
    fail('VERSION_OWNER_DIRECTIVE_REQUIRED', `${id} supersession must name a recorded owner directive.`, { id });
  }
  if (!isRequestId(value.directiveId, { family: 'R' })) {
    fail('VERSION_OWNER_DIRECTIVE_REQUIRED', `${id} supersession directiveId is invalid.`, { id });
  }
  return Object.freeze({
    kind: 'owner-directive',
    actor: 'owner',
    recorded: true,
    directiveId: value.directiveId,
    directiveVerbatim: exactText(value.directiveVerbatim, `${id} supersession directiveVerbatim`)
  });
}

function normalizeClauses(value, id) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 2000) {
    fail('VERSION_CLAUSES_INVALID', `${id} clauses are invalid.`);
  }
  const seen = new Set();
  const clauses = value.map(raw => {
    const clause = normalizeScopeRule(raw);
    if (seen.has(clause.ruleId)) {
      fail('VERSION_CLAUSES_INVALID', `${id} has duplicate clause ruleId "${clause.ruleId}".`);
    }
    seen.add(clause.ruleId);
    return clause;
  });
  return Object.freeze(clauses);
}

function normalizeEntry(value) {
  exact(value, ['id', 'kind', 'verbatim', 'parents', 'supersession', 'clauses'],
    ['id', 'kind', 'verbatim', 'parents'], 'version entry');
  const parsed = parseVersionId(value.id);
  assertKindMatchesId(value.kind, parsed, value.id);
  const parents = normalizeParentIds(value.parents, value.id);
  const isRoot = parsed.segments.length === 0;
  if (isRoot && parents.length !== 0) {
    fail('VERSION_ROOT_PARENTS_INVALID', `${value.id} is a root and cannot have parents.`);
  }
  if (!isRoot && parents.length === 0) {
    fail('VERSION_UNPARENTED_DESCENDANT', `${value.id} is a version but has no real parent.`, { id: value.id });
  }
  const supersession = normalizeSupersession(value.supersession, value.id, parents.length > 0);
  const clauses = normalizeClauses(value.clauses, value.id);
  if (supersession && clauses.some(clause => clause.sourceRequestId !== supersession.directiveId)) {
    fail('VERSION_CLAUSE_PROVENANCE_INVALID', `${value.id} clauses must come from its owner supersession directive.`, { id: value.id });
  }
  return Object.freeze({
    id: parsed.id,
    kind: value.kind,
    verbatim: exactText(value.verbatim, `${value.id} verbatim`),
    parents,
    supersession,
    clauses
  });
}

function assertNoCycles(entriesById) {
  const state = new Map();
  for (const id of entriesById.keys()) {
    if (state.get(id) === 'done') continue;
    const stack = [{ id, nextParent: 0 }];
    state.set(id, 'visiting');
    while (stack.length > 0) {
      const frame = stack.at(-1);
      const parents = entriesById.get(frame.id).parents;
      if (frame.nextParent >= parents.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const parentId = parents[frame.nextParent];
      frame.nextParent += 1;
      const parentState = state.get(parentId);
      if (parentState === 'visiting') fail('VERSION_CYCLE_REFUSED', `Cycle detected at ${parentId}.`, { id: parentId });
      if (parentState !== 'done') {
        state.set(parentId, 'visiting');
        stack.push({ id: parentId, nextParent: 0 });
      }
    }
  }
}

function assertVersionDescendsFromParents(entry, entriesById) {
  if (entry.parents.length === 0) return;
  const child = parseVersionId(entry.id);
  const parents = entry.parents.map(parentId => entriesById.get(parentId));
  for (const parent of parents) {
    if (!parent) fail('VERSION_PARENT_NOT_FOUND', `${entry.id} names missing parent "${parent}".`, { id: entry.id });
    if (parent.kind !== entry.kind) {
      fail('VERSION_PARENT_KIND_MISMATCH', `${entry.id} cannot supersede a ${parent.kind}.`, { id: entry.id, parentId: parent.id });
    }
    const parsedParent = parseVersionId(parent.id);
    if (parsedParent.root !== child.root) {
      fail('VERSION_PARENT_ROOT_MISMATCH', `${entry.id} must remain anchored on ${child.root}.`, { id: entry.id, parentId: parent.id });
    }
  }
  if (entry.parents.length === 1) {
    const parentId = entry.parents[0];
    if (!entry.id.startsWith(`${parentId}.`)) {
      fail('VERSION_DESCENDANT_INVALID', `${entry.id} does not descend from real parent ${parentId}.`, { id: entry.id, parentId });
    }
    return;
  }

  // A merge's dotted suffix names each immediate parent branch.  For example,
  // R40.2 + R40.3 may produce R40.2.3.  The common root is verified above;
  // every parent terminal component must also appear in the new id.
  const childComponents = new Set(child.segments.map(String));
  for (const parent of parents) {
    const terminal = String(parseVersionId(parent.id).segments.at(-1));
    if (!childComponents.has(terminal)) {
      fail('VERSION_MERGE_ID_INVALID', `${entry.id} does not name merge parent ${parent.id}.`, { id: entry.id, parentId: parent.id });
    }
  }
}

function uniqueRules(rules) {
  const byId = new Map();
  for (const rule of rules) {
    const existing = byId.get(rule.ruleId);
    if (!existing) {
      byId.set(rule.ruleId, rule);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(rule)) {
      fail('VERSION_CLAUSE_DUPLICATE_AMBIGUOUS', `Rule ${rule.ruleId} has two different historical records.`, { ruleId: rule.ruleId });
    }
  }
  return [...byId.values()];
}

function normalizeResolutionOptions(value = {}) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['threadId', 'nowMs'].includes(key))) {
    fail('VERSION_RESOLUTION_OPTIONS_INVALID', 'Resolution options are invalid.');
  }
  return value;
}

function buildVersionChain(values) {
  if (!Array.isArray(values) || values.length > 10_000) {
    fail('VERSION_CHAIN_INVALID', 'A version chain must be an array of at most 10,000 entries.');
  }
  const entries = values.map(normalizeEntry);
  const entriesById = new Map();
  for (const entry of entries) {
    if (entriesById.has(entry.id)) fail('VERSION_ID_DUPLICATE', `Duplicate version id ${entry.id}.`, { id: entry.id });
    entriesById.set(entry.id, entry);
  }
  for (const entry of entries) {
    for (const parentId of entry.parents) {
      if (!entriesById.has(parentId)) {
        fail('VERSION_PARENT_NOT_FOUND', `${entry.id} names missing parent ${parentId}.`, { id: entry.id, parentId });
      }
    }
  }
  assertNoCycles(entriesById);
  for (const entry of entries) assertVersionDescendsFromParents(entry, entriesById);

  const childrenById = new Map(entries.map(entry => [entry.id, []]));
  for (const entry of entries) {
    for (const parentId of entry.parents) childrenById.get(parentId).push(entry.id);
  }
  for (const children of childrenById.values()) children.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const requireEntry = id => {
    if (typeof id !== 'string' || !entriesById.has(id)) {
      fail('VERSION_NOT_FOUND', `Unknown version id "${id}".`, { id });
    }
    return entriesById.get(id);
  };

  const effectiveResolution = (id, options = {}) => {
    normalizeResolutionOptions(options);
    requireEntry(id);
    const memo = new Map();
    const stack = [{ id, expanded: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (memo.has(frame.id)) continue;
      const entry = entriesById.get(frame.id);
      if (!frame.expanded) {
        stack.push({ id: frame.id, expanded: true });
        for (let index = entry.parents.length - 1; index >= 0; index -= 1) {
          const parentId = entry.parents[index];
          if (!memo.has(parentId)) stack.push({ id: parentId, expanded: false });
        }
        continue;
      }
      const inherited = entry.parents.flatMap(parentId => memo.get(parentId).rules);
      memo.set(frame.id, resolveScopeRules(uniqueRules([...inherited, ...entry.clauses]), options));
    }
    return memo.get(id);
  };

  const active = Object.freeze(entries.filter(entry => childrenById.get(entry.id).length === 0));
  const chain = {
    schemaVersion: 1,
    entries: Object.freeze(entries),
    // This is constructed once from the graph's outgoing edges.  There is no
    // caller-provided include/exclude option, so a superseded record cannot
    // appear accidentally in this projection.
    active,
    getSupersededBy(id, { transitive = false } = {}) {
      requireEntry(id);
      if (typeof transitive !== 'boolean') fail('VERSION_QUERY_INVALID', 'transitive must be boolean.');
      if (!transitive) return Object.freeze(childrenById.get(id).map(childId => entriesById.get(childId)));
      const result = [];
      const stack = [...childrenById.get(id)].reverse();
      while (stack.length > 0) {
        const childId = stack.pop();
        result.push(entriesById.get(childId));
        stack.push(...[...childrenById.get(childId)].reverse());
      }
      return Object.freeze(result);
    },
    getSupersedes(id, { transitive = false } = {}) {
      const entry = requireEntry(id);
      if (typeof transitive !== 'boolean') fail('VERSION_QUERY_INVALID', 'transitive must be boolean.');
      if (!transitive) return Object.freeze(entry.parents.map(parentId => entriesById.get(parentId)));
      const result = [];
      const stack = [...entry.parents].reverse();
      while (stack.length > 0) {
        const parentId = stack.pop();
        result.push(entriesById.get(parentId));
        stack.push(...[...entriesById.get(parentId).parents].reverse());
      }
      return Object.freeze(result);
    },
    resolveClauses(id, options = {}) {
      return effectiveResolution(id, options);
    },
    mergeProvenance(id, options = {}) {
      const entry = requireEntry(id);
      if (entry.parents.length < 2) fail('VERSION_NOT_A_MERGE', `${id} is not a merge.`);
      const resolution = effectiveResolution(id, options);
      const winningRuleIds = new Set(resolution.rules.map(rule => rule.ruleId));
      const parents = entry.parents.map(parentId => {
        const parent = entriesById.get(parentId);
        const parentResolution = effectiveResolution(parentId, options);
        return Object.freeze({
          id: parent.id,
          // The parent text is carried as the original string, never generated
          // from an interpretation or a normalized version.
          verbatim: parent.verbatim,
          contributedRuleIds: Object.freeze(parentResolution.rules
            .filter(rule => winningRuleIds.has(rule.ruleId))
            .map(rule => rule.ruleId))
        });
      });
      return Object.freeze({
        id: entry.id,
        ownerDirective: entry.supersession,
        parents: Object.freeze(parents),
        resolution
      });
    }
  };
  Object.freeze(chain);
  builtChains.add(chain);
  return chain;
}

function activeView(chain) {
  if (!plain(chain) || !builtChains.has(chain)) fail('VERSION_CHAIN_REQUIRED', 'A version chain is required.');
  // Do not accept arbitrary records or a filter predicate.  The only source is
  // buildVersionChain()'s leaf projection.
  return chain.active;
}

function activePhaseView(chain, queueProjection) {
  if (!plain(queueProjection) || !Array.isArray(queueProjection.completedIds)) {
    fail('VERSION_QUEUE_PROJECTION_INVALID', 'Queue completedIds from the existing queue projection are required.');
  }
  const completedIds = new Set(queueProjection.completedIds.map(id => {
    const parsed = parseVersionId(id, 'completed phase id');
    if (parsed.family !== 'Q') fail('VERSION_QUEUE_PROJECTION_INVALID', `Completed phase id "${id}" must be a Q id.`, { id });
    return parsed.id;
  }));
  return Object.freeze(activeView(chain)
    .filter(entry => entry.kind === 'phase' && !completedIds.has(entry.id)));
}

function nextSimpleVersionId(parentId, occupiedIds) {
  parseVersionId(parentId, 'parent id');
  const prefix = `${parentId}.`;
  let greatest = 0n;
  for (const candidateId of occupiedIds) {
    parseVersionId(candidateId, 'candidate id');
    if (!candidateId.startsWith(prefix)) continue;
    const nextSegment = candidateId.slice(prefix.length).split('.', 1)[0];
    const numericSegment = BigInt(nextSegment);
    if (numericSegment > greatest) greatest = numericSegment;
  }
  return `${parentId}.${greatest + 1n}`;
}

function normalizeMigrationEntry(value) {
  exact(value, ['id', 'verbatim', 'ruleKey', 'amends'], ['id', 'verbatim'], 'migration entry');
  const parsed = parseVersionId(value.id, 'migration entry id');
  if (parsed.family !== 'R') {
    fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} must be an owner request id.`);
  }
  let ruleKey = null;
  if (value.ruleKey !== undefined) {
    if (typeof value.ruleKey !== 'string' || !RULE_KEY_RE.test(value.ruleKey)) {
      fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} ruleKey is invalid.`);
    }
    ruleKey = value.ruleKey;
  }
  let amends = Object.freeze([]);
  if (value.amends !== undefined) {
    if (!Array.isArray(value.amends) || value.amends.length === 0 || value.amends.length > 32) {
      fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} amends is invalid.`);
    }
    const unique = new Set();
    amends = Object.freeze(value.amends.map(parentId => {
      if (!isRequestId(parentId, { family: 'R' })) {
        fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} amends contains an invalid request id.`);
      }
      if (unique.has(parentId)) fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} amends contains a duplicate parent.`);
      if (parentId === parsed.id) fail('VERSION_MIGRATION_ENTRY_INVALID', `${value.id} cannot amend itself.`);
      unique.add(parentId);
      return parentId;
    }));
  }
  return Object.freeze({ id: parsed.id, verbatim: exactText(value.verbatim, `${value.id} verbatim`), ruleKey, amends });
}

/**
 * Produce a reviewable proposal only.  It never writes a ledger, alters the
 * supplied array, or changes any entry object. A migration proposal is created
 * only from explicit `amends` links in the supplied, current ledger. Request
 * numbers and rule labels never confer authority by themselves.
 */
function migrationPlan(values) {
  if (!Array.isArray(values) || values.length > 10_000) {
    fail('VERSION_MIGRATION_INPUT_INVALID', 'Migration input must be an array of at most 10,000 entries.');
  }
  const entries = values.map(normalizeMigrationEntry);
  const byId = new Map();
  for (const entry of entries) {
    if (byId.has(entry.id)) fail('VERSION_MIGRATION_ENTRY_DUPLICATE', `Duplicate migration entry ${entry.id}.`);
    byId.set(entry.id, entry);
  }
  const occupiedIds = new Set(entries.map(entry => entry.id));
  const proposals = [];
  const unresolved = [];
  for (const amendment of entries) {
    const parentIds = [...amendment.amends];
    const reason = parentIds.length ? 'explicit-amends' : null;
    if (parentIds.length === 0) continue;
    const missing = parentIds.filter(parentId => !byId.has(parentId));
    if (missing.length) {
      unresolved.push(Object.freeze({ directiveId: amendment.id, reason: 'parent-not-supplied', parentIds: Object.freeze([...missing]) }));
      continue;
    }
    if (parentIds.length !== 1) {
      // A historical merge needs an explicit human/controller choice of the
      // merge identifier.  Do not guess at it from old records.
      unresolved.push(Object.freeze({ directiveId: amendment.id, reason: 'merge-requires-human-disposition', parentIds: Object.freeze([...parentIds]) }));
      continue;
    }
    const parentId = parentIds[0];
    const proposedId = nextSimpleVersionId(parentId, occupiedIds);
    occupiedIds.add(proposedId);
    proposals.push(Object.freeze({
      type: 'supersession-proposal',
      proposedId,
      parentIds: Object.freeze([parentId]),
      ownerDirective: Object.freeze({
        kind: 'owner-directive',
        actor: 'owner',
        recorded: true,
        directiveId: amendment.id,
        directiveVerbatim: amendment.verbatim
      }),
      verbatim: amendment.verbatim,
      reason
    }));
  }
  return Object.freeze({
    schemaVersion: 1,
    appliesChanges: false,
    proposals: Object.freeze(proposals),
    unresolved: Object.freeze(unresolved)
  });
}

module.exports = Object.freeze({
  VersionChainError,
  VERSION_ID_RE: REQUEST_ID_RE,
  buildVersionChain,
  activeView,
  activePhaseView,
  migrationPlan
});
