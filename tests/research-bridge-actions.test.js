'use strict';

// The bridge's research surface: exact route/action parity with server.js,
// the {ok:true, receipt} envelope, and provider refusals mapped onto honest
// HTTP statuses instead of a generic 500.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createResearchActions } = require('../src/lib/mission-bridge/research-actions');
const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');
const { createStateStore } = require('../src/lib/state-store');
const { ResearchControl } = require('../src/lib/providers/research');

const EXPECTED_ROUTES = Object.freeze({
  '/v1/actions/research-snapshot': 'researchSnapshot',
  '/v1/actions/research-runs': 'researchRuns',
  '/v1/actions/research-results': 'researchResults',
  '/v1/actions/research-findings': 'researchFindings',
  '/v1/actions/research-project-save': 'researchProjectSave',
  '/v1/actions/research-experiment-save': 'researchExperimentSave',
  '/v1/actions/research-run-submit': 'researchRunSubmit',
  '/v1/actions/research-session-assign': 'researchSessionAssign',
  '/v1/actions/research-finding-save': 'researchFindingSave',
  '/v1/actions/research-lifecycle': 'researchLifecycle'
});

test('server.js routes every research action this factory creates, and no other', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mission-bridge', 'server.js'), 'utf8');
  for (const [route, action] of Object.entries(EXPECTED_ROUTES)) {
    assert.ok(serverSource.includes(`'${route}': '${action}'`), `server.js must route ${route} -> ${action}`);
  }
  const actions = createResearchActions({ control: {} });
  assert.deepEqual(Object.keys(actions).sort(), Object.values(EXPECTED_ROUTES).sort());
});

test('actions answer {ok:true, receipt} and inject the human actor for the app', async () => {
  const seen = [];
  const control = {
    snapshot: () => ({ projects: [] }),
    projectSave: input => { seen.push(input); return { project: { projectId: 'rp-1234' } }; }
  };
  const actions = createResearchActions({ control });
  const snapshot = await actions.researchSnapshot();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.receipt.projects, []);
  const saved = await actions.researchProjectSave({ name: 'Demo' });
  assert.equal(saved.receipt.project.projectId, 'rp-1234');
  assert.equal(seen[0].actor, 'human', 'the bridge caller is the app acting for the owner');
});

test('a body carrying its own actor cannot spoof the audit attribution', async () => {
  // The adversarial review reproduced exactly this: spread order let a bearer
  // holder attribute a research write to another actor. The literal wins now.
  const seen = [];
  const actions = createResearchActions({ control: { projectSave: input => { seen.push(input); return { project: { projectId: 'rp-1' } }; } } });
  await actions.researchProjectSave({ actor: 'gemini', name: 'Spoofed' });
  assert.equal(seen[0].actor, 'human', 'the caller-supplied actor is overwritten, never recorded');
});

test('the bridge policy guard refuses every research write before control mutates state', async () => {
  const writes = [
    ['researchProjectSave', 'projectSave'],
    ['researchExperimentSave', 'experimentSave'],
    ['researchRunSubmit', 'runSubmit'],
    ['researchSessionAssign', 'sessionAssign'],
    ['researchFindingSave', 'findingSave'],
    ['researchLifecycle', 'lifecycle']
  ];
  const controlCalls = [];
  const policyCalls = [];
  const control = Object.fromEntries(writes.map(([, method]) => [method, () => controlCalls.push(method)]));
  const policy = {
    assertActive(action, options) {
      policyCalls.push({ action, options });
      throw new Error('KILLSWITCH is active');
    }
  };
  const actions = createResearchActions({ control, policy });

  for (const [action] of writes) {
    await assert.rejects(actions[action]({}), error =>
      error instanceof MissionBridgeError && error.code === 'BRIDGE_GUARD_REFUSED'
      && (error.status === 409 || (error.details && error.details.status === 409)));
  }

  assert.deepEqual(controlCalls, [], 'no provider write runs after the guard refuses it');
  assert.deepEqual(policyCalls, writes.map(([action]) => ({
    action: `mission.bridge.${action}`,
    options: { outward: true }
  })));
});

test('provider refusals map onto honest statuses', async () => {
  const throwing = code => () => { const error = new Error('refused'); error.code = code; throw error; };
  const cases = [
    ['RESEARCH_PIPELINE_DISABLED', 409, 'runSubmit', 'researchRunSubmit'],
    ['RESEARCH_EXPERIMENT_NOT_FOUND', 404, 'runSubmit', 'researchRunSubmit'],
    ['RESEARCH_INPUT_INVALID', 400, 'projectSave', 'researchProjectSave'],
    ['RESEARCH_RUNTIME_UNAVAILABLE', 503, 'lifecycle', 'researchLifecycle']
  ];
  for (const [code, status, method, action] of cases) {
    const actions = createResearchActions({ control: { [method]: throwing(code) } });
    await assert.rejects(actions[action]({}), error =>
      error instanceof MissionBridgeError && error.code === code
      && (error.status === status || (error.details && error.details.status === status)));
  }
});

test('asynchronous provider refusals cannot escape inside an ok receipt', async () => {
  const unavailable = new Error('runtime unavailable');
  unavailable.code = 'RESEARCH_RUNTIME_UNAVAILABLE';
  const actions = createResearchActions({
    control: { snapshot: async () => { throw unavailable; } }
  });

  await assert.rejects(actions.researchSnapshot(), error =>
    error instanceof MissionBridgeError && error.code === unavailable.code
    && (error.status === 503 || (error.details && error.details.status === 503)));
});

test('against a real store, the read actions round-trip what the writes created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-bridge-'));
  const state = createStateStore({ file: path.join(dir, 'state.sqlite3') });
  state.health();
  const gate = () => ({
    pipelineWithheld: false, pipeline: { state: 'enabled', why: null },
    runners: {
      agent: { state: 'withheld', why: 'off' },
      process: { state: 'enabled', why: null },
      http: { state: 'withheld', why: 'off' }
    }
  });
  const control = new ResearchControl({ state, gate, auditRequire: () => ({ durable: true }) });
  const actions = createResearchActions({ control });

  const project = (await actions.researchProjectSave({ name: 'Demo', enabled: true })).receipt.project;
  const submitted = (await actions.researchRunSubmit({
    experiment: {
      projectId: project.projectId, name: 'grid', runnerKind: 'process',
      runnerConfig: { command: 'node', args: [], stdin: 'none' },
      resultSchema: { fields: { n: 'number' }, required: ['n'] },
      collector: { kind: 'stdout-json' }
    },
    params: { n: 1 }
  })).receipt;
  assert.equal(submitted.disposition, 'submitted');

  const snapshot = (await actions.researchSnapshot()).receipt;
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.experiments[project.projectId].length, 1);
  assert.equal(snapshot.settings.pipelineEnabled, true);

  const runs = (await actions.researchRuns({ experimentId: submitted.experiment.experimentId })).receipt.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].task.status, 'queued');

  const finding = (await actions.researchFindingSave({ projectId: project.projectId, claim: 'grid runs queue' })).receipt;
  assert.match(finding.findingId, /^F-\d{4}-\d{4}-\d{3}$/);
  const findings = (await actions.researchFindings({ projectId: project.projectId })).receipt.findings;
  assert.equal(findings.length, 1);
  state.close();
});

process.on('exit', () => { console.log('research bridge action tests passed'); });
