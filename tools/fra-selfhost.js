#!/usr/bin/env node
'use strict';

// SELF-HOST PREFLIGHT FOR THE DIRECT (NO-RELAY) FRA LANE.
//
// WHY THIS EXISTS. The direct lane genuinely needs no server of ours: two
// computers on one network hold a shared secret, dial each other over TCP, and
// run a mutually-authenticated encrypted session. `tools/fra-doctor.js` already
// says, accurately, whether that lane is healthy RIGHT NOW on a tree that was
// already set up. What did not exist was anything that helps a person get from
// a fresh install to a working pair, and the gap was not documentation --
// it was one genuinely hidden input.
//
// THE HIDDEN INPUT. Adding your two machines means editing
// config/service-registry.json. That file is one of the ~48 files covered by
// the FRA runtime-integrity anchor, so editing it invalidates the anchor and
// the listener then refuses to start. Re-anchoring is the right answer and the
// code supports it:
//
//     node src/lib/fra-runtime-integrity.js --write --host <machine-id> \
//       --expected-preimage <sha256-of-the-current-anchor-file>
//
// `--expected-preimage` is a deliberate anti-clobber check, and it is correct.
// But nothing in the tree computed it for you, and it is not a value anyone
// can guess or read off a screen. A person following the existing docs hits
// FRA_RUNTIME_PREIMAGE_REQUIRED and has no next move. That single missing
// affordance is most of what made self-hosting feel hard.
//
// WHAT THIS TOOL DOES. `--check` (the default) walks the prerequisites in
// dependency order and, for each failure, prints the exact command that fixes
// it -- with the preimage already computed. `--reanchor --apply` performs the
// re-anchor for every machine the registry declares.
//
// WHAT THIS TOOL DELIBERATELY WILL NOT DO. It never writes a credential, never
// reads a credential VALUE (presence only), never edits the DACL, and never
// opens a firewall port. Those are the steps where a wrong automatic decision
// is expensive and silent, so they are reported as instructions for a human.
// This tool is additive: it can explain and it can re-anchor, and it can never
// make the lane less strict than it already is.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runtimeIntegrity = require('../src/lib/fra-runtime-integrity');
const rootAccess = require('../src/lib/fra-root-access');
const { loadRegistry } = require('../src/lib/service-registry');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

function parseArgs(argv) {
  const options = { mode: 'check', apply: false, json: false };
  for (const arg of argv) {
    if (arg === '--check') options.mode = 'check';
    else if (arg === '--reanchor') options.mode = 'reanchor';
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else {
      process.stderr.write(`unknown option: ${arg}\n`);
      process.exit(2);
    }
  }
  return options;
}

const HELP = `fra-selfhost -- get the direct, no-relay FRA lane working between two computers

  node tools/fra-selfhost.js                 check every prerequisite, print the fix for each failure
  node tools/fra-selfhost.js --json          the same result as JSON
  node tools/fra-selfhost.js --reanchor      show the exact re-anchor commands (with preimages)
  node tools/fra-selfhost.js --reanchor --apply
                                             re-anchor every machine the registry declares

Exit 0 when the lane is ready to start, 1 when a step still needs doing.
This tool never reads a credential value and never changes a DACL or firewall.
`;

// --- individual checks ------------------------------------------------------

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function checkRegistry() {
  try {
    const registry = loadRegistry({ noCache: true });
    const machines = Object.entries(registry.machines)
      .map(([id, machine]) => ({ id, address: machine.address }));
    if (machines.length !== 2) {
      return {
        name: 'registry',
        ok: false,
        detail: `config/service-registry.json declares ${machines.length} machine(s); the direct lane needs exactly the two that will talk to each other.`,
        fix: 'Edit config/service-registry.json and give each computer an entry under "machines" with its LAN IPv4 address, then re-run this tool.',
        machines
      };
    }
    return {
      name: 'registry',
      ok: true,
      detail: machines.map(m => `${m.id}=${m.address}`).join(', '),
      machines
    };
  } catch (error) {
    return {
      name: 'registry',
      ok: false,
      detail: `${(error && error.code) || 'REGISTRY_UNREADABLE'}: ${(error && error.message) || 'unknown'}`,
      fix: 'Repair config/service-registry.json. It must be JSON with schemaVersion 1, a "machines" object, and a "services" object.',
      machines: []
    };
  }
}

function anchorStateFor(machine) {
  const resolved = runtimeIntegrity.resolveAnchorPath(ROOT, machine.id, {});
  const anchorPath = resolved.identityPath;
  let exists;
  try {
    fs.statSync(anchorPath);
    exists = true;
  } catch (error) {
    if (error && error.code === 'ENOENT') exists = false;
    else throw error;
  }
  const relative = path.relative(ROOT, anchorPath).replace(/\\/g, '/');
  const preimage = exists ? sha256File(anchorPath) : 'absent';
  let valid = false;
  let code = null;
  let verificationError = false;
  try {
    const report = runtimeIntegrity.verifyRuntimeIntegrity({ root: ROOT, host: machine.id });
    valid = report.valid === true;
  } catch (error) {
    code = (error && error.code) || 'FRA_RUNTIME_INTEGRITY_FAILED';
    if (!exists) {
      try {
        fs.statSync(anchorPath);
        verificationError = true;
      } catch (statError) {
        if (!statError || statError.code !== 'ENOENT') throw statError;
        // Absence was established both before and after verification, so this
        // is a known missing anchor rather than an unmeasured verification.
      }
    } else {
      const establishedInvalid = new Set([
        'FRA_RUNTIME_DIGEST_MISMATCH', 'FRA_RUNTIME_FILE_HASH_MISMATCH',
        'FRA_RUNTIME_LAYOUT_MISMATCH', 'FRA_RUNTIME_MANIFEST_INVALID',
        'FRA_RUNTIME_MANIFEST_NONCANONICAL', 'FRA_RUNTIME_ROOTS_MISMATCH'
      ]);
      verificationError = !establishedInvalid.has(code);
    }
  }
  return { machine, anchorPath, relative, exists, preimage, valid, code, verificationError };
}

function reanchorCommand(state) {
  return `node src/lib/fra-runtime-integrity.js --write --host ${state.machine.id} --expected-preimage ${state.preimage}`;
}

function checkAnchors(machines) {
  const states = machines.map(anchorStateFor);
  const unmeasured = states.filter(state => state.verificationError);
  const broken = states.filter(state => !state.valid);
  return {
    name: 'runtime-anchor',
    ok: broken.length === 0,
    detail: unmeasured.length > 0
      ? `could not verify ${unmeasured.length} of ${states.length} anchor(s): ${unmeasured.map(state => `${state.machine.id} (${state.code})`).join(', ')}`
      : broken.length === 0
      ? `every declared machine has a valid anchor (${states.length})`
      : `${broken.length} of ${states.length} anchor(s) do not match this tree`,
    fix: broken.length === 0 ? null
      : unmeasured.length > 0
        ? 'Resolve the verification error(s) above and re-run this tool. No re-anchor command is offered for an anchor that could not be measured.'
      : 'Re-anchor each machine below. The preimage is already computed for you:\n'
        + broken.map(state => `    ${reanchorCommand(state)}`).join('\n'),
    states
  };
}

function checkCapabilityManifests(machines) {
  const missing = [];
  const unreadable = [];
  for (const machine of machines) {
    const file = path.join(ROOT, 'config', `fra-capability-manifest.${machine.id}.json`);
    const relative = `config/fra-capability-manifest.${machine.id}.json`;
    try {
      fs.statSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') missing.push(relative);
      else unreadable.push(`${relative} (${(error && error.code) || 'READ_FAILED'})`);
    }
  }
  return {
    name: 'capability-manifest',
    ok: missing.length === 0 && unreadable.length === 0,
    detail: unreadable.length > 0
      ? `could not establish manifest presence: ${unreadable.join(', ')}`
      : missing.length === 0
      ? `every declared machine has a capability manifest (${machines.length})`
      : `missing: ${missing.join(', ')}`,
    fix: unreadable.length > 0
      ? 'Resolve the filesystem error(s) above and re-run this tool; unreadable manifests are not treated as missing or present.'
      : missing.length === 0 ? null
      : 'Each machine needs a manifest naming exactly the tools the peer may call. Copy an existing\n'
        + '    config/fra-capability-manifest.<other-machine-id>.json to the missing name above and edit the\n'
        + '    allowed tool list. The manifest is a security boundary: list only what you want the peer to run.'
  };
}

function checkCredential() {
  // PRESENCE ONLY, AND LITERALLY SO. This deliberately uses the vault's
  // `exists` action rather than `get`: the secret is never decrypted, never
  // enters this process's memory, and cannot be printed by a later edit to
  // this function. `exists` exits 0 when the key is present and 1 when it is
  // not, and it writes its own vault access-log entry, so this check leaves
  // the same audit trace as any other question asked about that key.
  let present = false;
  let reason = null;
  let measured = true;
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'tools', 'secrets.ps1'),
      'exists', 'custom.full_remote_access_token'
    ], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: false,
      // This one spawns the SECRETS tool. Handing the vault reader every
      // provider credential in ambient env is the least defensible inheritance
      // on the list, fixed argv or not.
      env: safeLaunchEnvironment(process.env, { context: 'fra self-host vault presence probe' })
    });
    present = true;
  } catch (error) {
    if (error && error.status === 1) reason = 'not present in the local vault';
    else {
      measured = false;
      reason = `presence could not be measured (${(error && (error.code || error.signal)) || 'VAULT_PROBE_FAILED'})`;
    }
  }
  return {
    name: 'credential',
    ok: present,
    detail: present
      ? 'custom.full_remote_access_token is present in the local vault'
      : `custom.full_remote_access_token is not usable (${reason})`,
    fix: present ? null
      : !measured
        ? 'Repair the local vault probe and re-run this tool. A probe failure does not establish that the shared credential is absent.'
      : 'Generate ONE random 32-byte secret and store it under custom.full_remote_access_token in the local\n'
        + '    vault on BOTH computers -- the same value on each; that shared value is what authenticates the\n'
        + '    pair. Use tools/secrets.ps1 to store it. Never send it over chat, email, or the tunnel.'
  };
}

function checkRootAccess() {
  try {
    const report = rootAccess.verifyFraRootAccess({ root: ROOT });
    const ok = report && report.valid === true;
    return {
      name: 'root-access',
      ok,
      detail: ok ? 'the install directory passes the FRA root/DACL check'
        : `the install directory fails the FRA root/DACL check (${(report && report.code) || 'unknown'})`,
      fix: ok ? null
        : 'Apply the protected DACL to the install directory:\n'
          + '    powershell -NoProfile -ExecutionPolicy Bypass -File tools/fra-root-access-control.ps1\n'
          + '    The bridge refuses to start until this passes; that is deliberate, because the anchor is only\n'
          + '    meaningful if the files it covers cannot be rewritten by another account.'
    };
  } catch (error) {
    return {
      name: 'root-access',
      ok: false,
      detail: `root-access check failed (${(error && error.code) || 'unknown'})`,
      fix: 'Run tools/fra-root-access-control.ps1 from an elevated PowerShell on this computer.'
    };
  }
}

function checkPlatform() {
  const ok = process.platform === 'win32';
  return {
    name: 'platform',
    ok,
    detail: ok ? `windows (${process.platform})` : `${process.platform} is not supported by the direct FRA lane today`,
    fix: ok ? null
      : 'The direct lane currently requires Windows on BOTH computers: the credential store is DPAPI and the\n'
        + '    root-access gate reads a Windows DACL. There is no supported Linux or macOS peer yet.'
  };
}

// --- modes ------------------------------------------------------------------

function runChecks() {
  const results = [];
  results.push(checkPlatform());
  const registry = checkRegistry();
  results.push(registry);
  const machines = registry.machines || [];
  if (machines.length >= 2) {
    results.push(checkCapabilityManifests(machines));
    results.push(checkAnchors(machines));
  }
  results.push(checkCredential());
  results.push(checkRootAccess());
  return results;
}

function renderChecks(results) {
  const lines = [];
  lines.push('');
  lines.push('FRA self-host preflight  --  direct lane, no relay, no account');
  lines.push('');
  for (const result of results) {
    lines.push(`  ${result.ok ? 'PASS' : 'TODO'}  ${result.name.padEnd(20)} ${result.detail}`);
  }
  const todo = results.filter(result => !result.ok);
  lines.push('');
  if (todo.length === 0) {
    lines.push('  READY. Start the listener on each computer:');
    lines.push('      node src/full-remote-access-bridge.js');
    lines.push('');
    return { text: lines.join('\n'), exit: 0 };
  }
  lines.push(`  ${todo.length} STEP(S) LEFT, in this order:`);
  lines.push('');
  for (const result of todo) {
    lines.push(`  [${result.name}] ${result.detail}`);
    if (result.fix) lines.push(`    ${result.fix}`);
    lines.push('');
  }
  return { text: lines.join('\n'), exit: 1 };
}

function runReanchor(apply) {
  const registry = checkRegistry();
  if (!registry.ok) {
    return { text: `\n  cannot re-anchor: ${registry.detail}\n`, exit: 1 };
  }
  const lines = [''];
  let failures = 0;
  let outstanding = 0;
  for (const machine of registry.machines) {
    const state = anchorStateFor(machine);
    if (state.valid) {
      lines.push(`  OK    ${machine.id} (${machine.address}) anchor already matches this tree`);
      continue;
    }
    if (state.verificationError) {
      failures += 1;
      lines.push(`  FAIL  ${machine.id} (${machine.address}) anchor could not be verified (${state.code})`);
      continue;
    }
    if (!apply) {
      // Plan mode still reports work outstanding as a non-zero exit, so a
      // caller that gates on this command cannot read "nothing was written"
      // as "nothing needed writing".
      outstanding += 1;
      lines.push(`  TODO  ${machine.id} (${machine.address}) ${state.exists ? 'anchor drifted' : 'anchor missing'}`);
      lines.push(`        ${reanchorCommand(state)}`);
      continue;
    }
    try {
      const report = runtimeIntegrity.writeRuntimeManifest({
        root: ROOT, host: machine.id, expectedPreimage: state.preimage
      });
      lines.push(`  WROTE ${machine.id} (${machine.address}) ${state.relative} -- ${report.fileCount ?? '?'} files, valid=${report.valid === true}`);
      if (report.valid !== true) failures += 1;
    } catch (error) {
      failures += 1;
      lines.push(`  FAIL  ${machine.id} (${machine.address}) ${(error && error.code) || 'FRA_RUNTIME_MANIFEST_WRITE_FAILED'}`);
    }
  }
  if (!apply) {
    lines.push('');
    lines.push('  Nothing was written. Re-run with --apply to perform the re-anchor.');
  }
  lines.push('');
  return { text: lines.join('\n'), exit: failures === 0 && outstanding === 0 ? 0 : 1 };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.mode === 'reanchor') {
    const result = runReanchor(options.apply);
    process.stdout.write(result.text + '\n');
    return result.exit;
  }
  const results = runChecks();
  if (options.json) {
    process.stdout.write(JSON.stringify({
      ok: results.every(result => result.ok),
      checks: results.map(result => ({
        name: result.name, ok: result.ok, detail: result.detail, fix: result.fix || null
      }))
    }, null, 2) + '\n');
    return results.every(result => result.ok) ? 0 : 1;
  }
  const rendered = renderChecks(results);
  process.stdout.write(rendered.text + '\n');
  return rendered.exit;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = Object.freeze({
  checkRegistry, checkAnchors, checkCapabilityManifests,
  checkCredential, checkRootAccess, checkPlatform,
  anchorStateFor, reanchorCommand, runChecks
});
