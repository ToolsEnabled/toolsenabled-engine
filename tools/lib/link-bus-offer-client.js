'use strict';

// Coordinator-side bootstrap for a link-bus token rotation.
//
// This is deliberately link-bus specific.  The retired "special session"
// migration exported an entire vault and two unrelated application profiles;
// the rotation needs exactly two things: the existing link-bus token and one
// bounded authenticated offer from the sole configured peer.  Reading the
// token through runtime.getSecret keeps the normal DPAPI/vault boundary and
// prompt:false prevents an unattended rotation from opening owner UI.

const http = require('node:http');
const { URL } = require('node:url');
const { getSecret } = require('../../src/lib/runtime');
const { directionalMachinePair } = require('../../src/lib/service-registry');
const {
  LinkBusTokenRotationError,
  TOKEN_VAULT_KEY,
  zero
} = require('./link-bus-token-rotation');

const ROTATION_PORT = '8792';
const MAX_OFFER_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_AUTH_KEY_BYTES = 16;
const MAX_AUTH_KEY_BYTES = 4096;

function fail(code, message) {
  throw new LinkBusTokenRotationError(code, message);
}

function rotationTopology(serviceRegistryOptions = {}) {
  const pair = directionalMachinePair(serviceRegistryOptions);
  return Object.freeze({
    coordinatorAddress: pair.coordinatorMachine.address,
    recipientAddress: pair.recipientMachine.address
  });
}

function collectOfferAuthenticationKey({ readSecret = getSecret } = {}) {
  let value;
  try {
    value = readSecret(TOKEN_VAULT_KEY, { prompt: false });
  } catch (error) {
    const code = error && error.code === 'SECRET_NOT_CONFIGURED'
      ? 'LINK_BUS_TOKEN_NOT_CONFIGURED'
      : 'LINK_BUS_TOKEN_UNAVAILABLE';
    fail(code, 'The existing link-bus token is unavailable; no rotation was started.');
  }
  if (typeof value !== 'string' || value.includes('\0')) {
    fail('INVALID_AUTH_KEY', 'The existing link-bus token has an invalid shape.');
  }
  const key = Buffer.from(value, 'utf8');
  value = null;
  if (key.byteLength < MIN_AUTH_KEY_BYTES || key.byteLength > MAX_AUTH_KEY_BYTES) {
    zero(key);
    fail('INVALID_AUTH_KEY', 'The existing link-bus token has an invalid length.');
  }
  return key;
}

function pinnedOfferUrl(value, { serviceRegistryOptions = {} } = {}) {
  const topology = rotationTopology(serviceRegistryOptions);
  let parsed;
  try { parsed = new URL(value); }
  catch { fail('INVALID_URL', 'The link-bus rotation offer URL is invalid.'); }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== topology.recipientAddress ||
    parsed.port !== ROTATION_PORT ||
    parsed.pathname !== '/offer' ||
    parsed.search !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    fail('URL_NOT_PINNED', 'The link-bus rotation offer URL is not the exact configured peer endpoint.');
  }
  return Object.freeze({ parsed, topology });
}

function requestOffer(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  serviceRegistryOptions = {},
  requestImpl = http.request
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail('INVALID_ARGUMENT', 'The link-bus offer timeout is invalid.');
  }
  const { parsed, topology } = pinnedOfferUrl(url, { serviceRegistryOptions });
  return new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      localAddress: topology.coordinatorAddress,
      agent: false,
      headers: { Accept: 'application/json', Connection: 'close' }
    });
    let settled = false;
    let timer;
    const chunks = [];
    let total = 0;
    const finish = (error, value) => {
      if (settled) {
        if (value && value.body) zero(value.body);
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      request.destroy();
      finish(new LinkBusTokenRotationError('HTTP_TIMEOUT', 'The peer offer request timed out.'));
    }, timeoutMs);
    request.on('error', () => {
      finish(new LinkBusTokenRotationError('HTTP_REQUEST_FAILED', 'The peer offer request failed.'));
    });
    request.on('response', response => {
      response.on('data', chunk => {
        const copy = Buffer.from(chunk);
        total += copy.byteLength;
        if (total > MAX_OFFER_BYTES) {
          zero(copy);
          for (const prior of chunks) zero(prior);
          chunks.length = 0;
          response.destroy();
          finish(new LinkBusTokenRotationError('HTTP_RESPONSE_TOO_LARGE', 'The peer offer exceeded its bound.'));
          return;
        }
        chunks.push(copy);
      });
      response.on('error', () => {
        for (const chunk of chunks) zero(chunk);
        chunks.length = 0;
        finish(new LinkBusTokenRotationError('HTTP_RESPONSE_FAILED', 'The peer offer response failed.'));
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks, total);
        for (const chunk of chunks) zero(chunk);
        chunks.length = 0;
        finish(null, { statusCode: response.statusCode || 0, body });
      });
    });
    request.end();
  });
}

async function loadAuthenticatedOffer({
  offerUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  serviceRegistryOptions = {},
  requestOfferImpl = requestOffer
}) {
  if (typeof offerUrl !== 'string' || offerUrl.length === 0) {
    fail('INVALID_ARGUMENT', 'The link-bus rotation offer URL is required.');
  }
  let response;
  try {
    response = await requestOfferImpl(offerUrl, { timeoutMs, serviceRegistryOptions });
    if (!response || !Buffer.isBuffer(response.body)) {
      fail('HTTP_RESPONSE_FAILED', 'The peer offer response was invalid.');
    }
    if (response.statusCode < 200 || response.statusCode > 299) {
      fail('HTTP_STATUS_REJECTED', 'The peer rejected the rotation offer request.');
    }
    try { return JSON.parse(response.body.toString('utf8')); }
    catch { fail('INVALID_OFFER_AUTH', 'The authenticated peer offer is not valid JSON.'); }
  } finally {
    if (response && response.body) zero(response.body);
  }
}

module.exports = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MAX_AUTH_KEY_BYTES,
  MAX_OFFER_BYTES,
  MIN_AUTH_KEY_BYTES,
  ROTATION_PORT,
  collectOfferAuthenticationKey,
  loadAuthenticatedOffer,
  pinnedOfferUrl,
  requestOffer,
  rotationTopology
});
