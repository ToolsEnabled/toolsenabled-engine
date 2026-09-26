'use strict';
const assert = require('node:assert/strict');
const watchdog = setTimeout(() => { console.error('Unsettled mode operation'); process.exit(1); }, 4000);
const { CodexAdapter } = require('../../src/lib/agent-engine/codex-adapter');
function fixture() {
  let listener;
  const writes = [], deferred = [];
  const state = { hold: false, holdMethod: 'thread/settings/update', error: null, response: {}, modes: [{name:'Plan',mode:'plan'},{name:'Default',mode:'default'}] };
  const emit = message => listener(JSON.stringify(message) + '\n');
  const adapter = new CodexAdapter({codexVersion:'0.154.0',transport:{
    onData(fn) { listener=fn; return () => {}; },
    write(line) {
      const m=JSON.parse(line); writes.push(m); if(!m.id)return;
      if (m.method===state.holdMethod && state.hold) {deferred.push(m);return;}
      if (m.method==='thread/settings/update' && state.error) {emit({id:m.id,error:state.error});return;}
      const result=m.method==='thread/start'||m.method==='thread/resume' ? {thread:{id:'t',turns:[]}} : m.method==='collaborationMode/list' ? {data:state.modes} : m.method==='thread/settings/update' ? state.response : m.method==='turn/start' ? {turn:{id:'turn'}} : {};
      emit({id:m.id,result});
    }
  }});
  return {adapter,writes,state,ack(){const m=deferred.shift();assert.ok(m);emit({id:m.id,result:m.method==='thread/resume'?{thread:{id:'t',turns:[]}}:{}});}};
}
const retained={model:'chosen-model',effort:'high',developerInstructions:'Keep the host confinement and API policy.'};
async function run() {
  const f=fixture(), a=f.adapter;
  await a.initialize();
  await assert.rejects(a.selectMode('unknown','plan',retained),{code:'CODEX_MODE_THREAD_UNAVAILABLE'});
  await a.startThread();
  assert.equal(a.modeSelectionRequiresSettings,true);
  assert.equal(a.getSessionModes('t'),null);
  await a.listCollaborationModes();
  assert.deepEqual(a.getSessionModes('t'),{currentModeId:null,availableModes:[{id:'plan',name:'Plan'},{id:'default',name:'Default'}]});
  for(const mode of ['', 3, 'x'.repeat(513)]) {
    const before=f.writes.length;
    await assert.rejects(a.selectMode('t',mode,retained),{code:'CODEX_MODE_UNAVAILABLE'});
    assert.equal(f.writes.length,before,'Invalid ids must refuse before contacting the provider');
  }
  for (const settings of [undefined,{}, {...retained,developerInstructions:null},{model:retained.model,effort:null}, {...retained,model:''},{...retained,effort:3},{...retained,extra:true},{...retained,model:'m'.repeat(513)},{...retained,effort:'e'.repeat(33)},{...retained,developerInstructions:'d'.repeat(1_000_001)}]) {
    await assert.rejects(a.selectMode('t','plan',settings),{code:'CODEX_MODE_SETTINGS_REQUIRED'});
  }
  await assert.rejects(a.selectMode('t','auto',retained),{code:'CODEX_MODE_UNAVAILABLE'});
  assert.equal(f.writes.some(m=>m.method==='thread/settings/update'),false);
  const receipt=await a.selectMode('t','plan',retained);
  assert.equal(a.getSessionModes('t').currentModeId,'plan');
  assert.deepEqual(receipt,{threadId:'t',currentModeId:'plan',appliesOn:'subsequent-turns'});
  assert.deepEqual(f.writes.at(-1).params,{threadId:'t',collaborationMode:{mode:'plan',settings:{model:'chosen-model',reasoning_effort:'high',developer_instructions:'Keep the host confinement and API policy.'}}});
  await a.selectMode('t','default',{...retained,effort:null,developerInstructions:''});
  assert.deepEqual(f.writes.at(-1).params.collaborationMode.settings,{model:'chosen-model',reasoning_effort:null,developer_instructions:''});
  f.state.response=null;
  await assert.rejects(a.selectMode('t','plan',retained),{code:'CODEX_PROTOCOL_INVALID'});
  assert.equal(a.getSessionModes('t').currentModeId,'default');
  f.state.response={};
  f.state.error={code:-32601,message:'Method not found'};
  await assert.rejects(a.selectMode('t','plan',retained),e=>e.rpcCode===-32601);
  f.state.error=null; f.state.hold=true;
  const pending=a.selectMode('t','plan',retained);
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(a.selectMode('t','default',retained),{code:'CODEX_SETTINGS_BUSY'});
  await assert.rejects(a.updateThreadSettings('t',{effort:'low'}),{code:'CODEX_SETTINGS_BUSY'});
  await assert.rejects(a.sendTurn({threadId:'t',text:'User clicks send while selection waits'}),{code:'CODEX_SETTINGS_BUSY'});
  await assert.rejects(a.resumeThread('t'),{code:'CODEX_SETTINGS_BUSY'});
  f.ack(); await pending;
  const effort=a.updateThreadSettings('t',{effort:'low'});
  await assert.rejects(a.selectMode('t','plan',retained),{code:'CODEX_SETTINGS_BUSY'});
  f.ack();await effort;
  const closing=a.selectMode('t','default',retained);
  await new Promise(resolve=>setImmediate(resolve));a.close();
  await assert.rejects(closing,{code:'CODEX_ADAPTER_CLOSED'});
  assert.equal(f.writes.some(m=>m.method==='turn/start'),false);
  assert.equal(a.getSessionModes('t'),null);
  const busy=fixture(); await busy.adapter.initialize(); await busy.adapter.startThread();
  await busy.adapter.sendTurn({threadId:'t',text:'A running user turn'});
  await assert.rejects(busy.adapter.selectMode('t','plan',retained),{code:'CODEX_SETTINGS_BUSY'});busy.adapter.close();
  const restoring=fixture();await restoring.adapter.initialize();await restoring.adapter.startThread();
  restoring.state.hold=true;restoring.state.holdMethod='thread/resume';
  const restored=restoring.adapter.resumeThread('t');
  await assert.rejects(restoring.adapter.selectMode('t','plan',retained),{code:'CODEX_SETTINGS_BUSY'});
  restoring.ack();await restored;restoring.state.hold=false;
  await restoring.adapter.selectMode('t','plan',retained);
  await restoring.adapter.resumeThread('t');
  assert.equal(restoring.adapter.getSessionModes('t').currentModeId,null);
  restoring.adapter.close();
  clearTimeout(watchdog);
  console.log('Codex native mode selection passed: retained settings, advertised modes, missing-data refusals, provider errors, concurrent clicks/send/resume/effort, close settlement.');
}
run().catch(error=>{clearTimeout(watchdog);console.error(error);process.exitCode=1;});
