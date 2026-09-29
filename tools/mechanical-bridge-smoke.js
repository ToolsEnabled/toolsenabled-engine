#!/usr/bin/env node
'use strict';

// Bounded, read-only end-to-end smoke test for the direct Ethernet bridge.
// Tokens stay in the DPAPI-backed process memory and are never printed.
const net = require('node:net');
const os = require('node:os');
const { getSecret } = require('../src/lib/runtime');
const { directionalMachinePair, loadRegistry } = require('../src/lib/service-registry');

function numericSetting(name, fallback, { integer = false, min = 1, max = Infinity } = {}) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    const error = new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} through ${max}`);
    error.code = 'BRIDGE_SMOKE_CONFIGURATION_INVALID';
    throw error;
  }
  return value;
}

const PORT = numericSetting('REMOTE_AGENT_BRIDGE_PORT', 8788, { integer: true, max: 65535 });
const TIMEOUT_MS = 7000;
const DEEP_TIMEOUT_MS = numericSetting('BRIDGE_SMOKE_DEEP_TIMEOUT_MS', 20000);
const ROUNDS = numericSetting('BRIDGE_SMOKE_ROUNDS', 2, { integer: true, max: 3 });

function discoverPeer(machines) {
  const addresses = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal && machines.some(machine => item.address === machine.address)) addresses.add(item.address);
    }
  }
  if (addresses.size !== 1) return null;
  const localMachine = machines.find(machine => addresses.has(machine.address));
  return localMachine ? machines.find(machine => machine.machineId !== localMachine.machineId).address : null;
}

function readJsonLine(socket, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      resolve(value);
    };
    const refuse = (code, cause) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      const error = new Error(code, cause ? { cause } : undefined);
      error.code = code;
      reject(error);
    };
    const onData = chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { finish(JSON.parse(buffer.slice(0, end))); } catch (error) { refuse('BRIDGE_RESPONSE_INVALID', error); }
    };
    const onClose = () => refuse('BRIDGE_RESPONSE_CLOSED');
    const onError = error => refuse('BRIDGE_RESPONSE_ERROR', error);
    const onTimeout = () => refuse('BRIDGE_RESPONSE_TIMEOUT');
    socket.setTimeout(timeoutMs);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

async function rpc(peer, token, method, params, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    const result = { tcpOk: null, authOk: null, auth: null, responseOk: null, response: null, measurementError: null };
    const socket = net.createConnection({ host: peer, port: PORT });
    socket.setEncoding('utf8');
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.measurementError = result.measurementError || 'BRIDGE_RPC_TIMEOUT';
      finish();
    }, timeoutMs + 1000);
    socket.once('connect', async () => {
      result.tcpOk = true;
      try {
        socket.write(`${JSON.stringify({ type: 'authorize', token })}\n`);
        const auth = await readJsonLine(socket, timeoutMs);
        result.authOk = auth.type === 'authorized';
        if (!result.authOk) { clearTimeout(timer); finish(); return; }
        result.auth = { protocolVersion: auth.protocolVersion, bridgeRoot: auth.bridgeRoot, workingDirectory: auth.workingDirectory, rootExists: auth.rootExists };
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
        result.response = await readJsonLine(socket, timeoutMs);
        result.responseOk = result.response.id === 1 && !result.response.error;
        clearTimeout(timer);
        finish();
      } catch (error) {
        result.measurementError = error && error.code ? error.code : 'BRIDGE_RPC_FAILED';
        clearTimeout(timer);
        finish();
      }
    });
    socket.once('error', error => {
      if (result.tcpOk === true) return;
      result.tcpOk = false;
      result.measurementError = error && error.code ? error.code : 'BRIDGE_CONNECT_FAILED';
      clearTimeout(timer);
      finish();
    });
  });
}

function printResult(output) {
  console.log(JSON.stringify(output));
  if (output.pass !== true) process.exitCode = 1;
}

async function main() {
  const registry = loadRegistry();
  const topology = directionalMachinePair({ registry });
  const machines = [topology.coordinatorMachine, topology.recipientMachine];
  const peer = process.env.REMOTE_AGENT_BRIDGE_PEER || discoverPeer(machines);
  const output = { peer, port: PORT, rounds: [], pass: false, available: false };
  if (!peer) {
    output.unavailableReason = 'bridge peer is not configured or discoverable';
    printResult(output);
    return;
  }
  let token;
  try { token = getSecret('custom.remote_agent_bridge_token', { prompt: false }); }
  catch (error) {
    output.unavailableReason = error && error.code === 'SECRET_NOT_CONFIGURED'
      ? 'bridge credential is not configured in the local vault'
      : 'bridge credential could not be read from the local vault';
    printResult(output);
    return;
  }

  const listed = await rpc(peer, token, 'tools/list', {});
  const tools = listed.responseOk === true && listed.response && listed.response.result
    && Array.isArray(listed.response.result.tools) ? listed.response.result.tools : null;
  output.tcpOk = listed.tcpOk;
  output.authOk = listed.authOk;
  output.peerHandshake = listed.auth;
  const peerMachine = machines.find(machine => peer === machine.address);
  output.expectedPeerRoot = peerMachine ? peerMachine.root : null;
  output.peerRootMatches = output.expectedPeerRoot === null ? null
    : Boolean(listed.auth && typeof listed.auth.bridgeRoot === 'string'
      && listed.auth.bridgeRoot.toLowerCase() === output.expectedPeerRoot.toLowerCase()
      && listed.auth.rootExists === true);
  output.listMeasurementError = listed.measurementError;
  output.toolsRead = tools ? true : listed.responseOk === false ? false : null;
  output.toolCount = tools ? tools.length : null;
  output.hostExecAbsent = tools ? !tools.some(tool => tool && tool.name === 'host.exec') : null;
  output.requiredToolsAdvertised = {
    repoRead: tools ? tools.some(tool => tool && tool.name === 'repo.read_file') : null,
    processList: tools ? tools.some(tool => tool && tool.name === 'host.list_processes') : null,
  };
  const safety = await rpc(peer, token, 'system.kill_switch_status', {});
  let killSwitchActive = null;
  let killSwitchRead = false;
  let killSwitchMeasurementError = safety.measurementError;
  try {
    const text = safety.response.result.content[0].text;
    const parsed = JSON.parse(text);
    if (typeof parsed.killSwitchActive === 'boolean') killSwitchActive = parsed.killSwitchActive;
    else if (typeof parsed.active === 'boolean') killSwitchActive = parsed.active;
    else throw new Error('kill-switch response has no boolean status');
    killSwitchRead = true;
  } catch (error) {
    killSwitchMeasurementError = killSwitchMeasurementError
      || (error && error.code ? error.code : 'BRIDGE_KILL_SWITCH_RESPONSE_INVALID');
  }
  output.killSwitchActive = killSwitchActive;
  output.killSwitchRead = killSwitchRead;
  output.killSwitchMeasurementError = killSwitchMeasurementError;
  const audit = await rpc(peer, token, 'audit.status', {}, DEEP_TIMEOUT_MS);
  output.auditOk = audit.responseOk;
  output.auditError = audit.response && audit.response.error ? (audit.response.error.code || 'error') : null;
  output.auditMeasurementError = audit.measurementError;
  for (let i = 0; i < ROUNDS; i += 1) {
    const repo = await rpc(peer, token, 'repo.read_file', { path: 'src/remote-agent-bridge.js' }, DEEP_TIMEOUT_MS);
    const processes = await rpc(peer, token, 'host.list_processes', { nameFilter: 'node' }, DEEP_TIMEOUT_MS);
    output.rounds.push({
      repoReadOk: repo.responseOk,
      processReadOk: processes.responseOk,
      repoAuthOk: repo.authOk,
      processAuthOk: processes.authOk,
      repoError: repo.response && repo.response.error ? (repo.response.error.code || 'error') : null,
      processError: processes.response && processes.response.error ? (processes.response.error.code || 'error') : null,
      repoMeasurementError: repo.measurementError,
      processMeasurementError: processes.measurementError,
    });
  }
  output.pass = output.tcpOk === true
    && output.authOk === true
    && output.toolCount >= 1
    && output.hostExecAbsent === true
    && output.peerRootMatches === true
    && output.requiredToolsAdvertised.repoRead === true
    && output.requiredToolsAdvertised.processList === true
    && output.auditOk === true
    && output.killSwitchActive === false
    && output.rounds.every(round => round.repoReadOk && round.processReadOk);
  output.available = output.pass;
  if (!output.pass) {
    output.unavailableReason = output.tcpOk !== true ? 'bridge peer is unreachable'
      : output.authOk !== true ? 'bridge authorization failed'
        : output.peerRootMatches !== true ? 'bridge peer root does not match the expected registered-machine root'
          : output.requiredToolsAdvertised.repoRead !== true || output.requiredToolsAdvertised.processList !== true
            ? 'bridge peer does not advertise the required read-only tools'
            : output.auditOk !== true ? 'bridge audit status is unavailable'
              : output.killSwitchActive !== false ? 'bridge kill-switch status is unavailable or active'
                : 'one or more bridge read probes failed';
  }
  printResult(output);
}

main().catch(error => printResult({
  pass: false,
  available: false,
  unavailableReason: error && error.message ? error.message : 'bridge smoke test failed',
}));
