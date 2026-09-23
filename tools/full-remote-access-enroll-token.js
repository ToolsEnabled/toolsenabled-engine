#!/usr/bin/env node
'use strict';

// One-shot bootstrap for FRA's dedicated credential. The listener is bound to
// one direct-Ethernet endpoint, accepts only the exact opposite endpoint, and
// writes the generated token directly to the DPAPI vault over child stdin.
// It never prints or returns the token. After a successful first write it
// closes permanently and launches the fixed FRA restart controller.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { getSecret } = require('../src/lib/runtime');
const {
  assertSanctionedMachineAddress,
  machineAddressPolicy,
  peerMachineForAddress,
  ServiceRegistryError
} = require('../src/lib/service-registry');
const { createEnrollServer } = require('./lib/one-shot-token-enroll');

const ROOT = path.resolve(__dirname, '..');
const VAULT_KEY = 'custom.full_remote_access_token';
const BOOTSTRAP_VAULT_KEY = 'custom.remote_agent_bridge_token';
const ENROLL_PATH = '/v1/enroll-token';
const ENROLL_PORT = 8793;
const ENROLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ENVELOPE_SCHEMA = 'tools-enabled.fra-enrollment-envelope.v1';
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const CONTROL_SCRIPT = path.join(ROOT, 'tools', 'full-remote-access-control.ps1');
const RUNTIME_INTEGRITY_SCRIPT = path.join(ROOT, 'src', 'lib', 'fra-runtime-integrity.js');
const RUNTIME_INTEGRITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function decodeBase64Url(value, bytes, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(code);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) {
    decoded.fill(0);
    fail(code);
  }
  return decoded;
}

function exactEnvelopeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = ['ciphertext', 'createdAtMs', 'iv', 'nonce', 'schemaVersion', 'sourceHost', 'tag', 'targetHost'].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function envelopeAad(envelope) {
  return Buffer.from([
    envelope.schemaVersion,
    String(envelope.createdAtMs),
    envelope.sourceHost,
    envelope.targetHost,
    envelope.nonce
  ].join('\n'), 'utf8');
}

function deriveEnrollmentKey(bootstrapSecret, nonce, sourceHost, targetHost) {
  const secret = Buffer.isBuffer(bootstrapSecret)
    ? bootstrapSecret
    : Buffer.from(String(bootstrapSecret || ''), 'utf8');
  if (secret.length < 16) fail('FRA_ENROLLMENT_BOOTSTRAP_INVALID');
  const info = Buffer.from(`${ENVELOPE_SCHEMA}\0${sourceHost}\0${targetHost}`, 'utf8');
  try {
    return Buffer.from(crypto.hkdfSync('sha256', secret, nonce, info, 32));
  } finally {
    info.fill(0);
    if (!Buffer.isBuffer(bootstrapSecret)) secret.fill(0);
  }
}

function sealEnrollmentToken({
  token, bootstrapSecret, sourceHost, targetHost, now = Date.now(), randomBytes = crypto.randomBytes,
  serviceRegistryOptions = {}
}) {
  if (!TOKEN_RE.test(String(token || ''))) fail('FRA_ENROLLMENT_TOKEN_INVALID');
  if (peerForHost(sourceHost, serviceRegistryOptions) !== targetHost) fail('FRA_ENROLLMENT_PEER_MISMATCH');
  if (!Number.isSafeInteger(now) || now < 1) fail('FRA_ENROLLMENT_TIME_INVALID');
  const nonceBytes = randomBytes(32);
  const iv = randomBytes(12);
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 32 || !Buffer.isBuffer(iv) || iv.length !== 12) {
    if (Buffer.isBuffer(nonceBytes)) nonceBytes.fill(0);
    if (Buffer.isBuffer(iv)) iv.fill(0);
    fail('FRA_ENROLLMENT_RANDOM_INVALID');
  }
  const envelope = {
    schemaVersion: ENVELOPE_SCHEMA,
    createdAtMs: now,
    sourceHost,
    targetHost,
    nonce: nonceBytes.toString('base64url'),
    iv: iv.toString('base64url'),
    ciphertext: '',
    tag: ''
  };
  const aad = envelopeAad(envelope);
  const key = deriveEnrollmentKey(bootstrapSecret, nonceBytes, sourceHost, targetHost);
  const plaintext = Buffer.from(token, 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url');
    envelope.tag = cipher.getAuthTag().toString('base64url');
    return envelope;
  } finally {
    nonceBytes.fill(0);
    iv.fill(0);
    aad.fill(0);
    key.fill(0);
    plaintext.fill(0);
  }
}

function openEnrollmentToken({
  envelope, bootstrapSecret, sourceHost, targetHost, now = Date.now(), serviceRegistryOptions = {}
}) {
  if (!exactEnvelopeKeys(envelope)) fail('FRA_ENROLLMENT_ENVELOPE_INVALID');
  if (envelope.schemaVersion !== ENVELOPE_SCHEMA || envelope.sourceHost !== sourceHost ||
      envelope.targetHost !== targetHost || peerForHost(sourceHost, serviceRegistryOptions) !== targetHost) {
    fail('FRA_ENROLLMENT_CONTEXT_MISMATCH');
  }
  if (!Number.isSafeInteger(envelope.createdAtMs) || Math.abs(now - envelope.createdAtMs) > MAX_CLOCK_SKEW_MS) {
    fail('FRA_ENROLLMENT_ENVELOPE_EXPIRED');
  }
  const nonce = decodeBase64Url(envelope.nonce, 32, 'FRA_ENROLLMENT_NONCE_INVALID');
  const iv = decodeBase64Url(envelope.iv, 12, 'FRA_ENROLLMENT_IV_INVALID');
  const tag = decodeBase64Url(envelope.tag, 16, 'FRA_ENROLLMENT_TAG_INVALID');
  let ciphertext;
  try { ciphertext = decodeBase64Url(envelope.ciphertext, 43, 'FRA_ENROLLMENT_CIPHERTEXT_INVALID'); }
  catch (error) { nonce.fill(0); iv.fill(0); tag.fill(0); throw error; }
  const aad = envelopeAad(envelope);
  const key = deriveEnrollmentKey(bootstrapSecret, nonce, sourceHost, targetHost);
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const token = plaintext.toString('utf8');
    if (!TOKEN_RE.test(token)) fail('FRA_ENROLLMENT_TOKEN_INVALID');
    return token;
  } catch (error) {
    if (error && error.code && /^FRA_ENROLLMENT_/.test(error.code)) throw error;
    fail('FRA_ENROLLMENT_AUTH_FAILED');
  } finally {
    nonce.fill(0); iv.fill(0); tag.fill(0); ciphertext.fill(0); aad.fill(0); key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}

function resolveHost(
  configured = process.env.FULL_REMOTE_ACCESS_ENROLL_HOST || process.env.FULL_REMOTE_ACCESS_HOST,
  serviceRegistryOptions = {},
  networkInterfaces = os.networkInterfaces
) {
  const policy = machineAddressPolicy(serviceRegistryOptions);
  if (configured) {
    try { assertSanctionedMachineAddress(String(configured), serviceRegistryOptions); }
    catch (error) {
      if (error instanceof ServiceRegistryError
          && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED'].includes(error.code)) {
        throw Object.assign(new Error('FRA_ENROLL_HOST_INVALID'), { code: 'FRA_ENROLL_HOST_INVALID', cause: error });
      }
      throw error;
    }
    return String(configured);
  }
  const found = new Set();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address?.family === 'IPv4' && policy.has(address.address)) found.add(address.address);
    }
  }
  if (found.size !== 1) throw Object.assign(new Error('FRA_ENROLL_HOST_UNRESOLVED'), { code: 'FRA_ENROLL_HOST_UNRESOLVED' });
  return [...found][0];
}

function peerForHost(host, serviceRegistryOptions = {}) {
  try { return peerMachineForAddress(host, serviceRegistryOptions).address; }
  catch (error) {
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      throw Object.assign(new Error('FRA_ENROLL_HOST_INVALID'), { code: 'FRA_ENROLL_HOST_INVALID', cause: error });
    }
    throw error;
  }
}

function startFixedRestart({ spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', CONTROL_SCRIPT, '-Action', 'Restart'
    ], { cwd: ROOT, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      if (typeof child.unref === 'function') child.unref();
      resolve(true);
    });
  });
}

// serviceRegistryOptions is threaded rather than dropped, which every sibling in
// this file already does. Without it this function always resolved against the
// machine-local registry, so it could only run on a machine whose registry
// happened to declare the host -- and a caller passing a fixture registry was
// silently ignored, which reads as "the fixture did not work" rather than "the
// option never arrived".
function runFixedRuntimeIntegrity({ host, spawnImpl = spawn, serviceRegistryOptions = {} } = {}) {
  host = resolveHost(host, serviceRegistryOptions);
  const args = [RUNTIME_INTEGRITY_SCRIPT, '--check', '--host', host];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: ROOT, windowsHide: true, stdio: 'ignore'
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error('FRA_RUNTIME_ENROLLMENT_TIMEOUT'), { code: 'FRA_RUNTIME_ENROLLMENT_TIMEOUT' }));
    }, RUNTIME_INTEGRITY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error('FRA_RUNTIME_ENROLLMENT_FAILED'), { code: 'FRA_RUNTIME_ENROLLMENT_FAILED', cause: error }));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(Object.assign(new Error('FRA_RUNTIME_ENROLLMENT_FAILED'), { code: 'FRA_RUNTIME_ENROLLMENT_FAILED' }));
    });
  });
}

function createFullRemoteAccessEnrollServer({
  host, writeToVault, log, onSettled, allowedRemoteRe, bootstrapSecret, now,
  serviceRegistryOptions = {}
} = {}) {
  host = resolveHost(host, serviceRegistryOptions);
  const peerHost = peerForHost(host, serviceRegistryOptions);
  const exactPeer = allowedRemoteRe || new RegExp(`^${peerHost.replace(/\./g, '\\.')}$`);
  let secretInput = bootstrapSecret;
  if (secretInput === undefined) secretInput = getSecret(BOOTSTRAP_VAULT_KEY, { prompt: false });
  const secret = Buffer.from(String(secretInput || ''), 'utf8');
  secretInput = null;
  const server = createEnrollServer({
    vaultKey: VAULT_KEY,
    enrollPath: ENROLL_PATH,
    tokenRe: TOKEN_RE,
    allowedRemoteRe: exactPeer,
    decodeToken: envelope => openEnrollmentToken({
      envelope,
      bootstrapSecret: secret,
      sourceHost: peerHost,
      targetHost: host,
      serviceRegistryOptions,
      ...(now === undefined ? {} : { now })
    }),
    ...(writeToVault ? { writeToVault } : {}),
    ...(log ? { log } : {}),
    ...(onSettled ? { onSettled } : {})
  });
  server.once('close', () => secret.fill(0));
  return server;
}

async function main() {
  const host = resolveHost();
  let configured = false;
  // Only a genuinely ABSENT key may proceed to enrollment. A bare catch here
  // also swallowed DPAPI decrypt failure under a different session, corrupted
  // vault JSON, and transient file locks -- all of which left configured=false
  // and opened the one-shot 8793 listener, which would then OVERWRITE a good
  // FRA credential instead of refusing. Fail closed on everything but absence.
  try {
    configured = Boolean(getSecret(VAULT_KEY, { prompt: false }));
  } catch (error) {
    if (!error || error.code !== 'SECRET_NOT_CONFIGURED') throw error;
  }
  if (configured) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'FRA_TOKEN_ALREADY_CONFIGURED', secretValuesEmitted: false }) + '\n');
    process.exitCode = 1;
    return;
  }
  // Enrollment handles only the external DPAPI credential. Release assembly,
  // capability manifests, and the integrity anchor must already be installed
  // and must pass before the one-shot network listener is allowed to bind.
  await runFixedRuntimeIntegrity({ host });
  const server = createFullRemoteAccessEnrollServer({
    host,
    log: line => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
    onSettled: () => setTimeout(() => {
      server.close(async () => {
        try {
          await runFixedRuntimeIntegrity({ host });
          await startFixedRestart();
          process.exit(0);
        } catch (error) {
          const code = error && /^[A-Z0-9_]{1,80}$/.test(error.code || error.message)
            ? (error.code || error.message) : 'FRA_RUNTIME_ENROLLMENT_FAILED';
          process.stderr.write(`${code}\n`);
          process.exit(1);
        }
      });
    }, 250)
  });
  server.listen(ENROLL_PORT, host, () => {
    process.stdout.write(JSON.stringify({
      ok: true,
      code: 'FRA_ENROLLMENT_READY',
      host,
      peerHost: peerForHost(host),
      port: ENROLL_PORT,
      expiresInSeconds: ENROLL_TIMEOUT_MS / 1000,
      secretValuesEmitted: false
    }) + '\n');
  });
  setTimeout(() => {
    server.close(() => {
      process.stdout.write(JSON.stringify({ ok: false, code: 'FRA_ENROLLMENT_EXPIRED', secretValuesEmitted: false }) + '\n');
      process.exit(1);
    });
  }, ENROLL_TIMEOUT_MS).unref();
}

if (require.main === module) {
  main().catch(error => {
    const code = error && /^[A-Z0-9_]{1,80}$/.test(error.code || error.message)
      ? (error.code || error.message) : 'FRA_ENROLLMENT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  ROOT,
  VAULT_KEY,
  BOOTSTRAP_VAULT_KEY,
  ENROLL_PATH,
  ENROLL_PORT,
  ENROLL_TIMEOUT_MS,
  TOKEN_RE,
  ENVELOPE_SCHEMA,
  MAX_CLOCK_SKEW_MS,
  CONTROL_SCRIPT,
  RUNTIME_INTEGRITY_SCRIPT,
  RUNTIME_INTEGRITY_TIMEOUT_MS,
  resolveHost,
  peerForHost,
  sealEnrollmentToken,
  openEnrollmentToken,
  runFixedRuntimeIntegrity,
  startFixedRestart,
  createFullRemoteAccessEnrollServer,
  main
});
