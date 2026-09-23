'use strict';

// Machine-readable access to STANDING-ORDERS.md via its structured mirror,
// config/standing-orders.json.
//
// Why this file exists: STANDING-ORDERS.md is discipline-checked prose. An
// agent complies only if it chooses to re-read it and reason about which
// rules apply. This module gives code a bounded, deterministic way to ask
// "which orders govern this action" (classifyAction) and "what does the
// owner's rulebook say about class X" (ordersForClass), plus a consistency
// check so the prose and the JSON mirror cannot silently drift apart -- the
// same failure shape the analyst findings flagged for egress-preflight.js
// (a mechanism nobody calls is not a backstop): this module is a *reader*,
// not an enforcement gate by itself. Wiring classifyAction's output into an
// actual block/allow decision at a real call site is a separate, later step.
//
// Heuristics only. No model calls, no network calls, no filesystem writes.

const fs = require('node:fs');
const path = require('node:path');
// Reused, not reimplemented: dependency-graph.js already solved comment
// stripping carefully (its own header records the regex version swallowing a
// real require it should have seen). Writing a second stripper here is exactly
// the human-shaped substitute this file's checks exist to catch.
const { stripCommentsPreservingLiterals } = require('./dependency-graph');

const DEFAULT_JSON_PATH = path.join(__dirname, '..', '..', 'config', 'standing-orders.json');
const DEFAULT_MD_PATH = path.join(__dirname, '..', '..', 'STANDING-ORDERS.md');

// 'retired' is a fourth state, and it is NOT a weaker 'discipline'. discipline
// means "prose only -- still follow it". retired means the owner REVOKED the
// order: it is no longer in force at all, and it is kept in the file only so
// the number space stays stable and the revocation stays auditable.
//
// It exists because the alternative was a lie with a component name attached.
// BROWSER 1 was retired by the owner on 2026-08-10 ("literally you can drive
// the browsers as needed that was a thread specific rule and needs to be
// cleaned up"). STANDING-ORDERS.md was updated and tools/standing-orders-hook.js
// was updated -- checkBrowser() now logs and returns null on every path -- but
// this machine-readable mirror still recorded enforcement:'mechanical',
// wired:true, and an enforcingComponent asserting the hook "refuses
// browser-driving Bash/PowerShell commands with exit 2". Every consumer that
// reads the mirror rather than the prose was being told a revoked rule was the
// most strongly enforced kind of rule there is.
//
// Marking it 'discipline' instead would have been the reflex fix and it would
// have been wrong in the other direction: it would have told every reader the
// order still binds them and they should comply out of discipline. There was
// no honest value in the old set, which is why the set grew.
const VALID_ENFORCEMENT = new Set(['mechanical', 'advisory', 'discipline', 'retired']);

let cache = null; // { path, doc }

// --- loading & shape validation ---------------------------------------------

function validateDoc(doc, jsonPath) {
  const fail = (message) => { throw new TypeError(`standing-orders.json (${jsonPath}): ${message}`); };

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('root must be an object');
  if (!Array.isArray(doc.classes) || doc.classes.length === 0) fail('"classes" must be a non-empty array');
  if (!Array.isArray(doc.sessionBoot) || doc.sessionBoot.length === 0) fail('"sessionBoot" must be a non-empty array');
  const seenBootNumbers = new Set();
  for (const item of doc.sessionBoot) {
    if (!item || typeof item !== 'object' || typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number < 1) {
      fail('every sessionBoot item needs a positive integer "number"');
    }
    if (seenBootNumbers.has(item.number)) fail(`duplicate sessionBoot number: ${item.number}`);
    seenBootNumbers.add(item.number);
    if (typeof item.instruction !== 'string' || item.instruction.trim() === '') fail(`sessionBoot ${item.number} needs a non-empty "instruction"`);
  }

  const seenClassIds = new Set();
  for (const cls of doc.classes) {
    if (!cls || typeof cls !== 'object') fail('every class entry must be an object');
    if (typeof cls.id !== 'string' || !cls.id) fail('every class needs a non-empty string id');
    if (seenClassIds.has(cls.id)) fail(`duplicate class id: ${cls.id}`);
    seenClassIds.add(cls.id);
    if (!Array.isArray(cls.orders) || cls.orders.length === 0) fail(`class ${cls.id} needs a non-empty orders array`);

    const seenNumbers = new Set();
    for (const order of cls.orders) {
      if (!order || typeof order !== 'object') fail(`class ${cls.id} has a non-object order`);
      if (typeof order.number !== 'string' || !order.number) fail(`class ${cls.id} has an order missing "number"`);
      if (seenNumbers.has(order.number)) fail(`class ${cls.id} has duplicate order number ${order.number}`);
      seenNumbers.add(order.number);
      if (typeof order.summary !== 'string' || !order.summary) fail(`${cls.id} ${order.number} needs a non-empty "summary"`);
      if (order.verbatim !== null && typeof order.verbatim !== 'string') fail(`${cls.id} ${order.number} "verbatim" must be a string or null`);
      if (!VALID_ENFORCEMENT.has(order.enforcement)) fail(`${cls.id} ${order.number} has an invalid "enforcement": ${order.enforcement}`);
      if (order.enforcingComponent !== null && typeof order.enforcingComponent !== 'string') fail(`${cls.id} ${order.number} "enforcingComponent" must be a string or null`);
      if (order.revocationPhrase !== null && typeof order.revocationPhrase !== 'string') fail(`${cls.id} ${order.number} "revocationPhrase" must be a string or null`);
      if (Object.prototype.hasOwnProperty.call(order, 'wired') && order.wired !== null && typeof order.wired !== 'boolean') fail(`${cls.id} ${order.number} "wired" must be a boolean or null`);
      if (Object.prototype.hasOwnProperty.call(order, 'reference') && order.reference !== null && typeof order.reference !== 'string') fail(`${cls.id} ${order.number} "reference" must be a string or null`);
      // coverageGap: the honest-unknown field. An order can be genuinely
      // mechanical AND still have a route the mechanism cannot see (the
      // PreToolUse hook reads Bash/PowerShell command text and is structurally
      // blind to a native MCP call). Without this, "mechanical + wired:true"
      // reads as total coverage and the uncovered route disappears from view --
      // which is softening a status, the exact thing RECORD 2 forbids.
      if (Object.prototype.hasOwnProperty.call(order, 'coverageGap') && order.coverageGap !== null && typeof order.coverageGap !== 'string') fail(`${cls.id} ${order.number} "coverageGap" must be a string or null`);
      if (order.enforcement === 'discipline' && typeof order.coverageGap === 'string') fail(`${cls.id} ${order.number} is discipline; a coverageGap describes a partially-covering mechanism, and there is no mechanism here`);

      // 'retired' carries the strictest shape rules in this file, deliberately.
      // A revoked order is the easiest kind to falsify -- nothing runs, so
      // nothing contradicts a leftover claim -- and that is exactly how BROWSER
      // 1 sat here for a day declaring mechanical enforcement that had already
      // been deleted from the hook. So:
      //
      //   * no enforcingComponent -- naming a component for a revoked rule is
      //     the precise false record this state was added to remove;
      //   * no `wired` -- there is nothing to be wired to;
      //   * no coverageGap -- same reason as discipline, only more so;
      //   * a revocationPhrase is MANDATORY, and this is the load-bearing one.
      //     checkConsistency() already requires every revocationPhrase to
      //     appear as an exact quoted substring of that class's section in
      //     STANDING-ORDERS.md. So an agent cannot retire an order by editing
      //     this file: it must first be able to point at the owner's own words
      //     revoking it, in the prose. Retirement needs evidence, not a label.
      if (order.enforcement === 'retired') {
        if (order.enforcingComponent !== null) fail(`${cls.id} ${order.number} is retired; a revoked order has no enforcing component (found: ${order.enforcingComponent})`);
        if (Object.prototype.hasOwnProperty.call(order, 'wired') && order.wired !== null) fail(`${cls.id} ${order.number} is retired; "wired" must be null or absent, not ${order.wired}`);
        if (typeof order.coverageGap === 'string') fail(`${cls.id} ${order.number} is retired; a coverageGap describes a partially-covering mechanism, and a revoked order has none`);
        if (typeof order.revocationPhrase !== 'string' || order.revocationPhrase.trim() === '') fail(`${cls.id} ${order.number} is retired but records no "revocationPhrase"; an order may only be marked retired by quoting the owner's words that revoked it`);
      }
    }
  }
  return doc;
}

/**
 * Load and validate config/standing-orders.json. Cached by path; pass
 * force:true to bypass the cache (tests do this after asserting on a
 * deliberately broken fixture).
 */
function loadOrders({ jsonPath = DEFAULT_JSON_PATH, force = false } = {}) {
  if (!force && cache && cache.path === jsonPath) return cache.doc;
  const raw = fs.readFileSync(jsonPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`standing-orders.json (${jsonPath}) is not valid JSON: ${error.message}`);
  }
  validateDoc(parsed, jsonPath);
  cache = { path: jsonPath, doc: parsed };
  return parsed;
}

/** All orders for one class id (e.g. "OUTWARD"), or [] if the class is unknown. */
function ordersForClass(classId, options = {}) {
  const doc = loadOrders(options);
  const cls = doc.classes.find((entry) => entry.id === classId);
  return cls ? cls.orders : [];
}

/** The full class entry (id, heading, triggerWords, orders), or null. */
function getClass(classId, options = {}) {
  const doc = loadOrders(options);
  return doc.classes.find((entry) => entry.id === classId) || null;
}

/** All class ids in file order. */
function classIds(options = {}) {
  return loadOrders(options).classes.map((entry) => entry.id);
}

// --- classification ----------------------------------------------------------

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Every start index where `needleTokens` occurs as a contiguous run inside `haystackTokens`. */
function findSubsequenceStarts(haystackTokens, needleTokens) {
  if (needleTokens.length === 0) return [];
  const starts = [];
  outer: for (let start = 0; start <= haystackTokens.length - needleTokens.length; start += 1) {
    for (let offset = 0; offset < needleTokens.length; offset += 1) {
      if (haystackTokens[start + offset] !== needleTokens[offset]) continue outer;
    }
    starts.push(start);
  }
  return starts;
}

/** True if at least one occurrence in `starts` has every token index still unclaimed. */
function hasUnclaimedOccurrence(starts, needleLength, claimed) {
  return starts.some((start) => {
    for (let offset = 0; offset < needleLength; offset += 1) if (claimed.has(start + offset)) return false;
    return true;
  });
}

/**
 * Classify a candidate action against STANDING-ORDERS.md's action classes.
 * Pure heuristic word/tool matching -- no model calls. Tool/method identity
 * (`tool`) is matched exactly or by prefix, never tokenized into the prose
 * search, so a tool name and the command text cannot double-count the same
 * word. Within the prose search, multi-word `identifiers` (e.g. "task
 * submit") take precedence over generic single-word `keywords` (e.g.
 * OUTWARD's "submit"): every token occurrence an identifier claims is
 * ineligible for a separate generic keyword match, so a SPAWN call like
 * "task.submit" is not also flagged OUTWARD just because it contains the
 * word "submit".
 *
 * @param {object} action
 * @param {string} [action.tool]        tool/method name, e.g. "Bash", "Grep", "mcp__toolsenabled__task_submit"
 * @param {string} [action.command]     command text / arguments, if any
 * @param {string} [action.targetPath]  file or destination path involved, if any
 * @returns {{classes: string[], orders: object[]}}
 */
function classifyAction({ tool, command, targetPath } = {}, options = {}) {
  const doc = loadOrders(options);
  const heuristics = doc.classificationHeuristics || {};
  const toolLower = typeof tool === 'string' ? tool.toLowerCase() : '';
  const proseText = [command, targetPath].filter((value) => typeof value === 'string').join(' ');
  const tokens = tokenize(proseText);
  const claimed = new Set();
  const matched = new Set();

  // Pass 1: exact tool name / tool prefix matches, and multi-word identifiers.
  for (const [classId, spec] of Object.entries(heuristics)) {
    if (!spec || classId.startsWith('_')) continue;
    const tools = Array.isArray(spec.tools) ? spec.tools : [];
    const toolPrefixes = Array.isArray(spec.toolPrefixes) ? spec.toolPrefixes : [];
    if (toolLower && tools.some((name) => String(name).toLowerCase() === toolLower)) matched.add(classId);
    if (toolLower && toolPrefixes.some((prefix) => toolLower.startsWith(String(prefix).toLowerCase()))) matched.add(classId);

    const identifiers = Array.isArray(spec.identifiers) ? spec.identifiers : [];
    for (const identifier of identifiers) {
      const needle = tokenize(identifier);
      const starts = findSubsequenceStarts(tokens, needle);
      if (starts.length > 0) {
        matched.add(classId);
        for (const start of starts) for (let offset = 0; offset < needle.length; offset += 1) claimed.add(start + offset);
      }
    }
  }

  // Pass 2: generic single/short-phrase keywords, skipping occurrences an
  // identifier already claimed above.
  for (const [classId, spec] of Object.entries(heuristics)) {
    if (!spec || classId.startsWith('_')) continue;
    const keywords = Array.isArray(spec.keywords) ? spec.keywords : [];
    for (const keyword of keywords) {
      const needle = tokenize(keyword);
      if (needle.length === 0) continue;
      const starts = findSubsequenceStarts(tokens, needle);
      if (hasUnclaimedOccurrence(starts, needle.length, claimed)) matched.add(classId);
    }
  }

  const classes = doc.classes.map((entry) => entry.id).filter((id) => matched.has(id));
  const orders = classes.flatMap((id) => ordersForClass(id, options));
  return { classes, orders };
}

// --- MD <-> JSON consistency -------------------------------------------------

function parseClassSections(mdText) {
  const headingPattern = /^## Class: ([A-Za-z-]+)\b/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(mdText)) !== null) {
    headings.push({ id: match[1], index: match.index });
  }
  return headings.map((heading, i) => ({
    id: heading.id,
    text: mdText.slice(heading.index, i + 1 < headings.length ? headings[i + 1].index : mdText.length)
  }));
}

function parseOrderNumbers(sectionText) {
  const orderPattern = /^(\d+[a-z]?)\.\s+\S/gm;
  const numbers = [];
  let match;
  while ((match = orderPattern.exec(sectionText)) !== null) numbers.push(match[1]);
  return numbers;
}

function normalizeQuote(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Quoted spans of at least `minLength` characters, whitespace-normalized. */
function parseQuotes(sectionText, minLength = 10) {
  const quotePattern = /"([^"]+)"/g;
  const quotes = [];
  let match;
  while ((match = quotePattern.exec(sectionText)) !== null) {
    const normalized = normalizeQuote(match[1]);
    if (normalized.length >= minLength) quotes.push(normalized);
  }
  return quotes;
}

/**
 * Compare STANDING-ORDERS.md against its JSON mirror. Checks (1) every class
 * in the .md has a same-named class in the JSON and vice versa -- this is
 * "every order in the MD has a JSON twin" at the class level, (2) each class
 * has the exact same set of order numbers in both files -- the same check at
 * the per-order level, so an order added to one file and forgotten in the
 * other is caught by number, not by prose diffing, and (3) every JSON
 * `verbatim`/`revocationPhrase` string appears as an exact quoted substring
 * somewhere in that class's .md section -- so the JSON can never fabricate or
 * silently reword an owner quote relative to the source file it mirrors.
 *
 * Deliberately one-directional on quotes: STANDING-ORDERS.md also contains
 * many incidental quoted phrases inside explanatory prose (illustrative
 * examples, a cited doc-section title, a code snippet) that are not
 * themselves owner orders and have no reason to become a JSON `verbatim`
 * field. Requiring every such quote to have a JSON twin would force
 * transcribing narrative color, not orders; the order-number check above
 * already guarantees no *order* is silently missing.
 *
 * @returns {{ok: boolean, issues: string[]}}
 */
function checkConsistency({ mdPath = DEFAULT_MD_PATH, jsonPath = DEFAULT_JSON_PATH } = {}) {
  const issues = [];
  const mdText = fs.readFileSync(mdPath, 'utf8');
  const doc = loadOrders({ jsonPath, force: true });

  const mdSections = parseClassSections(mdText);
  const mdClassIds = mdSections.map((section) => section.id);
  const jsonClassIds = doc.classes.map((entry) => entry.id);

  for (const id of mdClassIds) if (!jsonClassIds.includes(id)) issues.push(`Class "${id}" exists in STANDING-ORDERS.md but not in standing-orders.json.`);
  for (const id of jsonClassIds) if (!mdClassIds.includes(id)) issues.push(`Class "${id}" exists in standing-orders.json but not in STANDING-ORDERS.md.`);

  for (const section of mdSections) {
    const jsonClass = doc.classes.find((entry) => entry.id === section.id);
    if (!jsonClass) continue; // already reported above

    const mdNumbers = parseOrderNumbers(section.text);
    const jsonNumbers = jsonClass.orders.map((order) => order.number);
    for (const number of mdNumbers) if (!jsonNumbers.includes(number)) issues.push(`Class "${section.id}" order ${number} exists in STANDING-ORDERS.md but not in standing-orders.json.`);
    for (const number of jsonNumbers) if (!mdNumbers.includes(number)) issues.push(`Class "${section.id}" order ${number} exists in standing-orders.json but not in STANDING-ORDERS.md.`);

    const mdQuotes = parseQuotes(section.text);
    const jsonQuotes = jsonClass.orders.flatMap((order) => [order.verbatim, order.revocationPhrase]).filter((value) => typeof value === 'string');

    for (const quote of jsonQuotes) {
      if (!mdQuotes.includes(quote)) issues.push(`Class "${section.id}": JSON verbatim/revocationPhrase text does not appear as a quoted substring in STANDING-ORDERS.md: "${quote}"`);
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Throws with every issue listed if the .md and .json have drifted apart. */
function assertConsistent(options = {}) {
  const result = checkConsistency(options);
  if (!result.ok) {
    const error = new Error(`STANDING-ORDERS.md and standing-orders.json have diverged:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`);
    error.code = 'STANDING_ORDERS_INCONSISTENT';
    error.issues = result.issues;
    throw error;
  }
  return result;
}

// --- wired-annotation drift ---------------------------------------------------
//
// Q31 build item 5: the fleet that built this JSON mirror flagged a gap in
// its own checker -- checkConsistency() above pins that the .md and the JSON
// cannot silently diverge on *which orders exist*, but nothing re-verified
// the JSON's own `wired` claims against the live repo. That is exactly how
// OUTWARD rules 3-4 went stale within the same session: they were transcribed
// as `wired:false` ("verified 2026-07-28: zero production call sites") and
// then, later in that same run, tool-registry.js and playwright-gateway.js
// actually wired egress-preflight.js into their dispatch paths -- the
// annotation was never re-checked against the change that falsified it.
//
// This is a heuristic drift *detector*, not a proof of correctness. But on
// 2026-08-09 it was measured, and the heuristic was measurably too weak in two
// specific ways that both produced a GREEN it had not earned. A false green is
// worse than no check at all, because a check reporting "ok" is the exact
// reason nobody looks again. Both holes are now closed:
//
// HOLE 1 -- A COMMENT SATISFIED `wired:true`. hasProductionReference() was
// `text.includes('symbol(')` over the raw file bytes. config/standing-orders.json
// declares COORDINATOR 3 enforcement:'mechanical', wired:true, enforcingComponent
// 'src/lib/agent-org.js#mayClaim'. That claim passed for one reason: the string
// "mayClaim()" appears in two COMMENTS in src/lib/controller-launch-record.js
// (its module header, and a JSDoc block). A language-server reference search on
// mayClaim returns exactly two hits -- its own declaration and its own export
// line. There is no caller. The checker was reading prose about a mechanism and
// scoring it as the mechanism, which is the same substitution the repo-wide
// 2026-08-08/09 measurement found everywhere else. References are now resolved
// against source with comments removed and string-literal CONTENTS blanked, and
// a reference must be a CALL or a require-destructuring BINDING -- being
// written about is not being called.
//
// HOLE 2 -- HALF THE CLAIMS WERE NEVER CHECKED AT ALL. The old code did
// `if (!ref) continue` for any enforcingComponent that was not exactly
// "path/to/file.js#symbol". Eight of the sixteen wired claims in the live
// mirror are prose sentences that happen to name a component, so eight
// `wired:true`/`wired:false` claims were skipped in silence and the run still
// printed ok. Component references are now extracted from prose too
// ("tools/owner-capture.js assertGatesAppendOnly()" resolves), and a claim that
// still cannot be resolved to a symbol is returned in `unresolved` rather than
// dropped -- surfaced, never counted as a pass.
//
// WHAT THIS CHECK DELIBERATELY DOES NOT ANSWER. "Does this FILE ever run?" is a
// different question at a different grain, and tools/invocation-guard.js is the
// authority on it. A file can be perfectly reachable while the specific symbol
// a declaration names has zero callers -- that is precisely the mayClaim case,
// which is why the two checks do not find the same set. Claims naming only a
// file path are reported here as unresolved and belong to that guard.
//
// RESIDUAL LIMIT, stated rather than hidden: a call to a DIFFERENT function
// that happens to share the name would still satisfy this. It is a drift
// detector, not a proof. What it can now prove is the specific claim "zero
// production call sites", which is the class of staleness it exists to catch.
const SCAN_DIRS = Object.freeze(['src', 'tools']);
const SCAN_EXCLUDE_DIR_NAMES = new Set(['node_modules', 'tests', '.git', 'scratch', 'coverage']);

// Prose forms that still name a real component, e.g.
//   "tools/owner-capture.js assertGatesAppendOnly() -- the ledger gate writer..."
//   "tools/standing-orders-hook.js#checkConsoleVisibility (agent-command refusal)"
const PROSE_HASH_REF_PATTERN = /([\w./-]+\.js)#([A-Za-z0-9_.]+)/g;
const PROSE_CALL_REF_PATTERN = /([\w./-]+\.js)\s+([A-Za-z_$][\w$]*)\s*\(\)/g;
const PROSE_FILE_PATTERN = /([\w./-]+\.js)/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A component reference that names a test file is not evidence of production wiring. */
function isProductionPath(file) {
  return !/^tests?[\\/]/.test(file) && !/[\\/]tests?[\\/]/.test(file);
}

/**
 * Every component reference an enforcingComponent names, in any of the shapes
 * the live mirror actually uses. Replaces the old all-or-nothing parse whose
 * `continue` silently exempted eight claims.
 *
 * @returns {{file: string, symbol: string|null}[]}
 */
function parseComponentReferences(enforcingComponent) {
  if (typeof enforcingComponent !== 'string' || enforcingComponent.trim() === '') return [];
  const byFile = new Map();
  const remember = (file, symbol) => {
    if (!isProductionPath(file)) return;
    const existing = byFile.get(file);
    if (existing === undefined || (existing.symbol === null && symbol !== null)) {
      byFile.set(file, { file, symbol });
    }
  };
  for (const match of enforcingComponent.matchAll(PROSE_HASH_REF_PATTERN)) {
    remember(match[1], match[2].split('.').pop() || null);
  }
  for (const match of enforcingComponent.matchAll(PROSE_CALL_REF_PATTERN)) {
    remember(match[1], match[2]);
  }
  for (const match of enforcingComponent.matchAll(PROSE_FILE_PATTERN)) {
    remember(match[1], null);
  }
  return [...byFile.values()];
}

function listJsFiles(root, dir, out = []) {
  const absolute = path.join(root, dir);
  // A directory that could not be enumerated is not an empty directory. Let
  // the read failure reach checkWiredDrift()'s caller; otherwise an unreadable
  // src/ or tools/ tree produces zero references and a definite wired verdict
  // from a scan that did not happen (or only happened in part).
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      listJsFiles(root, path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// String CONTENTS are blanked after comments are stripped. dependency-graph.js
// deliberately PRESERVES literals because it is hunting require() specifiers
// that live inside them; this checker wants the opposite, because an error
// message reading 'agent may not mayClaim()' is prose about the mechanism, not
// a call to it -- the same confusion HOLE 1 was made of. Length is preserved so
// reported line numbers stay true.
// REGEX LITERALS ARE TRACKED, and the reason is a measured one. The first
// version of this function scanned only for quote characters. tools/standing-
// orders-hook.js contains regex literals holding an unbalanced apostrophe, so
// that scanner entered "string mode" on one and stayed there, blanking 200
// lines of real code -- including the genuine call to checkConsoleVisibility at
// :1139 -- and the checker then reported that true declaration as hollow. An
// invented RED discredits a check exactly as fast as an invented GREEN, so the
// same regex-vs-division discipline dependency-graph.js uses is applied here.
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n', '']);

function blankStringLiteralContents(text) {
  const out = [];
  let state = 'code';
  let lastSignificant = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (state === 'code') {
      if (char === '\'' || char === '"' || char === '`') { state = char; out.push(char); index += 1; continue; }
      if (char === '/' && REGEX_PRECEDERS.has(lastSignificant)) { state = 'regex'; out.push(char); index += 1; continue; }
      out.push(char);
      if (char === '\n') lastSignificant = '\n';
      else if (!/\s/.test(char)) lastSignificant = char;
      index += 1;
      continue;
    }
    // Inside a literal: blank the contents, keep the delimiters and the newlines.
    if (char === '\\') {
      out.push(' ', index + 1 < text.length && text[index + 1] === '\n' ? '\n' : ' ');
      index += 2;
      continue;
    }
    if (char === '\n') {
      out.push('\n');
      // An unterminated regex cannot cross a newline; bail out rather than
      // swallowing the rest of the file.
      if (state === 'regex') { state = 'code'; lastSignificant = '\n'; }
      index += 1;
      continue;
    }
    if ((state === 'regex' && char === '/') || char === state) {
      out.push(char);
      state = 'code';
      lastSignificant = char;
      index += 1;
      continue;
    }
    out.push(' ');
    index += 1;
  }
  return out.join('');
}

/** Source with comments removed and string contents blanked: code, and only code. */
function codeOnly(text) {
  return blankStringLiteralContents(stripCommentsPreservingLiterals(text));
}

// A DECLARATION IS NOT A CALL. `function assertGatesAppendOnly(id, ...)` matches
// any "does SYM( appear" test, so without this the declaring line would prove
// its own claim. Blanked in place (length preserved) so reported lines stay true.
function blankDeclarations(code, symbol) {
  const escaped = escapeRegExp(symbol);
  const declarations = [
    new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\s*\\(`, 'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`, 'g'),
    new RegExp(`\\bclass\\s+${escaped}\\b`, 'g')
  ];
  let out = code;
  for (const re of declarations) out = out.replace(re, match => ' '.repeat(match.length));
  return out;
}

/**
 * Real production references to `symbol`, resolved against code rather than
 * bytes. A reference is a CALL (`symbol(` or `.symbol(`) or a require-
 * destructuring BINDING (`const { symbol } = require(...)`). A mention in a
 * comment, a doc block or a string is not a reference -- that distinction is
 * the entire point of this function.
 *
 * @returns {{file: string, line: number, kind: string, inDefiningFile: boolean}[]}
 */
function findProductionReferences(root, definingFile, symbol) {
  const definingRelative = definingFile.split(/[\\/]/).join(path.sep);
  const escaped = escapeRegExp(symbol);
  const patterns = [
    { kind: 'call', re: new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`) },
    { kind: 'member-call', re: new RegExp(`\\.\\s*${escaped}\\s*\\(`) },
    { kind: 'require-binding', re: new RegExp(`\\{[^{}]*(?<![\\w$])${escaped}(?![\\w$])[^{}]*\\}\\s*=\\s*require\\s*\\(`) }
  ];
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const relative of listJsFiles(root, dir)) {
      // Refuse the whole verdict when any contributing source file cannot be
      // read. Skipping it would turn "not measured" into "no reference" and
      // can make both wired:true and wired:false annotations look definite.
      const text = fs.readFileSync(path.join(root, relative), 'utf8');
      if (!text.includes(symbol)) continue; // cheap reject before the expensive strip
      // The defining file is SCANNED, not skipped. The old rule ("outside its
      // own defining file") was written for a library wired in from elsewhere,
      // and it is wrong for a CLI tool whose guard is invoked internally: it
      // scored tools/owner-capture.js#assertGatesAppendOnly hollow while
      // owner-capture.js really does call it at :410 and :441, and
      // tools/standing-orders-hook.js#checkConsoleVisibility hollow while that
      // file really does call it at :1139. Both declarations were true. A check
      // that invents red is discredited exactly as fast as one that invents
      // green, so declarations are blanked instead and in-file calls count.
      const code = blankDeclarations(codeOnly(text), symbol);
      for (const { kind, re } of patterns) {
        const match = code.match(re);
        if (!match) continue;
        hits.push({
          file: relative.split(path.sep).join('/'),
          line: code.slice(0, match.index).split('\n').length,
          kind,
          inDefiningFile: relative === definingRelative
        });
        break;
      }
    }
  }
  return hits;
}

/**
 * Re-verify every mechanical/advisory order's `wired` claim against a live
 * repo scan, instead of trusting the JSON's own say-so.
 *
 * @returns {{ok: boolean, issues: string[]}}
 */
function checkWiredDrift({ jsonPath = DEFAULT_JSON_PATH, root = path.join(__dirname, '..', '..') } = {}) {
  const issues = [];
  const unresolved = [];
  const doc = loadOrders({ jsonPath, force: true });
  for (const cls of doc.classes) {
    for (const order of cls.orders) {
      // discipline: never claimed a mechanism. retired: revoked, so there is no
      // live claim left to re-verify -- validateDoc() already refuses a retired
      // order that still names a component or a `wired` value, so reaching this
      // line with one is impossible; skipping explicitly keeps the intent
      // readable at the branch instead of relying on that invariant silently.
      if (order.enforcement === 'discipline' || order.enforcement === 'retired') continue;
      if (order.wired !== true && order.wired !== false) continue; // null: not yet claimed either way
      const refs = parseComponentReferences(order.enforcingComponent);
      const symbolRefs = refs.filter(ref => ref.symbol !== null);
      const label = `Class "${cls.id}" order ${order.number}`;

      // A claim naming no production symbol cannot be verified AT THIS GRAIN.
      // It is surfaced, never silently passed -- but it is not failed either,
      // because "does this file ever run?" is tools/invocation-guard.js's
      // question and answering it badly here would produce false reds on
      // genuinely-enforced orders, which is how a check earns being ignored.
      if (symbolRefs.length === 0) {
        unresolved.push(`${label}: wired:${order.wired} names no production "file.js#symbol" component`
          + `${refs.length > 0 ? ` (only file paths: ${refs.map(ref => ref.file).join(', ')})` : ''}`
          + ' -- not verifiable at symbol grain; file-level reachability is tools/invocation-guard.js.');
        continue;
      }

      const resolved = symbolRefs.map(ref => ({ ref, hits: findProductionReferences(root, ref.file, ref.symbol) }));
      const wired = resolved.filter(entry => entry.hits.length > 0);
      const named = symbolRefs.map(ref => `${ref.symbol} (${ref.file})`).join(', ');

      if (order.wired === true && wired.length === 0) {
        // Wording matters here: in-file calls DO count (see the note inside
        // findProductionReferences — the old "outside its own defining file"
        // rule invented red on CLI tools that invoke their own guard), so this
        // message must not claim an exclusion the scan no longer performs.
        issues.push(`${label}: wired:true for ${named}, but no production CALL or require-binding was found`
          + ' anywhere under src/ or tools/ (in-file calls count; tests/ never does). Mentions in comments,'
          + ' doc blocks and strings are not references -- this declaration claims mechanical enforcement'
          + ' that no code path performs.');
      }
      if (order.wired === false && wired.length > 0) {
        const where = wired[0].hits.map(hit => `${hit.file}:${hit.line}`).slice(0, 3).join(', ');
        issues.push(`${label}: wired:false for ${named}, but a production reference now exists (${where})`
          + ' -- this annotation is stale and needs re-verification.');
      }
    }
  }
  return { ok: issues.length === 0, issues, unresolved };
}

// --- enforcement gaps: prose-only orders, surfaced instead of accepted -------
//
// R95, the owner, on the loop this whole file exists inside: "its like a loop
// of me telling you things i want and how to do things, you doing it for a
// bit, and then forgetting, me telling you to build a system to prevent it,
// and then it repeats".
//
// The evidence from 2026-07-28/29 is unambiguous: every instruction that was
// MECHANICALLY WIRED held, and every instruction that existed only as PROSE
// drifted, without exception. checkConsistency() and checkWiredDrift() above
// already pin that the prose and the mirror cannot diverge and that a
// `wired:true` claim is not stale. Neither of them says anything about an
// order marked `enforcement:'discipline'` -- a prose-only order is currently
// *valid* by every check in this file, which means the mirror is at its most
// honest precisely where the system is at its weakest, and says nothing.
//
// unenforcedOrders() closes that: it is the standing, always-current answer to
// "which of the owner's instructions are load-bearing but depend entirely on
// an agent remembering to read them". It is a REPORT, not a gate -- a
// discipline order is not a bug, and some of them genuinely cannot be
// mechanized (see docs/ROLE-OPERATIONS.md §8's inherently-judgement table).
// The failure this closes is not "a prose order exists"; it is "nobody could
// see, at any moment, which orders were prose".

// \s+, not a literal space: STANDING-ORDERS.md is hard-wrapped, and RECORD 1a's
// claim really is split as "Mechanical\n   backstop:". A detector that missed a
// claim because of a line break would be the same class of false comfort it
// exists to catch.
const BACKSTOP_CLAIM = /mechanical\s+backstop/i;

// The retirement marker STANDING-ORDERS.md actually uses: a BOLD, block-leading
// "RETIRED" ("**RETIRED 2026-08-10 by the owner.**"). Bold-and-leading is not
// decoration, it is the discrimination: BROWSER 1's own block also contains the
// sentence "**Rule 2 below is NOT retired and is unaffected**", and a bare
// /retired/i would read that as retiring rule 2 -- inverting the one fact the
// prose was at pains to state. Requiring RETIRED to sit immediately after the
// bold delimiters excludes it, and excludes "allow-rule1-retired" (a log value
// quoted two lines earlier) for the same reason.
//
// STATED LIMIT: a future retirement written in some other form would not be
// seen here, and this direction would silently not fire. That is why the
// JSON->MD direction below is checked too: `enforcement:"retired"` in the
// mirror REQUIRES the marker in the prose, so the pair cannot drift apart from
// the side an agent is actually editing.
const RETIREMENT_MARKER = /\*\*\s*RETIRED\b/i;

/** Split one class section into per-order text blocks, in file order. */
function parseOrderBlocks(sectionText) {
  const orderPattern = /^(\d+[a-z]?)\.\s+\S/gm;
  const starts = [];
  let match;
  while ((match = orderPattern.exec(sectionText)) !== null) starts.push({ number: match[1], index: match.index });
  return starts.map((start, i) => ({
    number: start.number,
    text: sectionText.slice(start.index, i + 1 < starts.length ? starts[i + 1].index : sectionText.length)
  }));
}

/**
 * Every order whose compliance depends on an agent choosing to follow it.
 *
 * Two tiers, kept distinct because they fail differently:
 *   - `prose`      -- enforcement:'discipline'. Nothing checks it at all.
 *   - `unenforced` -- enforcement:'advisory', or 'mechanical' with wired!==true.
 *                     A correct mechanism exists and is callable, but nothing
 *                     blocks the wrong path. This is the exact shape the
 *                     McNair incident exposed: egress-preflight.js was written,
 *                     correct, and called by nobody.
 *
 *   - `partial`    -- mechanical and wired, but carrying a `coverageGap`: a
 *                     real route the mechanism cannot see. Counted apart from
 *                     `enforced` so total coverage is never implied by a
 *                     mechanism that only covers one route.
 *
 *   - `retired`    -- revoked by the owner. Deliberately its OWN bucket and not
 *                     folded into `prose`: a prose order is an instruction
 *                     nothing checks, and a retired order is not an instruction
 *                     at all. Putting it in `prose` would inflate the gap list
 *                     with work that does not exist and would tell a reading
 *                     agent to comply with a rule the owner deleted. It is also
 *                     kept out of the coverage FRACTION's denominator by
 *                     enforcementReport() for the same reason -- see `active`
 *                     there.
 *
 * @returns {{prose:object[], unenforced:object[], partial:object[], enforced:object[], retired:object[]}}
 */
function unenforcedOrders(options = {}) {
  const doc = loadOrders(options);
  const prose = [];
  const unenforced = [];
  const partial = [];
  const enforced = [];
  const retired = [];
  for (const cls of doc.classes) {
    for (const order of cls.orders) {
      const entry = {
        classId: cls.id, number: order.number, summary: order.summary,
        verbatim: order.verbatim || null, enforcement: order.enforcement,
        enforcingComponent: order.enforcingComponent || null,
        wired: Object.prototype.hasOwnProperty.call(order, 'wired') ? order.wired : null,
        coverageGap: typeof order.coverageGap === 'string' ? order.coverageGap : null,
        revocationPhrase: order.revocationPhrase || null,
        reference: order.reference || null
      };
      // Retired is tested FIRST. If it were tested after the mechanical branch,
      // a retired order that still carried a stale wired:true would be reported
      // as fully enforced -- reproducing, inside the very function that exists
      // to surface enforcement honestly, the exact bug this state was added to
      // fix. (validateDoc() also refuses that shape; both, not either.)
      if (order.enforcement === 'retired') retired.push(entry);
      else if (order.enforcement === 'discipline') prose.push(entry);
      else if (order.enforcement === 'mechanical' && order.wired === true) (entry.coverageGap ? partial : enforced).push(entry);
      else unenforced.push(entry);
    }
  }
  return { prose, unenforced, partial, enforced, retired };
}

/**
 * Catch the most dangerous kind of dishonesty in this pair of files: the prose
 * telling the reader an order has teeth when the mirror knows it does not.
 *
 * Three rules, from two incidents a fortnight apart in the same order:
 *
 *  (1) MD claims a "Mechanical backstop", mirror says discipline/retired.
 *      Written from BROWSER 1 in July 2026, when the .md read "Mechanical
 *      backstop: tools/standing-orders-hook.js ... It refuses (exit 2)" while
 *      the mirror recorded `discipline` with a null component.
 *
 *  (2) MD marks the order RETIRED, mirror still records it in force. Written
 *      from the SAME order in August 2026, when the owner revoked it, the prose
 *      and the hook were both updated, and the mirror was left declaring
 *      mechanical + wired:true. Rule (1) could not see this: it only ever
 *      looked for prose that OVERstated. Nothing looked for prose that had
 *      moved on.
 *
 *  (3) Mirror says retired, MD shows no retirement. The reverse pin, so an
 *      order cannot be revoked in the machine-readable file alone.
 *
 * Still deliberately one-directional on rule (1), for the same reason
 * checkConsistency()'s quote check is: a mechanical order need not narrate its
 * own mechanism in prose (LOCAL-WORK 3 does not), so "JSON says mechanical, MD
 * names no backstop" is not an error. Rules (2) and (3) ARE bidirectional,
 * because retirement is a discrete, checkable event rather than a description.
 *
 * @returns {{ok:boolean, issues:string[]}}
 */
function checkBackstopDrift({ mdPath = DEFAULT_MD_PATH, jsonPath = DEFAULT_JSON_PATH } = {}) {
  const issues = [];
  const mdText = fs.readFileSync(mdPath, 'utf8');
  const doc = loadOrders({ jsonPath, force: true });

  for (const section of parseClassSections(mdText)) {
    const jsonClass = doc.classes.find((entry) => entry.id === section.id);
    if (!jsonClass) continue; // checkConsistency() already reports a missing class
    for (const block of parseOrderBlocks(section.text)) {
      const order = jsonClass.orders.find((entry) => entry.number === block.number);
      if (!order) continue; // checkConsistency() already reports a missing order
      const mdRetires = RETIREMENT_MARKER.test(block.text);

      // (1) The original direction: prose promising teeth the mirror denies.
      if (BACKSTOP_CLAIM.test(block.text) && (order.enforcement === 'discipline' || order.enforcement === 'retired')) {
        issues.push(
          `Class "${section.id}" order ${block.number}: STANDING-ORDERS.md claims a "Mechanical backstop" for `
          + `this order, but standing-orders.json records it as enforcement:"${order.enforcement}" with no enforcing `
          + 'component. Either the prose is overstating the teeth this order has, or the mirror is stale. An '
          + 'agent reading only the .md would believe it was covered.'
        );
      }

      // (2) The direction that was missing, and the one that actually bit.
      // BROWSER 1 was retired in the prose and in the hook on 2026-08-10 while
      // this mirror went on recording it as mechanical + wired:true with a
      // component claiming it "refuses ... with exit 2". Nothing in this file
      // looked at that, because every check here ran from the mirror's own
      // claims outward. An agent reading only the JSON -- which is every
      // consumer of this module -- was told a revoked order was the most
      // strongly enforced kind there is. That is worse than the case above:
      // overstated teeth make an agent over-careful, a live claim on a dead
      // rule makes it refuse work the owner explicitly asked for.
      if (mdRetires && order.enforcement !== 'retired') {
        issues.push(
          `Class "${section.id}" order ${block.number}: STANDING-ORDERS.md marks this order RETIRED, but `
          + `standing-orders.json still records it as enforcement:"${order.enforcement}"`
          + `${order.enforcingComponent ? ` enforced by ${order.enforcingComponent}` : ''}`
          + `${order.wired === true ? ' with wired:true' : ''}. A revoked order must be enforcement:"retired" in `
          + 'the mirror. An agent reading only the JSON would still be obeying -- or enforcing -- a rule the '
          + 'owner deleted.'
        );
      }

      // (3) And the same pin from the other side, so the marker heuristic in
      // (2) cannot be the only thing holding this together: if the mirror says
      // retired, the prose must visibly say so too.
      if (order.enforcement === 'retired' && !mdRetires) {
        issues.push(
          `Class "${section.id}" order ${block.number}: standing-orders.json records enforcement:"retired", but `
          + 'STANDING-ORDERS.md carries no bold RETIRED marker for it. An order may not be quietly revoked in '
          + 'the machine-readable mirror while the prose an agent reads still presents it as in force.'
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * The owner-facing answer to "which of my instructions are actually enforced".
 * Composes the three existing checks with the gap list so a single call
 * produces the whole picture, including whether each check could be run at all.
 *
 * Honest-unknown throughout: a check that throws is reported as UNKNOWN with
 * its error, never dropped and never counted as passing.
 */
function enforcementReport(options = {}) {
  const run = (label, fn) => {
    try { return { name: label, ...fn() }; }
    catch (error) { return { name: label, ok: null, issues: [`UNKNOWN: ${label} could not run: ${error.message}`] }; }
  };
  // The gap list itself must not be able to crash the report. If the mirror
  // cannot be read, that is the single most important thing to SAY, and a
  // report that throws instead says nothing at all -- the same "failure mode
  // of an unowned duty is silence" shape this whole file exists inside.
  let gaps;
  let gapsError = null;
  try { gaps = unenforcedOrders(options); }
  catch (error) {
    gapsError = `UNKNOWN: the order list could not be read: ${error.message}`;
    gaps = { prose: [], unenforced: [], partial: [], enforced: [], retired: [] };
  }
  const checks = [
    run('checkConsistency', () => checkConsistency(options)),
    run('checkWiredDrift', () => checkWiredDrift(options)),
    run('checkBackstopDrift', () => checkBackstopDrift(options))
  ];
  if (gapsError) checks.unshift({ name: 'unenforcedOrders', ok: null, issues: [gapsError] });
  const total = gaps.prose.length + gaps.unenforced.length + gaps.partial.length
    + gaps.enforced.length + gaps.retired.length;
  // `active` -- orders actually in force -- is the denominator for the coverage
  // fraction, and retired orders are excluded from it on purpose.
  //
  // Both alternatives are dishonest in a specific direction. Counting a retired
  // order as unenforced invents a coverage gap for a rule that no longer needs
  // covering, and every such phantom drags the fraction down until the number
  // stops meaning anything. Counting it as enforced is worse: it would let
  // coverage be improved by DELETING rules. Excluding it makes the fraction
  // answer the only question worth asking -- "of the orders that bind me right
  // now, how many refuse at the moment of action" -- and `total` still reports
  // every entry in the file, so nothing disappears from view.
  const active = total - gaps.retired.length;
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total,
      active,
      enforced: gaps.enforced.length,
      partial: gaps.partial.length,
      unenforced: gaps.unenforced.length,
      prose: gaps.prose.length,
      retired: gaps.retired.length,
      enforcedFraction: active === 0 ? null : Number((gaps.enforced.length / active).toFixed(3))
    },
    ...gaps,
    checks,
    ok: checks.every((entry) => entry.ok === true)
  };
}

module.exports = {
  loadOrders,
  ordersForClass,
  getClass,
  classIds,
  classifyAction,
  checkConsistency,
  assertConsistent,
  checkWiredDrift,
  // Exported so a claim's evidence is citable (file:line) rather than a bare
  // boolean. A verdict nobody can audit is how the substring check survived.
  findProductionReferences,
  parseComponentReferences,
  unenforcedOrders,
  checkBackstopDrift,
  enforcementReport,
  DEFAULT_JSON_PATH,
  DEFAULT_MD_PATH
};
