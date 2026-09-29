const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertActive } = require('../policy');
const { record } = require('../audit');
const { authenticatedRequest } = require('../google-oauth');
const projectBoundary = require('../configured-project-boundary');

function itemPath(publisherId, itemId) { return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`; }
const oauthKeys = { accessKey: 'cws_access_token', refreshKey: 'cws_refresh_token', clientIdKey: 'cws_client_id', clientSecretKey: 'cws_client_secret' };
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const COMPLETE_UPLOAD_STATES = new Set(['SUCCEEDED', 'UPLOAD_SUCCEEDED']);
const PENDING_UPLOAD_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);

// The protected Store item id is CONFIGURATION, not a constant, single-sourced
// from ../configured-project-boundary along with that project's checkout root.
// Three things below compare against it -- the upload fence in upload(), the
// audit-target redaction, and the audit-details gate -- so the one thing that
// must not happen to this file is for a comparison to be deleted along with a
// literal. Both readers return false/null rather than throwing when nothing is
// configured, which is the normal case, and the three paths below then behave
// generically.
const { isProtectedStoreItem, isWithinConfiguredRoot, protectedStoreItemId } = projectBoundary;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function protectedProjectAuditTarget(itemId) { return isProtectedStoreItem(itemId) ? 'configured-protected-item' : itemId; }
function protectedProjectAuditDetails(itemId, publisherId, details) {
  if (!isProtectedStoreItem(itemId)) return { publisherId, ...details };
  const { packagePath, ...safeDetails } = details || {};
  return {
    publisherIdSha256: crypto.createHash('sha256').update(String(publisherId)).digest('hex'),
    protectedProjectItem: true,
    ...(typeof packagePath === 'string' ? { packagePathSha256: crypto.createHash('sha256').update(packagePath).digest('hex') } : {}),
    ...safeDetails
  };
}

function validatePackage(packagePath, options = {}) {
  const resolved = path.resolve(packagePath || '');
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new Error(`Extension package not found: ${resolved}`, { cause: error });
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error('Chrome Web Store packagePath must be a regular ZIP file.');
  if (path.extname(resolved).toLowerCase() !== '.zip') throw new Error('Chrome Web Store packagePath must end in .zip.');
  if (stat.size <= 0 || stat.size > MAX_PACKAGE_BYTES) throw new Error('Chrome Web Store packages must be non-empty and no larger than 2GB.');
  const isProtectedProject = isWithinConfiguredRoot(resolved);
  if (isProtectedProject) {
    const attestation = options.protectedProjectAttestation;
    if (!attestation || attestation.artifactPath !== resolved || !/^[a-f0-9]{64}$/.test(attestation.sha256 || '')) {
      throw new Error('The configured protected project requires a broker-owned upload attestation.');
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    if (actual !== attestation.sha256) throw new Error('The broker-attested protected-project package bytes changed before upload.');
  }
  const descriptor = fs.openSync(resolved, 'r');
  try {
    const magic = Buffer.alloc(2);
    if (fs.readSync(descriptor, magic, 0, magic.length, 0) !== magic.length || magic.toString('ascii') !== 'PK') {
      throw new Error('Chrome Web Store packagePath is not a ZIP archive (missing PK signature).');
    }
  } finally { fs.closeSync(descriptor); }
  return { resolved, bytes: stat.size };
}

// The protected project has already broker-attested the artifact hash. Copy those exact
// bytes into a private, short-lived snapshot before handing a stream to HTTP:
// a pathname can otherwise be atomically replaced after validation and before
// the request body is consumed.
function snapshotAttestedPackage(resolved, attestation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-cws-upload-'));
  const snapshotPath = path.join(directory, 'package.zip');
  let source; let destination;
  try {
    source = fs.openSync(resolved, 'r');
    const before = fs.fstatSync(source);
    if (!before.isFile() || before.size <= 0) throw new Error('Broker-attested protected-project package is no longer a regular non-empty file.');
    destination = fs.openSync(snapshotPath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (read <= 0) throw new Error('Broker-attested protected-project package changed while creating its upload snapshot.');
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(destination, buffer, written, read - written);
        if (count <= 0) throw new Error('Unable to create the broker-attested protected-project upload snapshot.');
        written += count;
      }
      position += read;
    }
    const after = fs.fstatSync(source);
    if (after.size !== before.size || position !== before.size || hash.digest('hex') !== attestation.sha256) {
      throw new Error('Broker-attested protected-project package bytes changed before upload snapshot.');
    }
    fs.closeSync(destination); destination = undefined;
    fs.closeSync(source); source = undefined;
    return { bytes: position, directory, snapshotPath };
  } catch (error) {
    if (destination !== undefined) fs.closeSync(destination);
    if (source !== undefined) fs.closeSync(source);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fetchStatus({ publisherId, itemId }) {
  const url = `https://chromewebstore.googleapis.com/v2/${itemPath(publisherId, itemId)}:fetchStatus`;
  return (await authenticatedRequest(url, {}, oauthKeys)).body;
}

async function status({ publisherId, itemId }) {
  assertActive('chromeWebStore.status');
  const result = await fetchStatus({ publisherId, itemId });
  record('chromeWebStore.status', protectedProjectAuditTarget(itemId), protectedProjectAuditDetails(itemId, publisherId, { lastAsyncUploadState: result.lastAsyncUploadState }));
  return result;
}

async function waitForUpload({ publisherId, itemId, initial }, dependencies = {}) {
  const getStatus = dependencies.fetchStatus || fetchStatus;
  const wait = dependencies.sleep || sleep;
  const now = dependencies.now || Date.now;
  const pollIntervalMs = dependencies.pollIntervalMs || 2500;
  const timeoutMs = dependencies.timeoutMs || 5 * 60 * 1000;
  let state = initial && initial.uploadState;
  if (COMPLETE_UPLOAD_STATES.has(state)) return { ...initial, uploadState: 'SUCCEEDED', polls: 0 };
  if (!PENDING_UPLOAD_STATES.has(state)) throw new Error(`Chrome Web Store upload failed with state '${state || 'UNSPECIFIED'}'.`);
  const deadline = now() + timeoutMs;
  let polls = 0;
  while (now() < deadline) {
    assertActive('chromeWebStore.upload.poll');
    await wait(pollIntervalMs);
    const current = await getStatus({ publisherId, itemId });
    polls += 1;
    state = current.lastAsyncUploadState;
    if (COMPLETE_UPLOAD_STATES.has(state)) return { ...initial, uploadState: 'SUCCEEDED', polls, status: current };
    if (!PENDING_UPLOAD_STATES.has(state)) throw new Error(`Chrome Web Store upload failed with state '${state || 'UNSPECIFIED'}'.`);
  }
  throw new Error(`Chrome Web Store upload was still processing after ${timeoutMs}ms.`);
}

async function upload({ publisherId, itemId, packagePath }, dependencies = {}) {
  assertActive('chromeWebStore.upload');
  // The existing AIC item is never reachable through the generic API, even
  // if its bytes are copied out of the source tree.  Only the dedicated
  // broker passes this private dependency after revalidating its attestation.
  if (isProtectedStoreItem(itemId) && !dependencies.protectedProjectAttestation) {
    throw new Error('The configured protected Store item requires a broker-owned upload attestation.');
  }
  const { resolved, bytes } = validatePackage(packagePath, dependencies);
  const snapshot = dependencies.protectedProjectAttestation
    ? snapshotAttestedPackage(resolved, dependencies.protectedProjectAttestation)
    : null;
  const url = `https://chromewebstore.googleapis.com/upload/v2/${itemPath(publisherId, itemId)}:upload`;
  const requestAuthenticated = dependencies.authenticatedRequest || authenticatedRequest;
  try {
    const uploadBytes = snapshot ? snapshot.bytes : bytes;
    const initial = (await requestAuthenticated(url, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'content-length': String(uploadBytes) },
      bodyFactory: () => fs.createReadStream(snapshot ? snapshot.snapshotPath : resolved)
    }, oauthKeys)).body;
    const result = await waitForUpload({ publisherId, itemId, initial }, dependencies);
    record('chromeWebStore.upload', protectedProjectAuditTarget(itemId), protectedProjectAuditDetails(itemId, publisherId, {
      packagePath: resolved, bytes: uploadBytes, uploadState: result.uploadState, polls: result.polls
    }));
    return result;
  } finally {
    if (snapshot) fs.rmSync(snapshot.directory, { recursive: true, force: true });
  }
}

async function publish({ publisherId, itemId, staged = false, deployPercentage, skipReview = false, blockOnWarnings = true }, dependencies = {}) {
  assertActive('chromeWebStore.publish');
  const url = `https://chromewebstore.googleapis.com/v2/${itemPath(publisherId, itemId)}:publish`;
  const payload = {
    publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH', skipReview,
    blockOnWarnings
  };
  if (deployPercentage !== undefined) {
    const percentage = Number(deployPercentage);
    if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error('deployPercentage must be an integer from 0 through 100.');
    payload.deployInfos = [{ deployPercentage: percentage }];
  }
  const requestAuthenticated = dependencies.authenticatedRequest || authenticatedRequest;
  const result = (await requestAuthenticated(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }, oauthKeys)).body;
  record('chromeWebStore.publish', protectedProjectAuditTarget(itemId), protectedProjectAuditDetails(itemId, publisherId, {
    staged, deployPercentage, skipReview, state: result.state
  }));
  return result;
}

async function cancel({ publisherId, itemId }) {
  assertActive('chromeWebStore.cancelSubmission');
  const url = `https://chromewebstore.googleapis.com/v2/${itemPath(publisherId, itemId)}:cancelSubmission`;
  const result = (await authenticatedRequest(url, { method: 'POST' }, oauthKeys)).body;
  record('chromeWebStore.cancelSubmission', protectedProjectAuditTarget(itemId), protectedProjectAuditDetails(itemId, publisherId, {}));
  return result;
}

// A fixed built-in Store item ID is deliberately absent from this surface. It would be a
// value; the replacements are readers, because the answer now depends on this
// installation's configuration and a value captured at require() time would go
// stale and would reintroduce exactly the shipped-literal problem.
module.exports = { MAX_PACKAGE_BYTES, cancel, fetchStatus, isProtectedStoreItem, protectedProjectAuditDetails, protectedProjectAuditTarget, protectedStoreItemId, publish, snapshotAttestedPackage, status, upload, validatePackage, waitForUpload };
