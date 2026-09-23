'use strict';
require('./lib/isolated-environment').activate('web-inspector');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const inspector = require('../src/lib/providers/web-inspector');
const registry = require('../src/lib/tool-registry');
const context = { agentPrincipal: { kind: 'agent-session', sessionId: 'test-session', agentId: 'test-agent' } };
function fixture() {
  const requests = [], audits = [], workers = [];
  const service = inspector.createService({ active() {}, auditSink: { requireRecord(...args) { audits.push(args); } }, workerFactory() {
    const worker = { closed: false, async request(args) { requests.push(args); return { ownedTab: true, closed: args.action === 'close', cleanupFailures: 0 }; }, async finish() { worker.closed = true; return { closed: true, cleanupFailures: 0 }; } };
    workers.push(worker);
    return worker;
  } });
  return { service, requests, audits, workers };
}
test('generic public inspector tools declare effects and closed schemas', () => {
  for (const [suffix, effect] of [['status','local-read'],['open','external-write'],['call','external-write'],['close','local-write']]) {
    const tool = registry.getTool('browser.web_inspector_' + suffix);
    assert.equal(tool.effect, effect);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(registry.getTool('browser.web_inspector_call').approvalEligible, true);
});
test('no unbound session, cross-agent takeover, duplicate open or stale reuse', async () => {
  const { service, requests } = fixture();
  await assert.rejects(service.open(), { code: 'WEB_INSPECTOR_SESSION_REQUIRED' });
  const opened = await service.open({}, context);
  await assert.rejects(service.open({}, context), { code: 'WEB_INSPECTOR_BUSY' });
  await assert.rejects(service.call({ session: opened.session, action: 'snapshot' }, { agentPrincipal: { ...context.agentPrincipal, agentId: 'other' } }), { code: 'WEB_INSPECTOR_SESSION_MISMATCH' });
  await assert.rejects(service.close({ session: 'stale' }, context), { code: 'WEB_INSPECTOR_SESSION_MISMATCH' });
  assert.equal(requests.length, 1);
  assert.equal((await service.close({ session: opened.session }, context)).closed, true);
  await assert.rejects(service.call({ session: opened.session, action: 'snapshot' }, context), { code: 'WEB_INSPECTOR_SESSION_MISMATCH' });
});
test('action validation rejects mixed fields, unsafe URLs and oversized input', () => {
  for (const value of [{ action:'snapshot',script:'return 1' }, {action:'navigate',url:'file:///etc/passwd'},
    {action:'navigate',url:'https://user:pass@example.com'}, {action:'type',text:''}, {action:'tap',x:NaN,y:2},
    {action:'evaluate',script:'return 1',arguments:{}}, {action:'evaluate',script:'x'.repeat(16001)}, {action:'other'}]) {
    assert.throws(() => inspector.validateCall(value));
  }
  assert.deepEqual(inspector.validateCall({ session:'opaque',action:'evaluate',script:'return arguments[0]',arguments:['test'] }),
    {action:'evaluate',script:'return arguments[0]',arguments:['test']});
  assert.deepEqual(inspector.validateCall({action:'fill',text:''}),{action:'fill',text:''});
  for(const value of [{action:'fill'},{action:'fill',text:'x'.repeat(4001)},{action:'fill',text:'test',script:'return 1'}])
    assert.throws(()=>inspector.validateCall(value));
  assert.deepEqual(registry.getTool('browser.web_inspector_call').inputSchema.properties.action.enum,inspector.ACTIONS);
});
test('calls use only owned worker and never audit page or typed content', async () => {
  const f = fixture();
  const { session } = await f.service.open({}, context);
  await f.service.call({session,action:'type',text:'private test value'}, context);
  assert.deepEqual(f.requests[1], {action:'type',text:'private test value'});
  await f.service.call({session,action:'fill',text:'private test value'}, context);
  assert.deepEqual(f.requests[2], {action:'fill',text:'private test value'});
  assert.ok(!JSON.stringify(f.audits).includes('private test value'));
  await f.service.close({session}, context);
});
test('connection teardown releases principal-bound worker and permits new open', async () => {
  const f = fixture(), fileToolContext = {};
  await f.service.open({}, {...context,fileToolContext});
  await f.service.closeContext(fileToolContext);
  assert.equal(f.workers[0].closed,true);
  await f.service.open({}, context);
  await f.service.closeSession(context.agentPrincipal.sessionId);
  assert.equal(f.workers[1].closed,true);
});
test('failed status is unavailable, not a fabricated absent phone; helper closes', async () => {
  const f = fixture();
  const broken = inspector.createService({ active() {},workerFactory() {return { async request(){throw Object.assign(new Error('hidden serial'),{code:'WEB_INSPECTOR_DRIVER_ERROR'});},async finish(){f.requests.push('finished');} };} });
  const result = await broken.status();
  assert.equal(result.available,false);
  assert.equal(result.reason,'WEB_INSPECTOR_DRIVER_ERROR');
  assert.ok(!JSON.stringify(result).includes('hidden serial'));
  assert.deepEqual(f.requests,['finished']);
});

test('real registry dispatch forwards caller scope and rejects malformed input before provider', async () => {
  const settings = require('../src/lib/settings');
  const oldSettings = settings.loadSettings, oldOpen = inspector.open, oldCall = inspector.call, oldClose = inspector.close;
  const {executeTool} = require('./helpers/dispatch');
  const fileToolContext = {}, seen = [];
  // Isolated policy fixture; no owner setting is written or read.
  settings.loadSettings = (...args) => {const value=oldSettings(...args);return {...value,
    values:{...value.values,'agent.tool_approvals':false},provenance:{...value.provenance,'agent.tool_approvals':{source:'user'}}};};
  inspector.open = inspector.call = inspector.close = async (args, ctx) => {seen.push(ctx.fileToolContext); return {fixture:true};};
  try {
    const session = '12345678-1234-1234-1234-123456789abc';
    await executeTool('browser.web_inspector_open',{}, {fileToolContext});
    await executeTool('browser.web_inspector_call',{session,action:'snapshot'}, {fileToolContext});
    await executeTool('browser.web_inspector_close',{session}, {fileToolContext});
    assert.deepEqual(seen,[fileToolContext,fileToolContext,fileToolContext]);
    await assert.rejects(executeTool('browser.web_inspector_call',{session,action:'snapshot',unexpected:true},{fileToolContext}), {code:'INVALID_PARAMS'});
    assert.equal(seen.length,3);
  } finally {settings.loadSettings=oldSettings;inspector.open=oldOpen;inspector.call=oldCall;inspector.close=oldClose;}
});

function transport(answer) {
  let child, launched;
  const worker = new inspector.Worker({environment:{PATH:'',TOOLSENABLED_WEB_INSPECTOR_PYTHON:process.execPath,API_KEY:'must-not-pass',NODE_OPTIONS:'must-not-pass'}, launch(...args) {
    launched = args;
    child = new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{child.emit('close',null,'SIGKILL');return true;};
    child.stdin=new Writable({write(chunk, encoding, done){
      if (answer) queueMicrotask(()=>child.stdout.write(answer(JSON.parse(chunk))));
      done();
    },final(done){queueMicrotask(()=>{child.stdout.write(JSON.stringify({type:'cleanup',result:{closed:true,cleanupFailures:0}})+'\n');child.emit('close',0,null);});done();}});
    return child;
  }});
  return {worker,child,launched};
}
test('actual registry to provider honors Basic, required and unknown operation audit snapshots', async()=>{
  const settings=require('../src/lib/settings'), canonical=require('../src/lib/audit');
  const {executeTool}=require('./helpers/dispatch');
  const originals={load:settings.loadSettings,record:canonical.requireRecord,optional:canonical.record,open:inspector.open,call:inspector.call,close:inspector.close};
  let enabled=false, unknown=false, refuse=false, refuseProvider=false, flip=false, launches=0;
  const throughput=require('../src/lib/throughput-mode');
  throughput.setThroughputModeForTests('strict');
  const audits=[], calls=[], fileToolContext={};
  settings.loadSettings=()=>{
    if(unknown)throw Error('inert unreadable settings');
    const values={'audit.enabled':enabled,'agent.agent_api':'Only','agent.tool_approvals':false,'tools.throughput':'strict','audit.activity':'Off'};
    return {values,provenance:Object.fromEntries(Object.keys(values).map(id=>[id,{source:'user'}])),rejected:[]};
  };
  canonical.record=canonical.requireRecord=(action)=>{
    audits.push(action);
    if(refuse || (refuseProvider && action==='browser.web_inspector_open.intent'))throw Object.assign(Error('inert signer refusal'),{code:'AUDIT_REQUIRED'});
    if(flip && action==='mcp.tool.intent') enabled=false;
    return {durable:true,anchored:true,recorded:true};
  };
  const service=inspector.createService({workerFactory(){launches++;return{
    closed:false,async finish(){this.closed=true;return {closed:true,cleanupFailures:0};},
    async request(request){calls.push(request.action);return {ownedTab:true,closed:request.action==='close',cleanupFailures:0};}
  };}});
  inspector.open=service.open;inspector.call=service.call;inspector.close=service.close;
  try{
    const first=await executeTool('browser.web_inspector_open',{}, {fileToolContext});
    await executeTool('browser.web_inspector_call',{session:first.session,action:'snapshot'},{fileToolContext});
    await executeTool('browser.web_inspector_close',{session:first.session},{fileToolContext});
    assert.equal(audits.length,0,'Basic must never reach the canonical signer');
    assert.deepEqual(calls,['open','snapshot','close']);
    enabled=true;flip=true;
    const second=await executeTool('browser.web_inspector_open',{}, {fileToolContext});
    assert.ok(audits.includes('mcp.tool.intent'));
    assert.ok(audits.includes('browser.web_inspector_open.intent'),'provider must keep the admitted required snapshot after setting flips off');
    await executeTool('browser.web_inspector_close',{session:second.session},{fileToolContext});
    enabled=true;flip=false;refuse=true;
    await assert.rejects(executeTool('browser.web_inspector_open',{}, {fileToolContext}),{code:'AUDIT_REQUIRED'});
    assert.equal(launches,2,'required audit refusal precedes helper launch');
    refuse=false;refuseProvider=true;
    await assert.rejects(executeTool('browser.web_inspector_open',{}, {fileToolContext}),{code:'AUDIT_REQUIRED'});
    assert.equal(launches,2,'provider required intent must also refuse before helper launch');
    const count=audits.length;unknown=true;
    await assert.rejects(executeTool('browser.web_inspector_open',{}, {fileToolContext}),{code:'AUDIT_POLICY_INVALID'});
    assert.equal(audits.length,count);assert.equal(launches,2);
  }finally{
    settings.loadSettings=originals.load;canonical.requireRecord=originals.record;canonical.record=originals.optional;
    throughput.setThroughputModeForTests(null);
    inspector.open=originals.open;inspector.call=originals.call;inspector.close=originals.close;
  }
});
test('worker uses argument-vector launch and a scrubbed environment on both platform defaults',async()=>{
  const f=transport(()=>JSON.stringify({ok:true,result:{fixture:true}})+'\n');
  assert.equal(f.launched[2].shell,false);
  assert.equal(f.launched[2].windowsHide,true);
  assert.equal(f.launched[2].env.API_KEY,undefined);
  assert.equal(f.launched[2].env.NODE_OPTIONS,undefined);
  assert.deepEqual(f.launched[1].slice(0,2),['-I','-u']);
  assert.throws(()=>inspector.resolvePython({PATH:''},'win32'),{code:'WEB_INSPECTOR_DEPENDENCY_MISSING'});
  assert.equal(inspector.resolvePython({PATH:''},'linux'),'python3');
  assert.throws(()=>inspector.resolvePython({TOOLSENABLED_WEB_INSPECTOR_PYTHON:'relative'}),{code:'WEB_INSPECTOR_PYTHON_PATH_INVALID'});
  assert.deepEqual(await f.worker.request({action:'snapshot'}),{fixture:true});
  await f.worker.finish();assert.equal(f.worker.closed,true);
});
test('uncertain input is never replayed; one request at a time',async()=>{
  const f=transport();
  const pending=f.worker.request({action:'tap',x:1,y:1});
  await assert.rejects(f.worker.request({action:'tap',x:1,y:1}),{code:'WEB_INSPECTOR_BUSY'});
  f.child.stdout.write('{"ok":true,"result":{"dispatched":true}}\n');
  assert.deepEqual(await pending,{dispatched:true});
  await f.worker.finish();
  await assert.rejects(f.worker.request({action:'snapshot'}),{code:'WEB_INSPECTOR_TRANSPORT_CLOSED'});
});
test('malformed or oversized helper output poisons the transport without exposing it',async()=>{
  for (const [answer,code] of [[()=>'{private-driver-error\n','WEB_INSPECTOR_PROTOCOL_ERROR'],[()=>'x'.repeat(3*1024*1024+1025),'WEB_INSPECTOR_OUTPUT_LIMIT']]) {
    const f=transport(answer);
    await assert.rejects(f.worker.request({action:'snapshot'}),{code});
    await assert.rejects(f.worker.request({action:'snapshot'}),{code:'WEB_INSPECTOR_TRANSPORT_CLOSED'});
    await f.worker.finish();
  }
});
test('screenshots are non-enumerable bounded MCP image attachments',async()=>{
  const png=Buffer.from('89504e470d0a1a0a00000000','hex');
  const service=inspector.createService({active(){},auditSink:{requireRecord(){}},workerFactory(){return{
    closed:false,async finish(){this.closed=true;return {closed:true,cleanupFailures:0};},async request({action}){return action==='screenshot'?{mimeType:'image/png',base64:png.toString('base64')}:{closed:true,cleanupFailures:0};}
  };}});
  const {session}=await service.open({},context);
  const image=await service.call({session,action:'screenshot'},context);
  assert.deepEqual(image.__mcpImage,png);
  assert.equal(JSON.stringify(image).includes('base64'),false);
  assert.equal(Object.keys(image).includes('__mcpImage'),false);
  const formatted=require('../src/mcp-server').toolResult(image);
  assert.equal(formatted.content[1].type,'image');
  assert.equal(formatted.structuredContent.bytes,png.length);
  await service.close({session},context);
});

test('Python helper cleanup, native input protocol and inert lease contracts', t => {
  const {spawnSync}=require('node:child_process');
  const path=require('node:path');
  const result=spawnSync(inspector.resolvePython(),['-I','-B',path.join(__dirname,'web-inspector-helper.py')],
    {encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
  if(result.error?.code==='ENOENT'){t.skip('Optional Python interpreter is not installed');return;}
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stderr,/Ran \d+ tests/);
});

test('failed and unknown cleanup keeps custody, refuses actions and replacement, permits explicit close retry', async () => {
  for (const dead of [false,true]) {
    const f=fixture(), {session}=await f.service.open({},context), w=f.workers[0];
    w.request=async()=>({closed:false,cleanupFailures:1});
    assert.equal((await f.service.close({session},context)).closed,false);
    await assert.rejects(f.service.call({session,action:'snapshot'},context),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});
    w.closed=dead;
    if(dead)w.finish=async()=>{throw Object.assign(Error('uncertain'),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});};
    await assert.rejects(f.service.open({},context),{code:dead?'WEB_INSPECTOR_CLEANUP_UNCONFIRMED':'WEB_INSPECTOR_BUSY'});
    assert.equal(f.workers.length,1);
    w.finish=async()=>({closed:true,cleanupFailures:0});
    w.request=async()=>({closed:true,cleanupFailures:0});
    await f.service.close({session},context);
    await f.service.open({},context);
    assert.equal(f.workers.length,2);
    await f.service.closeSession(context.agentPrincipal.sessionId);
  }
});
test('EOF/idle require final cleanup proof, never process exit alone or forced/nonzero exit', async()=>{
  for(const [receipt,code,signal,forced,pass] of [
    [undefined,0,null,false,false], [false,0,null,false,false], [true,1,null,false,false],
    [true,null,'SIGKILL',false,false], [true,0,null,true,false], [true,0,null,false,true]
  ]){
    const {worker,child}=transport();
    if(receipt!==undefined)child.stdout.write(JSON.stringify({type:'cleanup',result:{closed:receipt,cleanupFailures:receipt?0:1}})+'\n');
    worker.forced=forced;child.emit('close',code,signal);
    if(pass) assert.deepEqual(await worker.finish(),{closed:true,cleanupFailures:0});
    else await assert.rejects(worker.finish(),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});
  }
});
test('EOF cleanup failure is sticky in connection teardown and uncertain open', async()=>{
  const f=fixture();await f.service.open({},context);
  f.workers[0].finish=async()=>({closed:false,cleanupFailures:1});
  await assert.rejects(f.service.closeSession(context.agentPrincipal.sessionId),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});
  await assert.rejects(f.service.open({},context),{code:'WEB_INSPECTOR_BUSY'});
  let launches=0;
  const s=inspector.createService({active(){},auditSink:{requireRecord(){}},workerFactory(){launches++;return{
    closed:true,async request(){throw Error('uncertain open');},async finish(){return {closed:false,cleanupFailures:1};}
  };}});
  await assert.rejects(s.open({},context),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});
  await assert.rejects(s.open({},context),{code:'WEB_INSPECTOR_CLEANUP_UNCONFIRMED'});
  assert.equal(launches,1);
});
