'use strict';
const assert=require('node:assert/strict');
const {CodexAdapter}=require('../../src/lib/agent-engine/codex-adapter');
function peer({config={config:{developer_instructions:'Host policy remains intact.'}},configError=null,hold=false,holdResume=false,start={thread:{id:'t'},model:'actual-model',reasoningEffort:'high'}}={}) {
 let listener,held;const writes=[],resumes=[];
 const adapter=new CodexAdapter({codexVersion:'0.154.0',transport:{onData(fn){listener=fn;return()=>{};},write(line){
  const m=JSON.parse(line);writes.push(m);if(!m.id)return;
  if(m.method==='config/read'&&hold){held=m;return;}
  if(m.method==='thread/resume'&&holdResume){resumes.push(m);return;}
  if(m.method==='config/read'&&configError){listener(JSON.stringify({id:m.id,error:configError})+'\n');return;}
  const result=m.method==='config/read'?config:m.method==='thread/start'||m.method==='thread/resume'?start:m.method==='collaborationMode/list'?{data:[{name:'Plan',mode:'plan'}]}:{};
  listener(JSON.stringify({id:m.id,result})+'\n');
 }}});
 return {adapter,writes,replyResume(index=0,error=null){const m=resumes[index];assert.ok(m);listener(JSON.stringify({id:m.id,...(error?{error}:{result:start})})+'\n');},late(){listener(JSON.stringify({id:held.id,result:config})+'\n');}};
}
async function resumedNativeModeBinding() {
 const path = require('node:path');
 for (const fromPath of [false, true]) {
  const p = peer();
  try {
   await p.adapter.initialize();
   const options = { developerInstructions: 'Exact trusted resume policy', model: 'requested-model', sandbox: 'read-only', approvalPolicy: 'never' };
   const restored = await (fromPath ? p.adapter.resumeThreadFromPath('t', path.resolve('owned-rollout.jsonl'), options) : p.adapter.resumeThread('t', options));
   assert.deepEqual(restored.nativeModeSettings, { model: 'actual-model', effort: 'high', developerInstructions: options.developerInstructions });
   assert.equal(restored.nativeModeUnavailableReason, null);
   const request = p.writes.find(m => m.method === 'thread/resume');
   assert.equal(request.params.developerInstructions, options.developerInstructions);
   assert.equal(request.params.sandbox, 'read-only'); assert.equal(request.params.approvalPolicy, 'never');
   assert.equal(p.writes.some(m => m.method === 'config/read'), false);
   await p.adapter.selectMode('t', 'plan', restored.nativeModeSettings);
   assert.deepEqual(p.writes.at(-1).params.collaborationMode.settings, { model: 'actual-model', reasoning_effort: 'high', developer_instructions: options.developerInstructions });
   const rejoined = await p.adapter.resumeThread('t', { developerInstructions: 'Unconfirmed rejoin override' });
   assert.equal(rejoined.nativeModeSettings ?? null, null, 'an already-bound server is not the first fresh-process restore');
  } finally { p.adapter.close(); }
 }
 for (const [start, reason] of [
  [{ thread: { id: 't' }, model: 'actual-model', reasoningEffort: null }, null],
  [{ thread: { id: 't' }, model: 'actual-model' }, 'CODEX_MODE_EFFORT_UNAVAILABLE'],
  [{ thread: { id: 't' }, reasoningEffort: 'high' }, 'CODEX_MODE_MODEL_UNAVAILABLE']
 ]) {
  const p = peer({ start });
  try {
   await p.adapter.initialize();
   const restored = await p.adapter.resumeThread('t', { developerInstructions: 'Explicit trusted resume policy' });
   assert.equal(restored.nativeModeUnavailableReason, reason);
   if (reason) assert.equal(restored.nativeModeSettings, null);
   else assert.deepEqual(restored.nativeModeSettings, { model: 'actual-model', effort: null, developerInstructions: 'Explicit trusted resume policy' });
  } finally { p.adapter.close(); }
 }
 const mismatch = peer({ start: { thread: { id: 'other' }, model: 'actual-model', reasoningEffort: 'high' } });
 try {
  await mismatch.adapter.initialize();
  await assert.rejects(mismatch.adapter.resumeThreadFromPath('t', path.resolve('owned-rollout.jsonl'), { developerInstructions: 'Trusted' }), { code: 'CODEX_RESUME_IDENTITY_MISMATCH' });
 } finally { mismatch.adapter.close(); }
 for (const developerInstructions of [null, '', 7]) {
  const p = peer();
  try {
   await p.adapter.initialize();
   await assert.rejects(p.adapter.resumeThread('t', { developerInstructions }), { code: 'AGENT_ENGINE_CONTRACT_INVALID' });
   assert.equal(p.writes.some(m => m.method === 'thread/resume'), false);
  } finally { p.adapter.close(); }
 }
 for (const mode of ['mutable-options', 'concurrent-restore', 'closed', 'provider-refusal']) {
  const p = peer({ holdResume: true });
  try {
   await p.adapter.initialize();
   const options = { developerInstructions: 'Captured before dispatch' };
   const first = p.adapter.resumeThread('t', options);
   if (mode === 'mutable-options') {
    options.developerInstructions = 'Later caller mutation';
    p.replyResume();
    assert.equal((await first).nativeModeSettings.developerInstructions, 'Captured before dispatch');
   } else if (mode === 'concurrent-restore') {
    const second = p.adapter.resumeThread('t', { developerInstructions: 'Concurrent override' });
    p.replyResume(0); p.replyResume(1);
    assert.equal((await first).nativeModeSettings ?? null, null);
    assert.equal((await second).nativeModeSettings ?? null, null);
   } else {
    const refused = assert.rejects(first, { code: mode === 'closed' ? 'CODEX_ADAPTER_CLOSED' : 'CODEX_APP_SERVER_ERROR' });
    if (mode === 'closed') { p.adapter.close(); p.replyResume(); }
    else p.replyResume(0, { code: -32602, message: 'Explicit resume refused' });
    await refused;
    assert.equal(p.writes.some(m => m.method === 'thread/settings/update'), false);
   }
  } finally { p.adapter.close(); }
 }
 console.log('Explicit resume binding: id/path, exact instructions, actual model/effort, known null, missing settings, existing-thread exclusion and invalid/identity refusal passed.');
}
async function run(){
 const p=peer();await p.adapter.initialize();
 for (const configTimeoutMs of [0,10001,1.5]) await assert.rejects(p.adapter.startThreadWithNativeModeSettings({}, {configTimeoutMs}), {code:'CODEX_ADAPTER_INVALID'});
 const started=await p.adapter.startThreadWithNativeModeSettings({cwd:process.cwd(),sandbox:'read-only',approvalPolicy:'never',model:'requested-model'});
 assert.deepEqual(started.nativeModeSettings,{model:'actual-model',effort:'high',developerInstructions:'Host policy remains intact.'});
 assert.equal(started.nativeModeUnavailableReason,null);
 assert.throws(()=>{started.nativeModeSettings.model='other';},TypeError);
 const configRequest=p.writes.find(m=>m.method==='config/read'),startRequest=p.writes.find(m=>m.method==='thread/start');
 assert.deepEqual(configRequest.params,{includeLayers:false,cwd:process.cwd()});
 assert.equal(startRequest.params.developerInstructions,'Host policy remains intact.');
 assert.equal(startRequest.params.sandbox,'read-only');assert.equal(startRequest.params.approvalPolicy,'never');
 await p.adapter.selectMode('t','plan',started.nativeModeSettings);
 assert.deepEqual(p.writes.at(-1).params,{threadId:'t',collaborationMode:{mode:'plan',settings:{model:'actual-model',reasoning_effort:'high',developer_instructions:startRequest.params.developerInstructions}}});p.adapter.close();
 for(const [options,reason] of [
  [{configError:{code:-32601,message:'Method not found'}},'CODEX_MODE_CONFIG_UNAVAILABLE'],
  [{config:{config:{developer_instructions:null}}},'CODEX_MODE_INSTRUCTIONS_UNAVAILABLE'],
  [{config:{config:{}}},'CODEX_MODE_INSTRUCTIONS_UNAVAILABLE'],
  [{config:{config:{developer_instructions:7}}},'CODEX_MODE_CONFIG_UNAVAILABLE'],
  [{config:{config:{developer_instructions:'x'.repeat(1_000_001)}}},'CODEX_MODE_INSTRUCTIONS_TOO_LARGE'],
  [{hold:true},'CODEX_MODE_CONFIG_TIMEOUT'],
  [{start:{thread:{id:'t'},reasoningEffort:'high'}},'CODEX_MODE_MODEL_UNAVAILABLE'],
  [{start:{thread:{id:'t'},model:'actual-model'}},'CODEX_MODE_EFFORT_UNAVAILABLE']
 ]){
  const f=peer(options);await f.adapter.initialize();const result=await f.adapter.startThreadWithNativeModeSettings({}, {configTimeoutMs:5});
  assert.equal(result.threadId,'t');assert.equal(result.nativeModeSettings,null);assert.equal(result.nativeModeUnavailableReason,reason);
  if(!options.start)assert.equal(Object.hasOwn(f.writes.find(m=>m.method==='thread/start').params,'developerInstructions'),false);
  if(options.hold){f.late();assert.equal((await f.adapter.listCollaborationModes()).modes[0].mode,'plan');}
  f.adapter.close();
 }
 const explicit=peer({configError:{code:-32601,message:'Unused'}});await explicit.adapter.initialize();
 const bound=await explicit.adapter.startThreadWithNativeModeSettings({developerInstructions:'Explicit trusted launch policy'});
 assert.equal(bound.nativeModeSettings.developerInstructions,'Explicit trusted launch policy');assert.equal(explicit.writes.some(m=>m.method==='config/read'),false);explicit.adapter.close();
 const empty=peer({config:{config:{developer_instructions:''}},start:{thread:{id:'t'},model:'actual-model',reasoningEffort:null}});await empty.adapter.initialize();
 const knownEmpty=await empty.adapter.startThreadWithNativeModeSettings();assert.deepEqual(knownEmpty.nativeModeSettings,{model:'actual-model',effort:null,developerInstructions:''});empty.adapter.close();
 const resumed=peer();await resumed.adapter.initialize();const restored=await resumed.adapter.resumeThread('t');assert.equal(Object.hasOwn(restored,'nativeModeSettings'),false);assert.equal(resumed.writes.some(m=>m.method==='config/read'),false);resumed.adapter.close();
 await resumedNativeModeBinding();
 console.log('Native mode launch binding passed: config/start/select identical instructions, actual settings, no widening, named unavailable recovery, bounded timeout/late reply, explicit overrides, empty/null, resume no guessing.');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
