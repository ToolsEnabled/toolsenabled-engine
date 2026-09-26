'use strict';
const isolated = require('./lib/isolated-environment').activate('linux-credential-prompt');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { spawnLinuxOwned } = require('../src/lib/linux-process-control');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
const adapter = require('../src/lib/owner-prompt-platform');
const item = { kind: 'credential', label: 'Fixture credential', vaultKey: 'custom.fixture', requester: 'unattributed',
  requestContext: { purpose: 'Verify private input', scope: 'Isolated fixture only', lifetime: 'Until fixture ends' } };

test('native input uses bounded private public metadata, strict safe results and a scrubbed environment', () => {
  for (const platform of ['linux', 'win32']) {
    const calls = [];
    const ui = adapter.createUI({ platform, environment: { DISPLAY: ':fixture', NODE_OPTIONS: '--require=bad', PYTHONPATH: '/bad', LD_PRELOAD: '/bad' },
      execute(command, args, options) {
        const file = args[args.indexOf('-InputFile') + 1] || args.at(-1);
        const actual = platform === 'win32' ? file : args.at(-1);
        const payload = JSON.parse(fs.readFileSync(actual, 'utf8'));
        assert.equal(fs.statSync(actual).mode & 0o777, 0o600);
        assert.equal(Object.hasOwn(payload, 'value'), false);
        assert.match(payload.message, /Not established/);
        assert.equal(options.shell, false);
        for (const key of ['NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD']) assert.equal(options.env[key], undefined);
        calls.push({ command, args, payload, actual });
        return { status: 0, stdout: JSON.stringify({ ok: true, outcome: payload.mode === 'start' ? 'begin' : 'completed' }) };
      } });
    assert.equal(ui.begin(1, item), true);
    assert.equal(ui.capture(item), 'completed');
    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(fs.existsSync(call.actual), false);
    if (platform === 'linux') assert.deepEqual(calls[0].args.slice(0, 2), ['-I', '-B']);
    else { assert.match(calls[0].command, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/); assert.ok(calls[0].args.includes('-ParentPid')); }
  }
  for (const result of [{ status: 0, stdout: '{"ok":true,"outcome":"completed","value":"forbidden"}' },
    { status: 1, stdout: '{"ok":true,"outcome":"completed"}' }, { status: 0, stdout: 'completed' },
    { status: 0, error: { code: 'ETIMEDOUT' }, stdout: '{"ok":true,"outcome":"completed"}' }]) {
    assert.throws(() => adapter.createUI({ execute: () => result }).capture(item), { code: 'OWNER_PROMPT_RUNNER_UNAVAILABLE' });
  }
  const cardItem = { ...item, kind: 'payment_card', vaultKey: 'payment_card_default' };
  for (const status of ['created', 'updated']) {
    const ui = adapter.createUI({ platform: 'linux', execute: () => ({ status: 0,
      stdout: JSON.stringify({ ok: true, outcome: 'completed', recordStatus: status }) }) });
    assert.equal(ui.capture(cardItem), 'completed', 'shared queue continues to receive only the outcome');
    const value = require('../src/lib/vault-linux').nativePrompt({ mode: 'capture', kind: 'payment_card' },
      { execute: () => ({ status: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', recordStatus: status }) }) });
    assert.deepEqual(value, { ok: true, outcome: 'completed', recordStatus: status });
  }
  for (const value of [{ ok: true, outcome: 'completed' }, { ok: true, outcome: 'completed', recordStatus: 'unknown' },
    { ok: true, outcome: 'cancelled', recordStatus: 'created' },
    { ok: true, outcome: 'completed', recordStatus: 'created', cardNumber: 'must-not-cross' }]) {
    assert.throws(() => adapter.createUI({ platform: 'linux', execute: () => ({ status: 0, stdout: JSON.stringify(value) }) })
      .capture(cardItem), { code: 'OWNER_PROMPT_RUNNER_UNAVAILABLE' });
  }
  const linuxVault = require('../src/lib/vault-linux');
  let nativeCalls = 0;
  assert.throws(() => linuxVault.capturePaymentCard({ environment: {}, execute() { nativeCalls++; } }),
    { code: 'CREDENTIAL_INTERACTION_REQUIRED' });
  assert.equal(nativeCalls, 0, 'a missing desktop never starts a card form');
  for (const outcome of ['completed', 'cancelled', 'timeout', 'deferred']) {
    assert.deepEqual(linuxVault.capturePaymentCard({ environment: { DISPLAY: ':fixture' }, execute(command, args) {
      const payload = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
      assert.equal(payload.kind, 'payment_card'); assert.equal(payload.key, 'payment_card_default');
      return { status: 0, stdout: JSON.stringify({ ok: true, outcome, ...(outcome === 'completed' ? { recordStatus: 'updated' } : {}) }) };
    } }), { key: 'payment_card_default', status: outcome === 'completed' ? 'updated' : outcome === 'deferred' ? 'in_progress' : outcome });
  }
  if (process.platform === 'linux') {
    const runtime = require('../src/lib/runtime'), filename = require.resolve('../src/lib/vault-linux');
    const original = require.cache[filename].exports;
    let response = { key: 'payment_card_default', status: 'updated' }, calls = 0;
    require.cache[filename].exports = { ...original, capturePaymentCard() { calls++; return response; } };
    try {
      assert.deepEqual(runtime.capturePaymentCard(), { key: 'payment_card_default', status: 'updated' });
      response = { key: 'payment_card_default', status: 'cancelled' };
      assert.throws(() => runtime.capturePaymentCard(), { code: 'CREDENTIAL_CAPTURE_CANCELLED' });
      response = { key: 'payment_card_default', status: 'timeout' };
      assert.throws(() => runtime.capturePaymentCard(), { code: 'CREDENTIAL_INTERACTION_REQUIRED' });
      response = { key: 'payment_card_default', status: 'in_progress' };
      assert.throws(() => runtime.capturePaymentCard(), { code: 'CREDENTIAL_CAPTURE_IN_PROGRESS' });
      assert.throws(() => runtime.capturePaymentCard('custom.invalid'), { code: 'PAYMENT_METHOD_CAPTURE_UNSUPPORTED' });
      assert.equal(calls, 4);
    } finally { require.cache[filename].exports = original; }
  }
  for (const outcome of ['cancelled', 'timeout', 'deferred']) {
    assert.equal(adapter.createUI({ execute: () => ({ status: 0, stdout: JSON.stringify({ ok: true, outcome }) }) }).capture(item), outcome);
  }
});

test('native Save integrates with a disposable encrypted GNOME vault and the production runtime reader',
  { skip: process.platform !== 'linux', timeout: 60000 }, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'linux-vault.test.js'), '--components',
      'tests/lib/linux-credential-vault-case.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, timeout: 55000, maxBuffer: 16384 });
    assert.equal(result.status, 0, 'the private keyring fixture and actual credential/card Save bridge must complete');
    assert.match(result.stdout, /PASS native credential Save uses production encryption/);
    assert.match(result.stdout, /PASS native payment card version3 save\/update and hygiene/);
  });

test('Linux payment-card entry is available and validates the same bounded version3 card contract', () => {
  assert.doesNotThrow(() => adapter.assertAvailable({ platform: 'linux', environment: { DISPLAY: ':fixture' }, kind: 'payment_card' }));
  assert.deepEqual(adapter.createUI({ platform: 'linux' }).supportedKinds, ['credential', 'payment_card']);
  const source = `import importlib.util,datetime,json\ns=importlib.util.spec_from_file_location('vault',${JSON.stringify(path.resolve(__dirname, '../src/linux-vault.py'))})\nv=importlib.util.module_from_spec(s);s.loader.exec_module(v)\nf={'given_name':'  Fixture   Owner ','family_name':'Example','card_number':'4242 4242 4242 4242','expiration':'12/29','postal_code':' 12345 '}\nr=v.normalize_payment_card(f,today=datetime.date(2026,9,13))\nassert r=={'version':3,'cardholder':{'givenName':'Fixture Owner','familyName':'Example'},'cardholderName':'Fixture Owner Example','cardNumber':'4242424242424242','expMonth':12,'expYear':2029,'postalCode':'12345'}\nfor field,value in [('card_number','4242 4242 4242 4241'),('card_number','42'),('expiration','08/26'),('expiration','13/29'),('given_name',''),('family_name','x'*161),('postal_code','x'*33)]:\n bad=dict(f);bad[field]=value\n try:v.normalize_payment_card(bad,today=datetime.date(2026,9,13));raise AssertionError('invalid card accepted')\n except v.Refusal as e:assert e.code=='SECRET_PAYMENT_CARD_INVALID'\nfor record in [dict(r,cvc='000'),dict(r,version=2),dict(r,unknown='field')]:\n try:v.validate_payment_card(record);raise AssertionError('invalid record accepted')\n except v.Refusal as e:assert e.code=='SECRET_PAYMENT_CARD_INVALID'\n# Expiry prevents new capture, but an expired stored card remains hygienic.\nv.validate_payment_card(dict(r,expYear=2000))\nfor action in ['set-many','capture-payment-card']:\n try:v.validate_request({'action':action,'file':'/never-opened','entries':[{'key':'payment_card_default','value':json.dumps(r)}]});raise AssertionError('generic protected write accepted')\n except v.Refusal as e:assert e.code in {'SECRET_ACCESS_DENIED','SECRET_INPUT_INVALID'}\nprint('PASS fixed card validation and generic protected-write refusal')`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', source], { encoding: 'utf8', shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  assert.equal(result.status, 0, 'card validation and all invalid/expired/extra-field controls must pass');
  assert.equal(result.stdout.trim(), 'PASS fixed card validation and generic protected-write refusal');
  assert.equal(result.stderr, '');
});

function authority(number, cookie) {
  const field = data => { const size = Buffer.alloc(2); size.writeUInt16BE(data.length); return Buffer.concat([size, data]); };
  return Buffer.concat([Buffer.from([255, 255]), field(Buffer.alloc(0)), field(Buffer.from(number)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}
test('real isolated Linux controls save only on explicit Save; cancellation, timeout and parent exit never save',
  { skip: process.platform !== 'linux', timeout: 100000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-native-'));
    const children = [], env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
    let failed;
    const launch = (command, args, terminateDescendantsOnRootExit = true) => {
      const child = spawnLinuxOwned(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], terminateDescendantsOnRootExit }, { safeLaunchEnvironment });
      child.on('error', () => {}); child.stderr.resume(); children.push(child); return child;
    };
    const cookie = randomBytes(16), serverAuth = path.join(directory, 'server.auth');
    fs.writeFileSync(serverAuth, authority('', cookie), { flag: 'wx', mode: 0o600 });
    try {
      const server = launch('/usr/bin/Xvfb', ['-displayfd', '1', '-screen', '0', '900x700x24', '-nolisten', 'tcp', '-noreset', '-auth', serverAuth]);
      await server.jobReady;
      const reader = createInterface({ input: server.stdout });
      const number = (await reader[Symbol.asyncIterator]().next()).value; assert.match(number, /^[0-9]{1,5}$/);
      const clientAuth = path.join(directory, 'client.auth'); fs.writeFileSync(clientAuth, authority(number, cookie), { mode: 0o600 });
      Object.assign(env, { DISPLAY: ':' + number, XAUTHORITY: clientAuth, XDG_SESSION_TYPE: 'x11' });
      const xdo = args => new Promise(resolve => execFile('/usr/bin/xdotool', args, { env, encoding: 'utf8', timeout: 7000 },
        (error, stdout) => resolve({ status: error ? error.code : 0, stdout })));
      // The queue is not the only caller. Two native input processes targeting
      // the same vault must share one capture-lifetime lock across both kinds.
      const lockVault = path.join(isolated.root, 'never-written-lock-vault.json');
      const lockTitle = 'Capture lifetime ' + randomBytes(8).toString('hex');
      const startCapture = (kind, title) => {
        const filename = path.join(directory, title + '.json');
        fs.writeFileSync(filename, JSON.stringify({ mode: 'capture', title, label: item.label,
          message: adapter.publicMessage(item), key: kind === 'payment_card' ? 'payment_card_default' : item.vaultKey,
          kind, count: 1, timeoutSeconds: 15, vaultFile: lockVault }), { mode: 0o600 });
        const child = launch('/usr/bin/python3', ['-I', '-B', adapter.PYTHON, filename]);
        let output = ''; child.stdout.on('data', chunk => { output += chunk; });
        return { child, result: () => JSON.parse(output) };
      };
      const firstCapture = startCapture('payment_card', lockTitle);
      await firstCapture.child.jobReady;
      const firstWindow = await xdo(['search', '--sync', '--onlyvisible', '--name', '^' + lockTitle + '$']);
      assert.equal(firstWindow.status, 0);
      const overlapping = startCapture('credential', lockTitle + ' second');
      await overlapping.child.jobReady;
      let lockTimer;
      const overlappingClose = await Promise.race([overlapping.child.jobClosed,
        new Promise((_, reject) => { lockTimer = setTimeout(() => reject(new Error('overlapping native capture did not defer')), 4000); })])
        .finally(() => clearTimeout(lockTimer));
      assert.equal(overlappingClose.failure, null);
      assert.deepEqual(overlapping.result(), { ok: true, outcome: 'deferred' });
      assert.equal((await xdo(['search', '--onlyvisible', '--name', '^' + lockTitle + '$'])).status, 0);
      await xdo(['windowfocus', '--sync', firstWindow.stdout.trim()]); await xdo(['key', 'Escape']);
      assert.equal((await firstCapture.child.jobClosed).failure, null);
      assert.deepEqual(firstCapture.result(), { ok: true, outcome: 'cancelled' });
      const afterRelease = startCapture('credential', lockTitle + ' released');
      await afterRelease.child.jobReady;
      const releasedWindow = await xdo(['search', '--sync', '--onlyvisible', '--name', '^' + lockTitle + ' released$']);
      assert.equal(releasedWindow.status, 0, 'closing the first capture releases its kernel lifetime lock');
      await xdo(['windowfocus', '--sync', releasedWindow.stdout.trim()]); await xdo(['key', 'Return']);
      assert.equal((await afterRelease.child.jobClosed).failure, null);
      assert.deepEqual(afterRelease.result(), { ok: true, outcome: 'cancelled' });
      assert.equal(fs.existsSync(lockVault), false, 'overlap/cancel never stores a card or credential');
      for (const kind of ['credential', 'payment_card']) for (const action of ['save', 'cancel-filled', 'escape-filled', 'default', 'empty-save', 'timeout', 'parent-exit', ...(kind === 'payment_card' ? ['bad-card', 'expired', 'prefill-save'] : [])]) {
        const title = (kind === 'payment_card' ? 'Payment fixture ' : 'Credential fixture ') + randomBytes(8).toString('hex');
        const payload = { mode: 'capture', title, label: item.label, message: adapter.publicMessage(item), key: kind === 'payment_card' ? 'payment_card_default' : item.vaultKey, kind, count: 1,
          timeoutSeconds: 5, vaultFile: path.join(isolated.root, 'never-written-vault.json') };
        const file = path.join(directory, kind + '-' + action + '.json'); fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
        // Only the vault mutation boundary is replaced; these are the real GTK
        // controls and input/lifetime implementation. No keyring is accessed.
        const expected = kind === 'payment_card' ? { version: 3, cardholder: { givenName: 'Fixture', familyName: 'Owner' },
          cardholderName: 'Fixture Owner', cardNumber: '4242424242424242', expMonth: 12, expYear: new Date().getFullYear() + 3, postalCode: '12345' } : 'synthetic fixture only';
        const layoutFile = path.join(directory, kind + '-' + action + '-geometry.json');
        // Observe native widget geometry before input, then use real X11
        // clicks/typing. No response, validation, widget or dialog is mocked.
        const layoutProbe = kind !== 'payment_card' ? '' : `\nreal_loader=m.C.CDLL\ngtk=real_loader('libgtk-3.so.0');widgets=[]\nnew=gtk.gtk_entry_new;new.restype=m.C.c_void_p\nrun=gtk.gtk_dialog_run;run.argtypes=[m.C.c_void_p];run.restype=m.C.c_int\ndef entry_new():\n w=new();widgets.append(w);return w\ndef dialog_run(dialog):\n translate=gtk.gtk_widget_translate_coordinates;translate.argtypes=[m.C.c_void_p,m.C.c_void_p,m.C.c_int,m.C.c_int,m.C.POINTER(m.C.c_int),m.C.POINTER(m.C.c_int)]\n width=gtk.gtk_widget_get_allocated_width;width.argtypes=[m.C.c_void_p];width.restype=m.C.c_int\n height=gtk.gtk_widget_get_allocated_height;height.argtypes=[m.C.c_void_p];height.restype=m.C.c_int\n points=[]\n for w in widgets:\n  x=m.C.c_int();y=m.C.c_int();assert translate(w,dialog,0,0,m.C.byref(x),m.C.byref(y))\n  points.append([x.value+width(w)//2,y.value+height(w)//2])\n with open(${JSON.stringify(layoutFile)},'x') as f:json.dump(points,f)\n return run(dialog)\nclass ObservedGtk:\n def __getattr__(self,name):return entry_new if name=='gtk_entry_new' else dialog_run if name=='gtk_dialog_run' else getattr(gtk,name)\nm.C.CDLL=lambda name:ObservedGtk() if name=='libgtk-3.so.0' else real_loader(name)\n`;
        const prefillProbe = action === 'prefill-save' ? `\nload=m.load_vault\ndef with_identity():\n v=load();v.owner_identity_for_payment_prompt=lambda file:{'givenName':'Fixture','familyName':'Owner'};return v\nm.load_vault=with_identity\n` : '';
        const source = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('prompt',${JSON.stringify(adapter.PYTHON)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${layoutProbe}${prefillProbe}\ncalls=[]\ndef save(file,key,value):\n calls.append(file==${JSON.stringify(payload.vaultFile)} and key==${JSON.stringify(payload.key)} and value==${JSON.stringify(expected)})\n return {'status':'created'}\nresult=m.prompt(m.load_payload(sys.argv[1]),save)\nprint(json.dumps({'outcome':result,'saved':calls}))`;
        const wrapper = `const cp=require('node:child_process');const r=cp.spawnSync('/usr/bin/python3',['-I','-B','-c',${JSON.stringify(source)},${JSON.stringify(file)}],{encoding:'utf8',env:process.env,stdio:['ignore','pipe','ignore']});if(r.stdout)process.stdout.write(r.stdout);process.exitCode=r.status||0;`;
        const child = launch(process.execPath, ['-e', wrapper], action !== 'parent-exit'); const identity = await child.jobReady;
        let output = ''; child.stdout.on('data', data => { output += data; });
        const found = await xdo(['search', '--sync', '--onlyvisible', '--name', '^' + title + '$']);
        assert.equal(found.status, 0, action + ': native window must open');
        const windows = found.stdout.trim().split(/\s+/); assert.equal(windows.length, 1); const window = windows[0];
        const geometry = await xdo(['getwindowgeometry', '--shell', window]);
        const width = Number(/^WIDTH=(\d+)$/m.exec(geometry.stdout)[1]), height = Number(/^HEIGHT=(\d+)$/m.exec(geometry.stdout)[1]);
        assert.equal((await xdo(['windowfocus', '--sync', window])).status, 0);
        if (action === 'parent-exit') process.kill(identity.rootPid, 'SIGKILL');
        else if (action === 'default') await xdo(['key', 'Return']);
        else if (action !== 'timeout') {
          if (action !== 'empty-save') {
            if (kind === 'payment_card') {
              const points = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
              assert.equal(points.length, 5, 'the native card form must have exactly the five public fields, no security-code field');
              const values = ['Fixture', 'Owner', action === 'bad-card' ? '4242424242424241' : '4242424242424242',
                action === 'expired' ? '01/00' : '12/' + String(expected.expYear), '12345'];
              for (let index = action === 'prefill-save' ? 2 : 0; index < points.length; index++) {
                await xdo(['mousemove', '--window', window, ...points[index].map(String), 'click', '1']);
                await xdo(['type', '--clearmodifiers', '--delay', '1', values[index]]);
              }
            } else {
              await xdo(['mousemove', '--window', window, '120', String(height - 74), 'click', '1']);
              await xdo(['type', '--clearmodifiers', '--delay', '1', 'synthetic fixture only']);
            }
          }
          if (action === 'escape-filled') await xdo(['key', 'Escape']);
          else await xdo(['mousemove', '--window', window, String(width - (action === 'cancel-filled' ? 190 : 72)), String(height - 20), 'click', '1']);
          if (['empty-save', 'bad-card', 'expired'].includes(action)) {
            assert.equal((await xdo(['search', '--onlyvisible', '--name', '^' + title + '$'])).status, 0, 'invalid or incomplete Save remains disabled');
            await xdo(['key', 'Escape']);
          }
        }
        let lifetimeTimer;
        const closed = await (action === 'parent-exit' ? Promise.race([child.jobClosed, new Promise((_, reject) => { lifetimeTimer = setTimeout(() => reject(new Error('native parent-death closure failed')), 3000); })]).finally(() => clearTimeout(lifetimeTimer)) : child.jobClosed);
        assert.equal(closed.failure, null, action);
        if (action !== 'parent-exit') {
          const value = JSON.parse(output);
          assert.equal(value.outcome, ['save', 'prefill-save'].includes(action) ? 'completed' : action === 'timeout' ? 'timeout' : 'cancelled', action);
          assert.deepEqual(value.saved, ['save', 'prefill-save'].includes(action) ? [true] : [], action + ': only explicit Save calls the custody boundary');
        }
        assert.notEqual((await xdo(['search', '--onlyvisible', '--name', '^' + title + '$'])).status, 0);
        assert.equal(fs.existsSync(payload.vaultFile), false);
      }
      // Exercise the actual API -> detached shared runner -> GTK Start route.
      // Declining Start cannot reach the real vault, so no custody seam is
      // replaced for this end-to-end launcher test.
      const launchSource = `require(${JSON.stringify(path.join(__dirname, 'lib/isolated-environment'))}).activate('credential-real-launch');
        const q=require(${JSON.stringify(require.resolve('../src/lib/providers/owner-prompt-queue'))});
        const native=require(${JSON.stringify(require.resolve('../src/lib/owner-prompt-platform'))});
        const r=q.enqueue(${JSON.stringify({ ...item, vaultKey: 'custom.native_launch' })});
        if(!r.launcherRequested){console.log(JSON.stringify({launched:false,code:r.launchFailure}));process.exit(1);}
        const deadline=Date.now()+12000;const timer=setInterval(()=>{if(!native.runnerIsAlive(q.QUEUE_FILE)||Date.now()>deadline){clearInterval(timer);console.log(JSON.stringify({launched:true,alive:native.runnerIsAlive(q.QUEUE_FILE),statuses:q.readQueue().items.map(x=>x.status)}));}},100);`;
      const real = launch(process.execPath, ['-e', launchSource]); await real.jobReady;
      let actualOutput = ''; real.stdout.on('data', data => { actualOutput += data; });
      const found = await xdo(['search', '--sync', '--onlyvisible', '--name', '^ToolsEnabled - private owner step$']);
      assert.equal(found.status, 0, 'the actual queued Linux request must open Start');
      const actualWindow = found.stdout.trim(); assert.match(actualWindow, /^[0-9]+$/);
      await xdo(['windowfocus', '--sync', actualWindow]); await xdo(['key', 'Return']);
      assert.equal((await real.jobClosed).failure, null);
      assert.deepEqual(JSON.parse(actualOutput), { launched: true, alive: false, statuses: ['queued'] });
      assert.notEqual((await xdo(['search', '--onlyvisible', '--name', '^ToolsEnabled - private owner step$'])).status, 0);
      reader.close();
    } catch (error) { failed = error; throw error; }
    finally {
      const errors = [];
      for (const child of children.reverse()) { await child.terminateJob(); const closed = await child.jobClosed; if (closed.failure) errors.push(closed.failure); }
      fs.rmSync(directory, { recursive: true, force: true });
      if (!failed) assert.deepEqual(errors, []);
    }
  });
