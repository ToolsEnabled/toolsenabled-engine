// GREPSAVER orientation — the token-saving layer as an executable capability
// instead of a convention an agent has to remember.
//
// Today CLAUDE.md and AGENTS.md *tell* a session to read context/SYSTEMS.md and
// the right card before grepping. That only saves tokens when the session
// happens to comply. This turns the same routing into one call: give it a
// topic, get back the cards, doc-router lines, and tool namespaces that answer
// it, plus an explicit measurement of how much text was avoided.
//
// Honesty rules that are not negotiable here:
//   * Bytes are reported as bytes. Nothing in this file converts bytes to
//     tokens or claims a token saving — the ledger is explicit that bytes must
//     never be mislabeled as tokens.
//   * Cards are maps, not authority. Every packet says so, and stale/unknown
//     card status is surfaced rather than hidden.
//   * No secret-shaped line is ever emitted, even from a file the caller could
//     read directly.
//
// Usage:
//   node tools/grepsaver-orient.js "provider release gate"
//   node tools/grepsaver-orient.js --json "durable worker lease"
//   node tools/grepsaver-orient.js --limit 5 "dashboard"

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeText, looksSecret, toPosix } = require('./grepsaver-lib');

const ROOT = path.resolve(__dirname, '..');
const CONTEXT_DIR = process.env.TOOLSENABLED_GREPSAVER_CONTEXT
  ? path.resolve(process.env.TOOLSENABLED_GREPSAVER_CONTEXT)
  : path.join(ROOT, 'context');
const CONTEXT_ROOT = path.dirname(CONTEXT_DIR);
const SYSTEMS_JSON = path.join(CONTEXT_DIR, 'systems.json');
const DOCS_ROUTER = path.join(CONTEXT_DIR, 'DOCS.md');
const TOOL_DIGEST = path.join(CONTEXT_DIR, 'toolsenabled-tools.md');

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
// Bounded so an orientation packet can never itself become the token cost it
// exists to avoid.
const MAX_CARD_OUTLINE_LINES = 24;
const MAX_DOC_LINES = 8;
// Absolute relevance floor -- see the note at the ranking step. Identity tokens
// are weighted x8 and an exact id is +100, so a real hit clears this trivially;
// this only removes incidental one-word body collisions.
const ABSOLUTE_MIN_SCORE = 8;
// Questions this index structurally cannot answer: it maps static code on disk,
// and knows nothing about which MCP server is answering right now or which other
// agent already owns a piece of work. Both are the expensive things to guess
// wrong, so route them explicitly instead of returning a card.
const LIVE_STATE_HINTS = [
  'session', 'sessions', 'agent', 'agents', 'codex', 'claude', 'gemini', 'luna',
  'running', 'active', 'now', 'mcp', 'connected', 'tool', 'tools', 'capability',
  'available', 'working', 'in-flight', 'inflight', 'handoff', 'coordinate', 'coordination'
];
const MAX_NAMESPACES = 8;

// Some system-card terms intentionally name a subsystem rather than an MCP
// namespace (for example, "presence" and "wake" live behind task/system
// routes). Keep those associations closed and reviewable instead of making the
// router fall back to an arbitrary lexical match or returning no tools at all.
const TOPIC_NAMESPACE_HINTS = Object.freeze({
  toolsenabled: ['system', 'task', 'code'],
  agent: ['agent_comms', 'task', 'workspace', 'system'],
  lane: ['task', 'workspace', 'launch', 'system'],
  presence: ['task', 'workspace', 'system'],
  wake: ['task', 'system', 'workspace'],
  mission: ['launch', 'task', 'workspace', 'system'],
  bridge: ['launch', 'task', 'workspace', 'system'],
  secret: ['system', 'owner_identity'],
  store: ['system', 'owner_identity'],
  internal: ['repo', 'workspace', 'system'],
  vcs: ['repo', 'workspace', 'system'],
  repo: ['repo', 'workspace', 'system'],
  sync: ['repo', 'workspace', 'system'],
  error: ['system', 'audit'],
  taxonomy: ['system', 'audit'],
});

// Words that match everything and therefore rank nothing.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on',
  'with', 'how', 'what', 'where', 'why', 'do', 'does', 'i', 'we', 'my', 'this',
  'that', 'be', 'are', 'was', 'can', 'get', 'find', 'show', 'me', 'about'
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
}

function readIfPresent(filePath) {
  try {
    return normalizeText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function byteLength(text) {
  return Buffer.byteLength(text ?? '', 'utf8');
}

function safeSizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (cause) {
    const error = new Error(`cannot measure GrepSaver input ${toPosix(filePath)}: ${cause.message}`);
    error.code = 'GREPSAVER_INPUT_UNAVAILABLE';
    throw error;
  }
}

/**
 * Score a candidate by how many distinct query terms it contains. Repeats do
 * not compound: a card that says "calendar" forty times should not outrank one
 * that actually matches two different terms.
 */
function scoreAgainst(queryTerms, haystack) {
  if (!haystack) return 0;
  const lower = haystack.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (lower.includes(term)) hits += 1;
  }
  return hits;
}

function loadSystems() {
  let raw;
  try {
    raw = normalizeText(fs.readFileSync(SYSTEMS_JSON, 'utf8'));
  } catch (cause) {
    if (cause.code !== 'ENOENT') {
      // Only absence authorizes the documented in-memory fallback. Treating a
      // permissions or I/O failure as absence would replace an index we could
      // not establish with a confidently regenerated answer.
      const error = new Error(`context/systems.json cannot be read: ${cause.message}`);
      error.code = 'GREPSAVER_SYSTEMS_INDEX_UNAVAILABLE';
      throw error;
    }
    raw = null;
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.systems)) {
        const error = new Error('context/systems.json does not contain a systems array');
        error.code = 'GREPSAVER_SYSTEMS_INDEX_INVALID';
        throw error;
      }
      if (!parsed.systems.length) {
        const error = new Error('context/systems.json contains no system records');
        error.code = 'GREPSAVER_SYSTEMS_INDEX_UNAVAILABLE';
        throw error;
      }
      return { systems: parsed.systems, source: 'generated-file' };
    } catch (cause) {
      if (cause.code === 'GREPSAVER_SYSTEMS_INDEX_INVALID' || cause.code === 'GREPSAVER_SYSTEMS_INDEX_UNAVAILABLE') throw cause;
      // A corrupt index is a reportable condition, not a silent empty result.
      const error = new Error('context/systems.json is present but not valid JSON');
      error.code = 'GREPSAVER_SYSTEMS_INDEX_INVALID';
      throw error;
    }
  }

  // systems.json is per-machine generated output and intentionally ignored. A
  // fresh clone still has cards, so derive the same index in memory rather than
  // making orientation depend on a preliminary write command. `--check`
  // remains the explicit, non-writing freshness signal for the missing file.
  const { computeTarget } = require('./grepsaver-reindex.js');
  const target = computeTarget(CONTEXT_DIR);
  if (target.errors.length) {
    const error = new Error(`cannot derive an in-memory GrepSaver index: ${target.errors.join('; ')}`);
    error.code = 'GREPSAVER_SYSTEMS_INDEX_UNAVAILABLE';
    throw error;
  }
  if (!target.state.systems.length) {
    const error = new Error(`cannot derive an in-memory GrepSaver index: no system cards found in ${CONTEXT_DIR}`);
    error.code = 'GREPSAVER_SYSTEMS_INDEX_UNAVAILABLE';
    throw error;
  }
  return { systems: target.state.systems, source: 'generated-in-memory' };
}

/**
 * Pull a card's shape — its headings, plus any line that carries a port, path,
 * command, or entry point. That is what a session actually needs to orient;
 * the prose between headings is what it does not.
 */
function outlineCard(cardText) {
  if (!cardText) return [];
  const lines = cardText.split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (looksSecret(trimmed)) continue;
    const isHeading = /^#{1,4}\s+\S/.test(trimmed);
    const isLoadBearing = /^[-*]\s+/.test(trimmed) && /(port|`|http:\/\/|https:\/\/|\.js|\.ps1|\.json|\.md|npm |node )/i.test(trimmed);
    if (isHeading || isLoadBearing) {
      kept.push(trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed);
    }
    if (kept.length >= MAX_CARD_OUTLINE_LINES) break;
  }
  return kept;
}

function matchDocRouter(queryTerms) {
  const text = readIfPresent(DOCS_ROUTER);
  if (!text) return { lines: [], antiRoutes: [], bytes: 0, available: false };
  const lines = text.split('\n');
  const scored = [];
  let antiRoutes = [];
  let inAntiRoutes = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s/.test(trimmed)) inAntiRoutes = /anti-route/i.test(trimmed);
    if (inAntiRoutes && /^[-*]\s+/.test(trimmed)) {
      antiRoutes.push(trimmed);
      continue;
    }
    if (!/^[-*]\s+/.test(trimmed)) continue;
    if (looksSecret(trimmed)) continue;
    const score = scoreAgainst(queryTerms, trimmed);
    if (score > 0) scored.push({ score, line: trimmed });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    lines: scored.slice(0, MAX_DOC_LINES).map(entry => entry.line),
    antiRoutes,
    bytes: byteLength(text),
    available: true
  };
}

function matchToolNamespaces(queryTerms) {
  const text = readIfPresent(TOOL_DIGEST);
  if (!text) return { namespaces: [], bytes: 0, available: false };
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+([a-z0-9_]+)\s+\((\d+)\)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { namespace: heading[1], toolCount: Number(heading[2]), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);

  const hintedNamespaces = new Set();
  for (const term of queryTerms) {
    const singular = term.endsWith('s') ? term.slice(0, -1) : term;
    for (const hint of TOPIC_NAMESPACE_HINTS[term] || TOPIC_NAMESPACE_HINTS[singular] || []) hintedNamespaces.add(hint);
  }

  const scored = sections
    .map(section => ({
      namespace: section.namespace,
      toolCount: section.toolCount,
      lexicalScore: scoreAgainst(queryTerms, `${section.namespace} ${section.body}`),
      hinted: hintedNamespaces.has(section.namespace),
    }))
    // Once a closed system route is available, keep the result to that route.
    // An incidental description word must not leak a Chrome-Web-Store or
    // sidecar namespace into a Mission Bridge answer merely because it happened
    // to score lexically in a long tool description.
    .filter(entry => hintedNamespaces.size ? entry.hinted : entry.lexicalScore > 0)
    .sort((a, b) => Number(b.hinted) - Number(a.hinted) || b.lexicalScore - a.lexicalScore || a.namespace.localeCompare(b.namespace));

  return {
    namespaces: scored.slice(0, MAX_NAMESPACES).map(({ namespace, toolCount, lexicalScore, hinted }) => ({
      namespace, toolCount, source: lexicalScore > 0 ? 'lexical' : (hinted ? 'system-route' : 'unknown'),
    })),
    bytes: byteLength(text),
    available: true
  };
}

/**
 * Build one orientation packet for a topic.
 *
 * The returned `measurement` block is deliberately conservative: `bytesAvoided`
 * counts only files this packet actually replaces reading in full, and is
 * labelled as an upper bound on avoided *reading*, not as a token saving.
 */
function orient(query, options = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT));
  const queryTerms = tokenize(query);
  if (!queryTerms.length) {
    const error = new Error('the orientation query has no searchable terms');
    error.code = 'GREPSAVER_ORIENT_EMPTY_QUERY';
    throw error;
  }

  const index = loadSystems();
  const systems = index.systems;
  const candidates = systems.map(system => {
    const cardPath = system.card ? path.join(CONTEXT_ROOT, system.card) : null;
    const cardText = cardPath ? readIfPresent(cardPath) : null;
    // Identity beats prose, and id/name beat path. Three separate weights,
    // because collapsing them mis-ranks in a specific and costly way: sibling
    // projects nested under a parent directory all carry the parent's name in
    // their path, so a path-weighted query for the parent surfaces the
    // children first and sends the reader to the wrong card.
    const idTokens = tokenize(`${system.id} ${system.name}`);
    const exactIdMatch = queryTerms.some(term => term === String(system.id).toLowerCase());
    const identityScore = scoreAgainst(queryTerms, idTokens.join(' ')) * 8;
    const pathScore = scoreAgainst(queryTerms, toPosix(system.path ?? ''));
    const bodyScore = scoreAgainst(queryTerms, cardText ?? '');
    const score = (exactIdMatch ? 100 : 0) + identityScore + pathScore + bodyScore;
    return { system, cardPath, cardText, score };
  });

  const ranked = candidates
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.system.id).localeCompare(String(b.system.id)));

  // Relevance floor. A weak match is worse than no match: it sends the reader
  // to the wrong card and costs the tokens this tool exists to save. Anything
  // scoring under 40% of the best hit is dropped.
  const topScore = ranked.length ? ranked[0].score : 0;
  // Verified empirically: dropping this floor to 1 makes "durable worker lease"
  // return an unrelated nested site, because a single incidental body hit is
  // enough to win when nothing matches well. A stated coverage gap plus the
  // right doc-router lines beats a confidently wrong card.
  // ...but that floor is RELATIVE, so when the best hit is itself noise every
  // near-noise hit clears it. Measured 2026-07-29: "gmail thread read" returned
  // openclaw-gateway + portfolio-dashboard + servercontrol, and "what are other
  // agent sessions working on" returned the KB literature card -- three and one
  // confidently wrong answers to questions no card covers.
  //
  // The cause is a coverage fact worth stating plainly: this index maps the
  // OTHER PROJECTS on this machine (ServerControl, Portfolio Dashboard,
  // LEAN-bench, KB, ...). ToolsEnabled itself has ONE whole-repo card, so
  // in-repo questions ("fleet supervisor", "durable worker lease") legitimately
  // match nothing and must say so instead of returning the nearest stranger.
  //
  // Hence an ABSOLUTE floor as well. Identity hits are weighted x8 and an exact
  // id is +100, so a genuine match clears 8 easily; incidental single-word body
  // hits score 1-3 and are exactly what this drops.
  const floor = Math.max(ABSOLUTE_MIN_SCORE, topScore * 0.4);
  const matched = ranked.filter(entry => entry.score >= floor).slice(0, limit);
  const weakMatchesDropped = ranked.length - matched.length;
  // True when something matched, but only weakly enough to be misleading.
  const belowAbsoluteFloor = ranked.length > 0 && topScore < ABSOLUTE_MIN_SCORE;

  const liveStateAsked = queryTerms.some(term => LIVE_STATE_HINTS.includes(term));

  const docs = matchDocRouter(queryTerms);
  const tools = matchToolNamespaces(queryTerms);

  const cards = matched.map(entry => ({
    id: entry.system.id,
    name: entry.system.name,
    path: entry.system.path ? toPosix(entry.system.path) : null,
    card: entry.system.card ? toPosix(entry.system.card) : null,
    ports: Array.isArray(entry.system.ports) ? entry.system.ports : [],
    // Freshness is surfaced, never smoothed over. A STALE card is still worth
    // reading; silently presenting it as current is what would be wrong.
    status: entry.system.status ?? 'unknown',
    staleSince: entry.system.stale_since ?? null,
    outline: outlineCard(entry.cardText),
    cardBytes: entry.cardPath ? safeSizeOf(entry.cardPath) : 0,
    availability: entry.cardText === null
      ? { state: 'unavailable', why: `Card cannot be read: ${entry.system.card ?? 'no card path is recorded'}` }
      : { state: 'available' }
  }));

  const unavailableInputs = [];
  if (!docs.available) unavailableInputs.push({ input: 'doc-router', path: 'context/DOCS.md', why: 'file is missing or unreadable' });
  if (!tools.available) unavailableInputs.push({ input: 'tool-digest', path: 'context/toolsenabled-tools.md', why: 'file is missing or unreadable' });
  for (const card of cards) {
    if (card.availability.state !== 'available') {
      unavailableInputs.push({ input: `card:${card.id}`, path: card.card, why: card.availability.why });
    }
  }

  const packet = {
    schemaVersion: 'grepsaver-orientation-v1',
    query,
    queryTerms,
    generatedAt: new Date().toISOString(),
    cards,
    docRouter: docs.lines,
    antiRoutes: docs.antiRoutes,
    toolNamespaces: tools.namespaces,
    availability: unavailableInputs.length
      ? { state: 'degraded', unavailableInputs }
      : { state: 'available', unavailableInputs: [] },
    // A query that matches nothing is a coverage gap, not a failure. Saying so
    // is the difference between the reader trying a different word and the
    // reader falling back to grepping the whole tree — which is the cost this
    // layer exists to avoid.
    coverage: cards.length
      ? { state: 'matched', candidateCount: ranked.length, weakMatchesDropped }
      : {
        state: belowAbsoluteFloor ? 'matched-too-weakly-to-report' : 'no-carded-system-matched',
        candidateCount: ranked.length,
        weakMatchesDropped,
        advice: belowAbsoluteFloor
          ? 'Something matched, but only on an incidental word, so it is withheld rather than sent as an '
            + 'answer. This index maps the OTHER projects on this machine; ToolsEnabled itself has one '
            + 'whole-repo card, so in-repo questions often land here legitimately. Use the code.* tools '
            + 'for symbols and search.query for prose before grepping the tree.'
          : 'The system may exist but be uncarded. Check context/SYSTEMS.md, then fall back to search.query before grepping the tree.'
      },
    // Live state is a different question from where-is-the-code, and this index
    // cannot answer it at any relevance score: it reads static files. Asking it
    // "what is codex doing" returned a literature-review card. Route instead.
    liveState: liveStateAsked
      ? {
        state: 'not-answerable-here',
        why: 'This packet is built from static files (context/systems.json, DOCS.md, the tool digest). '
          + 'It knows nothing about which MCP server is currently answering or which other agent session '
          + 'already owns this work.',
        run: 'node tools/agent-preflight.js'
      }
      : null,
    trust: 'Cards and doc-router lines are maps, not authority. Verify any load-bearing claim against live files before acting on it, and never before a destructive edit.',
    contentTrust: 'untrusted'
  };

  packet.index = { source: index.source };

  const returnedBytes = byteLength(JSON.stringify(packet));
  // Upper bound on reading avoided: the matched cards in full, plus the router
  // and the tool digest, which this packet exists to stand in for.
  const avoidedBytes = cards.reduce((total, card) => total + card.cardBytes, 0) + docs.bytes + tools.bytes;

  packet.measurement = {
    unit: 'bytes',
    returnedBytes,
    sourceBytesAvoidedUpperBound: Math.max(0, avoidedBytes - returnedBytes),
    matchedSystemCount: cards.length,
    indexedSystemCount: systems.length,
    note: 'Bytes only. This is an upper bound on source text not read, not a token or cost saving; a matched-baseline measurement is required before any savings claim.'
  };

  return packet;
}

function renderMarkdown(packet) {
  const out = [];
  out.push(`# Orientation: ${packet.query}`);
  out.push('');
  // FIRST, not last: when the question is about live state, the routing is the
  // answer and any card below it is at best background. Burying it under a card
  // is how "what is codex doing" got answered with a literature review.
  if (packet.liveState) {
    out.push('> **Live state is not answerable from this index.** '
      + `${packet.liveState.why} Run: \`${packet.liveState.run}\``);
    out.push('');
  }
  if (!packet.cards.length) {
    out.push(`**No carded system matched.** ${packet.coverage.advice}`);
    out.push('');
  }
  for (const card of packet.cards) {
    const ports = card.ports.length ? ` · ports ${card.ports.join(', ')}` : '';
    const stale = card.status === 'fresh' ? '' : ` · **${card.status}**${card.staleSince ? ` since ${card.staleSince}` : ''}`;
    out.push(`## ${card.name} (\`${card.id}\`)`);
    out.push(`\`${card.path ?? 'path unknown'}\`${ports}${stale}`);
    out.push(`Card: \`${card.card ?? 'none'}\``);
    if (card.availability?.state !== 'available') {
      out.push(`**Card unavailable:** ${card.availability?.why ?? 'the card could not be read'}`);
    }
    if (card.outline.length) {
      out.push('');
      for (const line of card.outline) out.push(line);
    }
    out.push('');
  }
  if (packet.availability?.state === 'degraded') {
    out.push('## Unavailable inputs');
    for (const input of packet.availability.unavailableInputs) {
      out.push(`- \`${input.path ?? input.input}\`: ${input.why}`);
    }
    out.push('');
  }
  if (packet.docRouter.length) {
    out.push('## Relevant docs');
    for (const line of packet.docRouter) out.push(line);
    out.push('');
  }
  if (packet.toolNamespaces.length) {
    out.push('## Tool namespaces');
    for (const entry of packet.toolNamespaces) {
      out.push(`- \`${entry.namespace}\` (${entry.toolCount} tools)`);
    }
    out.push('');
  }
  if (!packet.cards.length && packet.coverage) {
    out.push('## Coverage');
    out.push(`\`${packet.coverage.state}\` — ${packet.coverage.advice}`);
    out.push('');
  }
  if (packet.antiRoutes.length) {
    out.push('## Do not');
    for (const line of packet.antiRoutes) out.push(line);
    out.push('');
  }
  out.push(`> ${packet.trust}`);
  out.push('');
  out.push(`_${packet.measurement.returnedBytes} bytes returned; up to ${packet.measurement.sourceBytesAvoidedUpperBound} source bytes not read. Bytes, not tokens._`);
  return out.join('\n');
}

// Exit codes for the CLI. Until now this tool exited 0 while printing "No
// carded system matched" — including for "trademark", with six documents of
// trademark research sitting in docs/. Exit 0 is what every caller reads as
// "fine, nothing to see", so the fleet redid the work.
//
// `orient()` itself is deliberately untouched: agent-onboarding.js and the
// existing tests consume the packet, not the process status.
const ORIENT_EXIT = Object.freeze({
  FOUND: 0,     // a card matched, or prior work exists in the corpus
  USAGE: 2,
  NOTHING: 3,   // both indexes were read in full and neither knows this topic
  UNKNOWN: 4    // an index could not be consulted — NOT the same as "nothing"
});

/**
 * The card index maps CODE. It structurally cannot hold a research finding —
 * CARD-TEMPLATE.md requires system/source_path/fingerprint/entry-points/PORTS,
 * and "USPTO returned zero hits across nine query forms" has no shape there.
 * That is why a card miss must not be reported as an answer on its own: the
 * question is "does this exist", and half the corpus was never consulted.
 */
function priorWorkFor(query) {
  try {
    return require('./prior-work-index').query(query, { limit: 6 });
  } catch (error) {
    return { outcome: 'unknown', reason: 'PRIOR_WORK_INDEX_FAILED', results: [],
      why: `the prior-work index could not be consulted: ${error.message}` };
  }
}

function renderPriorWork(priorWork) {
  const out = [];
  if (priorWork.outcome === 'hit') {
    out.push('## Prior work on this topic — READ BEFORE STARTING');
    out.push(`${priorWork.totalCandidates} document(s) already address this topic. `
      + 'A card miss above means the CODE is uncarded, not that the topic is unexplored.');
    for (const hit of priorWork.results) out.push(`- \`${hit.path}\` — ${hit.title} (${hit.modified})`);
    out.push('');
  } else if (priorWork.outcome === 'miss') {
    out.push('## Prior work on this topic');
    out.push(`None. ${priorWork.indexedFileCount} files across docs/, reports/ and context/ were read `
      + 'in full and none is about this. This is a genuine gap, not a failed lookup.');
    out.push('');
  } else {
    out.push('## ⚠ Prior work on this topic — UNKNOWN');
    out.push(`${priorWork.why} This is NOT a finding that the topic is unexplored; do not redo work on it.`);
    out.push('');
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  let asJson = false;
  let limit = DEFAULT_LIMIT;
  const words = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') asJson = true;
    else if (arg === '--limit') {
      limit = Number(args[index + 1]);
      index += 1;
    } else words.push(arg);
  }
  const query = words.join(' ').trim();
  if (!query) {
    process.stderr.write('usage: node tools/grepsaver-orient.js [--json] [--limit N] "<topic>"\n');
    process.exitCode = ORIENT_EXIT.USAGE;
    return;
  }

  let packet = null;
  let cardIndexFailed = null;
  try {
    packet = orient(query, { limit });
  } catch (error) {
    // A broken card index is UNKNOWN, not "nothing matched". Keep going: the
    // prior-work index is independent and may well answer the question.
    cardIndexFailed = error;
  }

  const priorWork = priorWorkFor(query);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ...(packet || { schemaVersion: 'grepsaver-orientation-v1', query, cards: [] }),
      cardIndex: cardIndexFailed
        ? { state: 'unavailable', code: cardIndexFailed.code ?? 'GREPSAVER_ORIENT_FAILED', why: cardIndexFailed.message }
        : { state: 'available' },
      priorWork
    }, null, 2)}\n`);
  } else {
    const out = [];
    if (packet) {
      out.push(renderMarkdown(packet));
    } else {
      out.push(`# Orientation: ${query}`);
      out.push('');
      out.push(`**⚠ The card index could not be read** (${cardIndexFailed.code ?? 'GREPSAVER_ORIENT_FAILED'}: `
        + `${cardIndexFailed.message}). Nothing below rules out an existing carded system.`);
    }
    out.push('');
    out.push(...renderPriorWork(priorWork));
    process.stdout.write(`${out.join('\n')}\n`);
  }

  // The combined verdict. A hit in EITHER index means the topic is covered.
  const cardHit = Boolean(packet && packet.cards.length);
  if (cardHit || priorWork.outcome === 'hit') process.exitCode = ORIENT_EXIT.FOUND;
  else if (cardIndexFailed || priorWork.outcome === 'unknown') process.exitCode = ORIENT_EXIT.UNKNOWN;
  else process.exitCode = ORIENT_EXIT.NOTHING;
}

if (require.main === module) main(process.argv);

module.exports = { orient, renderMarkdown, tokenize, outlineCard, ORIENT_EXIT };
