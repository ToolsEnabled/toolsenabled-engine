#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scopeStore = require('../src/lib/owner-request-scope-store');
const {
  buildScopeProposal,
  validateScopeProposal,
  validateReviewReceipt,
  renderScopeProposalReport,
  sha256
} = require('../src/lib/owner-request-scope-proposal');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
  ledger: path.join(ROOT, 'reports', 'OWNER-REQUEST-LEDGER.json'),
  scopeStore: scopeStore.productionScopeStoreFile(),
  proposal: path.join(ROOT, 'reports', 'OWNER-REQUEST-SCOPE-PROPOSAL.json'),
  report: path.join(ROOT, 'reports', 'OWNER-REQUEST-SCOPE-PROPOSAL.md')
});
const APPLY_CONFIRMATION = 'APPLY_REVIEWED_SCOPE_PROPOSAL';

class OwnerScopeProposalToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerScopeProposalToolError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerScopeProposalToolError(code, message);
}

function readText(file, label) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { fail('OWNER_SCOPE_PROPOSAL_READ_FAILED', `${label} could not be read: ${file}`); }
}

function readJson(file, label) {
  const raw = readText(file, label);
  try { return { raw, value: JSON.parse(raw) }; }
  catch { fail('OWNER_SCOPE_PROPOSAL_JSON_INVALID', `${label} is not valid JSON: ${file}`); }
}

function atomicWrite(file, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, raw, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } catch {
    fail('OWNER_SCOPE_PROPOSAL_WRITE_FAILED', `Could not atomically write ${file}.`);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* rename consumed it */ }
  }
}

function readScopeStoreSource(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const normalized = scopeStore.normalizeStore(JSON.parse(raw));
    return Object.freeze({
      snapshot: Object.freeze({ exists: true, revision: normalized.revision, sha256: sha256(raw) }),
      rules: normalized.rules
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        snapshot: Object.freeze({ exists: false, revision: 0, sha256: sha256('absent') }),
        rules: Object.freeze([])
      });
    }
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_INVALID', `Scope store could not be read as current scope data: ${file}`);
  }
}

function scopeStoreSnapshot(file) {
  return readScopeStoreSource(file).snapshot;
}

function generateProposal(options = {}) {
  const ledgerFile = path.resolve(options.ledger || DEFAULTS.ledger);
  const scopeStoreFile = path.resolve(options.scopeStore || DEFAULTS.scopeStore);
  const proposalFile = path.resolve(options.proposal || DEFAULTS.proposal);
  const reportFile = path.resolve(options.report || DEFAULTS.report);
  const ledgerSource = readJson(ledgerFile, 'owner ledger');
  const currentScope = readScopeStoreSource(scopeStoreFile);
  const proposal = buildScopeProposal({
    ledger: ledgerSource.value,
    ledgerRaw: ledgerSource.raw,
    scopeRules: currentScope.rules,
    scopeStoreSnapshot: currentScope.snapshot,
    evaluatedAt: new Date().toISOString()
  });
  atomicWrite(proposalFile, `${JSON.stringify(proposal, null, 2)}\n`);
  atomicWrite(reportFile, `${renderScopeProposalReport(proposal)}\n`);
  return Object.freeze({
    ok: true,
    mode: 'generate',
    proposalFile,
    reportFile,
    proposalSha256: proposal.proposalSha256,
    counts: proposal.counts,
    applyState: proposal.applyState
  });
}

function verifySourceSnapshots(proposal, options) {
  const ledger = readJson(options.ledger, 'owner ledger');
  if (ledger.value.revision !== proposal.sourceLedger.revision
      || sha256(ledger.raw) !== proposal.sourceLedger.sha256) {
    fail('OWNER_SCOPE_PROPOSAL_LEDGER_CHANGED', 'Ledger revision or bytes changed after proposal generation.');
  }
  const currentScope = readScopeStoreSource(options.scopeStore);
  if (currentScope.snapshot.exists !== proposal.sourceScopeStore.exists
      || currentScope.snapshot.revision !== proposal.sourceScopeStore.revision
      || currentScope.snapshot.sha256 !== proposal.sourceScopeStore.sha256) {
    fail('OWNER_SCOPE_PROPOSAL_SCOPE_STORE_CHANGED', 'Scope store bytes or revision changed after proposal generation.');
  }
  const rebuilt = buildScopeProposal({
    ledger: ledger.value,
    ledgerRaw: ledger.raw,
    scopeRules: currentScope.rules,
    scopeStoreSnapshot: currentScope.snapshot,
    evaluatedAt: proposal.generatedAt
  });
  if (rebuilt.proposalSha256 !== proposal.proposalSha256) {
    fail('OWNER_SCOPE_PROPOSAL_SOURCE_MISMATCH', 'Proposal content is not the projection of the bound current ledger and scope store.');
  }
  return true;
}

function applyReviewedProposal(options = {}) {
  const resolved = {
    ledger: path.resolve(options.ledger || DEFAULTS.ledger),
    scopeStore: path.resolve(options.scopeStore || DEFAULTS.scopeStore),
    proposal: path.resolve(options.proposal || DEFAULTS.proposal),
    reviewReceipt: options.reviewReceipt ? path.resolve(options.reviewReceipt) : null,
    expectedProposalSha256: options.expectedProposalSha256,
    confirmation: options.confirmation
  };
  if (resolved.confirmation !== APPLY_CONFIRMATION
      || !/^[a-f0-9]{64}$/.test(resolved.expectedProposalSha256 || '')
      || resolved.reviewReceipt === null) {
    fail('OWNER_SCOPE_PROPOSAL_APPLY_NOT_CONFIRMED', 'Apply requires the confirmation token, expected proposal SHA-256, and review receipt.');
  }
  const proposal = readJson(resolved.proposal, 'scope proposal').value;
  const validated = validateScopeProposal(proposal);
  if (proposal.proposalSha256 !== resolved.expectedProposalSha256) {
    fail('OWNER_SCOPE_PROPOSAL_HASH_MISMATCH', 'Typed proposal SHA-256 does not match the proposal.');
  }
  verifySourceSnapshots(proposal, resolved);
  validateReviewReceipt(readJson(resolved.reviewReceipt, 'scope proposal review receipt').value, proposal);
  const result = scopeStore.replaceScopeRulesFromReviewedProposal({
    rules: validated.rules,
    expectedRevision: proposal.sourceScopeStore.revision,
    expectedStoreSha256: proposal.sourceScopeStore.sha256,
    proposalSha256: proposal.proposalSha256,
    reviewedLedgerRevision: proposal.sourceLedger.revision,
    reviewedRequestIds: proposal.entries.map(entry => entry.sourceRequestId)
  }, { file: resolved.scopeStore });
  return Object.freeze({ ok: true, mode: 'apply', ...result });
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['generate', 'apply'].includes(command)) {
    fail('OWNER_SCOPE_PROPOSAL_USAGE', 'Usage: owner-scope-proposal.js generate|apply [--name value ...]');
  }
  const allowed = new Set([
    'ledger', 'scope-store', 'proposal', 'report',
    'review-receipt', 'expected-proposal-sha256', 'confirm'
  ]);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || !allowed.has(flag.slice(2))) {
      fail('OWNER_SCOPE_PROPOSAL_USAGE', `Invalid argument near ${flag || '<end>'}.`);
    }
    values[flag.slice(2)] = value;
  }
  return Object.freeze({ command, values });
}

function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  const options = {
    ledger: values.ledger,
    scopeStore: values['scope-store'],
    proposal: values.proposal,
    report: values.report,
    reviewReceipt: values['review-receipt'],
    expectedProposalSha256: values['expected-proposal-sha256'],
    confirmation: values.confirm
  };
  const result = command === 'generate' ? generateProposal(options) : applyReviewedProposal(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.code || 'OWNER_SCOPE_PROPOSAL_UNEXPECTED'}: ${error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  OwnerScopeProposalToolError,
  DEFAULTS,
  APPLY_CONFIRMATION,
  scopeStoreSnapshot,
  verifySourceSnapshots,
  generateProposal,
  applyReviewedProposal,
  parseArgs,
  main
});
