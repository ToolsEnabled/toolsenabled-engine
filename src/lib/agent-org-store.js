'use strict';

// THE FIRST WRITER OF DECLARED ORG STATE.
//
// Until this file existed the declared organisation was read-only end to end.
// config/agent-org.json was authored by hand in the builder's own checkout,
// tools/gen-fleet.mjs read it at BUILD time and emitted a static projection,
// and the application read that projection over its loopback server. Every
// consumer in src/lib was a reader. So the drag-to-reparent control on the
// agent page wrote `agent.parentId` on an object that the next projection load
// rebuilt from JSON, and the edit vanished with no error -- the control looked
// like it worked and could not have worked.
//
// WHAT THIS MODULE DOES NOT DO, AND WHY THAT MATTERS MORE THAN WHAT IT DOES.
//
// It does not implement a second organisation model. Every mutation here is
// applied to a plain object and handed to agentOrg.normalizeOrg(), which is
// what decides whether the result is legal. That is deliberate: agent-org.js
// already refuses a management cycle, an agent with two managers, a relationship
// naming an agent that does not exist, and an org without exactly one
// controller. Re-deriving any of those here would be a fourth copy of a rule
// that already has three (the graph's hover guard, the projection's commit
// guard, and the normalizer), and the copy would be the one that drifts.
//
// A REPARENT IS A RELATIONSHIP EDIT, NOT A FIELD EDIT. The page's model gives
// each agent a `parentId`, which is a convenient shape for drawing a tree. The
// declared org has never had that field. It expresses hierarchy as
// `{ from, to, type: 'manages' }` edges, because an org needs to say more than
// parentage -- it also carries `reviews`, `delegates_to` and `escalates_to`,
// and an agent can have several of those while having exactly one manager. So
// reparenting removes the incoming `manages` edge and adds one from the new
// parent, and leaves every other edge alone.
//
// WHERE THE EDIT LIVES. Not in config/agent-org.json. In a packaged install
// that file is inside the payload, it is replaced wholesale at pack time by
// capability-defaults/config/agent-org.json, and it is loaded through
// require(), which caches -- so writing it would be edited-in-place data that
// the packaging guard is trying to keep clean, discarded on the next update,
// and not visible to the running process anyway. The overlay lives in
// %LOCALAPPDATA%\ToolsEnabled, next to machine.json and the settings file.
//
// THE BASELINE IS STILL READ. An installation that has never been edited has no
// overlay, and reads the shipped default. The first edit seeds the overlay from
// whatever the baseline said at that moment, and records the baseline's
// contentHash alongside it. That recorded hash is not decoration: it is how a
// later version can TELL that the shipped default has moved on underneath an
// operator's edits, and say so, rather than silently keeping stale seats or
// silently discarding the operator's work.

const fs = require('node:fs');
const path = require('node:path');
const agentOrg = require('./agent-org');
const { resolveServicesRoot } = require('./durable-memory-file');

const SCHEMA_VERSION = 1;
const OVERLAY_FILE = 'agent-org.json';
const MAX_RECORD_BYTES = 1024 * 1024;

class AgentOrgStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentOrgStoreError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new AgentOrgStoreError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A mutable deep copy, so a caller can never edit a frozen normalised org. */
function mutableOrg(org) {
  return {
    schemaVersion: agentOrg.SCHEMA_VERSION,
    revision: org.revision,
    agents: org.agents.map(agent => ({
      id: agent.id,
      displayName: agent.displayName,
      role: agent.role,
      ...(agent.roleSelection === '' ? { roleSelection: '' } : {}),
      provider: agent.provider,
      enabled: agent.enabled,
      assignedPhase: agent.assignedPhase,
      phasePriority: [...agent.phasePriority],
      nodeId: agent.nodeId ?? null,
      ...(agent.scopeActivation ? { scopeActivation: { ...agent.scopeActivation } } : {})
    })),
    relationships: org.relationships.map(relation => ({ ...relation }))
  };
}

/**
 * Persist a JSON document the way renderer-prefs.cjs does: write a uniquely
 * named temporary in the same directory, fsync it, then rename over the target.
 * The rename is what makes a reader see either the old document or the new one
 * and never a half-written one.
 */
function writeAtomic(fileSystem, target, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    fail('AGENT_ORG_STORE_TOO_LARGE', 'The declared org would exceed its size limit.');
  }
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${OVERLAY_FILE}-${process.pid}-${Date.now()}.tmp`);
  let descriptor;
  try {
    fileSystem.mkdirSync(directory, { recursive: true });
    descriptor = fileSystem.openSync(temporary, 'wx');
    fileSystem.writeFileSync(descriptor, text, 'utf8');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporary, target);
  } catch (error) {
    fail('AGENT_ORG_STORE_WRITE_FAILED', `The declared org could not be saved (${error && error.code ? error.code : 'unknown error'}).`);
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch { /* closing a failed handle */ }
    }
    try { fileSystem.unlinkSync(temporary); } catch { /* already renamed away */ }
  }
}

/**
 * The declared-org store.
 *
 * `baselineFile` is the shipped default (config/agent-org.json). `overlayFile`
 * defaults to the installation's own directory. `customRoles` is an optional
 * object exposing listRoles(), which is how operator-defined roles become part
 * of the vocabulary this store will accept -- see knownRoles() below.
 */
function createAgentOrgStore({
  baselineFile,
  overlayFile,
  customRoles = null,
  env = process.env,
  fileSystem = fs
} = {}) {
  if (typeof baselineFile !== 'string' || baselineFile.length === 0) {
    fail('AGENT_ORG_STORE_INVALID', 'createAgentOrgStore requires the path of the shipped baseline org.');
  }
  const overlayPath = overlayFile || path.join(resolveServicesRoot({ env }), OVERLAY_FILE);

  function readJson(file) {
    let text;
    try {
      text = fileSystem.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { present: false, value: null, damaged: null };
      return { present: true, value: null, damaged: `could not be read (${error && error.code ? error.code : 'unknown error'})` };
    }
    try {
      return { present: true, value: JSON.parse(text), damaged: null };
    } catch {
      return { present: true, value: null, damaged: 'contains malformed JSON' };
    }
  }

  /**
   * The authoritative role vocabulary this store will accept. All definitions
   * are projected because an operator may edit a shipped default's workflow
   * capabilities as well as create a custom role. normalizeOrg still supplies
   * the shipped defaults when no role store is present.
   *
   * A custom-role store that throws is NOT treated as "there are no custom
   * roles". Doing so would silently invalidate every agent already holding one
   * and, because normalizeOrg refuses an unknown role, would present the
   * operator's whole org as corrupt. The error is raised instead.
   */
  function roleDefinitions() {
    if (!customRoles || typeof customRoles.listRoles !== 'function') return [];
    return customRoles.listRoles();
  }

  function knownRoles(definitions = roleDefinitions()) {
    return definitions
      .map(role => ({
        id: role.id,
        baseDefaultRole: role.baseDefaultRole ?? null,
        capabilities: role.capabilities
      }));
  }

  function normalize(document, definitions, maxAgents = 0) {
    return agentOrg.normalizeOrg(document, { knownRoles: knownRoles(definitions), maxAgents });
  }

  function readBaseline(definitions = roleDefinitions()) {
    const baseline = readJson(baselineFile);
    if (!baseline.present) {
      fail('AGENT_ORG_STORE_NO_BASELINE', `The shipped declared org is missing at ${baselineFile}.`, { baselineFile });
    }
    if (baseline.damaged) {
      fail('AGENT_ORG_STORE_BASELINE_DAMAGED', `The shipped declared org ${baseline.damaged}.`, { baselineFile });
    }
    return normalize(baseline.value, definitions);
  }

  return {
    baselineFile,
    overlayFile: overlayPath,

    /**
     * The org this installation is actually operating under, plus where it came
     * from. `source` is 'overlay' when the operator has edited, 'baseline' when
     * they have not -- a caller that wants to show "you have local changes" asks
     * this rather than diffing.
     *
     * A damaged overlay does not silently fall back to the baseline: falling
     * back would present the shipped default as though it were the operator's
     * org, and the next write would flatten edits that are still on disk. The
     * baseline is returned so the application still opens, and `damaged` says
     * why, so the surface can tell the operator their edits are not being shown.
     */
    read({ roleDefinitions: definitions = roleDefinitions() } = {}) {
      const overlay = readJson(overlayPath);
      if (!overlay.present) {
        return Object.freeze({ org: readBaseline(definitions), source: 'baseline', damaged: null, baselineDrift: null });
      }
      if (overlay.damaged) {
        return Object.freeze({ org: readBaseline(definitions), source: 'baseline', damaged: `the saved organisation ${overlay.damaged}`, baselineDrift: null });
      }
      const stored = overlay.value;
      if (!plain(stored) || stored.schemaVersion !== SCHEMA_VERSION || !plain(stored.org)) {
        return Object.freeze({
          org: readBaseline(definitions),
          source: 'baseline',
          damaged: 'the saved organisation is in a format this build does not understand',
          baselineDrift: null
        });
      }
      let org;
      try {
        org = normalize(stored.org, definitions);
      } catch (error) {
        // The saved org no longer validates. The commonest real cause is a
        // custom role that was deleted while agents still held it. Say that
        // rather than showing the shipped default as if nothing happened.
        return Object.freeze({
          org: readBaseline(definitions),
          source: 'baseline',
          damaged: `the saved organisation is no longer valid: ${error.message}`,
          baselineDrift: null
        });
      }
      // Did the shipped default move underneath these edits? Reported, never
      // acted on: silently adopting the new baseline would discard the
      // operator's work, and silently ignoring it would hide seats a product
      // update added.
      let baselineDrift = null;
      // Drift is a comparison, so an unreadable baseline is not evidence of
      // "no drift". Refuse the read rather than returning a definite null for
      // a comparison that could not be performed.
      const baseline = readBaseline(definitions);
      if (stored.baselineContentHash && stored.baselineContentHash !== baseline.contentHash) {
        baselineDrift = Object.freeze({
          seededFrom: stored.baselineContentHash,
          shippedNow: baseline.contentHash
        });
      }
      return Object.freeze({ org, source: 'overlay', damaged: null, baselineDrift });
    },

    /** The shipped default, ignoring any local edit. */
    baseline() {
      const definitions = roleDefinitions();
      return readBaseline(definitions);
    },

    /**
     * Replace the whole declared org. Every named mutation below funnels here,
     * so validation, revision bumping and the atomic write exist once.
     *
     * `expectedRevision` is optimistic concurrency against two windows editing
     * at the same time. Undefined skips the check; a caller that read first
     * should pass what it read.
     */
    write(document, { expectedRevision } = {}) {
      const definitions = roleDefinitions();
      const current = this.read({ roleDefinitions: definitions });
      if (expectedRevision !== undefined && expectedRevision !== current.org.revision) {
        fail('AGENT_ORG_STORE_REVISION_CONFLICT',
          `The declared org changed since it was read (expected revision ${expectedRevision}, found ${current.org.revision}).`,
          { expectedRevision, actualRevision: current.org.revision });
      }
      if (current.damaged) {
        fail('AGENT_ORG_STORE_DAMAGED', `Refusing to overwrite an organisation that could not be read: ${current.damaged}`);
      }
      const configuredLimit = agentOrg.resolveMaxAgents({ env, fileSystem });
      // Lowering the admission bound never erases or prevents repairing an
      // existing organisation. Growth still stops until it is below the bound.
      const admittedLimit = configuredLimit === null ? 0 : Math.max(configuredLimit, current.org.agents.length);
      const next = normalize({ ...document, revision: current.org.revision + 1 }, definitions, admittedLimit);
      // A write without a readable baseline cannot truthfully record what the
      // overlay was seeded from. Refuse instead of persisting a null hash that
      // would make future drift checks silently inconclusive.
      const baselineHash = readBaseline(definitions).contentHash;
      writeAtomic(fileSystem, overlayPath, {
        schemaVersion: SCHEMA_VERSION,
        // Recorded at the moment of the first write and carried forward, so
        // `baselineDrift` compares against what was actually seeded, not
        // against whatever shipped most recently.
        baselineContentHash: (() => {
          const overlay = readJson(overlayPath);
          const previous = overlay.present && plain(overlay.value) ? overlay.value.baselineContentHash : null;
          return previous || baselineHash;
        })(),
        savedAt: new Date().toISOString(),
        org: mutableOrg(next)
      });
      return Object.freeze({ org: next, overlayFile: overlayPath });
    },

    /**
     * Move an agent under a new manager, or to the root with a null parent.
     *
     * The cycle check is normalizeOrg's, not a new one. Refusing to reparent
     * the role-defined root is this module's own rule and is about accountability
     * rather than graph shape: that seat is the single accountable root,
     * and an org whose root reports to one of its own reports has no root even
     * though the edges technically form a tree.
     */
    reparent({ agentId, parentId }, options = {}) {
      const { org } = this.read();
      const agent = org.agents.find(entry => entry.id === agentId);
      if (!agent) fail('AGENT_ORG_STORE_UNKNOWN_AGENT', `No agent "${agentId}" in the declared org.`, { agentId });
      if (agentOrg.roleHasCapability(org, agent.role, 'orgRoot')) {
        fail('AGENT_ORG_STORE_CONTROLLER_ROOTED', 'The organisation root cannot report to another agent.', { agentId });
      }
      if (parentId !== null && parentId !== undefined) {
        if (!org.agents.some(entry => entry.id === parentId)) {
          fail('AGENT_ORG_STORE_UNKNOWN_AGENT', `No agent "${parentId}" in the declared org.`, { agentId: parentId });
        }
        if (parentId === agentId) {
          fail('AGENT_ORG_STORE_SELF_PARENT', 'An agent cannot manage itself.', { agentId });
        }
      }
      const document = mutableOrg(org);
      document.relationships = document.relationships.filter(
        relation => !(relation.type === 'manages' && relation.to === agentId)
      );
      if (parentId !== null && parentId !== undefined) {
        document.relationships.push({ from: parentId, to: agentId, type: 'manages' });
      }
      return this.write(document, options);
    },

    /**
     * Give an agent a different role.
     *
     * The role must be one this store's vocabulary knows -- a default or a
     * custom role that currently exists. normalizeOrg does the refusing, which
     * is what keeps a deleted custom role from being assignable and keeps a
     * reserved identifier from being assignable at all.
     */
    assignRole({ agentId, role }, options = {}) {
      const { org } = this.read();
      const agent = org.agents.find(entry => entry.id === agentId);
      if (!agent) fail('AGENT_ORG_STORE_UNKNOWN_AGENT', `No agent "${agentId}" in the declared org.`, { agentId });
      if (agent.role === role && agent.roleSelection === undefined) return Object.freeze({ org, overlayFile: overlayPath, unchanged: true });
      // Exactly one role-defined root is a rule normalizeOrg enforces. Naming
      // the current holder makes an attempted second appointment actionable.
      const nextIsRoot = agentOrg.roleHasCapability(org, role, 'orgRoot');
      const currentIsRoot = agentOrg.roleHasCapability(org, agent.role, 'orgRoot');
      if (nextIsRoot) {
        const existing = agentOrg.rootAgentOf(org);
        if (existing && existing.id !== agentId) {
          fail('AGENT_ORG_STORE_CONTROLLER_EXISTS',
            `"${existing.displayName}" is already the organisation root. An organisation has exactly one, so change that seat first.`,
            { agentId, currentControllerId: existing.id });
        }
      }
      if (currentIsRoot && !nextIsRoot) {
        fail('AGENT_ORG_STORE_CONTROLLER_VACANT',
          'This is the only organisation root. Appoint another root instead of leaving the organisation without one.',
          { agentId });
      }
      const document = mutableOrg(org);
      const reassigned = document.agents.find(entry => entry.id === agentId);
      reassigned.role = role;
      delete reassigned.roleSelection;
      return this.write(document, options);
    },

    /**
     * The declared org as a document an operator could keep, diff, or hand to
     * another installation. It is the org and nothing else -- no overlay
     * bookkeeping, no timestamps, no machine paths -- so it is the same shape
     * as the config/agent-org.json a builder authors by hand.
     */
    /* ONE SEAT FOR ONE TREE NODE, IDEMPOTENTLY.
     *
     * WHY THIS EXISTS. computers.js roleBindingForStart() binds a tree node to
     * an organisation identity only when a seat exists whose id EQUALS the
     * node id and whose role EQUALS the node's role. Nothing declared such
     * seats, so every tree agent ran anonymous and agent.spawn refused every
     * caller with AGENT_SPAWN_IDENTITY_REQUIRED (measured 2026-09-02; the
     * three Manager seats were then written by hand through write()). This is
     * the one call a renderer or shell can make when a role-bearing node is
     * created or started, safe to repeat:
     *   - the seat already exists with this role and is enabled: unchanged;
     *   - it exists with another role, or disabled: refused by name -- a seat
     *     is never silently re-roled or re-enabled by a start;
     *   - the role is the organisation root and another root exists: refused,
     *     the same way assignRole refuses a second root;
     *   - otherwise the seat is added, enabled, and reports to `managerId`
     *     (default: the current root) with one `manages` edge. */
    /* `adoptProvider` exists for ONE case, and it is narrow on purpose.
     *
     * A seat that already exists is left exactly as it is -- that is what
     * makes this call idempotent and safe to make on every start. But the
     * organisation's ROOT seat ships declared with provider "none", meaning
     * nobody has run it yet, and a session's identity binding requires the
     * seat's provider to equal the provider the session actually runs on. So a
     * person who starts their Controller circle on Claude has a root seat that
     * can never bind: not because anything is wrong, but because the seat still
     * says nobody has run it.
     *
     * With this flag the caller states that this start IS the seat running, and
     * the seat learns which provider it runs on. Nothing else about the seat is
     * touched, a differing ROLE still refuses by name, and the flag is off
     * unless a caller asks for it -- so no existing caller's seat moves. */
    ensureSeat({ id, role, roleSelection = undefined, provider = 'claude', displayName = null, managerId = undefined, adoptProvider = false, nodeId = null }, options = {}) {
      const { org } = this.read();
      if (typeof id !== 'string' || id.length === 0) fail('AGENT_ORG_STORE_INVALID', 'ensureSeat needs the seat id.', { field: 'id' });
      if (typeof role !== 'string' || role.length === 0) fail('AGENT_ORG_STORE_INVALID', 'ensureSeat needs the seat role.', { field: 'role' });
      if (roleSelection !== undefined && (role !== 'worker' || !nodeId || (roleSelection !== '' && roleSelection !== role))) {
        fail('AGENT_ORG_STORE_INVALID', 'The role choice must match this tree-bound Worker seat or be empty.', { field: 'roleSelection' });
      }
      const existing = org.agents.find(entry => entry.id === id);
      if (existing) {
        if (existing.role !== role) {
          fail('AGENT_ORG_STORE_SEAT_ROLE_DIFFERS',
            `Seat "${id}" already exists as ${existing.role}, not ${role}. Change its role deliberately with assignRole.`,
            { agentId: id, currentRole: existing.role, requestedRole: role });
        }
        if (existing.enabled !== true) {
          fail('AGENT_ORG_STORE_SEAT_DISABLED', `Seat "${id}" exists but is disabled; enable it deliberately.`, { agentId: id });
        }
        if (roleSelection !== undefined && existing.nodeId && existing.nodeId !== nodeId) {
          fail('AGENT_ORG_STORE_INVALID', 'The role choice belongs to a different tree node.', { field: 'nodeId' });
        }
        const selectionChanged = roleSelection !== undefined && (existing.roleSelection === '' ? '' : existing.role) !== roleSelection;
        const providerChanged = adoptProvider === true && existing.provider !== provider;
        if (providerChanged || selectionChanged) {
          const adopted = mutableOrg(org);
          const seatToAdopt = adopted.agents.find(entry => entry.id === id);
          if (providerChanged) seatToAdopt.provider = provider;
          if (selectionChanged) {
            if (roleSelection === '') { seatToAdopt.roleSelection = ''; seatToAdopt.nodeId = nodeId; }
            else delete seatToAdopt.roleSelection;
          }
          const rewritten = this.write(adopted, options);
          return Object.freeze({
            ...rewritten,
            unchanged: false,
            ...(providerChanged ? { adoptedProvider: true } : {}),
            seat: rewritten.org.agents.find(entry => entry.id === id)
          });
        }
        return Object.freeze({ org, overlayFile: overlayPath, unchanged: true, seat: existing });
      }
      const root = agentOrg.rootAgentOf(org);
      if (agentOrg.roleHasCapability(org, role, 'orgRoot')) {
        if (root && root.id !== id) {
          fail('AGENT_ORG_STORE_CONTROLLER_EXISTS',
            `"${root.displayName}" is already the organisation root. An organisation has exactly one, so change that seat first.`,
            { agentId: id, currentControllerId: root.id });
        }
      }
      let manager = managerId === undefined ? (root ? root.id : null) : managerId;
      if (agentOrg.roleHasCapability(org, role, 'orgRoot')) manager = null;
      if (manager !== null && manager !== undefined) {
        if (manager === id) fail('AGENT_ORG_STORE_SELF_PARENT', 'An agent cannot manage itself.', { agentId: id });
        if (!org.agents.some(entry => entry.id === manager)) {
          fail('AGENT_ORG_STORE_UNKNOWN_AGENT', `No agent "${manager}" in the declared org.`, { agentId: manager });
        }
      }
      const document = mutableOrg(org);
      document.agents.push({
        id,
        displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : id,
        role,
        ...(roleSelection === '' ? { roleSelection: '' } : {}),
        provider,
        enabled: true,
        assignedPhase: null,
        phasePriority: [],
        nodeId
      });
      if (manager !== null && manager !== undefined) document.relationships.push({ from: manager, to: id, type: 'manages' });
      const written = this.write(document, options);
      const seat = written.org.agents.find(entry => entry.id === id);
      return Object.freeze({ ...written, unchanged: false, seat });
    },

    /* THE COUNTERPART OF ensureSeat.
     *
     * A tree node's seat never went away when the node did: nothing called
     * this, so a dead circle kept its organisation seat forever, until the
     * 64-seat bound in agentOrg.normalizeOrg() started refusing every new
     * seat for a live circle (measured 2026-09-03: 64 seats held, 56 for
     * circles from earlier trees). Idempotent when the seat is already gone,
     * because a caller racing a removal against a stop should not have to
     * check first. Refuses the organisation root by name, mirroring
     * reparent's own root rule: that seat is the single accountable root,
     * and removing it is a deliberate act (assignRole to a different root
     * first), never a side effect of a tree node disappearing. */
    releaseSeat({ id }, options = {}) {
      const { org } = this.read();
      if (typeof id !== 'string' || id.length === 0) fail('AGENT_ORG_STORE_INVALID', 'releaseSeat needs the seat id.', { field: 'id' });
      const existing = org.agents.find(entry => entry.id === id);
      if (!existing) return Object.freeze({ org, overlayFile: overlayPath, unchanged: true });
      if (agentOrg.roleHasCapability(org, existing.role, 'orgRoot')) {
        fail('AGENT_ORG_STORE_SEAT_IS_ROOT', 'The organisation root cannot be released.', { agentId: id });
      }
      const document = mutableOrg(org);
      document.agents = document.agents.filter(entry => entry.id !== id);
      document.relationships = document.relationships.filter(
        relation => relation.from !== id && relation.to !== id
      );
      const written = this.write(document, options);
      return Object.freeze({ ...written, unchanged: false });
    },

    exportOrg() {
      const { org } = this.read();
      return mutableOrg(org);
    },

    /** Forget every local edit and go back to the shipped default. */
    resetToBaseline() {
      try {
        fileSystem.unlinkSync(overlayPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          fail('AGENT_ORG_STORE_WRITE_FAILED', `The saved organisation could not be removed (${error && error.code ? error.code : 'unknown error'}).`);
        }
      }
      return Object.freeze({ org: readBaseline(), overlayFile: overlayPath });
    }
  };
}

/**
 * Assemble the two stores that define the organisation an installed customer
 * is actually using. Both resolve below the owner-fenced installation service
 * root; its product-directory identity comes from the shell-selected state
 * root, so a caller cannot drift into another account or product build.
 */
function createInstalledAgentOrgStores({
  baselineFile,
  overlayFile,
  roleMemoryFile,
  env = process.env,
  fileSystem = fs
} = {}) {
  const { createDurableMemoryFile } = require('./durable-memory-file');
  const { createCustomRoleStore } = require('./custom-role-store');
  const { installedRoleMemoryFiles, selectInstalledRoleMemoryFile } = require('./installed-role-memory');
  // Explicit paths remain an embedding contract. Ordinary installed callers
  // supply neither one and cannot select away a conflicting second history.
  const roleMemoryFiles = roleMemoryFile
    ? Object.freeze([roleMemoryFile])
    : installedRoleMemoryFiles({ env });
  let roleStore;
  let orgStore;
  let roleMemorySelection;
  function compose() {
    roleMemorySelection = roleMemoryFile
      ? Object.freeze({ file: roleMemoryFile, source: 'explicit' })
      : selectInstalledRoleMemoryFile(roleMemoryFiles, { fileSystem });
    roleStore = createCustomRoleStore({
      // Do not reuse the inspection backend: its cached bytes were read before
      // an authority consumer could stamp the complete input set.
      stateStore: createDurableMemoryFile({ file: roleMemorySelection.file, env, fileSystem })
    });
    orgStore = createAgentOrgStore({ baselineFile, overlayFile, customRoles: roleStore, env, fileSystem });
  }
  compose();
  return Object.freeze({
    get roleStore() { return roleStore; },
    get orgStore() { return orgStore; },
    get roleMemorySelection() { return roleMemorySelection; },
    roleMemoryFiles,
    read() {
      // A repeated installed read is fresh, including location selection. In
      // particular, cached absence must not hide a role saved by the shell or
      // the appearance of a second, conflicting authority file.
      compose();
      // Snapshot the complete definition vocabulary once. The org and the
      // returned directions/capabilities must describe the same authority
      // instant even if another process edits the role-memory file mid-read.
      const roles = roleStore.listRoles();
      const view = orgStore.read({ roleDefinitions: roles });
      if (view.damaged) {
        fail('AGENT_ORG_STORE_DAMAGED', `The installed organisation cannot be used: ${view.damaged}`);
      }
      const knownRoles = roles.map(role => Object.freeze({
        id: role.id,
        baseDefaultRole: role.baseDefaultRole ?? null,
        capabilities: role.capabilities
      }));
      return Object.freeze({ ...view, roles, knownRoles: Object.freeze(knownRoles) });
    }
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  OVERLAY_FILE,
  AgentOrgStoreError,
  createAgentOrgStore,
  createInstalledAgentOrgStores
});
