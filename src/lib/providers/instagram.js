const { getSecret } = require('../runtime');
const { assertActive, assertHttps, loadPolicy } = require('../policy');
const { record } = require('../audit');
const { request, form } = require('../http');
const { safeObject } = require('./provider-safety');

const OPERATION_TYPE = 'instagram.publish_image';
const OPERATION_LEASE_MS = 3 * 60 * 1000;

function config() {
  const policy = loadPolicy();
  return {
    apiVersion: (policy.providers && policy.providers.instagram && policy.providers.instagram.apiVersion) || 'v25.0',
    token: getSecret('ig_access_token'),
    userId: getSecret('ig_user_id')
  };
}

async function api(path, options = {}, providerConfig = config()) {
  const { apiVersion, token } = providerConfig;
  const method = options.method || 'GET';
  const data = { ...(options.data || {}), access_token: token };
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
  const init = { method };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(data)) url.searchParams.set(key, value);
  } else {
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    init.body = form(data);
  }
  return (await request(url, init)).body;
}

async function verify() {
  assertActive('instagram.verify');
  const providerConfig = config();
  const { userId, token } = providerConfig;
  const account = await api(userId, { data: { fields: 'id,username,account_type' } }, providerConfig);
  const quota = await api(`${userId}/content_publishing_limit`, { data: { fields: 'quota_usage,config' } }, providerConfig);
  record('instagram.verify', userId, { accountType: account.account_type });
  return { account: safeObject(account, token), quota: safeObject(quota.data || quota, token) };
}

function errorStatus(error, fallbackCode, errorMessage) {
  const candidate = error && typeof error.code === 'string' ? error.code : '';
  const errorCode = /^[A-Za-z0-9_.-]{1,100}$/.test(candidate) ? candidate : fallbackCode;
  return { errorCode, errorMessage };
}

function clockNow(clock) {
  const value = typeof clock === 'function' ? clock() : clock && typeof clock.now === 'function' ? clock.now() : Date.now();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

async function bestEffortFailure(store, handle, error, clock) {
  const failure = errorStatus(error, 'INSTAGRAM_PRE_PUBLISH_FAILED', 'Instagram failed before the final publish request; a fenced retry is safe.');
  try { await store.failOperation(handle, { ...failure, retryAtMs: clockNow(clock) }); }
  catch { /* The lease can expire for a later safe retry; preserve the provider error. */ }
}

async function bestEffortUncertain(store, handle, error) {
  const failure = errorStatus(error, 'INSTAGRAM_EXTERNAL_COMMIT_UNCERTAIN', 'Instagram may have accepted the final publish request; automatic retry is disabled.');
  try { await store.markOperationUncertain(handle, failure); }
  catch { /* Never replace the ambiguity at the provider boundary with a state error. */ }
}

function completionError() {
  const error = new Error('Instagram returned a published media ID, but durable completion could not be recorded. Automatic retry is disabled until the operation is reconciled.');
  error.code = 'EXTERNAL_COMMIT_UNRECORDED';
  return error;
}

async function publishImage({ imageUrl, caption = '', idempotencyKey = '' }, dependencies = {}) {
  assertActive('instagram.publish');
  assertHttps(imageUrl, 'imageUrl');
  if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,200}$/.test(idempotencyKey)) throw new Error('idempotencyKey must contain only letters, digits, dot, underscore, colon, or hyphen.');
  const loadConfig = dependencies.config || config;
  const providerConfig = loadConfig();
  const { userId } = providerConfig;
  const apiCall = dependencies.api || ((path, options) => api(path, options, providerConfig));
  const sleep = dependencies.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const auditRecord = dependencies.audit || record;
  const clock = dependencies.clock;

  let store = null;
  let handle = null;
  if (idempotencyKey) {
    // Load lazily so validation and non-idempotent publishing remain usable before
    // the transactional state module is installed during an upgrade.
    const stateApi = dependencies.state || require('../state-store');
    store = stateApi.getStateStore();
    const reservation = await store.reserveOperation({
      type: OPERATION_TYPE,
      key: idempotencyKey,
      inputHash: stateApi.hashInput({ userId, imageUrl, caption }),
      leaseMs: OPERATION_LEASE_MS
    });
    if (reservation.disposition === 'replay') {
      const result = reservation.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || !result.containerId || !result.mediaId || result.status !== 'published') {
        throw new Error('Instagram operation replay returned an invalid result.');
      }
      return { ...result, replayed: true };
    }
    if (reservation.disposition !== 'reserved' || !reservation.handle) throw new Error('Instagram operation reservation returned an invalid state.');
    handle = reservation.handle;
  }

  let container;
  let published;
  let finalPublishStarted = false;
  try {
    if (store) await store.markOperationExecuting(handle, { leaseMs: OPERATION_LEASE_MS });
    container = await apiCall(`${userId}/media`, {
      method: 'POST', data: { image_url: imageUrl, caption }
    });
    if (!container || !container.id) throw new Error('Instagram did not return a media container id.');
    let status = 'IN_PROGRESS';
    let attempts = 0;
    while (attempts++ < 24) {
      if (store) await store.heartbeatOperation(handle, { leaseMs: OPERATION_LEASE_MS });
      const result = await apiCall(container.id, { data: { fields: 'status_code,status' } });
      if (store) await store.heartbeatOperation(handle, { leaseMs: OPERATION_LEASE_MS });
      status = result && (result.status_code || result.status);
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram media container ${container.id} ended as ${status}.`);
      await sleep(5000);
    }
    if (status !== 'FINISHED') throw new Error(`Instagram media container ${container.id} did not finish before timeout.`);
    if (store) await store.heartbeatOperation(handle, { leaseMs: OPERATION_LEASE_MS });

    // From this assignment onward, a timeout or malformed response may still mean
    // Meta committed the publish. Such an operation must never be retried blindly.
    finalPublishStarted = true;
    published = await apiCall(`${userId}/media_publish`, { method: 'POST', data: { creation_id: container.id } });
    if (!published || !published.id) throw new Error('Instagram did not return a published media id.');
  } catch (error) {
    if (store) {
      if (finalPublishStarted) await bestEffortUncertain(store, handle, error);
      else await bestEffortFailure(store, handle, error, clock);
    }
    throw error;
  }

  const output = { containerId: container.id, mediaId: published.id, status: 'published' };
  if (store) {
    const durableResult = { ...output, completedAt: new Date(clockNow(clock)).toISOString() };
    try { await store.succeedOperation(handle, { result: durableResult }); }
    catch {
      await bestEffortUncertain(store, handle, completionError());
      throw completionError();
    }
  }
  try { await auditRecord('instagram.publish', published.id, { containerId: container.id, imageUrl, captionLength: caption.length, idempotencyKey }); }
  catch { /* Durable completion already won; audit failure cannot make publishing retry. */ }
  return output;
}

module.exports = { OPERATION_LEASE_MS, OPERATION_TYPE, verify, publishImage };
