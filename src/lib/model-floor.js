'use strict';

// THE reader for config/model-floor.json -- the one authoritative source of
// truth for which Gemini models may be used for delegated work.
//
// Delegated work runs only on the explicitly configured high-capability Gemini
// tiers. The decision is centralized here rather than reconstructed per call.
// A declared floor that nothing reads is not an enforced floor, so:
//   * assertModelAllowed() THROWS. A below-floor, unknown, or non-servable
//     model is a refusal, never a fallback.
//   * The refusal message names the rule being enforced, so the
//     next violator learns the rule from the error rather than from a document
//     they would have had to remember to read.
//   * checkDeclarationDrift() re-reads every other file in the repo that
//     declares a Gemini model list and reports any that contradicts this one,
//     so the three-way contradiction cannot be reintroduced silently.
//
// Dependency-free on purpose (node builtins only): the fleet supervisor keeps
// `--status` cheap by not loading the provider gateway, and the tool registry
// loads this at module scope. Nothing here does I/O beyond reading JSON/JS
// text off disk, and nothing here writes.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FLOOR_PATH = path.join(REPO_ROOT, 'config', 'model-floor.json');

// A whole argument value that IS a plausible Gemini model id, never a
// substring inside prose. Gemini model ids begin with a numeric generation
// (for example gemini-2.5-pro or gemini-3.1-pro-preview). Requiring that
// generation avoids treating unrelated opaque values such as an
// `gemini-envelope-smoke-*` idempotency key as a model selection.
// The tool-registry guard uses this so a prompt that merely mentions a model
// name is not mistaken for a model selection.
const MODEL_ID_VALUE = /^gemini-\d+(?:\.\d+)?(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const MODEL_ID_ANYWHERE = /gemini-[A-Za-z0-9][A-Za-z0-9.-]*/g;

// The sentence a refused caller reads. It states the RULE, not its history: an
// error message is the only documentation a violator is guaranteed to see, so
// it has to be self-contained and mean something to someone who has never read
// anything else about this product.
const ORDER_CITATION =
  'Configured model floor policy: delegated work runs only on the explicitly allowed '
  + 'high-capability Gemini models. A model downgrade is a REFUSAL, never a fallback.';

let cache = null; // { path, doc }

// --- loading & shape validation ---------------------------------------------

function validateFloor(doc, floorPath) {
  const fail = (message) => { throw new TypeError(`model-floor.json (${floorPath}): ${message}`); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('root must be an object');
  if (doc.schemaVersion !== 'model-floor-v1') fail(`unsupported schemaVersion: ${doc.schemaVersion}`);
  if (!doc.backends || typeof doc.backends !== 'object') fail('"backends" must be an object');
  const backendIds = Object.keys(doc.backends);
  if (backendIds.length === 0) fail('"backends" must declare at least one backend');
  for (const id of backendIds) {
    const backend = doc.backends[id];
    if (!backend || typeof backend !== 'object') fail(`backend ${id} must be an object`);
    if (!Array.isArray(backend.allowed) || backend.allowed.length === 0) fail(`backend ${id} needs a non-empty "allowed" array`);
    for (const model of backend.allowed) {
      if (typeof model !== 'string' || !model) fail(`backend ${id} has a non-string entry in "allowed"`);
    }
    if (typeof backend.default !== 'string' || !backend.default) fail(`backend ${id} needs a string "default"`);
    if (!backend.allowed.includes(backend.default)) fail(`backend ${id} default "${backend.default}" is not in its own allowed list`);
    if (backend.notServable !== undefined && (typeof backend.notServable !== 'object' || backend.notServable === null || Array.isArray(backend.notServable))) {
      fail(`backend ${id} "notServable" must be an object of id -> reason`);
    }
  }
  if (!doc.policy || typeof doc.policy !== 'object') fail('"policy" must be an object');
  if (doc.policy.purposesCannotLowerTheFloor !== true) {
    fail('"policy.purposesCannotLowerTheFloor" must be true -- the configured model floor policy '
      + 'forbids per-purpose exceptions, including planning passes.');
  }
  if (doc.refusedIds !== undefined && (typeof doc.refusedIds !== 'object' || doc.refusedIds === null || Array.isArray(doc.refusedIds))) {
    fail('"refusedIds" must be an object of id -> reason');
  }
  // A refused id must never also be an allowed id -- that contradiction is the
  // exact shape this file exists to make impossible.
  for (const id of backendIds) {
    for (const model of doc.backends[id].allowed) {
      if (doc.refusedIds && Object.prototype.hasOwnProperty.call(doc.refusedIds, model)) {
        fail(`backend ${id} allows "${model}" while refusedIds also refuses it`);
      }
    }
  }
  /* The non-empty requirement belongs on the repository drift gate, not here.
   *
   * validateFloor() runs from loadFloor(), which is the runtime path: every
   * consumer that wants to know which models are allowed goes through it,
   * including the engine at startup. `declarationSites` is consumed by
   * exactly one function, checkDeclarationDrift(), which is a repo-development
   * gate -- it scans files in the ENGINE CHECKOUT for model declarations that
   * contradict this floor.
   *
   * A packaged floor may intentionally omit repository-only declaration sites.
   * It remains loadable because it still declares
   * backends, policy and refusedIds, which is everything the runtime asks of
   * it. It is only the DRIFT CHECK that cannot do its job without sites, so
   * that is where the refusal belongs. */
  if (doc.declarationSites !== undefined && !Array.isArray(doc.declarationSites)) {
    fail('"declarationSites" must be an array when present');
  }
  return doc;
}

function loadFloor({ floorPath = DEFAULT_FLOOR_PATH, force = false } = {}) {
  if (!force && cache && cache.path === floorPath) return cache.doc;
  const raw = fs.readFileSync(floorPath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new SyntaxError(`model-floor.json (${floorPath}) is not valid JSON: ${error.message}`); }
  validateFloor(parsed, floorPath);
  cache = { path: floorPath, doc: parsed };
  return parsed;
}

function backendIds(options = {}) {
  return Object.keys(loadFloor(options).backends);
}

function backendOrThrow(backend, options = {}) {
  const doc = loadFloor(options);
  const ids = Object.keys(doc.backends);
  const candidate = backend === undefined || backend === null ? doc.policy.defaultBackend : backend;
  if (!ids.includes(candidate)) {
    const error = new Error(
      `Unknown Gemini backend "${candidate}". Declared backends: ${ids.join(', ')}. `
      + 'An unrecognised backend is refused rather than defaulted -- guessing a backend would silently '
      + 'apply the wrong model floor.'
    );
    error.code = 'MODEL_BACKEND_UNKNOWN';
    throw error;
  }
  return candidate;
}

/** The allowed model ids for a backend (frozen copy). */
function allowedFor(backend, options = {}) {
  const doc = loadFloor(options);
  const id = backendOrThrow(backend, options);
  return Object.freeze([...doc.backends[id].allowed]);
}

/** The default (top-tier) model for a backend. */
function defaultFor(backend, options = {}) {
  const doc = loadFloor(options);
  return doc.backends[backendOrThrow(backend, options)].default;
}

/** Every model id allowed on any backend -- the union used by the drift checker. */
function allowedUnion(options = {}) {
  const doc = loadFloor(options);
  const union = new Set();
  for (const backend of Object.values(doc.backends)) for (const model of backend.allowed) union.add(model);
  return Object.freeze([...union]);
}

/** Why an id is refused everywhere, or null. */
function refusedReason(model, options = {}) {
  const doc = loadFloor(options);
  return (doc.refusedIds && doc.refusedIds[model]) || null;
}

/** Why an id cannot be served on a backend at all (distinct from "below floor"), or null. */
function notServableReason(backend, model, options = {}) {
  const doc = loadFloor(options);
  const id = backendOrThrow(backend, options);
  const table = doc.backends[id].notServable;
  return (table && table[model]) || null;
}

// --- the refusal --------------------------------------------------------------

/**
 * Non-throwing evaluation. Returns {allowed:boolean, model, backend, code, reason}.
 * `purpose` is recorded and echoed in the refusal, never used to widen the
 * floor -- see policy.purposesCannotLowerTheFloor.
 */
function evaluateModel({ backend, model, purpose = null } = {}, options = {}) {
  const doc = loadFloor(options);
  let resolvedBackend;
  try { resolvedBackend = backendOrThrow(backend, options); }
  catch (error) { return { allowed: false, model: model ?? null, backend: backend ?? null, purpose, code: error.code, reason: error.message }; }

  const allowed = doc.backends[resolvedBackend].allowed;
  const candidate = model === undefined || model === null ? doc.backends[resolvedBackend].default : model;

  if (typeof candidate !== 'string' || !candidate) {
    return {
      allowed: false, model: candidate ?? null, backend: resolvedBackend, purpose, code: 'MODEL_FLOOR_UNKNOWN',
      reason: `A non-string model was offered for backend "${resolvedBackend}". Honest-unknown: an unreadable `
        + `model selection is refused, never assumed to be the default. ${ORDER_CITATION}`
    };
  }

  // "Cannot be obtained here" is a different fact from "is below the floor";
  // preserve that distinction in the typed refusal.
  const unservable = notServableReason(resolvedBackend, candidate, options);
  if (unservable) {
    return {
      allowed: false, model: candidate, backend: resolvedBackend, purpose, code: 'MODEL_NOT_SERVABLE',
      reason: `${unservable} Use ${doc.backends[resolvedBackend].default}, the verified top tier on this backend.`
    };
  }

  if (allowed.includes(candidate)) {
    return { allowed: true, model: candidate, backend: resolvedBackend, purpose, code: null, reason: null };
  }

  const known = refusedReason(candidate, options);
  const purposeNote = purpose
    ? ` The purpose "${purpose}" does not lower the configured model floor; the same policy applies `
      + 'to every lane type, including planning passes.'
    : '';
  return {
    allowed: false, model: candidate, backend: resolvedBackend, purpose, code: 'MODEL_FLOOR_REFUSED',
    reason: `Gemini model "${candidate}" is below the ${resolvedBackend} model floor `
      + `(allowed: ${allowed.join(', ')}).${known ? ` ${known}` : ''}${purposeNote} ${ORDER_CITATION} `
      + 'Source of truth: config/model-floor.json -- change the floor there, in the open, or not at all.'
  };
}

/** Throwing form. Returns the resolved model id when allowed. */
function assertModelAllowed(selection = {}, options = {}) {
  const verdict = evaluateModel(selection, options);
  if (verdict.allowed) return verdict.model;
  const error = new Error(verdict.reason);
  error.code = verdict.code;
  error.model = verdict.model;
  error.backend = verdict.backend;
  error.purpose = verdict.purpose;
  throw error;
}

/**
 * Backend-independent refusal, for a caller that has a model id but does not
 * yet know which backend will serve it (a tool argument, a brief, a queue
 * item). An id that is on NO backend's floor is below floor everywhere, so
 * refusing it needs no backend knowledge. Backend-specific selection stays with
 * assertModelAllowed().
 *
 * This is the symbol src/lib/tool-registry.js#executeTool() calls. The drift
 * check verifies that dispatch remains wired to this authority; renaming or
 * unwiring it fails that check.
 */
function assertOnSomeFloor(model, { tool = null, field = null } = {}, options = {}) {
  const union = allowedUnion(options);
  if (typeof model === 'string' && union.includes(model)) return model;
  const known = refusedReason(model, options);
  const where = tool ? `Tool '${tool}'${field ? ` argument ${field}` : ''} ` : '';
  const error = new Error(
    `${where}selects Gemini model "${model}", which is below the model floor `
    + `(allowed on some backend: ${union.join(', ')}).${known ? ` ${known}` : ''} `
    + 'No purpose lowers the configured model floor; the same policy applies to every lane type, '
    + 'including planning passes. '
    + `${ORDER_CITATION} `
    + 'Source of truth: config/model-floor.json -- change the floor there, in the open, or not at all.'
  );
  error.code = 'MODEL_FLOOR_REFUSED';
  error.model = model;
  throw error;
}

/**
 * Serve-side check: did the provider actually serve at or above the floor?
 * `reportedModels` is the CLI's own stats.models key set.
 *
 * Returns null when the provider said nothing. Honest-unknown: null is not a
 * pass, and callers must not treat it as one.
 */
function servedBelowFloor(backend, reportedModels, options = {}) {
  if (!Array.isArray(reportedModels) || reportedModels.length === 0) return null;
  const allowed = allowedFor(backend, options);
  return reportedModels.filter((name) => !allowed.includes(name));
}

// --- argument scanning (for the tool-registry pre-dispatch guard) -------------

const MAX_SCAN_NODES = 512;

/**
 * Every argument value that IS a bare Gemini model id, with its argument path.
 * Bounded traversal; matches whole values only, so a prompt or a log line that
 * merely mentions a model name is never mistaken for a model selection.
 */
function findModelArguments(args, { maxNodes = MAX_SCAN_NODES } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new RangeError('Model argument scan maxNodes must be a positive safe integer; an unusable scan limit cannot establish that arguments are on-floor.');
  }
  const found = [];
  let visited = 0;
  let truncated = false;
  const walk = (value, keyPath) => {
    if (visited >= maxNodes) {
      truncated = true;
      return;
    }
    visited += 1;
    if (typeof value === 'string') {
      if (MODEL_ID_VALUE.test(value.trim())) found.push({ key: keyPath, value: value.trim() });
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) walk(entry, `${keyPath}[${index}]`);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, keyPath ? `${keyPath}.${key}` : key);
    }
  };
  walk(args, '');
  if (truncated) {
    const error = new Error(
      `Model argument scan exceeded its ${maxNodes}-node limit; refusing because unscanned arguments may contain a below-floor model.`
    );
    error.code = 'MODEL_ARGUMENT_SCAN_INCOMPLETE';
    error.maxNodes = maxNodes;
    throw error;
  }
  return found;
}

// --- declaration drift --------------------------------------------------------
//
// The anti-reintroduction mechanism. A policy and its derived declarations
// cannot silently diverge. A site whose declared ids are not a subset of this file's
// allowed union is DRIFTED. A site whose symbol cannot be found is UNKNOWN,
// which is a failure, not a pass -- if enforcement cannot determine compliance
// it reports UNKNOWN with a reason and never assumes fine.

function extractDeclarationSpan(text, symbol) {
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${symbol}\\s*=`, 'm');
  const match = declaration.exec(text);
  if (!match) return null;
  let index = match.index + match[0].length;
  let depth = 0;
  let quote = null;
  const start = index;
  while (index < text.length) {
    const ch = text[index];
    if (quote) {
      if (ch === '\\') { index += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ';' && depth <= 0) {
      break;
    }
    index += 1;
  }
  return text.slice(start, index);
}

function idsIn(text) {
  const ids = new Set();
  for (const match of String(text).matchAll(MODEL_ID_ANYWHERE)) ids.add(match[0].replace(/\.+$/, ''));
  return [...ids];
}

function resolvePointer(doc, pointer) {
  let node = doc;
  for (const rawSegment of String(pointer).split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(segment in node)) return undefined;
    node = node[segment];
  }
  return node;
}

function evaluateSite(site, root, union, doc) {
  const absolute = path.join(root, site.file.split('/').join(path.sep));
  let text;
  try { text = fs.readFileSync(absolute, 'utf8'); }
  catch (error) {
    return { ...siteSummary(site), verdict: 'unknown', declared: [], offending: [], reason: `Cannot read ${site.file}: ${error.message}` };
  }

  let declared = [];
  if (site.kind === 'json-pointer') {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { return { ...siteSummary(site), verdict: 'unknown', declared: [], offending: [], reason: `${site.file} is not valid JSON: ${error.message}` }; }
    const node = resolvePointer(parsed, site.pointer);
    if (node === undefined) {
      return { ...siteSummary(site), verdict: 'unknown', declared: [], offending: [], reason: `JSON pointer ${site.pointer} does not resolve in ${site.file}` };
    }
    declared = idsIn(JSON.stringify(node));
  } else if (site.kind === 'js-const') {
    const missing = [];
    for (const symbol of site.symbols || []) {
      const span = extractDeclarationSpan(text, symbol);
      if (span === null) { missing.push(symbol); continue; }
      declared.push(...idsIn(span));
    }
    if (missing.length > 0) {
      return {
        ...siteSummary(site), verdict: 'unknown', declared: [...new Set(declared)], offending: [],
        reason: `Declaration(s) not found in ${site.file}: ${missing.join(', ')}. The symbol was renamed or removed; `
          + 'this checker refuses to report a site it can no longer see as compliant.'
      };
    }
  } else {
    return { ...siteSummary(site), verdict: 'unknown', declared: [], offending: [], reason: `Unsupported declaration site kind: ${site.kind}` };
  }

  declared = [...new Set(declared)];

  // A site claiming status:"derived" asserts it has no independent opinion --
  // it reads config/model-floor.json instead. That claim is checked, not
  // trusted: the file must actually reference the authority. Otherwise
  // "derived" becomes a label anyone can apply to an unchecked hand-written
  // list. Derived status must be mechanically evident in the source.
  if (site.status === 'derived') {
    const marker = site.derivedMarker || 'model-floor';
    if (!text.includes(marker)) {
      return {
        ...siteSummary(site), verdict: 'drifted', declared, offending: [],
        reason: `${site.file} is declared status:"derived" but contains no reference to "${marker}". `
          + 'A site that claims to derive from config/model-floor.json must demonstrably read it; an '
          + 'unverifiable derivation claim is refused, not accepted.'
      };
    }
  }

  const offending = declared.filter((id) => !union.includes(id));
  if (offending.length === 0) {
    return { ...siteSummary(site), verdict: 'compliant', declared, offending: [], reason: null };
  }
  const reasons = offending.map((id) => `${id}: ${(doc.refusedIds && doc.refusedIds[id]) || 'not on any backend floor in config/model-floor.json'}`);
  return {
    ...siteSummary(site), verdict: 'drifted', declared, offending,
    reason: `${site.file} declares Gemini model id(s) that contradict config/model-floor.json -- ${reasons.join(' | ')}`
  };
}

function siteSummary(site) {
  return {
    id: site.id, file: site.file, declaredStatus: site.status || null,
    owner: site.owner || null, note: site.note || null
  };
}

/**
 * Re-read every declaring file and compare it to the authoritative floor.
 *
 * @returns {{ok:boolean, union:string[], sites:object[], drifted:object[], unknown:object[]}}
 */
function checkDeclarationDrift({ floorPath = DEFAULT_FLOOR_PATH, root = REPO_ROOT } = {}) {
  const doc = loadFloor({ floorPath, force: true });
  /* A repository gate that scans zero sites establishes nothing. Keep this
     requirement here, while allowing a packaged runtime policy to omit
     repository-only declaration sites. */
  if (!Array.isArray(doc.declarationSites) || doc.declarationSites.length === 0) {
    throw new TypeError(`model-floor.json (${floorPath}): "declarationSites" must be a non-empty array `
      + 'to check declaration drift -- a gate that scans zero sites cannot establish compliance. '
      + 'A payload copy with no declaration sites is loadable but not checkable, and must not be checked here.');
  }
  const union = allowedUnion({ floorPath });
  const sites = doc.declarationSites.map((site) => evaluateSite(site, root, union, doc));
  const drifted = sites.filter((site) => site.verdict === 'drifted');
  const unknown = sites.filter((site) => site.verdict === 'unknown');
  return { ok: drifted.length === 0 && unknown.length === 0, union, sites, drifted, unknown };
}

module.exports = {
  loadFloor,
  backendIds,
  allowedFor,
  defaultFor,
  allowedUnion,
  refusedReason,
  notServableReason,
  evaluateModel,
  assertModelAllowed,
  assertOnSomeFloor,
  servedBelowFloor,
  findModelArguments,
  checkDeclarationDrift,
  MODEL_ID_VALUE,
  ORDER_CITATION,
  DEFAULT_FLOOR_PATH
};
