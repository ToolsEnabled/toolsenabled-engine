'use strict';
// A non-revoking relay transports genuine signed admission and E2E frames.
// Every account/computer and bridge response is disposable synthetic data.
const http = require('node:http');
const crypto = require('node:crypto');
const { createRelayShell } = require('../../src/lib/online-fra-relay-shell');
const { DEVICE_IDENTITY_VAULT_KEY } = require('../../src/lib/online-fra-device-identity');
const { DEVICE_CREDENTIAL_VAULT_KEY } = require('../../src/lib/online-fra-device-claim');
const { LEG_BYTE, LEG_ROLE } = require('../../src/lib/online-fra-relay-client');
const { ReferenceWebSocket, WebSocketServer } = require('./online-fra-reference-fixture');
const wire = key => key.publicKey.export({type:'spki',format:'der'}).toString('base64url');
const fingerprintOf = value => crypto.createHash('sha256').update(Buffer.from(value,'base64url')).digest('hex');
const SIGNED_LEASE_KEYS = ['schemaVersion','leaseId','pairId','deviceId','peerDeviceId','endpointRole','mtlsFingerprint','generation','issuedAtMs','expiresAtMs','nonce','ephemeralX25519PublicKey','capabilityDigest'];
const authority = crypto.generateKeyPairSync('ed25519');
const signingBytes = lease => Buffer.from(JSON.stringify(Object.fromEntries(SIGNED_LEASE_KEYS.map(key=>[key,lease[key]]))));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const json = (status,body) => ({status,ok:status<300,json:async()=>body});
function mintLease(fields) {
  const issuedAtMs=Date.now();
  const lease={schemaVersion:'online-fra-lease.v1',leaseId:'lease_'+crypto.randomBytes(16).toString('hex'),generation:1,
    issuedAtMs,expiresAtMs:issuedAtMs+600000,nonce:crypto.randomBytes(24).toString('base64url'),capabilityDigest:'e'.repeat(64),...fields};
  lease.signature=crypto.sign(null,signingBytes(lease),authority.privateKey).toString('base64url');return lease;
}
function fakeEdge({ httpServer }) {
  const events = [];
  const pairs = new Map();
  const server = new WebSocketServer({ server: httpServer, path: '/v1/rendezvous' });
  server.on('connection', (socket) => {
    const nonce = crypto.randomBytes(32).toString('base64url');
    let admitted = null;
    const refuse = (reason) => { events.push({ type: 'refused', reason }); try { socket.close(1008, reason); } catch { /* dead */ } };
    socket.send(JSON.stringify({ challenge: nonce, expiresAtMs: Date.now() + 30_000 }));
    socket.on('message', (data, isBinary) => {
      if (!admitted) {
        if (isBinary) return refuse('binary-before-admission');
        let answer = null;
        try { answer = JSON.parse(Buffer.from(data).toString('utf8')); } catch { answer = null; }
        if (!answer || !answer.lease || answer.nonce !== nonce || typeof answer.publicKeySpki !== 'string' || typeof answer.signature !== 'string') return refuse('admission-invalid');
        let proven = false;
        try {
          const der = Buffer.from(answer.publicKeySpki, 'base64url');
          const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
          proven = fingerprintOf(answer.publicKeySpki) === answer.lease.mtlsFingerprint
            && crypto.verify(null, Buffer.from(nonce, 'base64url'), key, Buffer.from(answer.signature, 'base64url'))
            && crypto.verify(null, signingBytes(answer.lease), authority.publicKey, Buffer.from(String(answer.lease.signature), 'base64url'));
        } catch { proven = false; }
        if (!proven) return refuse('proof-failed');
        const pair = pairs.get(answer.lease.pairId);
        const role = answer.lease.endpointRole;
        if (!pair || !Object.hasOwn(pair, role)) return refuse('no-such-leg');
        if (pair[role]) {
          if (role !== 'web-client') return refuse('duplicate-role');
          try { pair[role].close(4001, 'displaced'); } catch { /* dead */ }
        }
        pair[role] = socket;
        admitted = { pairId: answer.lease.pairId, role };
        events.push({ type: 'admitted', role });
        return;
      }
      if (!isBinary) return;
      const frame = Buffer.from(data);
      if (frame.length < 2) return;
      const target = LEG_ROLE[frame[0]];
      const pair = pairs.get(admitted.pairId);
      const targetSocket = target && Object.hasOwn(pair, target) ? pair[target] : null;
      if (!targetSocket) { events.push({ type: 'frame_dropped', reason: 'leg_absent', from: admitted.role, to: target || 'unknown' }); return; }
      events.push({ type: 'frame_routed', from: admitted.role, to: target });
      const out = Buffer.from(frame);
      out[0] = LEG_BYTE[admitted.role];   // the SOURCE leg, stamped in place of the target byte
      targetSocket.send(out);
    });
    socket.on('close', () => {
      if (!admitted) return;
      const pair = pairs.get(admitted.pairId);
      if (pair && pair[admitted.role] === socket) pair[admitted.role] = null;
      events.push({ type: 'closed', role: admitted.role });
    });
  });
  return {
    events,
    soloPair: (relayPairId) => pairs.set(relayPairId, { 'machine-a': null, 'web-client': null }),
    stop: () => new Promise((r) => server.close(r))
  };
}
async function createHarness({ bridge, authorityMaxAgeMs=250, authorityTimeoutMs=150,
  accountClockAheadMs=5000, shellOptions={}, productionClocks=false, renewalOverrides={} }={}) {
  const { createWebClient } = await import('../../src/lib/online-fra-web-client.mjs');
  const pair='pair_'+crypto.randomBytes(16).toString('hex');const ownPair='pair_'+crypto.randomBytes(8).toString('hex');
  const deviceId='dev-'+crypto.randomBytes(6).toString('hex');const token='device-'+crypto.randomBytes(8).toString('hex');
  const machineKey=crypto.generateKeyPairSync('ed25519');const accountOrigin='https://account.example.test';
  let webSession=null;let revoked=false;let introductionLoader=null;let introductions=0;const calls=[];
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url);const auth=String(init.headers?.authorization||'');const machine=auth==='Device '+token;
    const browser=init.credentials==='include';
    if(!machine&&!browser)return json(401,{});
    if(u.pathname==='/v1/devices/peer')return json(200,{peer:{relayPairId:pair,peerPairId:null,peerDeviceId:null,peerEd25519PublicKey:null,generation:1}});
    if(u.pathname==='/v1/relay/web-peer'){
      introductions++;
      if(introductionLoader)return introductionLoader(init.signal,webSession);
      if(revoked||!webSession)return json(404,{});
      return json(200,{webPeer:{...webSession,authorizationCheckedAtMs:Date.now()+accountClockAheadMs}});
    }
    if(u.pathname==='/v1/relay/leases'){
      const body=JSON.parse(init.body);
      if(body.role==='web-client'){
        if(revoked)return json(401,{});
        const webDeviceId='web-'+crypto.randomBytes(12).toString('hex');
        // Both bounds describe this same grant. Two clock reads occasionally
        // made authorization one millisecond longer than transport, which the
        // real authority parser correctly refused on every hello retry.
        const expiresAtMs=Date.now()+600000;
        webSession={webDeviceId,ed25519PublicKey:body.publicKeySpki,expiresAtMs,authorizationExpiresAtMs:expiresAtMs};
        return json(201,{lease:mintLease({pairId:pair,deviceId:webDeviceId,peerDeviceId:deviceId,endpointRole:'web-client',mtlsFingerprint:fingerprintOf(body.publicKeySpki),ephemeralX25519PublicKey:body.ephemeralX25519PublicKey}),machine:{deviceId,ed25519PublicKey:wire(machineKey),role:'machine-a'}});
      }
      return json(201,{lease:mintLease({pairId:pair,deviceId,peerDeviceId:null,endpointRole:'machine-a',mtlsFingerprint:fingerprintOf(wire(machineKey)),ephemeralX25519PublicKey:body.ephemeralX25519PublicKey})});
    }
    return json(404,{});
  };
  const server=http.createServer((request,response)=>{response.statusCode=426;response.end();});const edge=fakeEdge({httpServer:server});edge.soloPair(pair);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const relayUrl='ws://127.0.0.1:'+server.address().port+'/v1/rendezvous';
  const values=new Map([[DEVICE_IDENTITY_VAULT_KEY,machineKey.privateKey.export({type:'pkcs8',format:'pem'}).toString()],
    [DEVICE_CREDENTIAL_VAULT_KEY,JSON.stringify({pairId:ownPair,deviceId,deviceToken:token,claimedAtMs:Date.now()})]]);
  const vault={getSecret:key=>values.get(key),setSecret:(key,value)=>values.set(key,value)};
  const renewal=productionClocks ? {} : {leaseTtlMs:2000,renewLeadMs:1000,renewRetryMs:200,renewAbandonLeadMs:300,drainMs:700,...renewalOverrides};
  const actualBridge=bridge||{fetch:async(path,init)=>{calls.push({path,method:init.method});const body=Buffer.from(JSON.stringify({marker:'inert-response'}));return {status:200,headers:{},arrayBuffer:async()=>body};}};
  const shellEvents=[];const shell=createRelayShell({accountOrigin,relayUrl,vault,localBridge:actualBridge,fetchImpl,WebSocketImpl:ReferenceWebSocket,
    eventSink:e=>shellEvents.push(e),helloRetryMs:50,handshakeTimeoutMs:2000,webPeerRetryMs:50,
    authorityMaxAgeMs,authorityTimeoutMs,...renewal,...shellOptions});
  const S=await shell.connectToPeer();await S.handshake;const browsers=[];
  async function browser(){const events=[];const client=createWebClient({accountOrigin,relayUrl,relayPairId:pair,fetchImpl,WebSocketImpl:ReferenceWebSocket,
    eventSink:e=>events.push(e),helloRetryMs:50,handshakeTimeoutMs:2000,requestTimeoutMs:3000,...renewal});const W=await client.connect();browsers.push(W);
    try { await W.handshake; }
    catch (error) {
      // Keep the real refusal and its timing. A census-only failure needs the
      // synthetic peers' observed sequence, not a larger timeout or a retry.
      error.message += '\nBrowser authority fixture: '+JSON.stringify({ introductions,
        expiresAtMs:webSession?.expiresAtMs,authorizationExpiresAtMs:webSession?.authorizationExpiresAtMs,
        browser:events.slice(-32), machine:shellEvents.slice(-32), relay:edge.events.slice(-32) });
      throw error;
    }
    return {W,events};}
  async function close(){for(const W of browsers)W.close();S.close();await sleep(50);await edge.stop();await new Promise(resolve=>server.close(resolve));}
  return {browser,close,calls,shellEvents,get introductions(){return introductions;},set revoked(value){revoked=value;},
    set introductionLoader(value){introductionLoader=value;},get webSession(){return webSession;},
    // Closes only the machine leg, leaving any already-connected browsers open
    // and unaware -- so a browser's own crypto session ages past its lease
    // with nothing left alive to answer a renewal offer.
    stopMachine:()=>S.close()};
}
module.exports={createHarness,sleep,json};
