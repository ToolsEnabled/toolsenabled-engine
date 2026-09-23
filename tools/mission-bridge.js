#!/usr/bin/env node
'use strict';

const path = require('node:path');

function usage() {
  const { ORIGIN_PORT_MIN, ORIGIN_PORT_MAX } = require('../src/lib/mission-bridge/server');
  return [
    'Usage: node tools/mission-bridge.js --origin <local-origin> --root <id=absolute-path> [--origin ...] [--root ...] [--port 4610]',
    '',
    'The service binds only to 127.0.0.1. By default it tries 4610 through 4619 in order; --port forces one exact port.',
    `Each --origin must be an exact http://localhost|127.0.0.1|127.0.0.2 origin with a port from ${ORIGIN_PORT_MIN} through ${ORIGIN_PORT_MAX} (the declared dashboard/app port range).`,
    'Owner/UI and agent identities are authenticated per request; the service has no startup coordinator identity.',
    'Live service registration is intentionally not implemented by this tool.',
    '',
    'GET /v1/bootstrap now requires a local proof value (?proof=...) in addition to an allowed Origin, so the',
    'bearer is never handed out on the Origin check alone. Read the current-boot proof from the owner-only file',
    'printed as bootstrapProofFile below (the same per-boot ACL pattern as the bearer token file) and pass it',
    'through -- for example, embed it in the URL a local launcher uses to open the dashboard.'
  ].join('\n');
}

function parseArgs(argv) {
  const result = { origins: [], roots: {}, port: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--help') return { help: true };
    if (!value) throw new Error(`Missing value for ${flag}.`);
    index += 1;
    if (flag === '--origin') result.origins.push(value);
    else if (flag === '--resource-channel') {
      if (value !== 'inherited') throw new Error('--resource-channel must be inherited.');
      result.resourceChannel = true;
    }
    else if (flag === '--research-lifecycle-channel') {
      if (value !== 'inherited') throw new Error('--research-lifecycle-channel must be inherited.');
      result.researchLifecycleChannel = true;
    }
    else if (flag === '--port') {
      if (!/^[1-9]\d{0,4}$/.test(value)) throw new Error('--port must be an integer from 1 through 65535.');
      result.port = Number(value);
      if (result.port > 65535) throw new Error('--port must be an integer from 1 through 65535.');
    }
    else if (flag === '--root') {
      const separator = value.indexOf('=');
      if (separator < 1) throw new Error('--root must be id=absolute-path.');
      result.roots[value.slice(0, separator)] = path.resolve(value.slice(separator + 1));
    } else throw new Error(`Unknown flag ${flag}.`);
  }
  return result;
}

async function main() {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n${usage()}\n`); process.exitCode = 2; return; }
  if (parsed.help) { process.stdout.write(`${usage()}\n`); return; }
  const { getResearchWorkerSupervisor } = require('../src/lib/research/worker-supervisor');
  const { installResearchLifecycle } = require('../src/lib/research/lifecycle-channel');
  const researchHost = getResearchWorkerSupervisor();
  // Install on the retained inherited descriptor before the first await or
  // any research control construction. No HTTP/bootstrap caller gets this API.
  const researchChannel = parsed.researchLifecycleChannel ? installResearchLifecycle({ host: researchHost }) : null;
  let resourceClient = null;
  let bridge = null;
  let shutdownPromise = null;
  const shutdown = () => {
    researchHost.sealAdmission();
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const observed = await researchHost.quiesceOwned();
      await bridge?.close();
      try { await researchChannel?.publishQuiescence(observed); } catch { /* the parent retains UNKNOWN without a received observation */ }
      researchChannel?.close();
      resourceClient?.close();
      process.exit(observed.status === 'unknown' ? 1 : 0);
    })().catch(error => {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || 'BRIDGE_CLOSE_FAILED' })}\n`);
      process.exit(1);
    });
    return shutdownPromise;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    if (parsed.resourceChannel) {
      const resources = require('../src/lib/agent-resource-control');
      resourceClient = resources.createResourceClient();
      // Install before awaiting: a missing/dead parent can never turn this app
      // service into an ungoverned standalone engine. No preference is authority.
      const unavailable = () => { const error = new Error('Resource tools belong to the authenticated application controller.'); error.code = 'RESOURCE_HOST_UNAVAILABLE'; throw error; };
      resources.installResourceHost({ status: unavailable, advise: unavailable, reserveLane: resourceClient.reserveLane });
      await resourceClient.connect();
    }
    if (researchHost.snapshot().admissionSealed) return shutdown();
    // The server's dependency graph can fail on damaged audit custody. Keep
    // that import inside the same retained research cleanup as failed listen.
    const { createMissionBridgeServer, BOOTSTRAP_PROOF_FILE } = require('../src/lib/mission-bridge/server');
    bridge = createMissionBridgeServer({
      allowedOrigins: parsed.origins,
      actionOptions: { roots: parsed.roots }
    });
    const address = parsed.port === null ? await bridge.listen() : await bridge.listen(parsed.port);
    if (researchHost.snapshot().admissionSealed) return shutdown();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      baseUrl: address.baseUrl,
      port: address.port,
      startedAt: address.runtime.startedAt,
      pid: address.runtime.pid,
      roots: Object.keys(parsed.roots),
      liveRegistration: false,
      bootstrapProofFile: BOOTSTRAP_PROOF_FILE
    })}\n`);
  } catch (error) {
    researchHost.sealAdmission();
    // Construction can mint credentials before listen fails. Finish each
    // owned cleanup step even if another fails, preserving the startup error.
    const cleanupErrors = [];
    let researchObservation;
    for (const cleanup of [
      async () => { researchObservation = await researchHost.quiesceOwned(); },
      () => bridge?.close(),
      () => researchChannel?.publishQuiescence(researchObservation),
      () => researchChannel?.close(),
      () => resourceClient?.close()
    ]) {
      try { await cleanup(); } catch (failure) { cleanupErrors.push(failure); }
    }
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
    // This executable owns its inherited endpoint. Generic resource clients
    // must not disconnect IPC that other protocols still use.
    if (process.connected) {
      try { process.disconnect(); } catch (failure) { cleanupErrors.push(failure); }
    }
    if (cleanupErrors.length) process.stderr.write(`${JSON.stringify({ ok: false, code: 'BRIDGE_START_CLEANUP_FAILED', failures: cleanupErrors.length })}\n`);
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || 'BRIDGE_START_FAILED', message: error?.message || 'Bridge start failed.' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ parseArgs, usage });
