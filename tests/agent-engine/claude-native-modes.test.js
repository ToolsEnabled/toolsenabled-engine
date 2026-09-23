'use strict';
const assert = require('node:assert/strict');
const { ClaudeCliAdapter } = require('../../src/lib/agent-engine/claude-cli-adapter');
const id = '7cf7c88e-6912-4388-a181-78aef262c494';
function fixture(policy = { initialMode: 'acceptEdits', allowedModes: ['plan', 'default', 'acceptEdits'] }) {
  let receive; const sent = [];
  const adapter = new ClaudeCliAdapter({ modePolicy: policy, modeTimeoutMs: 20,
    transport: { onData(fn) { receive = fn; }, send(p) { sent.push(p); }, close() {} } });
  adapter.threadId = id;
  return { adapter, sent, receive: p => receive(p), ack(mode, subtype = 'success', requestId = sent.at(-1)?.request_id) {
    receive({ type: 'control_response', response: { request_id: requestId, subtype, response: { mode } } });
  } };
}
const code = value => error => error.code === value;
async function run() {
  for (const policy of [{initialMode:'plan',allowedModes:['plan','default']},
      {initialMode:'default',allowedModes:['acceptEdits']},
      {initialMode:'default',allowedModes:['bypassPermissions']},
      {initialMode:'acceptEdits',allowedModes:['bypassPermissions']},
      {initialMode:'auto',allowedModes:['auto']}, {initialMode:'default',allowedModes:[]}]) {
    assert.throws(() => fixture(policy), code('CLAUDE_MODE_POLICY_INVALID'));
  }
  {
    let f;
    assert.doesNotThrow(() => { f = fixture({ initialMode: 'bypassPermissions',
      allowedModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'] }); },
    'An Unrestricted launch retains every supported mode within its original ceiling');
    const a = f.adapter;
    try {
      assert.equal(a.getSessionModes(id).currentModeId, null, 'launch intent is not provider confirmation');
      assert.deepEqual(a.getSessionModes(id).availableModes.map(mode => mode.name),
        ['Plan', 'Default', 'Accept edits', 'Unrestricted']);
      f.receive({ type: 'system', subtype: 'status', session_id: id, permissionMode: 'bypassPermissions' });
      assert.equal(a.getSessionModes(id).currentModeId, 'bypassPermissions');
      for (const mode of ['plan', 'acceptEdits']) {
        const selecting = a.selectMode(id, mode);
        assert.deepEqual(f.sent.at(-1).request, { subtype: 'set_permission_mode', mode });
        f.ack(mode);
        assert.equal((await selecting).currentModeId, mode);
      }
      const refused = a.selectMode(id, 'bypassPermissions'); f.ack('bypassPermissions', 'error');
      await assert.rejects(refused, code('CLAUDE_MODE_REFUSED'));
      assert.equal(a.getSessionModes(id).currentModeId, 'acceptEdits', 'refusal preserves the confirmed mode');
      const restore = a.selectMode(id, 'bypassPermissions');
      assert.equal(a.getSessionModes(id).currentModeId, 'acceptEdits', 'return waits for its exact ACK');
      f.ack('bypassPermissions', 'success', 'unrelated');
      assert.equal(a.getSessionModes(id).currentModeId, 'acceptEdits');
      f.ack('bypassPermissions');
      assert.equal((await restore).currentModeId, 'bypassPermissions');
      assert.equal(a.getSessionModes(id).currentModeId, 'bypassPermissions');
    } finally { a.close(); }
  }
  {
    const f = fixture(null);
    assert.equal(f.adapter.getSessionModes(id), null);
    await assert.rejects(f.adapter.selectMode(id,'plan'), code('CLAUDE_MODE_NOT_ALLOWED'));
    assert.equal(f.sent.length,0); f.adapter.close();
  }
  {
    const f=fixture(); const a=f.adapter;
    assert.equal(a.getSessionModes(id).currentModeId,null);
    assert.deepEqual(a.getSessionModes(id).availableModes.map(m=>m.id),['plan','default','acceptEdits']);
    assert.equal(a.getSessionModes('other'),null);
    for (const m of ['bypassPermissions','auto','manual','invented']) {
      await assert.rejects(a.selectMode(id,m),code('CLAUDE_MODE_NOT_ALLOWED'));
    }
    await assert.rejects(a.selectMode('other','plan'),code('CLAUDE_CLI_INVALID_THREAD'));
    assert.equal(f.sent.length,0);
    const selection=a.selectMode(id,'plan');
    assert.deepEqual(f.sent[0].request,{subtype:'set_permission_mode',mode:'plan'});
    assert.equal(a.getSessionModes(id).currentModeId,null);
    await assert.rejects(a.selectMode(id,'default'),code('CLAUDE_MODE_BUSY'));
    await assert.rejects(a.sendTurn({threadId:id,text:'must wait'}),code('CLAUDE_MODE_UNCONFIRMED'));
    f.ack('plan','success','unrelated');
    assert.equal(a.getSessionModes(id).currentModeId,null);
    f.ack('plan');
    assert.equal((await selection).currentModeId,'plan');
    assert.equal(a.getSessionModes(id).currentModeId,'plan');
    const refused=a.selectMode(id,'default'); f.ack('default','error');
    await assert.rejects(refused,code('CLAUDE_MODE_REFUSED'));
    assert.equal(a.getSessionModes(id).currentModeId,'plan');
    const restore=a.selectMode(id,'acceptEdits');f.ack('acceptEdits');await restore;
    const turn=a.sendTurn({threadId:id,text:'local simulated user'});
    await assert.rejects(a.selectMode(id,'plan'),code('CLAUDE_MODE_BUSY'));
    f.receive({type:'result',subtype:'success',session_id:id,result:'fixture'});
    await turn;
    f.receive({type:'system',subtype:'status',session_id:id,permissionMode:'manual'});
    assert.equal(a.getSessionModes(id).currentModeId,'default');
    f.receive({type:'system',subtype:'status',session_id:'other',permissionMode:'plan'});
    assert.equal(a.getSessionModes(id).currentModeId,'default');
    a.close();assert.equal(a.getSessionModes(id),null);
    await assert.rejects(a.selectMode(id,'plan'),code('CLAUDE_CLI_CLOSED'));
  }
  for (const reply of [undefined,'default']) {
    const f=fixture();const pending=f.adapter.selectMode(id,'plan');f.ack(reply);
    await assert.rejects(pending,code('CLAUDE_MODE_UNCONFIRMED'));
    assert.equal(f.adapter.getSessionModes(id).currentModeId,null);
    await assert.rejects(f.adapter.sendTurn({threadId:id,text:'wait'}),code('CLAUDE_MODE_UNCONFIRMED'));
    const retry=f.adapter.selectMode(id,'plan');f.ack('plan');await retry;f.adapter.close();
  }
  {
    const f=fixture();const pending=f.adapter.selectMode(id,'plan');f.ack('plan');
    f.receive({type:'system',subtype:'status',session_id:id,permissionMode:'default'});
    await assert.rejects(pending,code('CLAUDE_MODE_UNCONFIRMED'));f.adapter.close();
  }
  {
    const f=fixture();await assert.rejects(f.adapter.selectMode(id,'plan'),code('CLAUDE_MODE_TIMEOUT'));
    f.ack('plan');assert.equal(f.adapter.getSessionModes(id).currentModeId,null);
    assert.equal(f.adapter.pendingControl.size,0);f.adapter.close();
  }
  {
    const f=fixture();const pending=f.adapter.selectMode(id,'plan');f.adapter.close();
    await assert.rejects(pending,code('CLAUDE_CLI_CLOSED'));
  }

  {
    const f=fixture();const pending=f.adapter.selectMode(id,'plan');f.ack('plan');
    f.adapter.threadId='changed';
    await assert.rejects(pending,code('CLAUDE_MODE_UNCONFIRMED'));f.adapter.close();
  }
  {
    const f=fixture();const pending=f.adapter.selectMode(id,'plan');f.ack('plan');f.adapter.close();
    await assert.rejects(pending,code('CLAUDE_MODE_UNCONFIRMED'));
  }
  for (const modeTimeoutMs of [0,-1,60001,Infinity]) {
    assert.throws(()=>new ClaudeCliAdapter({modeTimeoutMs,transport:{send(){},onData(){}}}),TypeError);
  }
  console.log('Claude native mode behavioral checks GREEN');
}
const keepAlive=setTimeout(()=>{console.error('FAIL: behavioral checks did not complete');process.exitCode=1;},2000);
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(keepAlive));
