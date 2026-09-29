'use strict';

// The ONLY network I/O built on top of service-registry.js. Split into its
// own file, 2026-08-09, after a regression this file's own history should
// keep: service-registry.js originally carried resolveAndProbe/defaultHttpProbe
// directly, with a top-level `require('node:http')`. tools/health-observer.js's
// own test enforces that its ENTIRE reachable dependency graph -- eager or
// lazy requires, walked either way -- contains no require of node:http or
// node:https anywhere in a file's source text ("observation must stay local
// and cheap"). A later, unrelated fix added a plain require('./service-registry')
// (for the pure, network-free loadRegistry()) to a file that is itself
// reachable from the observer, which made service-registry.js -- and its http
// require -- newly reachable too, and broke that invariant. Moving http's
// only real user out to its own file, which nothing in the observer's graph
// requires, closes the gap for good rather than for this one caller: any
// FUTURE file that needs only loadRegistry() from service-registry.js can
// never accidentally drag networking capability into the observer's reach
// again, because it no longer lives in the same file to drag.
//
// resolveService()/resolveServiceOrThrow()/listServices() do no I/O and stay
// in service-registry.js; only resolveAndProbe() actually reaches the
// network, so only it and its helper move here.

const { resolveService } = require('./service-registry');

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_RESPONSE_BYTES = 16 * 1024;

function classifyProbeError(error) {
  const code = error && (error.code || error.name);
  if (typeof code !== 'string') return 'UNKNOWN';
  // A timeout or missing route describes the probe's inability to measure the
  // service, not the service itself. Only errors that establish a response at
  // the resolved endpoint may support the stronger DOWN claim.
  if (/ECONNREFUSED|ECONNRESET/i.test(code)) return 'DOWN';
  return 'UNKNOWN';
}

function defaultHttpProbe({ host, port, pathName, timeoutMs }) {
  const http = require('node:http');
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let request;
    try {
      request = http.request({ host, port, path: pathName, method: 'GET', timeout: timeoutMs }, response => {
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_PROBE_RESPONSE_BYTES) response.destroy();
        });
        response.on('end', () => finish({
          reachability: response.statusCode >= 200 && response.statusCode < 500 ? 'UP' : 'UNKNOWN',
          status: response.statusCode
        }));
      });
    } catch (error) {
      finish({ reachability: classifyProbeError(error), error: (error && error.code) || 'probe_error' });
      return;
    }
    request.once('timeout', () => { request.destroy(); finish({ reachability: 'UNKNOWN', error: 'timeout' }); });
    request.once('error', error => finish({ reachability: classifyProbeError(error), error: (error && error.code) || 'probe_error' }));
    request.end();
  });
}

/**
 * Resolve then perform one bounded, read-only reachability check against the
 * declared health path. Returns the resolution plus `reachability`:
 *   'UP'      -- a plausible HTTP response was received.
 *   'DOWN'    -- a concrete negative endpoint signal (refused/reset).
 *   'UNKNOWN' -- resolved but no answer could be classified either way
 *               (includes: no healthPath declared, so this service does not
 *               support this probe at all).
 * Resolution failure is returned unchanged (still {ok:false, ...}); no probe
 * is attempted against an endpoint this module could not identify.
 */
async function resolveAndProbe(serviceId, options = {}) {
  const resolved = resolveService(serviceId, options);
  if (!resolved.ok) return resolved;
  if (!resolved.healthPath) {
    return Object.freeze({ ...resolved, reachability: 'UNKNOWN', probeError: 'SERVICE_PROBE_UNSUPPORTED: no healthPath declared for this service.' });
  }
  const httpProbe = options.httpProbe || defaultHttpProbe;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const probe = await httpProbe({ host: resolved.host, port: resolved.port, pathName: resolved.healthPath, timeoutMs });
  return Object.freeze({
    ...resolved,
    reachability: probe.reachability,
    ...(probe.error ? { probeError: probe.error } : {}),
    ...(probe.status !== undefined ? { probeStatus: probe.status } : {})
  });
}

module.exports = Object.freeze({
  resolveAndProbe,
  defaultHttpProbe,
  classifyProbeError
});
