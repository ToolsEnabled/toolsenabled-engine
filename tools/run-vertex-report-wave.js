#!/usr/bin/env node
'use strict';

// Bounded, report-only Vertex Gemini wave runner.
// The caller records each dashboard launch before starting this process.
// This helper only creates disposable isolated worktrees, runs the already
// approved lane runner, copies a report when the one-file contract passes, and
// writes a compact result receipt. It never handles credentials or performs
// provider/browser actions outside the lane runner.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types: utilTypes } = require('node:util');
const {
  createLaneWorktree,
  materializeWorkingTree,
  captureBaselineTree,
  changedSinceBaseline,
  removeLaneWorktree
} = require('../src/lib/fleet-supervisor/worktree.js');
const { runLane } = require('../src/lib/fleet-supervisor/lane-runner.js');
const { DEFAULT_VERTEX_LANE_MODEL } = require('../src/lib/fleet-supervisor/lane-models.js');
const { adjudicateLaneModelReceipt } = require('../src/lib/fleet-supervisor/supervisor.js');
const { runDirectVertexReport } = require('../src/lib/fleet-supervisor/direct-vertex-report.js');
const { PLAINTEXT_SECRET } = require('../src/lib/providers/provider-safety.js');
const reportContract = require('../src/lib/fleet-supervisor/gemini-report-contract.js');

// A report-only lane is useful only if it leaves a bounded, reviewable report
// behind.  Gemini CLI returns its final response in JSON; the first versions
// of this runner ignored that response and instead expected the model to edit
// an unstated file path.  The report contract below makes the response the
// explicit artifact fallback.  It is deliberately narrow: no output is ever
// logged in a receipt, and a suspicious or oversized response is refused
// rather than copied into the shared reports tree.
const MIN_REPORT_BYTES = 101;
const MAX_REPORT_BYTES = 96 * 1024;
const SAFE_REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.md$/;
const SAFE_PROMPT_NAME = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.prompt\.txt$/;
const MAX_PROMPT_BYTES = 64 * 1024;
// Report metadata crosses several adapter boundaries and is therefore never
// authority for semantic acceptance.  These module-private witnesses are
// created only after a report has been written/read with the original frozen
// preflight contract.  The final acceptance boundary re-reads the file and
// validates its bytes again, so a caller cannot promote a lookalike
// `{ contract: { semanticVerified: true } }` object.
const materializedReportBindings = new WeakMap();

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

let specPath = null;
let resultPath = null;

const repoRoot = process.cwd();
const quietExec = (command, args, options = {}) => execFileSync(command, args, { ...options, stdio: 'pipe', windowsHide: true });
const gitMutationLock = path.join(repoRoot, 'state', 'gemini-wave-git.lock');

// Git objects are shared by every detached worktree. At high fleet fan-out,
// simultaneous `git add -A`/`write-tree` calls can race on Windows even though
// the worktrees themselves are isolated. Serialize only those short baseline
// mutations across helper processes; provider calls still run concurrently.
async function withGitMutationLock(work) {
  fs.mkdirSync(path.dirname(gitMutationLock), { recursive: true });
  let handle = null;
  while (handle === null) {
    try {
      handle = fs.openSync(gitMutationLock, 'wx');
      fs.writeFileSync(handle, `${process.pid} ${Date.now()}\n`, 'utf8');
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      try {
        const ageMs = Date.now() - fs.statSync(gitMutationLock).mtimeMs;
        if (ageMs > 5 * 60 * 1000) fs.rmSync(gitMutationLock, { force: true });
      } catch { /* another worker may be acquiring/releasing it */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  try { return await work(); }
  finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    try { fs.rmSync(gitMutationLock, { force: true }); } catch { /* best effort */ }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function exactPlainDataObject(value, allowedKeys, requiredKeys = allowedKeys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))
      || requiredKeys.some(key => !keys.includes(key))) return null;
    const copy = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function exactDataArray(value) {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) return null;
    const rows = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!keys.includes(String(index))) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      rows.push(descriptor.value);
    }
    return rows;
  } catch { return null; }
}

function assertNoLinkOrReparseComponents(root, candidate, { fsImpl = fs } = {}) {
  if (!isInside(root, candidate)) throw new Error('REPORT_WAVE_PATH_ESCAPE');
  const relative = path.relative(root, candidate);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let entry;
    try { entry = fsImpl.lstatSync(current); }
    catch { throw new Error('REPORT_WAVE_PATH_UNAVAILABLE'); }
    // Node reports Windows junctions/reparse aliases as symbolic links via
    // lstat. Refuse the entire component chain, not merely the final file.
    if (entry.isSymbolicLink()) throw new Error('REPORT_WAVE_PATH_REPARSE_REFUSED');
  }
}

function resolveApprovedPrompt(specFile, prompt, { root = repoRoot, fsImpl = fs } = {}) {
  if (typeof prompt !== 'string' || !SAFE_PROMPT_NAME.test(prompt)
      || path.isAbsolute(prompt) || /[\\/]/.test(prompt)) {
    throw new Error('REPORT_WAVE_PROMPT_NAME_INVALID');
  }
  const rootPath = path.resolve(root);
  let rootReal;
  let specReal;
  let promptRootReal;
  try {
    rootReal = fsImpl.realpathSync(rootPath);
    specReal = fsImpl.realpathSync(specFile);
    const promptRoot = path.join(path.dirname(specReal), 'prompts');
    assertNoLinkOrReparseComponents(rootReal, promptRoot, { fsImpl });
    const promptRootEntry = fsImpl.lstatSync(promptRoot);
    if (!promptRootEntry.isDirectory() || promptRootEntry.isSymbolicLink()) throw new Error('REPORT_WAVE_PROMPT_ROOT_ESCAPE');
    promptRootReal = fsImpl.realpathSync(promptRoot);
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.startsWith('REPORT_WAVE_')) throw error;
    throw new Error('REPORT_WAVE_PROMPT_ROOT_UNAVAILABLE');
  }
  if (!isInside(rootReal, specReal) || !isInside(rootReal, promptRootReal)) {
    throw new Error('REPORT_WAVE_PROMPT_ROOT_ESCAPE');
  }
  const candidate = path.join(promptRootReal, prompt);
  let entry;
  let resolved;
  try {
    entry = fsImpl.lstatSync(candidate);
    resolved = fsImpl.realpathSync(candidate);
  } catch { throw new Error('REPORT_WAVE_PROMPT_NOT_FOUND'); }
  if (!entry.isFile() || entry.isSymbolicLink() || !isInside(promptRootReal, resolved)
      || path.dirname(resolved) !== promptRootReal || path.basename(resolved) !== prompt) {
    throw new Error('REPORT_WAVE_PROMPT_ESCAPE');
  }
  let text;
  try {
    if (fsImpl.statSync(resolved).size > MAX_PROMPT_BYTES) throw new Error('REPORT_WAVE_PROMPT_TOO_LARGE');
    text = fsImpl.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error && error.message === 'REPORT_WAVE_PROMPT_TOO_LARGE') throw error;
    throw new Error('REPORT_WAVE_PROMPT_READ_FAILED');
  }
  return { path: resolved, text };
}

function validateWaveSpec(value, {
  root = repoRoot,
  specFile,
  fsImpl = fs,
  definition = reportContract.loadDefinition()
} = {}) {
  if (!specFile || typeof specFile !== 'string') throw new Error('REPORT_WAVE_SPEC_PATH_INVALID');
  // A report-only wave is only allowed to start when the durable contract is
  // present and intact.  This is intentionally checked before any worktree or
  // provider process is created.
  const safeSpec = exactPlainDataObject(value, ['lanes']);
  const lanes = safeSpec ? exactDataArray(safeSpec.lanes) : null;
  if (!lanes || lanes.length < 1 || lanes.length > 8) {
    throw new Error('wave spec must contain 1-8 lanes');
  }
  const laneIds = new Set();
  const itemIds = new Set();
  const reports = new Set();
  const prepared = [];
  for (const rawLane of lanes) {
    const lane = exactPlainDataObject(rawLane,
      ['laneId', 'itemId', 'report', 'prompt', 'contract', 'transport', 'model', 'backend', 'project', 'timeoutMs', 'supervisorId'],
      ['laneId', 'itemId', 'report', 'prompt', 'contract']);
    if (!lane) throw new Error('REPORT_WAVE_LANE_SCHEMA_INVALID');
    for (const field of ['laneId', 'itemId', 'report', 'prompt']) {
      if (typeof lane[field] !== 'string' || lane[field].trim() === '') throw new Error(`lane ${field} is required`);
    }
    if (!SAFE_REPORT_NAME.test(lane.report)) {
      throw new Error(`lane report must be a safe Markdown filename: ${lane.report}`);
    }
    if (laneIds.has(lane.laneId)) throw new Error('REPORT_WAVE_DUPLICATE_LANE_ID');
    if (itemIds.has(lane.itemId)) throw new Error('REPORT_WAVE_DUPLICATE_ITEM_ID');
    if (reports.has(lane.report)) throw new Error('REPORT_WAVE_DUPLICATE_REPORT');
    laneIds.add(lane.laneId);
    itemIds.add(lane.itemId);
    reports.add(lane.report);
    if (lane.transport === undefined) lane.transport = 'gemini-cli';
    if (!['gemini-cli', 'direct-vertex-report'].includes(lane.transport)) {
      throw new Error('REPORT_WAVE_TRANSPORT_INVALID');
    }
    // The Direct Vertex report path deliberately offers no model, account,
    // project, endpoint, or backend knob.  Its fixed provider fence owns all
    // of that configuration; a spec can select the transport, never tune it.
    if (lane.transport === 'direct-vertex-report'
      && (lane.model !== undefined || lane.backend !== undefined || lane.project !== undefined || lane.timeoutMs !== undefined)) {
      throw new Error('DIRECT_VERTEX_REPORT_PROFILE_OVERRIDE_REFUSED');
    }
    const contract = reportContract.validateLaneInputs(root, lane.contract, { fsImpl });
    if (!contract.ok) throw new Error(contract.code);
    // Keep only the frozen, preflight-bound contract.  In particular, a v2
    // report must retain the module-private source-line binding created by
    // validateLaneInputs(); reconstructing a lookalike object is refused.
    lane.contract = contract;
    const promptArtifact = resolveApprovedPrompt(specFile, lane.prompt, { root, fsImpl });
    lane.promptPath = promptArtifact.path;
    lane.promptText = promptArtifact.text;
    lane.destinationPath = path.resolve(root, 'reports', 'gemini-fleet', lane.report);
    lane.contractDefinition = definition;
    prepared.push(lane);
  }
  return { lanes: prepared };
}

function readSpec() {
  const definition = reportContract.loadDefinition();
  const rootReal = fs.realpathSync(repoRoot);
  const candidate = path.resolve(repoRoot, specPath);
  assertNoLinkOrReparseComponents(rootReal, candidate);
  const resolved = fs.realpathSync(candidate);
  if (!isInside(rootReal, resolved) || !fs.lstatSync(resolved).isFile()) {
    throw new Error('REPORT_WAVE_SPEC_ESCAPE');
  }
  const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return validateWaveSpec(value, { root: repoRoot, specFile: resolved, definition });
}

function safeReportText(value, contract = null) {
  if (typeof value !== 'string') return { ok: false, code: 'REPORT_RESPONSE_MISSING' };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < MIN_REPORT_BYTES) return { ok: false, code: 'REPORT_TOO_SMALL', bytes };
  if (bytes > MAX_REPORT_BYTES) return { ok: false, code: 'REPORT_TOO_LARGE', bytes };
  if (/\u0000/.test(value)) return { ok: false, code: 'REPORT_INVALID_TEXT', bytes };
  // A redacted response remains usable; a response carrying a live-looking
  // credential does not.  Do not try to "best effort" redact an unknown
  // secret here: rejecting it is the fail-closed boundary.
  if (PLAINTEXT_SECRET.test(value)) return { ok: false, code: 'REPORT_SECRET_LIKE_TEXT', bytes };
  if (contract) {
    const checkedContract = reportContract.validateReport(value, contract);
    if (!checkedContract.ok) return { ok: false, code: checkedContract.code, bytes };
    return { ok: true, text: value, bytes, contract: checkedContract };
  }
  return { ok: true, text: value, bytes, contract: null };
}

function bindMaterializedReport(report, reportPath, contract, bytes) {
  // Bind both formats to the written bytes.  Revalidating a v1 artifact keeps
  // its transport record honest, while its validator still returns
  // semanticVerified:false and acceptance quarantines it.
  if (!report || !contract || !report.contract) return report;
  materializedReportBindings.set(report, Object.freeze({
    path: path.resolve(reportPath),
    contract,
    bytes
  }));
  return report;
}

function revalidateMaterializedReport(report) {
  const binding = materializedReportBindings.get(report);
  if (!binding) return { valid: false, code: 'R125_REPORT_EVIDENCE_UNBOUND', bytes: 0, semanticVerified: false };
  let bytes;
  try { bytes = fs.readFileSync(binding.path); }
  catch { return { valid: false, code: 'R125_REPORT_ARTIFACT_READ_FAILED', bytes: 0, semanticVerified: false }; }
  if (!Buffer.isBuffer(bytes) || bytes.length !== binding.bytes) {
    return { valid: false, code: 'R125_REPORT_ARTIFACT_BYTES_MISMATCH', bytes: 0, semanticVerified: false };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { valid: false, code: 'R125_REPORT_ARTIFACT_ENCODING_INVALID', bytes: 0, semanticVerified: false };
  }
  const checked = safeReportText(text, binding.contract);
  if (!checked.ok) return { valid: false, code: checked.code, bytes: 0, semanticVerified: false };
  return {
    valid: true,
    code: null,
    bytes: checked.bytes,
    semanticVerified: checked.contract.semanticVerified === true
  };
}

function writeResponseReport(reportPath, response, contract = null) {
  const checked = safeReportText(response, contract);
  if (!checked.ok) return checked;
  const parent = path.dirname(reportPath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(reportPath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, checked.text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, reportPath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* rename already consumed it */ }
  }
  return bindMaterializedReport(
    { ok: true, source: 'response', bytes: checked.bytes, contract: checked.contract },
    reportPath, contract, checked.bytes
  );
}

function validateExistingReport(reportPath, contract = null) {
  let response;
  try { response = fs.readFileSync(reportPath, 'utf8'); }
  catch { return { ok: false, code: 'REPORT_READ_FAILED' }; }
  const checked = safeReportText(response, contract);
  if (!checked.ok) return checked;
  return bindMaterializedReport(
    { ok: true, source: 'artifact', bytes: checked.bytes, contract: checked.contract },
    reportPath, contract, checked.bytes
  );
}

// The detached worktree is intentionally clean, so the direct transport's
// own pre-existing-artifact check protects the producing artifact there.  The
// published report lives in the shared tree, however; reject it up front too
// so a rerun can neither spend a provider call for nor overwrite an existing
// canary artifact.  The exclusive copy below closes the check-to-copy race.
function assertDestinationAbsent(destinationPath, { fsImpl = fs } = {}) {
  try {
    if (fsImpl.existsSync(destinationPath)) {
      throw new Error('REPORT_WAVE_DESTINATION_PREEXISTING_ARTIFACT');
    }
  } catch (error) {
    if (error && error.message === 'REPORT_WAVE_DESTINATION_PREEXISTING_ARTIFACT') throw error;
    throw new Error('REPORT_WAVE_DESTINATION_CHECK_FAILED');
  }
}

// A receipt boundary must not invoke a getter merely to explain why it is
// rejecting an adapter result.  In particular, a transparent Proxy can look
// like an ordinary object to JSON.stringify while running arbitrary traps on
// every property lookup.  These helpers deliberately accept only ordinary
// Object.prototype envelopes whose *entire* own surface is data properties.
// Callers then copy only the individual primitive fields their stable receipt
// schema permits.
function strictPlainOwnDataObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch { return false; }
}

// Read only selected own data descriptors from a runner result.  A result can
// be adversarial in tests or from a future adapter; inherited values, getters,
// setters, proxies that throw during reflection, and non-plain envelopes never
// reach Q57's adjudicator as evidence.
function ownDataField(value, key) {
  try {
    if (!strictPlainOwnDataObject(value)) return { ok: false, value: undefined };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { ok: true, present: false, value: null };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.get !== undefined || descriptor.set !== undefined) return { ok: false, value: undefined };
    return { ok: true, present: true, value: descriptor.value };
  } catch { return { ok: false, value: undefined }; }
}

function nullableString(value, maxLength = 512) {
  return value === null || (typeof value === 'string' && value.length <= maxLength) ? value : null;
}

function optionalNullableString(field, maxLength = 512) {
  if (!field.ok || !field.present) return { valid: field.ok, value: null };
  const value = nullableString(field.value, maxLength);
  return { valid: value !== null || field.value === null, value };
}

function nullableFinite(value, maximum = 2_000_000) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maximum) ? value : null;
}

function optionalNullableFinite(field, maximum = 2_000_000) {
  if (!field.ok || !field.present) return { valid: field.ok, value: null };
  const value = nullableFinite(field.value, maximum);
  return { valid: value !== null || field.value === null, value };
}

function nullableStringArray(value, { maximumItems = 8, maximumLength = 160 } = {}) {
  if (value === null) return [];
  const rows = exactDataArray(value);
  if (!rows || rows.length > maximumItems || rows.some(row => typeof row !== 'string' || row.length > maximumLength)) return null;
  return rows.slice();
}

function optionalNullableStringArray(field, options) {
  if (!field.ok || !field.present) return { valid: field.ok, value: null };
  if (field.value === null) return { valid: true, value: null };
  const value = nullableStringArray(field.value, options);
  return { valid: value !== null, value };
}

// Accounts are intentionally validated but never copied into the durable
// receipt: an account is personal data, not necessary evidence.  This is also
// the nested-object boundary that stops a hostile `billing` proxy from making
// JSON serialization execute provider-controlled code.
function sanitizeBilling(value) {
  if (value === null) return { valid: true, value: null };
  if (!strictPlainOwnDataObject(value)) return { valid: false, value: null };
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !['backend', 'account', 'project'].includes(key))) return { valid: false, value: null };
  const backend = optionalNullableString(ownDataField(value, 'backend'), 64);
  const account = optionalNullableString(ownDataField(value, 'account'), 320);
  const project = optionalNullableString(ownDataField(value, 'project'), 256);
  if (!backend.valid || !account.valid || !project.valid) return { valid: false, value: null };
  return { valid: true, value: { backend: backend.value, project: project.value } };
}

function reportSnapshot(report) {
  // A report is evidence, not an extensible convenience object.  In
  // particular, do not let an adapter attach arbitrary own data which a later
  // serializer might accidentally start treating as an acceptance signal.
  if (!exactPlainDataObject(report, ['ok', 'source', 'bytes', 'contract'])) {
    return { valid: false, code: 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  const ok = ownDataField(report, 'ok');
  const code = optionalNullableString(ownDataField(report, 'code'));
  if (!ok.ok || typeof ok.value !== 'boolean' || !code.valid) {
    return { valid: false, code: 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  if (ok.value !== true) {
    return { valid: false, code: code.value || 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  const source = optionalNullableString(ownDataField(report, 'source'), 32);
  const bytes = ownDataField(report, 'bytes');
  const contract = ownDataField(report, 'contract');
  if (!source.valid || !['response', 'artifact'].includes(source.value) || !contract.ok || !contract.present
    || !bytes.ok || !bytes.present || !Number.isSafeInteger(bytes.value) || bytes.value < MIN_REPORT_BYTES
    || bytes.value > MAX_REPORT_BYTES || !exactPlainDataObject(contract.value,
      ['ok', 'version', 'role', 'sources', 'command', 'claimCount', 'semanticVerified'])) {
    return { valid: false, code: 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  const claimCount = ownDataField(contract.value, 'claimCount');
  if (!claimCount.ok || !claimCount.present || !Number.isSafeInteger(claimCount.value)
    || claimCount.value < 1 || claimCount.value > 1000) {
    return { valid: false, code: 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  const semanticVerified = ownDataField(contract.value, 'semanticVerified');
  if (!semanticVerified.ok || !semanticVerified.present || typeof semanticVerified.value !== 'boolean') {
    return { valid: false, code: 'R122_REPORT_INVALID', source: null, bytes: 0, claimCount: 0, semanticVerified: false };
  }
  return { valid: true, code: null, source: source.value, bytes: bytes.value, claimCount: claimCount.value, semanticVerified: semanticVerified.value };
}

function resultSnapshot(result) {
  // Keep the runner-result envelope closed.  We intentionally do not copy the
  // direct evidence itself; Q57 is the only code that may inspect it.
  if (!exactPlainDataObject(result,
    ['ok', 'code', 'directVertexEvidence', 'reportedModels', 'reportedTokens', 'billing'])) {
    return { valid: false, ok: false, code: 'R122_LANE_RESULT_INVALID', models: null, tokens: null, billing: null };
  }
  const ok = ownDataField(result, 'ok');
  const code = optionalNullableString(ownDataField(result, 'code'));
  const models = optionalNullableStringArray(ownDataField(result, 'reportedModels'));
  const tokens = optionalNullableFinite(ownDataField(result, 'reportedTokens'));
  const billingField = ownDataField(result, 'billing');
  const billing = !billingField.ok || !billingField.present
    ? { valid: billingField.ok, value: null }
    : sanitizeBilling(billingField.value);
  if (!ok.ok || typeof ok.value !== 'boolean' || !code.valid || !models.valid || !tokens.valid || !billing.valid) {
    return { valid: false, ok: false, code: 'R122_LANE_RESULT_INVALID', models: null, tokens: null, billing: null };
  }
  return { valid: true, ok: ok.value, code: code.value, models: models.value, tokens: tokens.value, billing: billing.value };
}

function decisionSnapshot(decision) {
  if (!exactPlainDataObject(decision,
    ['accepted', 'rejectionCodes', 'report', 'modelReceipt', 'changed', 'laneId', 'expectedModel', 'artifactProduced'])) return null;
  const accepted = ownDataField(decision, 'accepted');
  const rejectionCodes = ownDataField(decision, 'rejectionCodes');
  const report = ownDataField(decision, 'report');
  const receipt = ownDataField(decision, 'modelReceipt');
  const changed = ownDataField(decision, 'changed');
  const laneId = optionalNullableString(ownDataField(decision, 'laneId'), 160);
  const expectedModel = optionalNullableString(ownDataField(decision, 'expectedModel'), 160);
  const artifactProduced = ownDataField(decision, 'artifactProduced');
  const codes = rejectionCodes.ok && rejectionCodes.present
    ? nullableStringArray(rejectionCodes.value, { maximumItems: 16, maximumLength: 128 }) : null;
  if (!accepted.ok || accepted.value !== true && accepted.value !== false || !codes
    || !report.ok || !report.present || !exactPlainDataObject(report.value,
      ['valid', 'source', 'claimCount', 'semanticVerified', 'contractVersion', 'contractSha256'])
    || !receipt.ok || !receipt.present || !exactPlainDataObject(receipt.value,
      ['verdict', 'code', 'observed', 'servedModel'])
    || !changed.ok || !changed.present || !Number.isSafeInteger(changed.value)
    || !laneId.valid || typeof laneId.value !== 'string' || laneId.value.length < 1
    || !expectedModel.valid || typeof expectedModel.value !== 'string' || !/^gemini-[A-Za-z0-9.-]+$/.test(expectedModel.value)
    || !artifactProduced.ok || artifactProduced.value !== true) return null;
  const reportValid = ownDataField(report.value, 'valid');
  const reportSource = optionalNullableString(ownDataField(report.value, 'source'), 32);
  const reportClaims = ownDataField(report.value, 'claimCount');
  const reportSemantic = ownDataField(report.value, 'semanticVerified');
  const reportVersion = optionalNullableString(ownDataField(report.value, 'contractVersion'), 64);
  const reportHash = optionalNullableString(ownDataField(report.value, 'contractSha256'), 128);
  const receiptVerdict = optionalNullableString(ownDataField(receipt.value, 'verdict'), 64);
  const receiptCode = optionalNullableString(ownDataField(receipt.value, 'code'), 128);
  const receiptObserved = ownDataField(receipt.value, 'observed');
  const servedModel = optionalNullableString(ownDataField(receipt.value, 'servedModel'), 160);
  if (!reportValid.ok || typeof reportValid.value !== 'boolean' || !reportSource.valid || !reportClaims.ok
    || !Number.isSafeInteger(reportClaims.value) || !reportSemantic.ok || typeof reportSemantic.value !== 'boolean'
    || !reportVersion.valid || !reportHash.valid || !receiptVerdict.valid
    || !receiptCode.valid || !receiptObserved.ok || typeof receiptObserved.value !== 'boolean' || !servedModel.valid) return null;
  return {
    accepted: accepted.value,
    rejectionCodes: codes,
    report: { valid: reportValid.value, source: reportSource.value, claimCount: reportClaims.value, semanticVerified: reportSemantic.value, contractVersion: reportVersion.value, contractSha256: reportHash.value },
    modelReceipt: { verdict: receiptVerdict.value, code: receiptCode.value, observed: receiptObserved.value, servedModel: servedModel.value },
    changed: changed.value,
    laneId: laneId.value,
    expectedModel: expectedModel.value,
    artifactProduced: artifactProduced.value
  };
}

// Q57 owns receipt adjudication. This runner has no modelReceipt input and
// does not read one: only a direct transport's raw evidence may be offered to
// Q57, which independently binds it to lane facts. CLI stats.models remains a
// quarantined aggregate diagnostic.
function adjudicateReportReceipt(result, { laneId, expectedModel, changed } = {}) {
  const reported = ownDataField(result, 'reportedModels');
  const direct = ownDataField(result, 'directVertexEvidence');
  const perCall = ownDataField(result, 'perCallModelEvidence');
  try {
    if (!reported.ok || !direct.ok || !perCall.ok) {
      return adjudicateLaneModelReceipt({
        laneId,
        attemptNumber: 1,
        artifactProduced: changed === 1,
        backend: 'vertex',
        configuredModel: expectedModel,
        // Exact Q57 envelope validation rejects this harmless empty object.
        directVertexEvidence: Object.create(null)
      });
    }
    return adjudicateLaneModelReceipt({
      laneId,
      attemptNumber: 1,
      artifactProduced: changed === 1,
      backend: 'vertex',
      configuredModel: expectedModel,
      reportedModels: reported.present ? reported.value : null,
      perCallModelEvidence: perCall.present ? perCall.value : null,
      directVertexEvidence: direct.present ? direct.value : null
    });
  } catch {
    return { verdict: 'quarantined', code: 'R122_MODEL_RECEIPT_QUARANTINED', observed: false, servedModel: null };
  }
}

function acceptanceDecision({ result, laneId, report, reportBytes, changed, expectedModel, definition }) {
  const rejectionCodes = [];
  const resultInfo = resultSnapshot(result);
  const reportInfo = reportSnapshot(report);
  // The report envelope is untrusted adapter metadata.  Re-open the exact
  // artifact through the private witness made at preflight/materialization and
  // re-run the v2 source-byte contract before the receipt can say accepted.
  // No serializable report field, including `semanticVerified`, can replace
  // this step.
  const artifactInfo = reportInfo.valid
    ? revalidateMaterializedReport(report)
    : { valid: false, code: 'R125_REPORT_EVIDENCE_UNBOUND', bytes: 0, semanticVerified: false };
  if (!resultInfo.valid) rejectionCodes.push('R122_LANE_RESULT_INVALID');
  if (!resultInfo.ok) rejectionCodes.push('R122_LANE_NOT_OK');
  if (!reportInfo.valid) rejectionCodes.push(reportInfo.code || 'R122_REPORT_INVALID');
  if (!Number.isInteger(reportBytes) || reportBytes < MIN_REPORT_BYTES) rejectionCodes.push('R122_REPORT_BYTES_INVALID');
  if (!artifactInfo.valid) rejectionCodes.push(artifactInfo.code);
  if (artifactInfo.valid && (reportInfo.bytes !== artifactInfo.bytes || reportBytes !== artifactInfo.bytes)) {
    rejectionCodes.push('R125_REPORT_ARTIFACT_BYTES_MISMATCH');
  }
  if (changed !== 1) rejectionCodes.push('R122_REPORT_DIFF_INVALID');
  if (artifactInfo.valid && artifactInfo.semanticVerified !== true) rejectionCodes.push('R125_REPORT_EVIDENCE_UNVERIFIED');
  const receipt = adjudicateReportReceipt(result, { laneId, expectedModel, changed });
  const safeReceipt = strictPlainOwnDataObject(receipt) ? {
    verdict: optionalNullableString(ownDataField(receipt, 'verdict'), 64),
    code: optionalNullableString(ownDataField(receipt, 'code'), 128),
    observed: ownDataField(receipt, 'observed'),
    servedModel: optionalNullableString(ownDataField(receipt, 'servedModel'), 160)
  } : null;
  if (!safeReceipt || !safeReceipt.verdict.valid || !safeReceipt.code.valid || !safeReceipt.observed.ok
    || typeof safeReceipt.observed.value !== 'boolean' || !safeReceipt.servedModel.valid) {
    rejectionCodes.push('R122_MODEL_RECEIPT_QUARANTINED');
  } else if (safeReceipt.verdict.value !== 'accepted') {
    rejectionCodes.push(safeReceipt.code.value || 'R122_MODEL_RECEIPT_QUARANTINED');
  }
  const safeDefinition = strictPlainOwnDataObject(definition) ? {
    version: optionalNullableString(ownDataField(definition, 'version'), 64),
    sha256: optionalNullableString(ownDataField(definition, 'sha256'), 128)
  } : null;
  return {
    accepted: rejectionCodes.length === 0,
    rejectionCodes,
    report: {
      valid: reportInfo.valid,
      source: reportInfo.valid ? reportInfo.source : null,
      claimCount: reportInfo.valid ? reportInfo.claimCount : 0,
      semanticVerified: artifactInfo.valid ? artifactInfo.semanticVerified : false,
      contractVersion: safeDefinition && safeDefinition.version.valid ? safeDefinition.version.value : null,
      contractSha256: safeDefinition && safeDefinition.sha256.valid ? safeDefinition.sha256.value : null
    },
    modelReceipt: {
      verdict: safeReceipt && safeReceipt.verdict.valid ? safeReceipt.verdict.value : 'quarantined',
      code: safeReceipt && safeReceipt.code.valid ? safeReceipt.code.value : 'R122_MODEL_RECEIPT_QUARANTINED',
      observed: Boolean(safeReceipt && safeReceipt.observed.ok && safeReceipt.observed.value === true),
      servedModel: safeReceipt && safeReceipt.servedModel.valid ? safeReceipt.servedModel.value : null
    },
    changed,
    laneId: typeof laneId === 'string' ? laneId : null,
    expectedModel: typeof expectedModel === 'string' ? expectedModel : null,
    artifactProduced: changed === 1
  };
}

// A durable serialized success must be reproducible from the untrusted runner
// result, not merely asserted by a previous decision object.  Re-adjudicating
// here binds the decision to the same Q57 producing-call receipt and scalar
// lane facts.  This is deliberately stricter than acceptanceDecision(): it is
// the last boundary before a receipt says `accepted: true`.
function acceptedOutcomeIsBound({ result, report, resultInfo, reportInfo, decisionInfo, changed, reportBytes, definition }) {
  if (!resultInfo.valid || resultInfo.ok !== true || !reportInfo.valid || !decisionInfo
    || decisionInfo.accepted !== true || decisionInfo.rejectionCodes.length !== 0
    || changed !== 1 || reportBytes < MIN_REPORT_BYTES || decisionInfo.changed !== changed
    || decisionInfo.artifactProduced !== true || decisionInfo.report.valid !== true
    || decisionInfo.report.source !== reportInfo.source || decisionInfo.report.claimCount !== reportInfo.claimCount
    || decisionInfo.report.semanticVerified !== true || reportInfo.semanticVerified !== true
    || typeof decisionInfo.report.contractVersion !== 'string' || decisionInfo.report.contractVersion.length < 1
    || typeof decisionInfo.report.contractSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(decisionInfo.report.contractSha256)) return false;
  const receipt = decisionInfo.modelReceipt;
  if (receipt.verdict !== 'accepted' || receipt.code !== null || receipt.observed !== true
    || receipt.servedModel !== decisionInfo.expectedModel) return false;
  // Recompute the full decision from the live values and the currently
  // approved contract definition.  This binds receipt, report, diff, lane id,
  // requested model, and contract document hash in one place rather than
  // treating any serialized decision property as authority.
  const recomputed = decisionSnapshot(acceptanceDecision({
    result,
    laneId: decisionInfo.laneId,
    report,
    reportBytes,
    changed,
    expectedModel: decisionInfo.expectedModel,
    definition
  }));
  return Boolean(recomputed && recomputed.accepted === true
    && recomputed.report.contractVersion === decisionInfo.report.contractVersion
    && recomputed.report.contractSha256 === decisionInfo.report.contractSha256
    && recomputed.modelReceipt.verdict === receipt.verdict && recomputed.modelReceipt.code === receipt.code
    && recomputed.modelReceipt.observed === receipt.observed && recomputed.modelReceipt.servedModel === receipt.servedModel);
}

// A provider failure is allowed to carry no report: direct transport returns a
// typed failure with `report: null` before any artifact exists.  Keep the
// receipt serializer on the same fail-closed boundary as acceptance instead
// of dereferencing that absent artifact while trying to report the failure.
function laneOutcomeFields({ result, report, decision, changed, reportBytes, definition = null }) {
  const resultInfo = resultSnapshot(result);
  const reportInfo = reportSnapshot(report);
  const decisionInfo = decisionSnapshot(decision);
  const safeChanged = Number.isSafeInteger(changed) ? changed : null;
  const safeReportBytes = Number.isSafeInteger(reportBytes) && reportBytes >= 0 ? reportBytes : 0;
  const accepted = acceptedOutcomeIsBound({ result, report, resultInfo, reportInfo, decisionInfo, changed: safeChanged, reportBytes: safeReportBytes, definition });
  const forcedRejection = !resultInfo.valid ? 'R122_LANE_RESULT_INVALID'
    : !reportInfo.valid ? (reportInfo.code || 'R122_REPORT_INVALID')
      : 'R122_OUTPUT_ACCEPTANCE_INVALID';
  const serializedDecision = decisionInfo ? {
    ...decisionInfo,
    accepted,
    rejectionCodes: accepted ? decisionInfo.rejectionCodes
      : (decisionInfo.rejectionCodes.length ? decisionInfo.rejectionCodes : [forcedRejection])
  } : null;
  return {
    ok: resultInfo.valid && resultInfo.ok === true,
    code: resultInfo.code,
    models: resultInfo.models,
    tokens: resultInfo.tokens,
    changed: safeChanged,
    reportBytes: safeReportBytes,
    reportCode: reportInfo.valid ? null : reportInfo.code,
    reportSource: reportInfo.valid ? reportInfo.source : null,
    reportContractVersion: decisionInfo && decisionInfo.report.valid ? decisionInfo.report.contractVersion : null,
    reportContractCode: reportInfo.valid ? null : reportInfo.code,
    accepted,
    r122: serializedDecision || {
      accepted: false,
      rejectionCodes: ['R122_DECISION_INVALID']
    },
    billing: resultInfo.billing
  };
}

async function runOne(lane) {
  let ref = null;
  const output = { laneId: lane.laneId, itemId: lane.itemId };
  try {
    // Refuse before a worktree or provider call when the durable destination
    // is already occupied. Each canary spec therefore needs a fresh report
    // name; existing reports remain immutable review evidence.
    assertDestinationAbsent(lane.destinationPath);
    ref = createLaneWorktree(lane.laneId, {
      repoRoot,
      itemId: lane.itemId,
      supervisorId: lane.supervisorId || 'codex-vertex-report-wave',
      exec: quietExec
    });
    const materialized = materializeWorkingTree(ref.path, { repoRoot, exec: quietExec });
    const onlyKnownGitlink = Array.isArray(materialized.trackedMissing)
      && materialized.trackedMissing.length === 1
      && materialized.trackedMissing[0] === 'reports/desktop-archive-2026-07-29/AI_Session_Logs';
    if (!materialized.complete && !onlyKnownGitlink) {
      throw new Error(`MATERIALIZE_REFUSED: ${materialized.reason}`);
    }

    const baseline = await withGitMutationLock(() => captureBaselineTree(ref.path, { exec: quietExec }));
    const reportPath = path.join(ref.path, 'reports', 'gemini-fleet', lane.report);
    let result;
    let report;
    let changed;
    let reportBytes;
    if (lane.transport === 'direct-vertex-report') {
      const direct = await runDirectVertexReport({
        laneId: lane.laneId,
        prompt: lane.promptText,
        reportPath,
        contract: lane.contract,
        materializeReport: writeResponseReport,
        changedFileCount: () => withGitMutationLock(() => changedSinceBaseline(ref.path, baseline, { exec: quietExec }))
      });
      result = {
        ok: direct.ok,
        code: direct.code,
        directVertexEvidence: direct.directVertexEvidence,
        reportedModels: null,
        reportedTokens: direct.accounting ? direct.accounting.billableOutputTokens : null,
        billing: direct.ok ? { backend: 'vertex', account: 'fixed-direct-vertex-report', project: null } : null
      };
      report = direct.report;
      changed = direct.changed;
      reportBytes = direct.reportBytes;
    } else {
      const cli = await runLane({
        laneId: lane.laneId,
        itemId: lane.itemId,
        brief: lane.promptText,
        cwd: ref.path,
        model: lane.model || DEFAULT_VERTEX_LANE_MODEL,
        backend: lane.backend || 'vertex',
        project: lane.project || 'example-vertex-project',
        timeoutMs: Number.isSafeInteger(lane.timeoutMs) ? lane.timeoutMs : 25 * 60 * 1000,
        execImpl: quietExec,
        onStart: pid => process.stdout.write(`${lane.itemId}:PID=${pid}\n`)
      });
      result = cli;
      // A report-only prompt is not an instruction to edit a particular hidden
      // path.  If it returned a bounded final report instead, materialize that
      // response as the one permitted worktree artifact.  Existing artifacts
      // are checked through the same fail-closed text boundary.
      report = fs.existsSync(reportPath)
        ? validateExistingReport(reportPath, lane.contract)
        : writeResponseReport(reportPath, result.response, lane.contract);
      changed = await withGitMutationLock(() => changedSinceBaseline(ref.path, baseline, { exec: quietExec }));
      reportBytes = report.ok && fs.existsSync(reportPath) ? fs.statSync(reportPath).size : 0;
    }
    const decision = acceptanceDecision({
      result, laneId: lane.laneId, report, reportBytes, changed,
      expectedModel: lane.transport === 'direct-vertex-report' ? DEFAULT_VERTEX_LANE_MODEL : (lane.model || DEFAULT_VERTEX_LANE_MODEL), definition: lane.contractDefinition
    });
    if (decision.accepted) {
      fs.mkdirSync(path.dirname(lane.destinationPath), { recursive: true });
      try {
        fs.copyFileSync(reportPath, lane.destinationPath, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error && error.code === 'EEXIST') throw new Error('REPORT_WAVE_DESTINATION_PREEXISTING_ARTIFACT');
        throw error;
      }
    }
    Object.assign(output, laneOutcomeFields({ result, report, decision, changed, reportBytes, definition: lane.contractDefinition }));
  } catch (error) {
    output.error = String(error && error.message || error);
  } finally {
    if (ref) {
      try {
        removeLaneWorktree(ref.path, { repoRoot, exec: quietExec });
      } catch (error) {
        output.cleanupError = String(error && error.message || error);
      }
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

// The result file is diagnostic evidence, not proof that the wave completed.
// A lane can return normally after runOne records a provider, validation, or
// cleanup failure.  Keep that uncertainty out of the process verdict: every
// requested lane must have produced a bound accepted artifact and completed
// cleanup before the wave command may exit successfully.
function waveSucceeded(results) {
  return Array.isArray(results) && results.length > 0
    && results.every(result => strictPlainOwnDataObject(result)
      && ownDataField(result, 'accepted').value === true
      && !ownDataField(result, 'error').present
      && !ownDataField(result, 'cleanupError').present);
}

async function main() {
  specPath = arg('--spec');
  resultPath = arg('--result');
  if (!specPath || !resultPath) {
    process.stderr.write('usage: node tools/run-vertex-report-wave.js --spec <json> --result <json>\n');
    process.exitCode = 2;
    return;
  }
  const spec = readSpec();
  const results = await Promise.all(spec.lanes.map(runOne));
  const destination = path.resolve(repoRoot, resultPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  if (!waveSucceeded(results)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`FATAL=${String(error && error.stack || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_REPORT_BYTES,
  MIN_REPORT_BYTES,
  SAFE_REPORT_NAME,
  SAFE_PROMPT_NAME,
  acceptanceDecision,
  assertDestinationAbsent,
  adjudicateReportReceipt,
  laneOutcomeFields,
  readSpec,
  ownDataField,
  resolveApprovedPrompt,
  safeReportText,
  validateWaveSpec,
  validateExistingReport,
  waveSucceeded,
  writeResponseReport
};
