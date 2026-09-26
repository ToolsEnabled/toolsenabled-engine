'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHIPPED_FILES = Object.freeze([
  'PRIVACY-POLICY.md',
  'src/lib/cloud-agent/cloud-mirror.js',
  'src/lib/owner-request-provenance.js',
  'src/lib/owner-capture-spool.js',
  'src/lib/machine-profile.js',
  'src/lib/r-ledger.js',
  'src/lib/providers/agent-comms-local.js',
  'src/lib/agent-session-observer.js',
  'src/lib/agent-engine/claude-cli-process.js',
  'src/lib/mission-bridge/owner-prompts.js',
  'src/lib/owner-authorization.js',
  'src/lib/agent-onboarding.js',
  'config/agent-org.json',
  'config/payload-boundary.json',
  'config/cloud-mirror-boundary.json',
  'config/settings-registry.json',
  'config/model-floor.json',
  'config/agent-allotment.json',
  'config/capability-features.json',
  'config/clarify-gate.json',
  'config/agent-digest.json',
  'config/dependency-acceptance.json',
  'src/lib/model-floor.js',
  'src/lib/tool-registry.js',
  'src/lib/controller-launch-record.js',
  'src/lib/providers/duo-desktop.js',
  'tools/ledger-archive.js',
  'src/lib/request-version/version-chain.js',
  'src/lib/request-version/legacy-dotted-disposition.js',
  'src/lib/owner-request-scope-proposal.js',
  'tools/record-luna-worktree-policy.js',
  'tools/run-luna-worktree-lane.ps1',
  'src/lib/intent-fidelity.js',
  'src/lib/controller-projection.js',
  'src/lib/action-guards.js',
  'src/lib/agent-wake.js',
  'src/lib/secret-store/requirements.js',
  'src/lib/service-control.js',
  'src/lib/supervision/observer.js',
  'tools/coordinator-duty-host.js'
]);

// PRIVATE MARKERS LIVE OUTSIDE THE TREE. Exact historical customer quotes and
// the names of private working trees or repositories are what this gate keeps
// out of shipped source, so the gate cannot carry them itself -- not as text,
// not split into fragments, and not as digests: a digest published with its
// length and first/last characters confirms a guessed phrase. A maintainer who
// holds such a list supplies it out of tree, as JSON of the shape
//   { "schemaVersion": 1, "quotes": ["..."], "treeNames": ["..."] }
// named by TE_PAYLOAD_PRIVACY_MARKERS, or else found as
// payload-privacy-markers.json in the per-user directory that also holds the
// owner-data identity profile (tools/check-no-owner-data.mjs). A file named
// explicitly must exist; the default location may be absent, and then these
// two private assertions are skipped and the summary line says so. Every
// generic check below runs either way. Generic product vocabulary does not
// belong in the list: owner, provenance, verbatim, and request ids are valid.
const PRIVATE_MARKERS_ENV = 'TE_PAYLOAD_PRIVACY_MARKERS';
const PRIVATE_MARKERS_BASENAME = 'payload-privacy-markers.json';
function defaultPrivateMarkersPath() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (base) return path.join(base, 'ToolsEnabled', PRIVATE_MARKERS_BASENAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'toolsenabled', PRIVATE_MARKERS_BASENAME);
  const home = os.homedir();
  return home ? path.join(home, '.config', 'toolsenabled', PRIVATE_MARKERS_BASENAME) : null;
}
function markerList(parsed, key, file) {
  const list = parsed[key] === undefined ? [] : parsed[key];
  assert.ok(Array.isArray(list), `${file}: "${key}" must be an array of strings`);
  for (const [index, value] of list.entries()) {
    assert.ok(typeof value === 'string' && value.trim().length >= 3,
      `${file}: ${key}[${index}] must be a string of at least 3 characters`);
  }
  return Object.freeze(list.map(value => value.toLowerCase()));
}
function loadPrivateMarkers() {
  const named = typeof process.env[PRIVATE_MARKERS_ENV] === 'string' && process.env[PRIVATE_MARKERS_ENV].trim();
  const file = named ? path.resolve(named) : defaultPrivateMarkersPath();
  if (!file || (!named && !fs.existsSync(file))) return null;
  assert.ok(fs.existsSync(file), `${PRIVATE_MARKERS_ENV} names a private marker file that does not exist`);
  const relative = path.relative(ROOT, file);
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative),
    'the private marker file must live outside this checkout, where no commit can pick it up');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // Name the file and the error class only: never echo the private contents.
    assert.fail(`private marker file ${file} is unreadable (${error.name})`);
  }
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.schemaVersion === 1,
    `private marker file ${file} must be a JSON object with schemaVersion 1`);
  return Object.freeze({
    quotes: markerList(parsed, 'quotes', file),
    treeNames: markerList(parsed, 'treeNames', file)
  });
}
const PRIVATE_MARKERS = loadPrivateMarkers();

const FORBIDDEN = Object.freeze([
  'R1186 outage',
  'publishes the whole working tree'
]);

for (const relative of SHIPPED_FILES) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8').toLowerCase();
  if (PRIVATE_MARKERS) {
    // Report the marker's position in the private list, never its text.
    const hit = PRIVATE_MARKERS.quotes.findIndex(quote => source.includes(quote));
    assert.equal(hit, -1, `${relative} contains a known customer quote (private marker quotes[${hit}])`);
  }
  for (const phrase of FORBIDDEN) {
    assert.equal(source.includes(phrase.toLowerCase()), false,
      `${relative} contains a known customer-specific phrase or incident marker: ${phrase}`);
  }
}

const sourceBoundary = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'payload-boundary.json'), 'utf8'));
assert.equal(sourceBoundary.status, 'owner-ratified', 'the source boundary must remain explicitly approved');
assert.equal(Object.hasOwn(sourceBoundary, '$openQuestions'), false,
  'a customer boundary must not ship the builder\'s unresolved planning questions');
assert.equal(Object.hasOwn(sourceBoundary, '$mechanismGaps'), false,
  'a customer boundary must not ship the builder\'s historical mechanism-gap record');
const publishable = new Set(sourceBoundary.open.paths);
for (const relative of SHIPPED_FILES) {
  assert.equal(publishable.has(relative), true,
    `${relative} is privacy-scanned but is no longer in the real publishable manifest`);
}

// Private builder tree and repository names come from the same out-of-tree
// marker file as the quotes above, for the same reason: a list of names to
// keep out of published source must not itself publish them.
if (PRIVATE_MARKERS && PRIVATE_MARKERS.treeNames.length) {
  for (const relative of sourceBoundary.open.paths) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8').toLowerCase();
    const hit = PRIVATE_MARKERS.treeNames.findIndex(name => source.includes(name));
    assert.equal(hit, -1,
      `${relative} contains a private builder tree/repository marker (private marker treeNames[${hit}])`);
  }
}
for (const relative of SHIPPED_FILES) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  assert.doesNotMatch(source, /owner directive\s+20\d\d-|owner ruling\s+20\d\d-/i,
    `${relative} carries dated builder authority instead of current installation policy`);
}

const FILE_FORBIDDEN = Object.freeze({
  'config/settings-registry.json': [
    /"derivedFrom"\s*:\s*"[^"]*\b[QR]\d/i,
    /"derivedFrom"\s*:\s*"[^"]*owner directive/i,
    /"derivedFrom"\s*:\s*"[^"]*20\d\d-\d\d-\d\d/i
  ],
  'config/model-floor.json': [/\bR(?:58|95)\b/],
  'src/lib/model-floor.js': [/\bR(?:58|95)\b/, /Vertex credit|billing account|owner quote/i],
  'src/lib/tool-registry.js': [/\bR(?:58|95)\b/],
  'src/lib/controller-launch-record.js': [/\bR(?:1065|1135)\b/],
  'src/lib/providers/duo-desktop.js': [/\bR86\b/, /EXACT_APPROVAL_OWNER_REQUEST_ID/],
  'tools/ledger-archive.js': [/\bR(?:44|51|70|241)\b/, /PROTECTED_REQUEST_IDS/],
  'src/lib/request-version/version-chain.js': [/\bR1065\b/, /KNOWN_AMENDMENT_RULE_KEYS/],
  'tools/record-luna-worktree-policy.js': [/\bR240\b/],
  'tools/run-luna-worktree-lane.ps1': [/\bR240\b/],
  'src/lib/request-version/legacy-dotted-disposition.js': [
    /\bR(?:25|52|54|94|99|101|133|135|137|138|139|147|148|1069|1162)(?:\.1)?\b/
  ],
  'src/lib/owner-request-scope-proposal.js': [
    /\bR(?:179|199|219|220|244|245|246|247|248|249|250|260|1010|1036|1037|1078|1079|1123|1131|1138|1145|1158|1162|1163)\b/,
    /DIRECTIVE-COHERENCE|OWNER-DECISION-COUNCIL/i
  ],
  'src/lib/agent-session-observer.js': [
    /BUILD-QUEUE\.md|\bQ27\b|Sol\s+1\.0x|Terra\s+0\.5x|Luna\s+0\.2x/i
  ],
  'src/lib/intent-fidelity.js': [/\bR77\b/, /personal .*\.codex|owner configuration/i],
  'config/dependency-acceptance.json': [/\bR1162\b/],
  'src/lib/action-guards.js': [/\bR(?:49|1162)\b/],
  'src/lib/agent-wake.js': [/\bR1146\b/],
  'src/lib/secret-store/requirements.js': [/\bR1131\b|DISABLED_OWNER_DIRECTIVE/i],
  'src/lib/service-control.js': [/\bR1131\b|\bQ116\.5\b/],
  'src/lib/supervision/observer.js': [/\bR(?:93|1131)\b|\bQ39\b/],
  'tools/coordinator-duty-host.js': [/\bR1131\b|\bQ116\.5\b/]
});
for (const [relative, patterns] of Object.entries(FILE_FORBIDDEN)) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  for (const pattern of patterns) {
    assert.doesNotMatch(source, pattern,
      `${relative} retains prior-customer authority or provenance matched by ${pattern}`);
  }
}

const privacyPolicy = fs.readFileSync(path.join(ROOT, 'PRIVACY-POLICY.md'), 'utf8');
for (const disclosure of [
  /optional, explicit-opt-in feature/i,
  /exact private GitHub repository you selected/i,
  /each customer must create or supply a dedicated private GitHub\s+repository in an account they control/i,
  /no ToolsEnabled-owned or default repository/i,
  /no preconfigured repository name/i,
  /no fallback destination/i,
  /refuses a public repository/i,
  /tracked source snapshot/i,
  /GitHub's\s+privacy, security, and retention terms apply/i,
  /keeps local Cloud Mirror state/i,
  /publication receipts and bounded receipt\s+history/i
]) {
  assert.match(privacyPolicy, disclosure, `Cloud Mirror privacy disclosure is missing ${disclosure}`);
}

function resolveLocal(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function literalRequireClosure(entry) {
  const pending = [entry];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:c?js|json)$/.test(file) || file.endsWith('.json')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const resolved = resolveLocal(file, match[1]);
      if (resolved && resolved.startsWith(`${ROOT}${path.sep}`)) pending.push(resolved);
    }
  }
  return seen;
}

const ledgerClosure = literalRequireClosure(path.join(ROOT, 'tools', 'ledger-archive.js'));
assert.equal(ledgerClosure.has(path.join(ROOT, 'tools', 'owner-capture-audit.js')), false,
  'installed ledger closure must not include the repo-only transcript audit');
assert.equal(ledgerClosure.has(path.join(ROOT, 'src', 'lib', 'text-shingles.js')), true,
  'installed ledger closure must use the neutral pure text helper');

const textShingles = require('../src/lib/text-shingles');
assert.equal(textShingles.normalize('  Eight—WORDS, with “quoted” text!  '), "eight words with 'quoted' text",
  'the extracted helper retains the audit matcher normalization exactly');
assert.deepEqual(textShingles.shingles('one two three four five six seven eight nine'), [
  'one two three four five six seven eight',
  'two three four five six seven eight nine'
], 'the extracted helper retains the eight-word sliding window exactly');
const repoOnlyAudit = require('../tools/owner-capture-audit');
assert.equal(repoOnlyAudit.normalize, textShingles.normalize,
  'the repo-only audit re-exports the shared pure normalization helper');
assert.equal(repoOnlyAudit.shingles, textShingles.shingles,
  'the repo-only audit re-exports the shared pure shingle helper');

const provenance = require('../src/lib/owner-request-provenance');
assert.throws(
  () => provenance.assertCitableAsOwnerRequirement({ id: 'R1', provenance: { class: 'agent-inferred' } }, 'privacy gate'),
  error => error.code === 'OWNER_PROVENANCE_NOT_CITABLE'
    && FORBIDDEN.every(phrase => !error.message.toLowerCase().includes(phrase.toLowerCase()))
);

const cloudMirror = require('../src/lib/cloud-agent/cloud-mirror');
assert.throws(
  () => cloudMirror.assertPrivateGithubMetadata({
    fullName: 'Customer/mirror',
    private: false,
    visibility: 'public',
    archived: false,
    disabled: false
  }, 'Customer/mirror'),
  error => error.code === 'CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE'
    && error.message.includes('selected, boundary-classified tracked snapshot')
    && !error.message.includes('whole working tree'),
  'the public-repository refusal must describe the classified tracked snapshot truthfully'
);

const authorization = require('../src/lib/owner-authorization');
const grant = {
  state: 'AUTHORIZED',
  authorizedOn: '2026-01-01',
  subject: 'the configured publisher identity',
  publisherIdentity: 'Customer',
  record: 'fixture',
  inScope: [{ statement: 'publish approved content' }],
  reserved: [{ statement: 'final confirmation', agentsMay: null, agentsMayNot: 'confirm for the owner' }],
  doesNotGrant: ['spending'],
  decisionProcedure: ['follow the recorded decision procedure']
};
const liveAuthorization = [authorization.authorizationHeadline(grant), ...authorization.authorizationLines(grant)].join('\n');
assert.equal(/\b(?:his|him)\b/i.test(liveAuthorization), false,
  'live owner-authorization output must be gender neutral');

const privateSummary = PRIVATE_MARKERS
  ? `${PRIVATE_MARKERS.quotes.length} private quote and ${PRIVATE_MARKERS.treeNames.length} private tree markers`
  : 'private markers SKIPPED (no out-of-tree marker file)';
console.log(`customer payload privacy gate passed (${SHIPPED_FILES.length} shipped files, ${FORBIDDEN.length} exact markers, ${privateSummary}, transcript audit absent from ledger closure)`);
