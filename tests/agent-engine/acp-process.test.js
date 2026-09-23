'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAcpSurface, assertGrokInspection } = require('../../src/lib/agent-engine/acp-confinement');
const { startAcpSession, resumeAcpSession } = require('../../src/lib/agent-engine/acp-process');
const { AcpAdapter } = require('../../src/lib/agent-engine/acp-adapter');

function fixture(t, provider) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-acp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = path.join(directory, 'account');
  fs.mkdirSync(path.join(account, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(account, '.gemini', 'oauth_creds.json'), 'fixture-not-a-credential');
  const files = new Map();
  const surface = prepareAcpSurface({ provider, directory, configDir: account, account: 'chosen',
    env: {}, entries: [['research-tools', { command: process.execPath, args: ['owned-server.js'], env: { SCOPE: 'one' } }]],
    servers: ['research-tools'], agentApiMode: 'Only', writeAtomic(file, value) { files.set(file, value); } });
  return { directory, account, files, plan: { ok: true, agentApiMode: 'Only', ...surface } };
}

function protocol({ hang = null, rejectMethod = null, rejectMessage = 'Authentication required', models = null, configOptions = null, selectionMismatch = false } = {}) {
  let listener;
  let cleanup = 0;
  const requests = [];
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.id === undefined || request.method === hang) return;
      queueMicrotask(() => {
        if (!listener) return;
        if (request.method === rejectMethod) {
          listener(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: rejectMessage } }) + '\n');
          return;
        }
        let result = {};
        if (request.method === 'initialize') result = { protocolVersion: 1, agentInfo: {name:'official-fixture',version:'9999.7'},
          agentCapabilities: { loadSession: true }, authMethods: [{id:'cached_token'}, {id:'oauth-personal'}] };
        if (request.method === 'session/new') result = { sessionId: 'session-one', models: models || {currentModelId:'runtime-default',availableModels:[]}, ...(configOptions ? {configOptions} : {}) };
        if (request.method === 'session/set_config_option') {
          configOptions = configOptions.map(option => option.id === request.params.configId && !selectionMismatch ? {...option,currentValue:request.params.value} : option);
          result = {configOptions};
        }
        if (request.method === 'session/load') {
          result = {...(models ? {models} : {}), ...(configOptions ? {configOptions} : {})};
          for (const update of [
            {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HISTORICAL'}},
            {sessionUpdate:'tool_call',toolCallId:'old-tool',title:'Previous tool',status:'completed'}
          ]) listener(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,update}})+'\n');
        }
        if (request.method === 'session/prompt') {
          listener(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,
            update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WORKING'},_meta:{future:true}}}})+'\n');
          result = { stopReason: 'end_turn' };
        }
        listener(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      });
    },
    close() { cleanup++; },
    async closeForStartupFailure() { cleanup++; },
    get cleanup() { return cleanup; },
    update(sessionId, update) { listener?.(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}})+'\n'); },
    exit() { listener?.(null, { code: 1 }); }
  };
  return { transport, requests };
}

for (const provider of ['gemini', 'grok']) {
  test(`${provider}: default model, exact selected account and app-owned tool surface`, async t => {
    const { plan, account, files } = fixture(t, provider);
    const rpc = protocol();
    let invocation;
    const options = { provider, plan, env: { PATH: '/fixture', XAI_API_KEY:'DO-NOT-FORWARD', GEMINI_API_KEY:'DO-NOT-FORWARD', GROK_HOME:'/wrong' },
      inspect: async request => { assert.deepEqual(request.args, ['--no-auto-update','inspect','--json']); return JSON.stringify({hooks:[],plugins:[],mcpServers:[],lspServers:[]}); },
      transportFactory: request => { invocation = request; return rpc.transport; } };
    const session = await startAcpSession(options);
    assert.equal(invocation.env[provider === 'gemini' ? 'GEMINI_CLI_HOME' : 'GROK_HOME'], account);
    assert.equal(invocation.env.XAI_API_KEY, undefined);
    assert.equal(invocation.env.GEMINI_API_KEY, undefined);
    assert(!invocation.args.includes('--version'));
    assert(!invocation.args.includes('--model'));
    assert(!invocation.args.includes('--always-approve'));
    assert(!rpc.requests.some(request => request.params?.model));
    const creation = rpc.requests.find(request => request.method === 'session/new');
    if (provider === 'grok') {
      assert.equal(creation.params.mcpServers[0].name, 'research-tools');
      assert(invocation.args.includes('--no-leader'));
      const profile = [...files.values()][0];
      assert.match(profile, /GrokBuild:search_tool/);
      assert.match(profile, /GrokBuild:use_tool/);
      assert.doesNotMatch(profile, /run_terminal|read_file|always-approve/);
      assert.deepEqual(rpc.requests.find(request=>request.method==='authenticate').params._meta,{headless:true});
    } else {
      const settings = JSON.parse([...files.values()][0]);
      assert.deepEqual(settings.tools.core, []);
      assert.deepEqual(settings.mcp.allowed, ['research-tools']);
      assert.equal(settings.mcpServers['research-tools'].trust, true);
      assert.equal(settings.hooksConfig.enabled, false);
      assert.deepEqual(creation.params.mcpServers, []);
    }
    const events = [];
    session.adapter.onEvent(event => events.push(event));
    await session.adapter.sendTurn({threadId:session.threadId,text:'test'});
    assert.equal(events.find(event=>event.type==='assistant_text').text,'WORKING');
    session.close();
    assert.equal(rpc.transport.cleanup,1);
    const resumedEvents = [];
    const resumed = await resumeAcpSession({...options,threadId:'original',onEvent:event=>resumedEvents.push(event)});
    assert.equal(resumed.threadId,'original');
    assert(rpc.requests.some(request=>request.method==='session/load'&&request.params.sessionId==='original'));
    assert.deepEqual(resumedEvents, [], 'loading history must not create fresh live messages or tool calls');
    await resumed.adapter.sendTurn({threadId:'original',text:'next'});
    assert.equal(resumedEvents.find(event=>event.type==='assistant_text').text,'WORKING');
    resumed.close();
  });
}

test('ambient Grok tools and malformed inspections cannot open a root', async t => {
  for(const value of ['', '{}', JSON.stringify({hooks:[{}],plugins:[],mcpServers:[],lspServers:[]}),
    JSON.stringify({hooks:[],plugins:[],mcpServers:[{}],lspServers:[]})]) assert.throws(()=>assertGrokInspection(value),{code:'AGENT_ACP_AMBIENT_TOOLS'});
  const {plan}=fixture(t,'grok');
  await assert.rejects(startAcpSession({provider:'grok',plan,inspect:async()=>'{}',transportFactory:()=>assert.fail('must not spawn')}),{code:'AGENT_ACP_AMBIENT_TOOLS'});
});

/* A GROK START THAT GROK ITSELF REFUSES NAMES GROK AND THE FIX. The preflight
   runs through the Codex version reader, so a missing Grok used to arrive as
   CODEX_CLI_NOT_FOUND ("install Codex") and a Grok too old for an option the
   start passes as CODEX_VERSION_DETECTION_FAILED ("run codex --version"). The
   fakes below are real child processes on the production reader and
   transport; their refusals are Grok 1.0.40's own words for an unknown option
   (recorded 2026-09-22, lanes/f-providers/grok-grok-/probe). No version is
   pinned: what decides is whether this Grok accepts what the start passes. */
function fakeGrok(t, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-fake-grok-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'grok');
  fs.writeFileSync(file, `#!${process.execPath}\n(${body.toString()})();\n`, { mode: 0o700 });
  return file;
}
const scriptedGrok = { skip: process.platform === 'win32' && 'the fake Grok is a script with a #! line' };

test('a missing Grok is reported as a missing program, never as Codex', async t => {
  const {plan}=fixture(t,'grok');
  const command=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'toolsenabled-no-grok-')),'grok');
  t.after(()=>fs.rmSync(path.dirname(command),{recursive:true,force:true}));
  await assert.rejects(startAcpSession({provider:'grok',plan,command,env:{PATH:path.dirname(command)},
    transportFactory:()=>assert.fail('must not spawn')}),error=>{
    assert.equal(error.code,'PROVIDER_LOGIN_NOT_INSTALLED');
    assert.doesNotMatch(error.message,/Codex|codex|winget/);
    return true;
  });
});

test('a Grok too old for --no-auto-update or inspect is told to update Grok', scriptedGrok, async t => {
  const {plan}=fixture(t,'grok');
  const command=fakeGrok(t,()=>{
    process.stderr.write("error: unexpected argument '--no-auto-update' found\n\nUsage: grok [OPTIONS] [PROMPT] [COMMAND]\n\nFor more information, try '--help'.\n");
    process.exit(2);
  });
  await assert.rejects(startAcpSession({provider:'grok',plan,command,env:{PATH:'/usr/bin:/bin'},
    transportFactory:()=>assert.fail('must not spawn')}),error=>{
    assert.equal(error.code,'GROK_CLI_INCOMPATIBLE');
    assert.match(error.message,/--no-auto-update/);
    assert.match(error.message,/grok update/);
    assert.doesNotMatch(error.message,/Codex|codex/);
    return true;
  });
});

test('a Grok whose agent refuses an option the start passes is told to update Grok', scriptedGrok, async t => {
  const {plan}=fixture(t,'grok');
  const command=fakeGrok(t,()=>{
    if (process.argv.includes('inspect')) {
      process.stdout.write(JSON.stringify({grokVersion:'0.0.1',hooks:[],plugins:[],mcpServers:[],lspServers:[]})+'\n');
      process.exit(0);
    }
    process.stderr.write("error: unexpected argument '--no-leader' found\n\nUsage: grok agent [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n");
    process.exit(2);
  });
  await assert.rejects(startAcpSession({provider:'grok',plan,command,env:{PATH:'/usr/bin:/bin'},startupTimeoutMs:20_000}),error=>{
    assert.equal(error.code,'GROK_CLI_INCOMPATIBLE');
    assert.match(error.message,/--no-leader/);
    assert.match(error.message,/grok update/);
    return true;
  });
});

test('a Grok that fails its tools check for another reason says so without naming Codex', scriptedGrok, async t => {
  const {plan}=fixture(t,'grok');
  const command=fakeGrok(t,()=>{
    process.stderr.write('Error: could not read the configuration in this folder\n');
    process.exit(1);
  });
  await assert.rejects(startAcpSession({provider:'grok',plan,command,env:{PATH:'/usr/bin:/bin'},
    transportFactory:()=>assert.fail('must not spawn')}),error=>{
    assert.equal(error.code,'GROK_CLI_CHECK_FAILED');
    assert.match(error.message,/grok inspect/);
    assert.doesNotMatch(error.message,/Codex|codex --version/);
    return true;
  });
});

test('missing Gemini login never starts a browser, CLI or hidden authentication', async t => {
  const {plan,account}=fixture(t,'gemini');
  fs.unlinkSync(path.join(account,'.gemini','oauth_creds.json'));
  await assert.rejects(startAcpSession({provider:'gemini',plan,transportFactory:()=>assert.fail('must not spawn')}),{code:'ACP_AUTH_REQUIRED'});
});

test('unprepared or broader plans fail before process creation', async () => {
  for(const provider of ['gemini','grok','unknown']) await assert.rejects(startAcpSession({provider,
    plan:{ok:true,agentApiMode:'Enabled'},transportFactory:()=>assert.fail('must not spawn')}),{code:'AGENT_ACP_PLAN_REQUIRED'});
});

test('timed-out starts confirm cleanup; process exit rejects an in-flight prompt', async t => {
  const {plan}=fixture(t,'gemini');
  const hanging=protocol({hang:'initialize'});
  await assert.rejects(startAcpSession({provider:'gemini',plan,startupTimeoutMs:20,transportFactory:()=>hanging.transport}),{code:'ACP_START_TIMEOUT'});
  assert.equal(hanging.transport.cleanup,1);
  const rpc=protocol({hang:'session/prompt'});
  const adapter=new AcpAdapter({transport:rpc.transport,defaultCwd:plan.acp.cwd});
  await adapter.initialize();
  const turn=adapter.sendTurn({threadId:'one',text:'test'});
  rpc.transport.exit();
  await assert.rejects(turn,{code:'ACP_PROCESS_EXITED'});
});

function catalog() {
  return {
    models: {currentModelId:'weak',availableModels:[{modelId:'strong',name:'Strong'},{modelId:'weak',name:'Weak'}]},
    configOptions: [
      {id:'model',category:'model',type:'select',currentValue:'weak',options:[{value:'strong'},{value:'weak'}]},
      {id:'reasoning_effort',category:'thought_level',type:'select',currentValue:'high',options:[{value:'high'},{value:'xhigh'}]}
    ]
  };
}
for (const provider of ['grok','gemini']) {
  test(`${provider}: exact advertised model and effort are selected before any prompt, including resume`, async t => {
    const {plan}=fixture(t,provider);
    const rpc=protocol(catalog());let invocation;
    const options={provider,plan,threadOptions:{model:`${provider}/strong`,effort:'xhigh'},
      inspect:async()=>JSON.stringify({hooks:[],plugins:[],mcpServers:[],lspServers:[]}),
      transportFactory:args=>{invocation=args;return rpc.transport;}};
    const session=await startAcpSession(options);
    assert.equal(session.model,`${provider}/strong`);assert.equal(session.reasoningEffort,'xhigh');
    assert.deepEqual(rpc.requests.filter(r=>r.method==='session/set_config_option').map(r=>r.params),[
      {sessionId:'session-one',configId:'model',value:'strong'},
      {sessionId:'session-one',configId:'reasoning_effort',value:'xhigh'}]);
    assert(!rpc.requests.some(r=>r.method==='session/prompt'));
    if(provider==='gemini')assert.deepEqual(invocation.args.slice(-2),['--model','strong']);
    const models=await session.adapter.listModels();
    assert.equal(models.models.find(m=>m.id===`${provider}/strong`).defaultEffort,'xhigh');
    session.close();
    const resumed=await resumeAcpSession({...options,threadId:'original'});
    assert.equal(resumed.model,`${provider}/strong`);assert.equal(resumed.reasoningEffort,'xhigh');resumed.close();
  });
}
test('unsupported explicit model, unsupported effort and an unconfirmed selection never become ready or send',async t=>{
  const {plan}=fixture(t,'grok');
  for(const [threadOptions,selectionMismatch,code] of [
    [{model:'grok/missing'},false,'ACP_MODEL_UNAVAILABLE'],
    [{model:'grok/strong',effort:'ultra'},false,'ACP_EFFORT_UNAVAILABLE'],
    [{model:'grok/strong'},true,'ACP_MODEL_SELECTION_UNCONFIRMED'],
    [{model:'grok/weak',effort:'xhigh'},true,'ACP_EFFORT_SELECTION_UNCONFIRMED']]){
    const rpc=protocol({...catalog(),selectionMismatch});
    await assert.rejects(startAcpSession({provider:'grok',plan,threadOptions,
      inspect:async()=>JSON.stringify({hooks:[],plugins:[],mcpServers:[],lspServers:[]}),transportFactory:()=>rpc.transport}),{code});
    assert(!rpc.requests.some(r=>r.method==='session/prompt'));assert.equal(rpc.transport.cleanup,1);
  }
});
test('Gemini individual-client retirement is a distinct permanent refusal, never repeated sign-in advice',async t=>{
  const {plan}=fixture(t,'gemini');
  const rpc=protocol({rejectMethod:'authenticate',rejectMessage:'This client is no longer supported for Gemini Code Assist for individuals. Migrate to Antigravity.'});
  await assert.rejects(startAcpSession({provider:'gemini',plan,transportFactory:()=>rpc.transport}),{code:'ACP_CLIENT_UNSUPPORTED'});
  assert(!rpc.requests.some(r=>r.method==='session/new'||r.method==='session/prompt'));assert.equal(rpc.transport.cleanup,1);
});
test('a Grok unsupported-client refusal does not direct the user to a Google account',async t=>{
  const {plan}=fixture(t,'grok');
  const rpc=protocol({rejectMethod:'authenticate',rejectMessage:'UNSUPPORTED_CLIENT'});
  await assert.rejects(startAcpSession({provider:'grok',plan,
    inspect:async()=>JSON.stringify({hooks:[],plugins:[],mcpServers:[],lspServers:[]}),
    transportFactory:()=>rpc.transport}),error=>{
    assert.equal(error.code,'ACP_CLIENT_UNSUPPORTED');
    assert.doesNotMatch(error.message,/Google|Gemini|Antigravity/);
    return true;
  });
  assert(!rpc.requests.some(r=>r.method==='session/new'||r.method==='session/prompt'));
  assert.equal(rpc.transport.cleanup,1);
});

// PROVISIONAL WORDING, PINNED BY PROPERTY RATHER THAN BY STRING.
// Google retired individual-account access through this CLI on 2026-06-18
// (github.com/google-gemini/gemini-cli/discussions/28017); Enterprise and
// API-key accounts are unaffected and keep using this exact client. The
// person has twice rejected wording from this effort for explaining
// mechanism instead of saying what to do, so this test holds the property
// the sentence must have -- names Antigravity, never implies Enterprise or
// API access broke, stays short -- and not the exact words, so the wording
// in acp-adapter.js can be rewritten in one place without touching this file.
test('the Gemini individual-account retirement wording points at Antigravity, stays short and actionable, and never implies Enterprise or API access broke',()=>{
  const { GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE: message } = require('../../src/lib/agent-engine/acp-adapter');
  assert.equal(typeof message,'string','acp-adapter.js must export the provisional wording as GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE so it can be rewritten in one place');
  assert.match(message,/Antigravity/,'must point an individual account at Antigravity');
  assert.doesNotMatch(message,/session authority|provider connection|protocol|adapter|json-rpc|\brpc\b/i,
    'must say what to do, not explain the mechanism that produced the refusal');
  const sentences=message.split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.ok(sentences.length<=3,`runs to ${sentences.length} sentences: ${message}`);
  // FORBID THE FALSE CLAIM, NOT THE TRUE WORD. Google's own transition text
  // offers two remedies, Antigravity or a Gemini API key, and API support
  // must stay available, so naming an API key here must stay legal. Only a
  // sentence that also claims Enterprise or API access is broken fails.
  const FALSE_UNSUPPORTED_CLAIM=/unsupported|retired|broken|ended|deprecated|no longer|not supported/i;
  for(const clause of sentences){
    assert.ok(clause.split(/\s+/).length<=18,`a clause a person has to read twice: ${clause}`);
    if(/enterprise|api[ -]?key/i.test(clause)){
      assert.doesNotMatch(clause,FALSE_UNSUPPORTED_CLAIM,
        `must not claim Enterprise or API access is unsupported, retired or ended: ${clause}`);
    }
  }
});
test('a later provider model fallback invalidates an explicit selection before another prompt',async t=>{
  const {plan}=fixture(t,'grok'),rpc=protocol(catalog());
  const session=await startAcpSession({provider:'grok',plan,threadOptions:{model:'grok/strong'},
    inspect:async()=>JSON.stringify({hooks:[],plugins:[],mcpServers:[],lspServers:[]}),transportFactory:()=>rpc.transport});
  rpc.transport.update(session.threadId,{sessionUpdate:'config_option_update',configOptions:catalog().configOptions});
  await assert.rejects(session.adapter.sendTurn({threadId:session.threadId,text:'must not send'}),{code:'ACP_MODEL_SELECTION_UNCONFIRMED'});
  assert(!rpc.requests.some(r=>r.method==='session/prompt'));session.close();
});
test('model-only ACP providers receive the exact advertised setter while foreign provider IDs refuse before spawn',async t=>{
  const {plan}=fixture(t,'gemini'),rpc=protocol({models:catalog().models});let invocation;
  const session=await startAcpSession({provider:'gemini',plan,threadOptions:{model:'gemini/strong'},transportFactory:request=>{invocation=request;return rpc.transport;}});
  assert.deepEqual(invocation.args.slice(-2),['--model','strong']);
  assert.deepEqual(rpc.requests.find(r=>r.method==='session/set_model').params,{sessionId:session.threadId,modelId:'strong'});
  assert.equal(session.adapter.getSessionModels(session.threadId).currentModelId,'strong');session.close();
  await assert.rejects(startAcpSession({provider:'gemini',plan,threadOptions:{model:'grok/strong'},transportFactory:()=>assert.fail('must not spawn')}),{code:'ACP_MODEL_UNAVAILABLE'});
});

// Antigravity is another official Gemini client, with a distinct stream
// protocol. These fixtures exercise its admission and custody contract only;
// they do not stand in for authenticated native provider qualification.
const { startAntigravitySession, resumeAntigravitySession } = require('../../src/lib/agent-engine/antigravity-cli-process');
const agyDirectories = [];
test.after(() => { for (const directory of agyDirectories) fs.rmSync(directory, { recursive: true, force: true }); });
function agyFixture({ init = {}, cleanup = async () => {} } = {}) {
  let listener;
  let invocation;
  const writes = [];
  const nativeId = 'a7206e0d-b8b0-44cb-9fb7-1b05a454d250';
  const model = 'gemini-fixture-advertised-model';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-owned-fixture-'));
  agyDirectories.push(cwd);
  const surface = require('../../src/lib/agent-engine/antigravity-confinement').prepareAntigravitySurface({
    directory: cwd, configDir: path.join(cwd, 'account'), account: 'selected', agentApiMode: 'Only', env: {},
    entries: [['toolsenabled', { command: process.execPath, args: [path.resolve(__dirname, '../../src/mcp-server.js')],
      env: { TOOLSENABLED_AGENT_ACTOR: 'gemini', TOOLSENABLED_AGENT_ID: 'gemini-fixture',
        TOOLSENABLED_AGENT_SESSION_CREDENTIAL: Buffer.alloc(32, 4).toString('base64url'), TOOLSENABLED_STATE_ROOT: cwd } }]],
    writeAtomic: (file, value) => fs.writeFileSync(file, value) });
  const send = value => listener?.(JSON.stringify(value) + '\n');
  const transport = {
    onData(fn) { listener = fn; queueMicrotask(() => send({ event: 'init', conversation_id: nativeId,
      init: { cwd, tools: ['view_file', 'run_command', 'call_mcp_tool'], agent: 'toolsenabled-research-only', model, permission_mode: 'request-review', ...init } }));
      return () => { listener = null; }; },
    write(line) { writes.push(JSON.parse(line)); },
    closeForStartupFailure: cleanup
  };
  const options = {
    plan: { ok: true, agentApiMode: 'Only', ...surface },
    threadOptions: { model: `gemini/antigravity/${model}`, effort: 'high' },
    env: { PATH: '/fixture', GOOGLE_API_KEY: 'fixture-secret-never-forward', ANTIGRAVITY_ENDPOINT: 'fixture-redirect-never-forward' },
    transportFactory(request) { invocation = request; return transport; }
  };
  const step = (type, data = {}) => send({ event: 'step_update', step_update: {
    conversation_id: nativeId, step_index: 0, state: 'DONE', step_type: type, ...data } });
  const result = (num_turns, data = {}) => send({ event: 'result', result: {
    conversation_id: nativeId, status: 'SUCCESS', response: 'fixture answer', num_turns, ...data } });
  const exit = () => listener?.(null);
  return { options, transport, send, step, result, exit, writes, nativeId, get invocation() { return invocation; } };
}

test('Antigravity: native init admits exact model/tools/account without a hidden prompt', async () => {
  const fixture = agyFixture();
  const events = [];
  const session = await startAntigravitySession({ ...fixture.options, onEvent: event => events.push(event) });
  assert.equal(session.threadId, fixture.nativeId);
  assert.equal(session.reasoningEffort, undefined); // No native effort readback exists.
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.invocation.env.HOME, fixture.options.plan.antigravity.accountHome);
  assert.equal(fixture.invocation.env.GOOGLE_API_KEY, undefined);
  assert.equal(fixture.invocation.env.ANTIGRAVITY_ENDPOINT, undefined);
  assert.deepEqual(fixture.invocation.args, ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--disable-slash-commands', '--print-timeout', '90000s', '--agent', 'toolsenabled-research-only', '--model', 'gemini-fixture-advertised-model', '--effort', 'high']);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'fixture request' });
  fixture.step('user_input');
  fixture.step('tool', { step_index: 1, tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'toolsenabled-research', ToolName: 'research_read', Arguments: { key: 'one' } }, output: 'answer' } });
  fixture.step('agent_response', { step_index: 2, text_delta: 'fixture answer' });
  fixture.result(1, { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  assert.equal((await turn).status, 'completed');
  assert.deepEqual(fixture.writes, [{ event: 'user', message: { content: 'fixture request' } }]);
  assert.deepEqual(events.map(event => event.type), ['turn_accepted', 'tool_call', 'tool_result', 'assistant_text_delta', 'usage', 'assistant_text', 'turn_completed']);
  await session.close();
});

for (const init of [{ model: 'different-model' }, { agent: 'default' }, { permission_mode: 'always-proceed' }]) {
  test(`Antigravity refuses unconfirmed native model/tool/permission boundary ${JSON.stringify(init)}`, async () => {
    let closed = 0;
    const fixture = agyFixture({ init, cleanup: async () => { closed++; } });
    await assert.rejects(startAntigravitySession(fixture.options), { code: 'AGY_CLI_BOUNDARY_UNCONFIRMED' });
    assert(closed > 0);
    assert.deepEqual(fixture.writes, []);
  });
}

// Antigravity updates itself, so the copy that answers moves on without the
// app. A start reads that copy's own --version once, in the launch's own
// environment, and returns it beside the session; a failed read is null and
// never stops a start. Measured 2026-09-22: agy 1.2.2 and 1.2.8 print the bare
// version on stdout with exit 0.
const { readAntigravityVersion } = require('../../src/lib/agent-engine/antigravity-cli-process');
function fakeVersionProgram({ stdout = '', code = 0, error = null, hang = false } = {}) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
    calls.push({ command, args, options, child });
    if (error) throw error;
    if (!hang) queueMicrotask(() => { child.stdout.end(stdout); setImmediate(() => child.emit('close', code)); });
    return child;
  };
  return { spawnImpl, calls };
}

test('Antigravity reports the version of the program that answered, read once at session start in the launch environment', async () => {
  const fixture = agyFixture();
  const reads = [];
  const session = await startAntigravitySession({ ...fixture.options, command: '/fixture/bin/agy',
    readVersion: request => { reads.push(request); return Promise.resolve('1.2.8'); } });
  assert.equal(session.cliVersion, '1.2.8');
  assert.equal(reads.length, 1, 'read once per start');
  assert.equal(reads[0].command, '/fixture/bin/agy', 'the same program the start launches');
  assert.equal(reads[0].env, fixture.invocation.env, 'the launch environment itself: its account home, self-update off');
  assert.equal(reads[0].env.AGY_CLI_DISABLE_AUTO_UPDATE, '1');
  assert.equal(reads[0].env.HOME, fixture.options.plan.antigravity.accountHome);
  assert.equal(reads[0].cwd, fixture.invocation.cwd);
  await session.close();
  const resumed = agyFixture();
  const again = await resumeAntigravitySession({ ...resumed.options, threadId: resumed.nativeId, readVersion: () => Promise.resolve('1.2.2') });
  assert.equal(again.cliVersion, '1.2.2', 'a resume reports its program too');
  await again.close();
});

test('Antigravity starts unchanged when its version cannot be read, and the record says null', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession({ ...fixture.options, readVersion: () => Promise.resolve(null) });
  assert.equal(session.cliVersion, null);
  assert.deepEqual(fixture.invocation.args, ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--disable-slash-commands', '--print-timeout', '90000s', '--agent', 'toolsenabled-research-only', '--model', 'gemini-fixture-advertised-model', '--effort', 'high']);
  await session.close();
});

test('Antigravity version read: the bare version on success, null for anything else, and a hung read is stopped', async () => {
  const good = fakeVersionProgram({ stdout: '1.2.8\n' });
  assert.equal(await readAntigravityVersion({ command: '/fixture/agy', env: { HOME: '/fixture/home' }, cwd: '/fixture', spawnImpl: good.spawnImpl }), '1.2.8');
  assert.deepEqual(good.calls[0].args, ['--version']);
  assert.deepEqual(good.calls[0].options.stdio, ['ignore', 'pipe', 'ignore'], 'stdin closed; nothing else read');
  assert.deepEqual(good.calls[0].options.env, { HOME: '/fixture/home' });
  assert.equal(await readAntigravityVersion({ spawnImpl: fakeVersionProgram({ stdout: '1.2.8', code: 1 }).spawnImpl }), null, 'a failed read is not a version');
  assert.equal(await readAntigravityVersion({ spawnImpl: fakeVersionProgram({ stdout: 'please sign in\n' }).spawnImpl }), null, 'diagnostic text is not a version');
  assert.equal(await readAntigravityVersion({ spawnImpl: fakeVersionProgram({ error: Object.assign(new Error('refused'), { code: 'HIDDEN_SPAWN_PROVIDER_REFUSED' }) }).spawnImpl }), null);
  const hung = fakeVersionProgram({ hang: true });
  assert.equal(await readAntigravityVersion({ timeoutMs: 20, spawnImpl: hung.spawnImpl }), null);
  assert.equal(hung.calls[0].child.killed, true, 'a read that does not answer is stopped');
});

test('Antigravity cold resume requires the native ID; no synthetic transcript or counter', async () => {
  const fixture = agyFixture();
  const session = await resumeAntigravitySession({ ...fixture.options, threadId: fixture.nativeId });
  assert.deepEqual(fixture.invocation.args.slice(-2), ['--conversation', fixture.nativeId]);
  assert.deepEqual(session.turns, []);
  assert.equal(session.turnCount, undefined);
  await session.close();
  const wrong = agyFixture();
  await assert.rejects(resumeAntigravitySession({ ...wrong.options, threadId: 'different-saved-thread' }), { code: 'AGY_CLI_RESUME_MISMATCH' });
  assert.deepEqual(wrong.writes, []);
});

test('Antigravity duplicate prior result cannot complete a subsequent turn', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const first = session.adapter.sendTurn({ threadId: session.threadId, text: 'first' });
  fixture.step('user_input'); fixture.result(1); await first;
  const second = session.adapter.sendTurn({ threadId: session.threadId, text: 'second' });
  const rejected = assert.rejects(second, { code: 'AGY_CLI_PROTOCOL_INVALID' });
  fixture.result(1);
  await rejected;
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'third' }), { code: 'AGY_CLI_CLOSED' });
  await session.close();
});

test('Antigravity Stop waits for whole-process custody and refuses late output', async () => {
  let confirm;
  const fixture = agyFixture({ cleanup: () => new Promise(resolve => { confirm = resolve; }) });
  const events = [];
  const session = await startAntigravitySession({ ...fixture.options, onEvent: event => events.push(event) });
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  const rejected = assert.rejects(turn, { code: 'AGY_CLI_CLOSED' });
  fixture.step('user_input');
  let stopped = false;
  const stop = session.adapter.interrupt().then(value => { stopped = true; return value; });
  await rejected;
  assert.equal(stopped, false);
  assert.equal(events.some(event => event.type === 'turn_completed'), false);
  fixture.result(1);
  confirm();
  assert.equal((await stop).requiresResume, true);
  assert.deepEqual(events.map(event => event.type), ['turn_accepted', 'turn_completed']);
});

test('Antigravity refuses unsupported effort and images before sending work', async () => {
  const fixture = agyFixture();
  await assert.rejects(startAntigravitySession({ ...fixture.options, threadOptions: { ...fixture.options.threadOptions, effort: 'xhigh' } }), { code: 'ACP_EFFORT_UNAVAILABLE' });
  assert.equal(fixture.invocation, undefined);
  const session = await startAntigravitySession(fixture.options);
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'image', images: [{ url: 'data:image/png;base64,Zml4dHVyZQ==' }] }), { code: 'AGY_CLI_IMAGES_UNSUPPORTED' });
  assert.deepEqual(fixture.writes, []);
  await session.close();
});


test('Antigravity refuses changed registration and foreign MCP server without accepting a successful tool result', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  const refusal = assert.rejects(turn, { code: 'AGY_CLI_BOUNDARY_UNCONFIRMED' });
  fixture.step('user_input');
  fixture.step('tool', { tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'foreign', ToolName: 'read' } } });
  await refusal;
  await session.close();
  const changed = agyFixture();
  fs.writeFileSync(changed.options.plan.antigravity.mcpFile, '{}');
  await assert.rejects(startAntigravitySession(changed.options), { code: 'AGY_CLI_BOUNDARY_UNAVAILABLE' });
  assert.equal(changed.invocation, undefined);
});

test('Antigravity native ERROR tool steps remain errors and an unconfirmed cleanup can be retried', async () => {
  let calls = 0;
  const fixture = agyFixture({ cleanup: async () => { if (++calls === 1) throw new Error('custody pending'); } });
  const events = [];
  const session = await startAntigravitySession({ ...fixture.options, onEvent: event => events.push(event) });
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  fixture.step('user_input');
  fixture.step('tool', { state: 'ERROR', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'toolsenabled-research', ToolName: 'read' } } });
  fixture.result(1); await turn;
  assert.equal(events.find(event => event.type === 'tool_result').status, 'error');
  await assert.rejects(session.close(), /custody pending/);
  await session.close();
  assert.equal(calls, 2);
});

test('Antigravity cannot label a private HOME as independent native authentication or ignore turn settings', async () => {
  const fixture = agyFixture();
  await assert.rejects(startAntigravitySession({ ...fixture.options, env: { TOOLSENABLED_PROVIDER_ISOLATION_ROOT: '/fixture/private' } }), { code: 'AGY_CLI_SHARED_AUTH' });
  assert.equal(fixture.invocation, undefined);
  const session = await startAntigravitySession(fixture.options);
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'do not send', options: { model: 'gemini/antigravity/gemini-other' } }), { code: 'AGY_CLI_OPTIONS_UNSUPPORTED' });
  assert.deepEqual(fixture.writes, []);
  await session.close();
  const { scopedEnvironment, SCOPE_ENV } = require('../../tools/antigravity-mcp-owner-proxy');
  assert.throws(() => scopedEnvironment({}), /Missing Antigravity app session scope/);
  const scope = JSON.parse(fixture.options.plan.env[SCOPE_ENV]);
  delete scope.environment.TOOLSENABLED_AGENT_SESSION_CREDENTIAL;
  assert.throws(() => scopedEnvironment({ [SCOPE_ENV]: JSON.stringify(scope) }));
});

// Regression (review R6, 2026-09-10): provider error results must reach the host
// as typed failures so an exhausted Antigravity allowance is recognizable.
test('Antigravity error results reject with typed codes and keep the conversation usable', async () => {
  const fixture = agyFixture();
  const events = [];
  const session = await startAntigravitySession({ ...fixture.options, onEvent: event => events.push(event) });
  const limited = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  fixture.step('user_input');
  fixture.result(1, { status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model.' });
  await assert.rejects(limited, { code: 'AGY_CLI_RATE_LIMITED' });
  assert.equal(events.some(event => event.type === 'turn_completed'), false, 'the host reports the typed failure; no untyped completion is emitted');
  const generic = session.adapter.sendTurn({ threadId: session.threadId, text: 'again' });
  fixture.step('user_input');
  fixture.result(2, { status: 'ERROR', error: 'The tool dispatcher failed.' });
  await assert.rejects(generic, { code: 'AGY_CLI_TURN_ERROR' });
  const next = session.adapter.sendTurn({ threadId: session.threadId, text: 'third' });
  fixture.step('user_input');
  fixture.result(3);
  assert.equal((await next).status, 'completed');
  await session.close();
});

// Regression (review R9): real activity renews the Antigravity silence limit,
// mirroring the Claude change; a silent turn still times out and is closed.
test('Antigravity productive turns outlive the silence limit while an idle turn still times out', async t => {
  const { AntigravityCliAdapter } = require('../../src/lib/agent-engine/antigravity-cli-adapter');
  const nativeId = 'b7206e0d-b8b0-44cb-9fb7-1b05a454d251';
  let listener;
  let closed = 0;
  const send = value => listener?.(JSON.stringify(value) + '\n');
  const transport = {
    onData(fn) { listener = fn; queueMicrotask(() => send({ event: 'init', conversation_id: nativeId,
      init: { cwd: '/fixture', tools: [], agent: 'fixture-agent', model: 'gemini-fixture', permission_mode: 'request-review' } })); return () => { listener = null; }; },
    write() {},
    async closeForStartupFailure() { closed++; }
  };
  const adapter = new AntigravityCliAdapter({ transport, model: 'gemini-fixture', tools: ['call_mcp_tool'], servers: ['toolsenabled-research'],
    agent: 'fixture-agent', cwd: '/fixture', turnTimeoutMs: 150 });
  const { threadId } = await adapter.startThread();
  // The adapter timer is unref'd; keep the loop alive while a timeout is awaited.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const step = (index, type, data = {}) => send({ event: 'step_update', step_update: { conversation_id: nativeId, step_index: index, state: 'DONE', step_type: type, ...data } });
  const turn = adapter.sendTurn({ threadId, text: 'long work' });
  let outcome;
  turn.then(value => { outcome = value; }, error => { outcome = error; });
  step(0, 'user_input');
  for (let index = 1; index <= 6; index++) {
    await new Promise(resolve => setTimeout(resolve, 60));
    step(index, 'agent_response', { text_delta: `part ${index}` });
    assert.equal(outcome, undefined, 'productive output keeps the original turn');
  }
  send({ event: 'result', result: { conversation_id: nativeId, status: 'SUCCESS', response: 'done', num_turns: 1 } });
  assert.equal((await turn).status, 'completed');
  const idle = adapter.sendTurn({ threadId, text: 'wait' });
  step(7, 'user_input');
  await assert.rejects(idle, { code: 'AGY_CLI_TURN_TIMEOUT' });
  assert.equal(closed, 1, 'the silent turn closes its owned process');
});

// Native agy emits SUCCESS with an empty response when --print-timeout expires,
// even with unfinished work. Its default is five minutes. The process contract
// above must give our own bounded turn custody time to close it first.
test('Antigravity activity cannot renew the absolute turn limit or produce a false completion', async t => {
  const { AntigravityCliAdapter } = require('../../src/lib/agent-engine/antigravity-cli-adapter');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listener;
  let closed = 0;
  const events = [];
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write() {},
    async closeForStartupFailure() { closed++; }
  };
  const adapter = new AntigravityCliAdapter({ transport, model: 'gemini-fixture', tools: [],
    agent: 'fixture-agent', cwd: '/fixture', turnTimeoutMs: 200, maxTurnDurationMs: 100 });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  const send = packet => listener?.(JSON.stringify(packet) + '\n');
  send({ event: 'init', conversation_id: 'absolute-limit-fixture', init: {
    cwd: '/fixture', tools: [], agent: 'fixture-agent', model: 'gemini-fixture', permission_mode: 'request-review'
  } });
  const { threadId } = await adapter.startThread();
  const turn = adapter.sendTurn({ threadId, text: 'bounded long work' });
  const rejected = assert.rejects(turn, { code: 'AGY_CLI_TURN_TIMEOUT' });
  const step = (type, extra = {}) => send({ event: 'step_update', step_update: {
    conversation_id: threadId, step_index: 0, state: 'DONE', step_type: type, ...extra
  } });
  step('user_input');
  t.mock.timers.tick(60);
  step('agent_response', { text_delta: 'still working' });
  t.mock.timers.tick(40);
  assert.equal(adapter.closed, true, 'the absolute timer closes the turn despite recent activity');
  await rejected;
  assert.equal(closed, 1);
  send({ event: 'result', result: { conversation_id: threadId, status: 'SUCCESS', response: '', num_turns: 1 } });
  assert.equal(events.some(event => event.type === 'turn_completed'), false);
});

test('Antigravity legitimate tool-only completion remains a completed turn', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'perform one tool action' });
  fixture.step('user_input');
  fixture.step('tool', { step_index: 1, tool_name: 'call_mcp_tool', tool_info: {
    parameters: { ServerName: 'toolsenabled-research', ToolName: 'read' }, output: 'done'
  } });
  fixture.result(1, { response: '' });
  assert.equal((await turn).status, 'completed');
  await session.close();
});


test('Antigravity one native error_message can recover into a completed turn', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'recover' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, state: 'ACTIVE', duration_seconds: 0 });
  fixture.step('error_message', { step_index: 1, state: 'DONE', duration_seconds: 0 });
  fixture.step('error_message', { step_index: 1, state: 'DONE', duration_seconds: 0 });
  fixture.step('unknown_progress', { step_index: 2 });
  fixture.step('agent_response', { step_index: 3, text_delta: '' });
  fixture.step('agent_response', { step_index: 3, text_delta: 'recovered' });
  fixture.result(1, { response: 'recovered' });
  assert.equal((await turn).status, 'completed');
  await session.close();
});

test('Antigravity counts distinct error step indexes and ignores empty deltas', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'count' });
  const rejected = assert.rejects(turn, { code: 'AGY_CLI_TURN_ERROR' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, state: 'ACTIVE', duration_seconds: 0 });
  fixture.step('error_message', { step_index: 1, state: 'DONE', duration_seconds: 0 });
  fixture.step('agent_response', { step_index: 2, text_delta: '' });
  fixture.step('error_message', { step_index: 3, duration_seconds: 0 });
  await rejected;
  await session.close();
});

test('Antigravity repeated error_message closes and uses identity-checked native ERROR from cleanup', async () => {
  const fixture = agyFixture({
    cleanup: async () => {
      fixture.send({ event: 'result', result: {
        conversation_id: fixture.nativeId, status: 'ERROR', response: '', num_turns: 1,
        error: 'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. 429 resets in 111 hours.'
      } });
    }
  });
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'quota' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  const rejected = assert.rejects(turn, { code: 'AGY_CLI_RATE_LIMITED' });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await rejected;
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'must not send' }), { code: 'AGY_CLI_CLOSED' });
  fixture.send({ event: 'result', result: { conversation_id: 'foreign-conversation', status: 'SUCCESS', response: 'late', num_turns: 1 } });
  fixture.result(1, { status: 'SUCCESS', response: 'must not complete' });
  await session.close();
});

test('Antigravity a prior result number cannot supply quota detail for the closing turn', async () => {
  const fixture = agyFixture({
    cleanup: async () => {
      fixture.send({ event: 'result', result: {
        conversation_id: fixture.nativeId, status: 'ERROR', response: '', num_turns: 1,
        error: 'RESOURCE_EXHAUSTED: stale prior turn 429'
      } });
    }
  });
  const session = await startAntigravitySession(fixture.options);
  const first = session.adapter.sendTurn({ threadId: session.threadId, text: 'first' });
  fixture.step('user_input');
  fixture.result(1);
  await first;
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'second' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await assert.rejects(turn, error => {
    assert.equal(error.code, 'AGY_CLI_TURN_ERROR');
    assert.doesNotMatch(error.message, /quota|429|RESOURCE_EXHAUSTED/i);
    return true;
  });
  await session.close();
});

test('Antigravity repeated error_message without a terminal result is a generic failure', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'silent-errors' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await assert.rejects(turn, error => {
    assert.equal(error.code, 'AGY_CLI_TURN_ERROR');
    assert.doesNotMatch(error.message, /quota|429|RESOURCE_EXHAUSTED|111 hours/i);
    return true;
  });
  await session.close();
});

test('Antigravity repeated-error cleanup failure can be retried and late packets cannot complete a later turn', async () => {
  let calls = 0;
  const fixture = agyFixture({ cleanup: async () => { if (++calls === 1) throw new Error('custody pending'); } });
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await assert.rejects(turn, { code: 'AGY_CLI_TURN_ERROR' });
  assert.equal(calls, 1, 'the first close attempt is the owned-process cleanup');
  await session.close();
  assert.equal(calls, 2);
  await assert.rejects(session.adapter.sendTurn({ threadId: session.threadId, text: 'after-close' }), { code: 'AGY_CLI_CLOSED' });
});

test('Antigravity parent exit before delayed custody keeps the original repeated-error cause', async () => {
  let confirm;
  const fixture = agyFixture({ cleanup: () => new Promise(resolve => { confirm = resolve; }) });
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  let settled;
  turn.then(value => { settled = value; }, error => { settled = error; });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await Promise.resolve();
  assert.equal(settled, undefined, 'parent exit is not process-tree custody');
  fixture.exit();
  await Promise.resolve();
  assert.equal(settled, undefined);
  confirm();
  await assert.rejects(turn, error => {
    assert.equal(error.code, 'AGY_CLI_TURN_ERROR');
    assert.notEqual(error.code, 'AGY_CLI_EXITED');
    return true;
  });
  await session.close();
});

test('Antigravity native ERROR after an absolute timeout does not relabel the timeout', async t => {
  const { AntigravityCliAdapter } = require('../../src/lib/agent-engine/antigravity-cli-adapter');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listener;
  let confirm;
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write() {},
    closeForStartupFailure: () => new Promise(resolve => { confirm = resolve; })
  };
  const adapter = new AntigravityCliAdapter({ transport, model: 'gemini-fixture', tools: [],
    agent: 'fixture-agent', cwd: '/fixture', turnTimeoutMs: 80, maxTurnDurationMs: 100 });
  const send = packet => listener?.(JSON.stringify(packet) + '\n');
  send({ event: 'init', conversation_id: 'timeout-refine-fixture', init: {
    cwd: '/fixture', tools: [], agent: 'fixture-agent', model: 'gemini-fixture', permission_mode: 'request-review'
  } });
  const { threadId } = await adapter.startThread();
  const turn = adapter.sendTurn({ threadId, text: 'bounded' });
  send({ event: 'step_update', step_update: { conversation_id: threadId, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  const rejected = assert.rejects(turn, { code: 'AGY_CLI_TURN_TIMEOUT' });
  t.mock.timers.tick(120);
  send({ event: 'result', result: {
    conversation_id: threadId, status: 'ERROR', response: '', num_turns: 1,
    error: 'RESOURCE_EXHAUSTED: 429 must not replace timeout'
  } });
  confirm();
  await rejected;
  await adapter.close();
});

test('Antigravity Stop after repeated-error cleanup starts waits for custody and wins', async () => {
  let confirm;
  const fixture = agyFixture({ cleanup: () => new Promise(resolve => { confirm = resolve; }) });
  const events = [];
  const session = await startAntigravitySession({ ...fixture.options, onEvent: event => events.push(event) });
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'work' });
  let settled;
  turn.then(value => { settled = value; }, error => { settled = error; });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1, duration_seconds: 0 });
  fixture.step('error_message', { step_index: 2, duration_seconds: 0 });
  await Promise.resolve();
  let stopped = false;
  const stop = session.adapter.interrupt().then(value => { stopped = true; return value; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(settled, undefined, 'Stop does not finish the turn before custody');
  fixture.result(1, { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: 429' });
  confirm();
  await assert.rejects(turn, { code: 'AGY_CLI_CLOSED' });
  assert.equal((await stop).requiresResume, true);
  assert.equal(events.filter(event => event.type === 'turn_completed').length, 1);
  assert.equal(events.find(event => event.type === 'turn_completed').status, 'interrupted');
});

test('Antigravity delayed duplicate error after productive output does not spend a new retry', async () => {
  const fixture = agyFixture();
  const session = await startAntigravitySession(fixture.options);
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'recover with reordered updates' });
  turn.catch(() => {});
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 1 });
  fixture.step('agent_response', { step_index: 2, text_delta: 'Recovered.' });
  fixture.step('error_message', { step_index: 1 });
  fixture.step('error_message', { step_index: 3 });
  fixture.step('agent_response', { step_index: 4, text_delta: 'Recovered again.' });
  fixture.result(1);
  try { assert.equal((await turn).status, 'completed'); }
  finally { await session.close(); }
});

test('Antigravity resumed first turn accepts the native cumulative error counter during cleanup', async () => {
  const fixture = agyFixture({ cleanup: async () => fixture.result(8, { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: 429' }) });
  const session = await resumeAntigravitySession({ ...fixture.options, threadId: fixture.nativeId });
  const turn = session.adapter.sendTurn({ threadId: session.threadId, text: 'resume work' });
  fixture.step('user_input');
  fixture.step('error_message', { step_index: 21 });
  fixture.step('error_message', { step_index: 22 });
  try { await assert.rejects(turn, { code: 'AGY_CLI_RATE_LIMITED' }); }
  finally { await session.close(); }
});
