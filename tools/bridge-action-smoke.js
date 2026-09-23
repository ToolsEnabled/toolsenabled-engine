'use strict';

// A read-only live-bridge smoke: proof → bootstrap → bearer → one action.
// Exists because the R1136 live run had to hand-roll exactly this and the gap
// was recorded as a trap. It NEVER mints or writes token/proof files — it only
// reads the owner-ACL'd proof the running bridge published, so it cannot
// reproduce the 2026-08 incident where a fixture destroyed the live bearer.
//
// Usage:
//   node tools/bridge-action-smoke.js research-snapshot
//   node tools/bridge-action-smoke.js research-runs '{"experimentId":"rx-..."}'
//   node tools/bridge-action-smoke.js --status        (GET /v1/status instead)
//
// Windows paths inside the JSON body: use forward slashes. Git Bash collapses
// the backslash escapes in '{"command":"C:\\..."}' before argv reaches node,
// so the body arrives as invalid JSON (measured 2026-08-15); "C:/..." works.
//
// Exit codes: 0 the action answered ok:true; 1 it answered a refusal (printed);
// 2 the bridge or its files were unreachable (nothing was measured).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://127.0.0.1:4600';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const [, , action, bodyRaw] = process.argv;
  if (!action) {
    console.error('usage: node tools/bridge-action-smoke.js <action-name|--status> [json-body]');
    process.exit(2);
  }
  const runtime = readJson(path.join(ROOT, 'state', 'mission-bridge-runtime.json'));
  if (!runtime || typeof runtime.baseUrl !== 'string') {
    console.error('no runtime discovery record; is the bridge running?');
    process.exit(2);
  }
  const proofRecord = readJson(path.join(ROOT, 'state', 'mission-bridge-bootstrap-proof.json'));
  if (!proofRecord || typeof proofRecord.token !== 'string') {
    console.error('no bootstrap proof file; is the bridge running from this checkout?');
    process.exit(2);
  }
  const bootstrapResponse = await fetch(`${runtime.baseUrl}/v1/bootstrap?proof=${proofRecord.token}`, {
    headers: { accept: 'application/json', origin: ORIGIN },
  });
  const bootstrap = await bootstrapResponse.json();
  if (!bootstrap || bootstrap.ok !== true || typeof bootstrap.token !== 'string') {
    console.error(`bootstrap refused: ${JSON.stringify(bootstrap && bootstrap.error || bootstrap)}`);
    process.exit(2);
  }
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${bootstrap.token}`,
    origin: ORIGIN,
    'content-type': 'application/json',
  };
  let response;
  if (action === '--status') {
    response = await fetch(`${runtime.baseUrl}/v1/status`, { headers });
  } else {
    let body = {};
    if (bodyRaw) {
      try { body = JSON.parse(bodyRaw); }
      catch { console.error('the body argument did not parse as JSON'); process.exit(2); }
    }
    response = await fetch(`${runtime.baseUrl}/v1/actions/${action}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
  }
  const value = await response.json();
  console.log(JSON.stringify({ httpStatus: response.status, capabilities: bootstrap.capabilities?.length, body: value }, null, 2));
  process.exit(value && value.ok === true ? 0 : 1);
}

main().catch(error => { console.error(String(error && error.message || error)); process.exit(2); });
