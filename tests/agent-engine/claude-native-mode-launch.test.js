'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const {EventEmitter} = require('node:events');
const target = require.resolve('../../src/lib/agent-engine/claude-cli-process');
const originalLoad = Module._load;
const launches = [];
const modesWithinCeiling = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];
function spawnHidden(command,args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();child.stdout.setEncoding=()=>{};
  child.stderr = new EventEmitter();child.stderr.setEncoding=()=>{};
  child.kill=()=>{};
  child.controlRequests=[];
  child.stdin={on(){},writable:true,end(){queueMicrotask(()=>child.emit('close',0));},write(raw){
    const packet=JSON.parse(raw);
    child.controlRequests.push(packet);
    assert.equal(packet.type,'control_request','No provider user turns in this test');
    queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({type:'control_response',
      response:{request_id:packet.request_id,subtype:'success',
        response:packet.request.subtype==='set_permission_mode'?{mode:packet.request.mode}:{}}})+'\n'));
    return true;
  }};
  if(args.includes('--version'))queueMicrotask(()=>{child.stdout.emit('data','fixture-version');child.emit('close',0);});
  else launches.push({args,child});
  return child;
}
Module._load=function(request,parent,...rest) {
  if(parent?.filename===target && request==='../proc/hidden-spawn')return {spawnHidden};
  if(parent?.filename===target && request==='../runtime')return {rootPath(){throw Error('No filesystem log in simulation');}};
  return originalLoad.call(this,request,parent,...rest);
};
async function run(){
  const {startClaudeSession,resumeClaudeSession}=require(target);
  for(const initialMode of ['plan','default','acceptEdits','bypassPermissions']) {
    for(const resume of [false,true]) {
      const session=await (resume?resumeClaudeSession:startClaudeSession)({
        cwd:process.cwd(),command:process.execPath,env:{},
        ...(resume?{threadId:'7cf7c88e-6912-4388-a181-78aef262c494'}:{}),
        plan:{claudePermissionMode:initialMode,roleFunctionsOnly:true,agentApiMode:'Only'}});
      const args=launches.at(-1).args;
      assert.equal(args[args.indexOf('--permission-mode')+1],initialMode);
      assert.equal(args[args.indexOf('--tools')+1],'');
      assert.equal(args[args.indexOf('--setting-sources')+1],'');
      assert.ok(args.includes('--disable-slash-commands'));
      try {
        const modes=session.adapter.getSessionModes(session.threadId);
        const expected=modesWithinCeiling.slice(0,modesWithinCeiling.indexOf(initialMode)+1);
        assert.equal(modes.currentModeId,null,'the provider has not reported its mode yet');
        assert.deepEqual(modes.availableModes.map(m=>m.id),expected);
        const child=launches.at(-1).child;
        child.stdout.emit('data',JSON.stringify({type:'system',subtype:'status',
          session_id:session.threadId,permissionMode:initialMode})+'\n');
        assert.equal(session.adapter.getSessionModes(session.threadId).currentModeId,initialMode);
        const beforeRefusal=child.controlRequests.length;
        for(const mode of [...modesWithinCeiling.filter(mode=>!expected.includes(mode)),'auto','invented']) {
          await assert.rejects(session.adapter.selectMode(session.threadId,mode),{code:'CLAUDE_MODE_NOT_ALLOWED'});
        }
        assert.equal(child.controlRequests.length,beforeRefusal,'above-ceiling choices dispatch nothing');
        for(const mode of [...expected,'plan',initialMode]) {
          const receipt=await session.adapter.selectMode(session.threadId,mode);
          assert.equal(receipt.currentModeId,mode);
          assert.equal(session.adapter.getSessionModes(session.threadId).currentModeId,mode);
        }
      } finally { await session.close(); }
    }
  }
  const unbound=await startClaudeSession({cwd:process.cwd(),command:process.execPath,env:{},args:['--fixture']});
  assert.equal(unbound.adapter.getSessionModes(unbound.threadId),null);unbound.close();
  console.log('Claude trusted launch/resume mode policy GREEN');
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{Module._load=originalLoad;});
