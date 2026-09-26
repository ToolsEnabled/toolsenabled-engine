#!/usr/bin/env node
'use strict';
// fra-doctor -- one command, one verdict, and on failure the exact file or field
// that diverged.
//
// WHY THIS EXISTS. On 2026-08-02 the FRA lane was down for roughly nineteen
// hours. Almost none of that was spent fixing anything; it was spent finding out
// WHICH of 43 pinned files disagreed between two machines, by hashing files by
// hand and reading truncated digests to each other over a message relay. Three
// separate faults were found that way -- a policy document inside an integrity
// digest, six files that had silently drifted on the older tree, and a
// credential written to the wrong vault slot -- and each took hours to localise
// even though each was a one-line fix once named.
//
// A digest that only reports "different" is a smoke alarm with no address. This
// prints the address.
//
// It runs entirely from local files and opens no socket. That is deliberate and
// it is not a limitation: BOTH machines hold BOTH anchors, so "do my files hash
// to what my peer expects of me" is answerable locally, with no peer, no
// credential, and no listener running. It is therefore safe to run when the lane
// is completely down, which is exactly when it is needed.
//
// It never emits a secret. Credentials appear only as a length and a truncated
// fingerprint, which is the same discipline the two machines used to compare
// credentials all night without ever transmitting one.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const integrity = require(path.join(ROOT, 'src', 'lib', 'fra-runtime-integrity.js'));
const binding = require(path.join(ROOT, 'src', 'lib', 'fra-transport-binding.js'));
const rootAccess = require(path.join(ROOT, 'src', 'lib', 'fra-root-access.js'));
const { safeLaunchEnvironment } = require(path.join(ROOT, 'src', 'lib', 'providers', 'subscription-launch-env.js'));
const { machineAddressPolicy } = require(path.join(ROOT, 'src', 'lib', 'service-registry.js'));
// B26: per-machine FRA files are named after the machine's registry identity,
// not its address. The doctor must resolve them the same way the product does,
// or it reports "unreadable" for files that are present and fine.
const { manifestPathForHost: capabilityManifestPathForHost } =
  require(path.join(ROOT, 'src', 'lib', 'fra-capability-manifest.js'));

const HOSTS = machineAddressPolicy().addresses;
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const quiet = argv.includes('--quiet');

const findings = [];
const report = { schemaVersion: 'fra-doctor.v1', checkedAt: new Date().toISOString(), root: ROOT, secretValuesEmitted: false };

function fail(area, summary, detail) {
  findings.push({ area, summary, detail: detail || null });
}

function short(value, n = 16) {
  return typeof value === 'string' && value.length > n ? `${value.slice(0, n)}...` : String(value);
}

// --- which machine is this, mechanically ------------------------------------
// Derived, never remembered. A session on this project has mislabelled itself
// even after reading the ownership document.
function localHost() {
  const os = require('node:os');
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4') addresses.add(entry.address);
    }
  }
  const matches = HOSTS.filter(h => addresses.has(h));
  if (matches.length === 1) return matches[0];
  // Both or neither present is a genuine ambiguity and must not be guessed.
  return null;
}

const host = localHost();
report.host = host;
report.peer = host ? HOSTS.find(h => h !== host) : null;
if (!host) {
  fail('identity', 'this machine holds neither or multiple registry-sanctioned addresses, so its FRA identity is ambiguous',
    'expected exactly one registry-declared machine address on a local interface');
}

// --- the 43 pinned files, against BOTH anchors ------------------------------
// The point of checking both is that each anchor encodes what ONE machine
// expects. Checking only your own answers "am I self-consistent"; checking the
// peer's answers "will my peer accept me", which is the question that was
// actually failing.
report.anchors = {};
for (const anchorHost of HOSTS) {
  const entry = { host: anchorHost };
  try {
    const verified = integrity.verifyRuntimeIntegrity({ root: ROOT, host: anchorHost });
    entry.ok = verified.valid === true;
    entry.fileCount = verified.fileCount;
    entry.runtimeDigest = verified.runtimeDigest;
  } catch (error) {
    entry.ok = false;
    entry.code = error.code || 'FRA_RUNTIME_INTEGRITY_INVALID';

    // THE PART THAT MATTERS: name the files, do not just report a mismatch.
    entry.divergent = [];
    try {
      const manifestPath = integrity.manifestPathForHost(ROOT, anchorHost);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
      for (const file of manifest.files || []) {
        const full = path.join(ROOT, file.path);
        let actual = null;
        try {
          actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        } catch (readError) {
          actual = readError && readError.code === 'ENOENT'
            ? 'FILE MISSING'
            : `UNREADABLE (${(readError && readError.code) || 'READ_FAILED'})`;
        }
        if (actual !== file.sha256) {
          entry.divergent.push({
            path: file.path,
            expected: short(file.sha256),
            actual: short(actual)
          });
        }
      }
    } catch (inner) {
      entry.divergentError = inner.code || String(inner.message || inner).slice(0, 120);
    }

    const names = (entry.divergent || []).map(d => d.path);
    fail('runtime-anchor',
      `anchor ${anchorHost} does not match this tree (${entry.code})`,
      names.length
        ? `${names.length} file(s) differ: ${names.join(', ')}`
        : 'no per-file detail available; the manifest itself may be unreadable');
  }
  report.anchors[anchorHost] = entry;
}

// Both anchors describe the same conceptual file set, so a disagreement between
// them is a distinct fault from either one failing.
const digests = HOSTS.map(h => report.anchors[h] && report.anchors[h].runtimeDigest).filter(Boolean);
if (digests.length === 2 && digests[0] !== digests[1]) {
  fail('runtime-anchor', 'the two anchors disagree with each other, which should be impossible',
    `${short(digests[0])} vs ${short(digests[1])}`);
}

// --- policy digest ----------------------------------------------------------
// This one IS compared live between the machines, so a local difference here is
// a guaranteed handshake failure. POLICY_FILES is deliberately small; it once
// contained two documents agents are REQUIRED to edit, and that coupling cost
// the outage this tool exists for.
try {
  report.policy = {
    files: [...binding.POLICY_FILES],
    digest: binding.policyDigestForRoot({ root: ROOT })
  };
  for (const relative of binding.POLICY_FILES) {
    try {
      fs.accessSync(path.join(ROOT, relative), fs.constants.R_OK);
    } catch (readError) {
      if (readError && readError.code === 'ENOENT') {
        fail('policy', `policy file missing: ${relative}`, 'the policy digest cannot be computed without it');
      } else {
        fail('policy', `policy file could not be read: ${relative}`,
          `${(readError && readError.code) || 'READ_FAILED'}; presence was not established`);
      }
    }
  }
  if (binding.POLICY_FILES.some(f => /\.md$/i.test(f) || /standing-orders/i.test(f))) {
    fail('policy', 'a routinely-edited document is inside the policy digest',
      'editing it during ordinary work will break the lane; this exact coupling caused a 19-hour outage');
  }
} catch (error) {
  report.policy = { error: error.code || 'FRA_POLICY_FILE_INVALID' };
  fail('policy', 'the policy digest could not be computed', error.code || null);
}

// --- capability manifest ----------------------------------------------------
report.capability = {};
for (const manifestHost of HOSTS) {
  const file = capabilityManifestPathForHost(manifestHost);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!Number.isInteger(parsed.allowedToolCount) || !Array.isArray(parsed.excludedTools)) {
      const error = new Error('capability manifest does not contain measurable tool counts');
      error.code = 'FRA_CAPABILITY_MANIFEST_COUNTS_INVALID';
      throw error;
    }
    report.capability[manifestHost] = {
      allowedToolCount: parsed.allowedToolCount,
      excludedCount: parsed.excludedTools.length,
      registryNameDigest: short(parsed.registryNameDigest)
    };
  } catch (error) {
    report.capability[manifestHost] = { error: 'unreadable' };
    fail('capability', `capability manifest for ${manifestHost} is missing or unreadable`, null);
  }
}
const counts = HOSTS.map(h => report.capability[h] && report.capability[h].allowedToolCount);
if (counts[0] !== undefined && counts[1] !== undefined && counts[0] !== counts[1]) {
  fail('capability', 'the two capability manifests allow different tool counts',
    `${counts[0]} vs ${counts[1]}; the peer will reject the binding`);
}

// --- root access ------------------------------------------------------------
// THE GATE THIS TOOL USED TO MISS ENTIRELY. src/full-remote-access-bridge.js
// and tools/remote-agent-mcp-proxy.js both refuse to start unless
// verifyFraRootAccess() passes, and this doctor checked every OTHER gate --
// anchors, policy digest, capability manifests, credentials -- and never this
// one. Measured on 2026-08-10: the tree's root DACL had never been hardened,
// FRA could not start, and this command printed VERDICT: HEALTHY and exited 0.
// A health check that is green while the service it certifies refuses to run is
// worse than no health check, because someone trusts it.
//
// Two levels, deliberately. verifyFraRootAccess() is the SAME call the bridge
// makes, so its answer is the one that matters -- but it collapses every
// specific refusal into FRA_ROOT_ACCESS_INVALID. This tool exists to print the
// address, not just sound the alarm, so on failure it re-runs the read-only
// probe directly to recover the granular code (FRA_ROOT_ACCESS_DACL_INHERITED
// and friends). The probe emits codes only -- never a path, SID, or account
// name -- which is why surfacing it here does not widen what this tool leaks.
function granularRootAccessCode() {
  try {
    const output = execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'tools', 'fra-root-access-probe.ps1')],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: safeLaunchEnvironment(
          { ...process.env, TOOLSENABLED_FRA_ROOT_ACCESS_TARGET: ROOT },
          { context: 'fra-doctor root-access probe' }
        )
      }
    );
    const parsed = JSON.parse(String(output).trim());
    return /^FRA_ROOT_ACCESS_[A-Z_]+$/.test(String(parsed.code || '')) ? parsed.code : null;
  } catch (error) {
    // The probe exits 1 on every refusal, which execFileSync throws on; the
    // JSON we want is still on stdout.
    try {
      const parsed = JSON.parse(String((error && error.stdout) || '').trim());
      return /^FRA_ROOT_ACCESS_[A-Z_]+$/.test(String(parsed.code || '')) ? parsed.code : null;
    } catch { return null; }
  }
}

try {
  const access = rootAccess.verifyFraRootAccess({ root: ROOT });
  report.rootAccess = {
    ok: access.valid === true,
    policyDigest: short(access.policyDigest),
    descriptorDigest: short(access.descriptorDigest)
  };
} catch (error) {
  const code = (error && error.code) || 'FRA_ROOT_ACCESS_INVALID';
  const granular = granularRootAccessCode();
  report.rootAccess = { ok: false, code, granularCode: granular };
  fail('root-access', 'the tree root fails FRA root-access verification',
    `${granular || code}; the FRA bridge and the MCP proxy both refuse to start on this, so the lane is DOWN regardless of anchors`);
  try {
    fs.accessSync(path.join(ROOT, 'state', 'fra-root-access-preimage.json'), fs.constants.R_OK);
    report.rootAccess.everHardened = true;
  } catch (preimageError) {
    if (preimageError && preimageError.code === 'ENOENT') {
      report.rootAccess.everHardened = false;
      fail('root-access', 'this tree has never been hardened',
        'no state/fra-root-access-preimage.json exists, so this is a first-time DACL change, not a drift to restore -- tools/fra-root-access-control.ps1 -Action Harden, and it changes ACLs across the whole tree');
    } else {
      report.rootAccess.everHardened = null;
      fail('root-access', 'the prior-hardening state could not be established',
        (preimageError && preimageError.code) || 'FRA_ROOT_ACCESS_PREIMAGE_UNREADABLE');
    }
  }
}

// --- credentials, by fingerprint only ---------------------------------------
// Never the value. Length alone has diagnostic power: the rendezvous token is 40
// characters, so a 40-character value in the BRIDGE slot means the rendezvous
// engine overwrote a credential it should never have touched.
function fingerprint(key) {
  try {
    const value = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'tools', 'secrets.ps1'), 'get', key],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: safeLaunchEnvironment(process.env, { context: 'fra-doctor credential fingerprint' })
      }
    ).trim();
    if (!value) return { present: false };
    return {
      present: true,
      length: value.length,
      fingerprint: crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
    };
  } catch (error) {
    return { present: null, unreadable: true, error: (error && error.code) || 'FRA_VAULT_READ_FAILED' };
  }
}

if (!argv.includes('--no-vault')) {
  report.credentials = {
    'custom.full_remote_access_token': fingerprint('custom.full_remote_access_token'),
    'custom.remote_agent_bridge_token': fingerprint('custom.remote_agent_bridge_token')
  };
  for (const [key, value] of Object.entries(report.credentials)) {
    if (value.unreadable) {
      fail('credential', `${key} could not be read from the vault`,
        `${value.error}; credential presence was not measured`);
    } else if (!value.present) {
      fail('credential', `${key} is absent from the vault`, 'the lane cannot authenticate without it');
    }
  }
  const fra = report.credentials['custom.full_remote_access_token'];
  const bridgeCred = report.credentials['custom.remote_agent_bridge_token'];
  if (fra.present && bridgeCred.present && fra.fingerprint === bridgeCred.fingerprint) {
    fail('credential', 'the FRA and bridge slots hold the SAME value',
      'these are separate authorities; one value for both grants the bounded bridge credential full agentic control');
  }
}

// --- local state, with the staleness rule applied ---------------------------
// A projection is only written by Start/Stop/Restart, never by Status, so its
// age says when it was last WRITTEN, not whether it is true now. Reporting a
// stale projection as current is a mistake that has already been made today.
function readJson(relative) {
  try {
    return { value: JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/^﻿/, '')) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { missing: true };
    return { error: (error && error.code) || 'INVALID_JSON' };
  }
}

const fraStateRead = readJson('state/full-remote-access-state.json');
const fraState = fraStateRead.value;
if (fraState) {
  const writtenMs = Date.parse(fraState.generatedAt || 0);
  const ageSec = Number.isFinite(writtenMs) ? Math.round((Date.now() - writtenMs) / 1000) : null;
  const futureDated = ageSec !== null && ageSec < -5;
  const stale = ageSec === null || ageSec > 300 || futureDated;
  const staleReason = futureDated
    ? 'projection is more than 5s in the future; correct clock skew and re-run the control script Status'
    : 'projection older than 300s; re-run the control script Status to learn the truth';
  report.listener = {
    lastWrittenAgeSeconds: ageSec,
    kind: 'last-action projection, not a heartbeat',
    operational: stale ? 'UNKNOWN' : fraState.operational,
    reason: stale ? staleReason : (fraState.reason || null),
    runtimeDigest: short(fraState.runtimeDigest)
  };
  if (!stale && fraState.operational !== true) {
    fail('listener', `the listener is not operational: ${fraState.reason || 'no reason recorded'}`, null);
  } else if (stale) {
    fail('listener', 'listener operation was not measured', report.listener.reason);
  }
} else if (fraStateRead.error) {
  report.listener = { operational: 'UNKNOWN', reason: `state could not be read (${fraStateRead.error})` };
  fail('listener', 'listener operation was not measured', report.listener.reason);
} else {
  report.listener = { operational: 'UNKNOWN', reason: 'no projection written yet' };
  fail('listener', 'listener operation was not measured', report.listener.reason);
}

const rendezvousPrimary = readJson('state/fra-rendezvous-state.json');
const rendezvousFallback = rendezvousPrimary.missing
  ? readJson('state/mechanical-connect-state.json')
  : null;
const rendezvousRead = rendezvousPrimary.value ? rendezvousPrimary : (rendezvousFallback || rendezvousPrimary);
const rendezvous = rendezvousRead.value;
if (rendezvous) {
  report.rendezvous = { generation: rendezvous.generation, role: rendezvous.role || null };
} else if (rendezvousRead.error) {
  report.rendezvous = { generation: null, role: null, note: `state could not be read (${rendezvousRead.error})` };
  fail('rendezvous', 'rendezvous state was not measured', report.rendezvous.note);
} else {
  report.rendezvous = { generation: null, role: null, note: 'no rendezvous state on this machine' };
}

// --- verdict ----------------------------------------------------------------
report.ok = findings.length === 0;
report.findings = findings;

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const L = [];
  L.push(`FRA doctor  --  ${host || 'UNKNOWN HOST'}${report.peer ? `  (peer ${report.peer})` : ''}`);
  L.push('');
  L.push(report.ok ? '  VERDICT: HEALTHY' : `  VERDICT: ${findings.length} PROBLEM(S)`);
  L.push('');
  for (const h of HOSTS) {
    const a = report.anchors[h] || {};
    L.push(`  anchor ${h}   ${a.ok ? 'ok  ' : 'FAIL'}  ${a.fileCount || '?'} files  ${short(a.runtimeDigest || a.code || '')}`);
    for (const d of a.divergent || []) {
      L.push(`      ${d.path}`);
      L.push(`          anchor ${d.expected}   disk ${d.actual}`);
    }
  }
  if (report.policy) L.push(`  policy digest        ${short(report.policy.digest || report.policy.error)}  (${(report.policy.files || []).length} files)`);
  for (const h of HOSTS) {
    const c = report.capability[h] || {};
    L.push(`  capability ${h}   ${c.allowedToolCount ?? '?'} allowed, ${c.excludedCount ?? '?'} excluded`);
  }
  if (report.credentials) {
    for (const [key, v] of Object.entries(report.credentials)) {
      L.push(`  ${key.padEnd(34)} ${v.unreadable ? 'UNREADABLE' : (v.present ? `len ${v.length}  ${v.fingerprint}` : 'ABSENT')}`);
    }
  }
  if (report.rootAccess) {
    L.push(`  root access          ${report.rootAccess.ok
      ? `ok    ${report.rootAccess.descriptorDigest}`
      : `FAIL  ${report.rootAccess.granularCode || report.rootAccess.code}${report.rootAccess.everHardened === false ? '  (never hardened on this tree)' : ''}`}`);
  }
  L.push(`  listener operational  ${report.listener.operational}${report.listener.reason ? `  (${report.listener.reason})` : ''}`);
  L.push(`  rendezvous            generation ${report.rendezvous.generation ?? 'none'}${report.rendezvous.role ? `, ${report.rendezvous.role}` : ''}`);
  if (findings.length) {
    L.push('');
    L.push('  PROBLEMS');
    for (const f of findings) {
      L.push(`    [${f.area}] ${f.summary}`);
      if (f.detail) L.push(`        ${f.detail}`);
    }
  }
  L.push('');
  if (!quiet) process.stdout.write(L.join('\n') + '\n');
}

process.exit(report.ok ? 0 : 1);
