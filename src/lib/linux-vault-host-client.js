'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const FILE = path.join(__dirname, 'vault-host/linux-worker.js');
let worker = null;
let custodyUnproven = false;
let closing = null;

function unavailableBeforeDispatch() {
  return { unavailable: true, dispatched: false, ...(custodyUnproven || closing ? { cleanupUnproven: true } : {}) };
}

function received(current, result) {
  if ((!result || result.cleanupUnproven) && worker === current) custodyUnproven = true;
  return result || { unavailable: true, dispatched: true, cleanupUnproven: true };
}

function ensure() {
  if (custodyUnproven || closing) throw new Error('Vault helper custody is not closed.');
  if (worker) return worker;
  if (!fs.statSync(FILE).isFile()) throw new Error('unavailable');
  const next = new Worker(FILE, { execArgv: [], env: {} });
  next.unref();
  const lost = () => { if (worker === next) { custodyUnproven = true; worker = null; } };
  next.on('error', lost);
  next.on('exit', lost);
  worker = next;
  return next;
}

function call(payload, env) {
  let current;
  try { current = ensure(); } catch { return unavailableBeforeDispatch(); }
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  try {
    current.postMessage({ payload, env, sab, port: port2 }, [port2]);
    if (Atomics.wait(sab, 0, 0, 42000) === 'timed-out') {
      return received(current, { unavailable: true, dispatched: true, cleanupUnproven: true });
    }
    return received(current, receiveMessageOnPort(port1)?.message);
  } catch { return received(current, null); }
  finally { port1.close(); }
}

async function close() {
  if (closing) return closing;
  const current = worker;
  if (!current) {
    if (custodyUnproven) throw Object.assign(new Error('The Linux vault helper closure is unproven after its worker exited.'), { code: 'VAULT_HOST_CLOSE_FAILED' });
    return;
  }
  closing = (async () => { try {
    await new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      let settled = false;
      const done = reply => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); port1.close();
        if (reply?.closed === true) resolve();
        else reject(Object.assign(new Error('The Linux vault helper did not confirm its process closed.'), { code: 'VAULT_HOST_CLOSE_FAILED' }));
      };
      const timer = setTimeout(() => done(null), 2000);
      port1.once('message', done);
      try { current.postMessage({ close: true, port: port2 }, [port2]); }
      catch { port2.close(); done(null); }
    });
    worker = null;
    custodyUnproven = false;
    await current.terminate();
  } catch (error) {
    custodyUnproven = true;
    throw error;
  } })().finally(() => { closing = null; });
  return closing;
}

function callAsync(payload, env) {
  let current;
  try { current = ensure(); } catch { return Promise.resolve(unavailableBeforeDispatch()); }
  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port1.close();
      resolve(received(current, result));
    };
    const timer = setTimeout(() => {
      finish({ unavailable: true, dispatched: true, cleanupUnproven: true });
    }, 42000);
    port1.once('message', finish);
    port1.once('close', () => finish({ unavailable: true, dispatched: true, cleanupUnproven: true }));
    try { current.postMessage({ payload, env, port: port2 }, [port2]); }
    catch { port2.close(); finish({ unavailable: true, dispatched: true, cleanupUnproven: true }); }
  });
}

module.exports = { call, callAsync, close };
