'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),authorPath=path.join(__dirname,'windows-job-pre-ready-settlement.test.js');
const author=fs.readFileSync(authorPath,'utf8');
const {fixture,turn}=new Function('require','__dirname',author.slice(0,author.indexOf("test('"))+'\nreturn {fixture,turn};')(createRequire(authorPath),__dirname);
const hostPath=path.join(root,'src/lib/providers/host-control.js'),source=fs.readFileSync(hostPath,'utf8');
const execSource=source.slice(source.indexOf('function exec({ command'),source.indexOf('\nmodule.exports ='));
const env={assertActive:()=>{},fail:(code,message)=>{throw Object.assign(new Error(message),{code})},
 HOME:root,resolveHostPath:p=>p,DEFAULT_TIMEOUT_MS:1000,MAX_TIMEOUT_MS:600000,
 safeLaunchEnvironment:()=>({}),deleteEnvNames:value=>value,killExecTree:child=>child.terminateJob(),
 audit:{redact:value=>value}};
const exec=new Function(...Object.keys(env),execSource+'\nreturn exec;')(...Object.values(env));
const files=['src/lib/windows-job-control.js','src/lib/providers/host-control.js','tests/windows-job-pre-ready-settlement.test.js'];
const measured=()=>Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const before=measured();console.log('REVIEW_BEFORE '+JSON.stringify(before));test.after(()=>{const after=measured();console.log('REVIEW_AFTER '+JSON.stringify(after));assert.deepEqual(after,before)});
async function scenario(kind) {
 let h,settled,result,error;const timers=new Set(),controller=new AbortController();
 const promise=exec({command:'inert-review',cwd:root,timeoutMs:1000},{
 platform:'win32',signal:controller.signal,requireRecordAsync:()=>Promise.resolve(),recordAsync:()=>Promise.resolve(),
 setTimeoutImpl:fn=>{const handle={fn,unref(){}};timers.add(handle);return handle},clearTimeoutImpl:t=>timers.delete(t),
 spawnInJobImpl:(_file,_args,_opts,deps)=>{
 h=fixture({beforeRootSpawn:deps.beforeRootSpawn,
 ...(kind==='cancel'?{prepareRootSpawn:()=>new Promise(()=>{})}:{}),
 ...(kind==='refusal'?{beforeRootSpawn:()=>{throw Object.assign(new Error('fixture admission refused'),{code:'AGENT_RESOURCE_REFUSED'})}}:{})});
 return h.child;
 }});
 promise.then(v=>{settled=true;result=v},e=>{settled=true;error=e});
 await turn();
 if(kind==='early'){h.native.emit('close',125,null)}
 else {
 h.native.emit('spawn');await turn();
 if(kind==='cancel')controller.abort();
 if(kind==='pre-error') {
 h.socket.emit('data','ERROR WINDOWS_JOB_WRAPPER_FAILED '+Buffer.from('fixture original pre-ready failure').toString('base64')+'\n');
 await turn();assert.equal(settled,undefined,'must await native close');
 h.native.emit('close',125,null);
 }
 if(kind==='normal'||kind==='ready-close') {
 h.socket.emit('data','READY 4242 1234 4343 5678\n');await h.child.jobReady;
 if(kind==='normal')h.socket.emit('data','EXIT 0 0\n');
 h.native.emit('close',kind==='normal'?0:125,null);
 }
 }
 for(let i=0;i<20&&!settled;i++)await turn();
 assert.equal(settled,true,'host must settle without firing its timeout');
 assert.equal(timers.size,0);
 return {result,error,h};
}
test('actual host maps pre-READY error and close to original failure without timeout',async()=>{
 const {result,h}=await scenario('pre-error');
 assert.equal(result.ok,false);assert.equal(result.timedOut,false);assert.equal(result.exitCode,null);
 assert.equal(result.error.code,'WINDOWS_JOB_WRAPPER_FAILED');assert.equal(result.terminationFailure.code,result.error.code);
 assert.equal(result.error.message,'fixture original pre-ready failure');assert.equal(h.child.jobIdentity,null);
});
test('actual host early close remains explicit failure',async()=>{
 const {result}=await scenario('early');assert.equal(result.ok,false);assert.equal(result.timedOut,false);
 assert.equal(result.error.code,'WINDOWS_JOB_WRAPPER_FAILED');
});
test('actual host READY without terminal receipt never claims cleanup success',async()=>{
 const {result}=await scenario('ready-close');assert.equal(result.ok,false);assert.equal(result.timedOut,false);
 assert.equal(result.terminationFailure.code,'WINDOWS_JOB_CLEANUP_UNPROVEN');
});
test('actual host normal terminal receipt remains successful',async()=>{
 const {result}=await scenario('normal');assert.equal(result.ok,true);assert.equal(result.exitCode,0);
 assert.equal(result.terminationFailure,null);assert.equal(result.timedOut,false);
});
test('actual host pre-OWNER cancel returns AbortError without invented identity',async()=>{
 const {error,h}=await scenario('cancel');assert.equal(error.code,'ABORT_ERR');assert.equal(h.child.jobIdentity,null);assert.deepEqual(h.sent,[]);
});
test('actual host admission refusal preserves causal refusal code',async()=>{
 const {result,h}=await scenario('refusal');assert.equal(result.ok,false);assert.equal(result.timedOut,false);
 assert.equal(h.child.jobIdentity,null);assert.deepEqual(h.sent,[]);
 assert.equal(result.error?.code,'AGENT_RESOURCE_REFUSED');
});
