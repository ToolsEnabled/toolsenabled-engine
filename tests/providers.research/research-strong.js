'use strict';

const assert = require('node:assert/strict');
const strong = require('../../src/lib/providers/research-strong');
const model = require('../../src/lib/providers/model');
const machineProfile = require('../../src/lib/machine-profile');
const { GiB } = require('../../src/lib/model-picker');

/* Drive status() through model.js's REAL peer resolution with an injected
 * machine profile, so the codes and reasons asserted below are the ones the
 * shipped path produces rather than error objects this test invented.
 * probeLocalModel() does not thread its dependencies into localJsonRequest, so
 * the profile is injected at that seam. */
function probeThroughRealPeerResolution(profile) {
  return () => model.probeLocalModel({
    requestJson: pathname => model.localJsonRequest(pathname, undefined, {
      dependencies: { loadMachineProfile: () => profile }
    })
  });
}

function profileWithPeers(peers) {
  return { ...machineProfile.singleMachineDefault(() => 'lane-test-host'), source: 'profile', peers, rejected: [] };
}

function completion(content = 'strong advisory output') {
  return {
    message: { role: 'assistant', content }, prompt_eval_count: 20,
    eval_count: 30, total_duration: 40_000_000
  };
}

function resources(overrides = {}) {
  return {
    ollamaReachable: true, installedModels: [strong.STRONG_MODEL], residentModels: [],
    freeRamBytes: 32 * GiB, freeVramBytes: 7 * GiB, onBattery: false, ...overrides
  };
}

function fixture(overrides = {}) {
  const calls = { chats: [], ledger: [], outerAudit: [], modelAudit: [] };
  const dependencies = {
    assertAllowed() {}, probe: async () => resources(), gpuTemperatureC: () => 55,
    chat: async request => { calls.chats.push(request); return completion(); },
    state: { recordModelUsage: value => calls.ledger.push(value) },
    auditRequire: (...args) => { calls.outerAudit.push(args); return { durable: true }; },
    auditRecord: (...args) => { calls.outerAudit.push(args); return { durable: true }; },
    modelAuditRequire: (...args) => { calls.modelAudit.push(args); return { durable: true }; },
    modelAuditRecord: (...args) => { calls.modelAudit.push(args); return { durable: true }; },
    ...overrides
  };
  return { calls, dependencies };
}

(async () => {
  {
    const test = fixture();
    const marker = `strong-prompt-not-in-audit-${process.pid}`;
    const result = await strong.complete({ prompt: marker, maxOutputTokens: 512 }, test.dependencies);
    assert.equal(result.output, 'strong advisory output');
    assert.equal(result.modelUsed, 'gpt-oss:20b');
    assert.equal(result.tier, 'strong-advisory');
    assert.equal(result.keepAlive, '15m');
    assert.equal(result.contentTrust, 'untrusted');
    assert.equal(result.grantsAuthority, false);
    assert.equal(test.calls.chats.length, 1);
    assert.equal(test.calls.chats[0].model, 'gpt-oss:20b');
    assert.equal(test.calls.chats[0].think, 'low');
    assert.equal(test.calls.chats[0].keep_alive, '15m');
    assert.equal(test.calls.chats[0].options.num_predict, 512);
    assert.equal(test.calls.chats[0].options.num_ctx, 4096);
    assert.equal(test.calls.chats[0].options.num_gpu, 8);
    assert.equal(Object.hasOwn(test.calls.chats[0], 'tools'), false);
    assert.deepEqual(test.calls.ledger, [{ model: 'gpt-oss:20b', promptTokens: 20, evalTokens: 30 }]);
    assert.doesNotMatch(JSON.stringify([test.calls.outerAudit, test.calls.modelAudit]), new RegExp(marker));
  }

  {
    const test = fixture({ auditRequire: (...args) => {
      test.calls.outerAudit.push(args);
      return { durable: false };
    } });
    await assert.rejects(strong.complete({ prompt: 'intent must be durable' }, test.dependencies),
      error => error && error.code === 'STRONG_AUDIT_UNAVAILABLE');
    assert.equal(test.calls.outerAudit.length, 1);
    assert.equal(test.calls.outerAudit[0][0], 'research.strong_complete.intent');
    assert.deepEqual(test.calls.chats, []);
    assert.deepEqual(test.calls.ledger, []);
    assert.deepEqual(test.calls.modelAudit, []);
  }

  {
    const executionFailure = new Error('model intent audit failed');
    const test = fixture({ modelAuditRequire: (...args) => {
      test.calls.modelAudit.push(args);
      throw executionFailure;
    } });
    await assert.rejects(strong.complete({ prompt: 'failed execution is audited' }, test.dependencies),
      error => error === executionFailure);
    assert.deepEqual(test.calls.chats, []);
    assert.deepEqual(test.calls.ledger, []);
    assert.equal(test.calls.outerAudit.length, 2);
    assert.equal(test.calls.outerAudit[1][0], 'research.strong_complete.failed');
    assert.equal(test.calls.outerAudit[1][2].code, 'STRONG_EXECUTION_FAILED');
  }

  {
    const executionFailure = new Error('model intent audit failed');
    const test = fixture({
      modelAuditRequire: (...args) => {
        test.calls.modelAudit.push(args);
        throw executionFailure;
      },
      auditRecord: (...args) => {
        test.calls.outerAudit.push(args);
        throw new Error('failure audit write failed without a safe code');
      }
    });
    await assert.rejects(strong.complete({ prompt: 'failed audit remains diagnosable' }, test.dependencies),
      error => error === executionFailure
        && error.failureAuditCode === 'STRONG_AUDIT_FAILURE_RECORD_FAILED');
    assert.deepEqual(test.calls.chats, []);
    assert.deepEqual(test.calls.ledger, []);
    assert.equal(test.calls.outerAudit.length, 2);
    assert.equal(test.calls.outerAudit[1][0], 'research.strong_complete.failed');
  }

  {
    const test = fixture({
      auditRecord: () => { throw Object.assign(new Error('audit sink unavailable'), { code: 'AUDIT_SINK_UNAVAILABLE' }); }
    });
    await assert.rejects(strong.complete({ prompt: 'audit failure remains diagnosable' }, test.dependencies),
      error => error && error.code === 'AUDIT_SINK_UNAVAILABLE' && error.failureAuditCode === 'AUDIT_SINK_UNAVAILABLE');
  }

  {
    for (const invalid of [
      { prompt: 'research', model: 'gpt-oss:120b' },
      { prompt: 'research', url: 'https://example.invalid' },
      { prompt: 'Authorization: Bearer fake-token' },
      { prompt: 'read C:\\vault\\records' },
      { prompt: 'short', maxOutputTokens: 255 },
      { prompt: 'short', maxOutputTokens: 1537 }
    ]) {
      await assert.rejects(strong.complete(invalid, fixture().dependencies), error =>
        error && (error.code === 'STRONG_INPUT_INVALID' || error.code === 'STRONG_SENSITIVE_INPUT'));
    }
  }

  {
    const cases = [
      [resources({ onBattery: true }), 55, 'paused_on_battery'],
      [resources({ residentModels: ['hermes3:8b'] }), 55, 'another_local_model_is_resident'],
      [resources({ freeRamBytes: 20 * GiB }), 55, 'fresh_load_free_ram_below_24GiB'],
      [resources({ freeVramBytes: 6 * GiB }), 55, 'fresh_load_free_vram_below_7GiB'],
      [resources(), 80, 'gpu_too_warm'],
      [resources({ residentModels: [strong.STRONG_MODEL], freeRamBytes: 11 * GiB, freeVramBytes: 2 * GiB }), 55, 'resident_free_ram_below_12GiB'],
      [resources({ residentModels: [strong.STRONG_MODEL], freeRamBytes: 13 * GiB, freeVramBytes: 1.9 * GiB }), 55, 'resident_free_vram_below_2GiB']
    ];
    for (const [probe, temperature, reason] of cases) {
      const test = fixture({ probe: async () => probe, gpuTemperatureC: () => temperature });
      await assert.rejects(strong.complete({ prompt: 'bounded strong work' }, test.dependencies),
        error => error && error.code === 'STRONG_PAUSED' && error.details.reason === reason);
      assert.equal(test.calls.chats.length, 0);
    }
    const residentReady = strong.readiness(resources({
      residentModels: [strong.STRONG_MODEL], freeRamBytes: 13 * GiB, freeVramBytes: 2.1 * GiB
    }), 60, true);
    assert.deepEqual(residentReady, { ready: true, reason: null, resident: true });
  }

  {
    for (const incomplete of [
      resources({ ollamaReachable: false }),
      resources({ installedModels: undefined }),
      resources({ residentModels: undefined }),
      resources({ freeRamBytes: undefined }),
      resources({ freeVramBytes: Number.NaN }),
      resources({ onBattery: undefined })
    ]) {
      assert.throws(() => strong.readiness(incomplete, 55, true),
        error => error && error.code === 'STRONG_PROBE_UNAVAILABLE');
      await assert.rejects(strong.status({
        probe: async () => incomplete,
        gpuTemperatureC: () => 55,
        policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
      }), error => error && error.code === 'STRONG_PROBE_UNAVAILABLE');
    }
  }

  {
    const test = fixture({ assertAllowed() { throw new Error('Strong local advisory inference is disabled by policy.'); } });
    await assert.rejects(strong.complete({ prompt: 'policy check' }, test.dependencies),
      error => error && error.code === 'STRONG_DISABLED');
    const observed = await strong.status({
      probe: async () => resources({
        installedModels: [strong.STRONG_MODEL, 'hermes3:8b'],
        residentModels: [strong.STRONG_MODEL], freeRamBytes: 13 * GiB, freeVramBytes: 2.2 * GiB
      }),
      gpuTemperatureC: () => 60,
      policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
    });
    assert.equal(observed.strong.ready, true);
    assert.equal(observed.strong.resident, true);
    assert.equal(observed.fast.ready, false);
    assert.equal(observed.fast.reason, 'another_local_model_is_resident');

    const lowRam = await strong.status({
      probe: async () => resources({
        installedModels: [strong.STRONG_MODEL, 'hermes3:8b'],
        freeRamBytes: 7.9 * GiB, freeVramBytes: 7 * GiB
      }),
      gpuTemperatureC: () => 60,
      policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
    });
    assert.equal(lowRam.fast.ready, false);
    assert.equal(lowRam.fast.reason, 'free_ram_below_8GiB');
  }

  {
    for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      await assert.rejects(strong.complete({ prompt: 'policy probe uncertainty' }, fixture({
        assertAllowed() { throw Object.assign(new Error('policy read failed'), { code }); }
      }).dependencies), error => error && error.code === 'STRONG_POLICY_INDETERMINATE'
        && error.details.causeCode === code && /not claiming.*disabled/i.test(error.message));

      assert.throws(() => strong.gpuTemperatureC(() => {
        throw Object.assign(new Error('temperature command failed'), { code });
      }), error => error && error.code === 'STRONG_TEMPERATURE_PROBE_INDETERMINATE'
        && error.details.causeCode === code && /not claiming.*absent/i.test(error.message));
    }

    // CONTROL: definite command absence keeps its old answer, and repeated calls
    // still execute the probe rather than caching or latching either outcome.
    let absentProbeCalls = 0;
    const absentProbe = () => {
      absentProbeCalls += 1;
      throw Object.assign(new Error('nvidia-smi not found'), { code: 'ENOENT' });
    };
    assert.equal(strong.gpuTemperatureC(absentProbe), null);
    assert.equal(strong.gpuTemperatureC(absentProbe), null);
    assert.equal(absentProbeCalls, 2);
  }

  /* THE PROBE THAT WAS FILED AS A TOOL FAILURE TWENTY-ONE TIMES OUT OF
   * TWENTY-ONE. research.local_tiers_status is a READ; an installation with no
   * peer machine has answered it, and an answer must not travel as a throw that
   * the dispatch chokepoint in tool-registry.js records as mcp.tool.failed. */
  {
    const absences = [
      ['no peer declared at all',
        machineProfile.singleMachineDefault(() => 'lane-test-host'), 'no_gpu_peer_configured'],
      ['one declared peer with a blank address',
        profileWithPeers([{ id: 'gpu-box', address: '   ' }]), 'gpu_peer_missing_address'],
      ['two declared peers and no selector',
        profileWithPeers([{ id: 'gpu-a', address: '203.0.113.5' }, { id: 'gpu-b', address: '203.0.113.6' }]),
        'gpu_peer_ambiguous']
    ];
    for (const [label, profile, reason] of absences) {
      let temperatureCalls = 0;
      const answer = await strong.status({
        probe: probeThroughRealPeerResolution(profile),
        gpuTemperatureC: () => { temperatureCalls += 1; return 55; },
        policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: false }
      });
      assert.equal(answer.available, false, label);
      assert.equal(answer.reason, reason, label);
      assert.equal(answer.localOnly, true, label);
      assert.equal(answer.fast.ready, false, label);
      assert.equal(answer.fast.reason, reason, label);
      assert.equal(answer.strong.ready, false, label);
      assert.equal(answer.strong.reason, reason, label);
      assert.equal(answer.fast.model, 'hermes3:8b', label);
      assert.equal(answer.strong.model, strong.STRONG_MODEL, label);
      // Policy still reads through, so a settings screen can tell "switched
      // off" apart from "nowhere to run it".
      assert.equal(answer.fast.enabled, true, label);
      assert.equal(answer.strong.enabled, false, label);
      // Nothing was measured, so nothing is REPORTED as measured. 0 would read
      // as "looked, and none is free"; [] as "looked, and none is resident".
      assert.equal(answer.freeRamMiB, null, label);
      assert.equal(answer.freeVramMiB, null, label);
      assert.equal(answer.gpuTemperatureC, null, label);
      assert.equal(answer.onBattery, null, label);
      assert.equal(answer.residentModels, null, label);
      // No backend to have a GPU: the nvidia-smi subprocess is never spawned.
      assert.equal(temperatureCalls, 0, label);
    }
  }

  /* AND A GENUINELY FAILED CALL IS STILL A FAILURE. Two families must keep
   * throwing: COULD-NOT-LOOK (the machine profile could not be checked, so no
   * absence was established) and A BACKEND THAT EXISTS AND DID NOT ANSWER. */
  {
    for (const source of ['unreadable', 'malformed']) {
      await assert.rejects(strong.status({
        probe: probeThroughRealPeerResolution({ source, peers: [], rejected: [] }),
        gpuTemperatureC: () => 55,
        policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
      }), error => error && error.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED',
      `A ${source} machine profile is could-not-look and must not be answered as available:false.`);
    }

    await assert.rejects(strong.status({
      probe: probeThroughRealPeerResolution({
        source: 'profile', peers: [], rejected: [{ id: 'gpu-box', address: 'not-an-address' }]
      }),
      gpuTemperatureC: () => 55,
      policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
    }), error => error && error.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED');

    // A declared peer that did not answer, and a reply that could not be used.
    for (const code of ['MODEL_UNAVAILABLE', 'MODEL_OLLAMA_UNAVAILABLE', 'MODEL_OLLAMA_TIMEOUT',
      'MODEL_OLLAMA_HTTP', 'MODEL_RESPONSE_INVALID', 'MODEL_RESPONSE_TOO_LARGE']) {
      await assert.rejects(strong.status({
        probe: async () => { throw new model.ModelCompletionError(code, 'the declared peer did not answer', {}); },
        gpuTemperatureC: () => 55,
        policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
      }), error => error && error.code === code,
      `${code} is a fault about a backend that exists and must not be reported as "no local backend".`);
    }

    // An absence code is not a password: a details.reason this module does not
    // recognise never reaches a caller as though it had been vouched for.
    const invented = await strong.status({
      probe: async () => {
        throw new model.ModelCompletionError('MODEL_NO_GPU_PEER_CONFIGURED', 'no peer', { reason: 'whatever_we_like' });
      },
      gpuTemperatureC: () => 55,
      policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
    });
    assert.equal(invented.available, false);
    assert.equal(invented.reason, 'no_gpu_peer_configured');
  }

  {
    // A reading says so too, so one caller shape reads both outcomes.
    const measured = await strong.status({
      probe: async () => resources({ installedModels: [strong.STRONG_MODEL, 'hermes3:8b'] }),
      gpuTemperatureC: () => 60,
      policy: { hermesAdvisoryEnabled: true, strongAdvisoryEnabled: true }
    });
    assert.equal(measured.available, true);
    assert.equal(measured.reason, null);
    assert.equal(measured.strong.ready, true);
    assert.equal(measured.freeRamMiB, 32 * 1024);
  }

  console.log('Strong local research provider tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
