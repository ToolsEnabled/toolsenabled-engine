// EXECUTABLE CHANGE
'use strict';

// TEST-CAN-FAIL REPORT (testcanfail-tests-cloud-mirror-bridge-test-js)
// Strengthened assertion: the caller-supplied cloudRepository case used a
// hand-written try/catch and proved only that *something* threw. It now requires
// BRIDGE_INPUT_INVALID and the exact-input refusal's diagnostic. Intended
// mutation: replace exact(...) at cloudMirrorRegister entry with an unrelated
// throw; the old checks accept that failure before the mirror call, while the
// strengthened error-code assertion rejects it.
// RED/GREEN PRECONDITION NOT MET: this image provides Node v20.20.2, but the
// repository requires Node >=22.19.0 and loading the test stops before its first
// assertion with "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module:
// node:sqlite". Installing Node 22 was also unavailable (nvm reported
// "Version '22' not found" and the Node download endpoint returned HTTP 403),
// so no fabricated mutation result or green result is quoted here.
// NOT-FOUND (1): no loop/forEach assertion over a possibly empty collection.
// NOT-FOUND (2): no exit-status or truthy process-return assertion.
// NOT-FOUND (4): the mirror fake is an observation boundary; assertions inspect
// arguments supplied by the actions under test, and no assertion reimplements
// the registry behavior delegated to that fake.
// NOT-FOUND (5): no skip or platform precondition guard in this file.
// NOT-FOUND (6): no expected value computed by the production code under test.

// The two mission-bridge verbs behind the cloud mirror setup surface.
//
// WHY A SEPARATE FILE. tests/mission-bridge.test.js stands up real lanes, real
// queues and a real HTTP server; these two verbs need none of that, and the
// questions they raise are entirely about WHAT THEY REFUSE. Folding them in
// there would bury behaviour worth reading on its own -- and that suite is
// currently red at HEAD for an unrelated launch-scope reason, so a pass in it
// would prove nothing about this.
//
// THE ONE THING THESE VERBS EXIST TO GET RIGHT. The registry keys every cloud
// dispatch on a repository string. If a person TYPES that string, they will
// eventually type one that merely looks right, and the failure surfaces much
// later as a dispatch that refuses with no clue why. So the register verb takes
// an ENVIRONMENT and reads the repository the provider says it is bound to.
// Everything below is about the ways that read can fail to give a usable
// answer, and about not papering over any of them.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { ROUTES } = require('../src/lib/mission-bridge/server');
const cloudMirrorCore = require('../src/lib/cloud-agent/cloud-mirror');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { installationProfileRoot } = require('../src/lib/agent-session-confinement');
// The builder refuses an actor that is not the enabled declared controller, so
// the identity is read from the real org rather than invented -- the same
// helper tests/mission-bridge.test.js uses.
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const CONTROLLER = enabledControllerId(declaredOrg());

function cloudMirrorTemporaryRoot() {
  return process.platform === 'win32'
    ? path.join(installationProfileRoot(), 'AppData', 'Local', 'Temp')
    : isolatedTemporaryRoot();
}

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown at all)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

let auditSequence = 0;
const SILENT_AUDIT = {
  append: () => {}, appendEvent: () => {}, record: () => {},
  requireRecord: () => {
    auditSequence += 1;
    return { durable: true, anchored: true, sequence: auditSequence, eventHash: auditSequence.toString(16).padStart(64, '0') };
  }
};
const OPEN_POLICY = { assertActive: () => {} };

// A stand-in for the mirror module. It RECORDS what it was asked to do, which
// is how the tests below assert that the provider's answer -- not the caller's
// input -- is what reached the registry.
function fakeMirror() {
  const calls = [];
  const publishCalls = [];
  const disableCalls = [];
  return {
    calls,
    publishCalls,
    disableCalls,
    listRegisteredProjects: () => ({ registryPath: 'C:/fake/registry.json', projects: [] }),
    registerMirrorProject: async (args) => {
      const destination = cloudMirrorCore.githubRepositoryFromRemote(args.mirrorRemote);
      const metadata = await args.githubRepoGetImpl(destination);
      cloudMirrorCore.assertPrivateGithubMetadata(metadata, destination.fullName);
      calls.push({ ...args, observedMetadata: metadata });
      return {
        ok: true, registryPath: 'C:/fake/registry.json', projectKey: args.projectKey,
        project: { cloudRepository: metadata.fullName, mirrorBranch: `cloud-mirror/${args.projectKey}` },
        replaced: false,
        checks: [{ name: 'mirror repository is private', state: 'OK', detail: 'provider reports private' }]
      };
    },
    publishMirror: async (args) => {
      publishCalls.push(args);
      const metadata = await args.githubRepoGetImpl({ owner: 'Example', repo: 'agent-mirror', fullName: 'Example/agent-mirror' });
      assert.equal(metadata.private, true);
      return {
        project: args.projectKey,
        publication: {
          cloudRepository: metadata.fullName,
          mirrorBranch: `cloud-mirror/${args.projectKey}`,
          sourceCommit: 'a'.repeat(40), publicationCommit: 'b'.repeat(40),
          mirroredEntries: 12, withheldEntries: 3
        }
      };
    },
    disableMirrorProject: (args) => {
      disableCalls.push(args);
      return {
        ok: true,
        registryPath: 'C:/fake/registry.json',
        projectKey: args.projectKey,
        project: {
          key: args.projectKey,
          cloudRepository: 'Example/agent-mirror',
          mirrorBranch: `cloud-mirror/${args.projectKey}`,
          enabled: false,
          locallyDisabledAt: args.disabledAt
        }
      };
    }
  };
}

function actionsWith({ environments = [], environmentsComplete = true, mirror = fakeMirror(), repositoryMetadata = null } = {}) {
  const toolCalls = [];
  return {
    mirror,
    toolCalls,
    actions: createMissionActions({
      audit: SILENT_AUDIT,
      policy: OPEN_POLICY,
      cloudMirror: mirror,
      // Pinned rather than inherited, for the reason mission-bridge.test.js
      // records: without it the builder reads THIS machine's recorded install
      // tier and the file passes or fails by whose computer it runs on.
      permissionSession: { origin: 'local', tier: 'full' },
      actor: CONTROLLER,
      agentOrg: declaredOrg(),
      // An absolute root is required by the builder; nothing here reads it.
      roots: { primary: cloudMirrorTemporaryRoot() },
      executeTool: async (tool, args) => {
        toolCalls.push({ tool, args });
        if (tool === 'cloud.account_list') {
          return { accounts: [], defaultAccount: null, environments, environmentsComplete, environmentsReadAt: '2026-08-24T00:00:00.000Z' };
        }
        if (tool === 'github.repo_get') {
          return repositoryMetadata || { fullName: 'Example/agent-mirror', private: true, visibility: 'private', archived: false, disabled: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      }
    })
  };
}

const PRIVATE_ENV = Object.freeze({
  environmentId: '6a8cb9e4d4c481918bab8089e2fe2ca2',
  repository: 'Example/agent-mirror', defaultBranch: 'main', visibility: 'private', reason: null
});

(async () => {
  check(ROUTES['/v1/actions/cloud-mirror-register'] === 'cloudMirrorRegister',
    'server: the registration trust boundary is exposed only through the authenticated mission-bridge action');
  check(ROUTES['/v1/actions/cloud-mirror-publish'] === 'cloudMirrorPublish',
    'server: the project-only publish action is routed through the authenticated mission bridge');
  check(ROUTES['/v1/actions/cloud-mirror-disable'] === 'cloudMirrorDisable',
    'server: the installed setup surface has an authenticated local disable action');

  // -------------------------------------------------------------------
  // list: an empty registry is an ANSWER, not a refusal.
  // -------------------------------------------------------------------
  {
    const { actions } = actionsWith({});
    const result = await actions.cloudMirrorList({});
    check(result.ok === true && Array.isArray(result.receipt.projects) && result.receipt.projects.length === 0,
      'list: a machine with nothing registered answers with an empty list -- being refused for the absence you are asking about is not an answer, and the setup surface could not draw its own state');
  }

  // -------------------------------------------------------------------
  // register: the repository comes from the PROVIDER, never from the caller.
  // -------------------------------------------------------------------
  {
    const { actions, mirror, toolCalls } = actionsWith({ environments: [PRIVATE_ENV] });
    const result = await actions.cloudMirrorRegister({
      projectKey: 'engine', sourceRoot: 'C:/checkout', mirrorRemote: 'https://github.com/Example/agent-mirror.git',
      environment: PRIVATE_ENV.environmentId
    });
    check(result.ok === true, 'register: a private, singly-bound environment registers');
    check(mirror.calls.length === 1, 'register: exactly one registration was attempted');
    check(mirror.calls[0].cloudRepository === 'Example/agent-mirror',
      'register: the repository handed to the registry is the one the PROVIDER reported, so a dispatch resolves under a string nobody typed');
    check(toolCalls.some((call) => call.tool === 'github.repo_get'
      && call.args.owner === 'Example' && call.args.repo === 'agent-mirror'),
      'register: authenticated github.repo_get is called for the exact owner/name canonicalized from the typed remote');
    check(typeof mirror.calls[0].githubRepoGetImpl === 'function'
      && !Object.hasOwn(mirror.calls[0], 'repositoryMetadata')
      && mirror.calls[0].observedMetadata.private === true,
      'register: the core receives an authenticated repo_get implementation and fetches metadata itself; no caller-supplied metadata field crosses the boundary');
    check(mirror.calls[0].mirrorBranch === undefined && result.receipt.project.mirrorBranch === 'cloud-mirror/engine',
      'register: the environment default branch is ignored and the project workspace branch is derived');
    check(Array.isArray(result.receipt.checks) && result.receipt.checks.length === 1,
      'register: the per-fact check list reaches the surface intact -- a registration showing only its successes would read as a clean bill of health for things nobody looked at');
    check(result.receipt.intentAudit?.sequence > 0 && result.receipt.audit?.sequence > result.receipt.intentAudit.sequence,
      'register: a durable intent precedes the registry mutation and a later outcome receipt reaches the surface');
  }

  // -------------------------------------------------------------------
  // register: API replace cannot bypass the core's active-binding guard.
  // -------------------------------------------------------------------
  {
    const root = fs.mkdtempSync(path.join(cloudMirrorTemporaryRoot(), 'cloud-mirror-bridge-replace-'));
    try {
      const registryPath = path.join(root, 'registry.json');
      const enabledRegistry = `${JSON.stringify({
        schemaVersion: cloudMirrorCore.REGISTRY_SCHEMA,
        projects: {
          engine: {
            sourceRoot: 'C:/existing-checkout',
            mirrorRemote: 'https://github.com/Example/agent-mirror.git',
            mirrorBranch: 'cloud-mirror/engine',
            boundaryManifest: 'config/cloud-mirror-boundary.json',
            cloudRepository: 'Example/agent-mirror',
            githubRepository: 'Example/agent-mirror',
            privacyVerifiedAt: '2026-08-30T00:00:00.000Z'
          }
        }
      }, null, 2)}\n`;
      fs.writeFileSync(registryPath, enabledRegistry, 'utf8');

      const networkCalls = [];
      const publishCalls = [];
      const guardedCore = {
        ...cloudMirrorCore,
        registerMirrorProject: (args) => cloudMirrorCore.registerMirrorProject({
          ...args,
          registryPath,
          networkGitImpl: async (_repoRoot, gitArgs) => {
            networkCalls.push([...gitArgs]);
            throw new Error('mission bridge active replacement reached a remote');
          }
        }),
        publishMirror: async (args) => {
          publishCalls.push(args);
          throw new Error('mission bridge registration invoked publication');
        }
      };
      const { actions, toolCalls } = actionsWith({ environments: [PRIVATE_ENV], mirror: guardedCore });
      const refusal = await raises('CLOUD_MIRROR_ACTIVE_REPLACEMENT_REFUSED',
        () => actions.cloudMirrorRegister({
          projectKey: 'engine', sourceRoot: 'C:/replacement-checkout',
          mirrorRemote: 'https://github.com/Example/agent-mirror.git',
          environment: PRIVATE_ENV.environmentId,
          replace: true
        }),
        'register API: replace=true cannot repoint an enabled registration through the mission bridge');
      check(/active Cloud Mirror binding cannot be replaced in place/.test(refusal.message),
        'register API: the core refusal code and actionable explanation survive the bridge unchanged');
      check(toolCalls.every((call) => call.tool !== 'github.repo_get')
        && networkCalls.length === 0 && publishCalls.length === 0,
        'register API: refused enabled replacement performs no GitHub lookup, remote Git operation, fetch, push or publication');
      check(fs.readFileSync(registryPath, 'utf8') === enabledRegistry,
        'register API: refused enabled replacement leaves the persisted registry byte-identical');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const { actions, mirror, toolCalls } = actionsWith({ environments: [PRIVATE_ENV] });
    await raises('BRIDGE_CLOUD_MIRROR_REPOSITORY_MISMATCH',
      () => actions.cloudMirrorRegister({
        projectKey: 'engine', sourceRoot: 'C:/checkout',
        mirrorRemote: 'https://github.com/Example/a-different-repository.git',
        environment: PRIVATE_ENV.environmentId
      }),
      'register: the typed destination must be identical to the selected Cloud environment repository');
    check(toolCalls.every((call) => call.tool !== 'github.repo_get'),
      'register: a mismatched environment stops before asking GitHub about an unrelated repository');
    check(mirror.calls.length === 0, 'register: an environment mismatch never reaches registry write');
  }

  {
    const { actions, mirror } = actionsWith({
      environments: [PRIVATE_ENV],
      repositoryMetadata: { fullName: 'Example/agent-mirror', private: false, visibility: 'public', archived: false, disabled: false }
    });
    await raises('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
      () => actions.cloudMirrorRegister({
        projectKey: 'engine', sourceRoot: 'C:/checkout',
        mirrorRemote: 'https://github.com/Example/agent-mirror.git',
        environment: PRIVATE_ENV.environmentId
      }),
      'register: a public GitHub destination refuses with no override');
    check(mirror.calls.length === 0, 'register: public repository metadata never reaches registry write');
  }

  {
    const { actions, mirror } = actionsWith({
      environments: [PRIVATE_ENV],
      repositoryMetadata: { fullName: 'Example/agent-mirror', private: true, visibility: 'private', archived: true, disabled: false }
    });
    await raises('CLOUD_MIRROR_REPOSITORY_ARCHIVED',
      () => actions.cloudMirrorRegister({
        projectKey: 'engine', sourceRoot: 'C:/checkout',
        mirrorRemote: 'https://github.com/Example/agent-mirror.git',
        environment: PRIVATE_ENV.environmentId
      }),
      'register: authenticated metadata for an archived destination refuses inside the core');
    check(mirror.calls.length === 0, 'register: an archived repository never reaches registry write');
  }

  {
    const { actions, mirror } = actionsWith({
      environments: [PRIVATE_ENV],
      repositoryMetadata: { fullName: 'Example/somewhere-else', private: true, visibility: 'private', archived: false, disabled: false }
    });
    await raises('CLOUD_MIRROR_REPOSITORY_MISMATCH',
      () => actions.cloudMirrorRegister({
        projectKey: 'engine', sourceRoot: 'C:/checkout',
        mirrorRemote: 'https://github.com/Example/agent-mirror.git',
        environment: PRIVATE_ENV.environmentId
      }),
      'register: github.repo_get must return the exact typed/environment repository identity');
    check(mirror.calls.length === 0, 'register: mismatched GitHub metadata never reaches registry write');
  }

  // -------------------------------------------------------------------
  // register: UNKNOWN and ABSENT get different sentences.
  //
  // This is the distinction the whole codebase keeps having to relearn. An
  // environment missing from a COMPLETE list does not exist. An environment
  // missing from an INCOMPLETE list has not been shown not to exist -- most
  // often the account that owns it simply is not signed in here. Same symptom,
  // opposite remedy, so one message for both would send half the people who
  // hit it to fix the wrong thing.
  // -------------------------------------------------------------------
  {
    const { actions } = actionsWith({ environments: [PRIVATE_ENV], environmentsComplete: true });
    const error = await raises('BRIDGE_CLOUD_ENVIRONMENT_UNKNOWN',
      () => actions.cloudMirrorRegister({
        projectKey: 'x', sourceRoot: 'C:/checkout', mirrorRemote: 'https://github.com/Example/agent-mirror.git', environment: 'not-a-real-environment'
      }),
      'register: an environment absent from a COMPLETE list refuses as unknown');
    check(/full list was read/.test(error.message),
      'register: the unknown refusal says the list was complete, so the reader knows this is not a gap in what could be seen');
  }
  {
    const { actions } = actionsWith({ environments: [], environmentsComplete: false });
    const error = await raises('BRIDGE_CLOUD_ENVIRONMENT_UNCONFIRMED',
      () => actions.cloudMirrorRegister({
        projectKey: 'x', sourceRoot: 'C:/checkout', mirrorRemote: 'https://github.com/Example/agent-mirror.git', environment: PRIVATE_ENV.environmentId
      }),
      'register: an environment absent from an INCOMPLETE list refuses as UNCONFIRMED, not as unknown -- we did not look everywhere, and saying "it does not exist" would be a claim nobody established');
    check(/Sign in to the account/.test(error.message),
      'register: the unconfirmed refusal names the remedy that actually applies -- signing in the account that owns it');
  }

  // -------------------------------------------------------------------
  // register: an environment bound to no single repository forwards ITS reason.
  // -------------------------------------------------------------------
  {
    const unbound = { environmentId: 'env-unbound', repository: null, defaultBranch: null, visibility: null,
      reason: 'This environment is bound to 3 repositories, so which one a task would land in cannot be established here.' };
    const { actions, mirror } = actionsWith({ environments: [unbound] });
    const error = await raises('BRIDGE_CLOUD_ENVIRONMENT_UNBOUND',
      () => actions.cloudMirrorRegister({
        projectKey: 'x', sourceRoot: 'C:/checkout', mirrorRemote: 'https://github.com/Example/agent-mirror.git', environment: 'env-unbound'
      }),
      'register: an environment with no single repository refuses rather than picking one');
    check(/bound to 3 repositories/.test(error.message),
      'register: the environment\'s own reason is forwarded rather than replaced by a second, vaguer sentence written here');
    check(mirror.calls.length === 0,
      'register: nothing was written -- the refusal happens before the registry is touched');
  }

  // -------------------------------------------------------------------
  // register: the caller cannot smuggle a repository past the provider.
  //
  // `exact()` refuses an unlisted field, so `cloudRepository` is not merely
  // ignored -- it is rejected. That is stronger than ignoring it, because a
  // caller who believes they are choosing the repository is told they are not.
  // -------------------------------------------------------------------
  {
    const { actions, mirror } = actionsWith({ environments: [PRIVATE_ENV] });
    const error = await raises('BRIDGE_INPUT_INVALID',
      () => actions.cloudMirrorRegister({
        projectKey: 'x', sourceRoot: 'C:/checkout', mirrorRemote: 'https://github.com/Example/agent-mirror.git',
        environment: PRIVATE_ENV.environmentId, cloudRepository: 'Attacker/elsewhere'
      }),
      'register: a caller-supplied cloudRepository is refused, not silently ignored');
    check(/unexpected or missing fields/.test(error.message),
      'register: the refusal identifies the unlisted input shape, rather than passing on an unrelated failure');
    check(mirror.calls.length === 0, 'register: nothing reached the registry on that attempt');
  }

  {
    const { actions, mirror } = actionsWith({ environments: [PRIVATE_ENV] });
    await raises('BRIDGE_INPUT_INVALID',
      () => actions.cloudMirrorRegister({
        projectKey: 'x', sourceRoot: 'C:/checkout',
        mirrorRemote: 'https://github.com/Example/agent-mirror.git',
        environment: PRIVATE_ENV.environmentId, mirrorBranch: 'main'
      }),
      'register: the product path does not accept a provider or caller branch override');
    check(mirror.calls.length === 0, 'register: a typed branch never reaches the core registration call');
  }

  {
    const { actions, mirror, toolCalls } = actionsWith({ environments: [PRIVATE_ENV] });
    const result = await actions.cloudMirrorPublish({ projectKey: 'engine' });
    check(result.ok === true && result.receipt.mirrorBranch === 'cloud-mirror/engine',
      'publish: the bridge returns the core-derived workspace branch');
    check(mirror.publishCalls.length === 1 && mirror.publishCalls[0].projectKey === 'engine',
      'publish: exactly one core publication is requested by project key');
    check(!Object.hasOwn(mirror.publishCalls[0], 'mirrorRemote')
      && !Object.hasOwn(mirror.publishCalls[0], 'mirrorBranch')
      && !Object.hasOwn(mirror.publishCalls[0], 'supersede'),
      'publish: remote, branch and force behavior cannot enter from the bridge request');
    check(toolCalls.some((call) => call.tool === 'github.repo_get'
      && call.args.owner === 'Example' && call.args.repo === 'agent-mirror'),
      'publish: the final core gate rechecks exact destination privacy through authenticated github.repo_get');
    check(result.receipt.intentAudit?.sequence > 0 && result.receipt.audit?.sequence > result.receipt.intentAudit.sequence,
      'publish: a durable intent precedes the possible GitHub push and a later outcome receipt reaches the surface');
    await raises('BRIDGE_INPUT_INVALID',
      () => actions.cloudMirrorPublish({ projectKey: 'engine', supersede: true }),
      'publish: supersede/public/destination overrides are rejected by the exact input contract');
  }

  {
    const { actions, mirror, toolCalls } = actionsWith({ environments: [PRIVATE_ENV] });
    const result = await actions.cloudMirrorDisable({ projectKey: 'engine' });
    check(result.ok === true && result.receipt.project.enabled === false,
      'disable: the bridge returns the locally disabled row the installed setup surface expects');
    check(result.receipt.remoteChanged === false,
      'disable: the receipt states explicitly that no remote repository or branch changed');
    check(mirror.disableCalls.length === 1 && mirror.disableCalls[0].projectKey === 'engine'
      && /^\d{4}-\d{2}-\d{2}T/.test(mirror.disableCalls[0].disabledAt),
      'disable: exactly one core lifecycle mutation is requested with a canonical timestamp');
    check(toolCalls.length === 0,
      'disable: no provider or GitHub tool is called because the remote repository and branch are unchanged');
    check(result.receipt.intentAudit?.sequence > 0 && result.receipt.audit?.sequence > result.receipt.intentAudit.sequence,
      'disable: the local lifecycle mutation is bracketed by durable intent and outcome receipts');
    await raises('BRIDGE_INPUT_INVALID',
      () => actions.cloudMirrorDisable({ projectKey: 'engine', deleteRemote: true }),
      'disable: a remote-deletion or other undeclared override is rejected by the exact input contract');
  }

  console.log(`cloud-mirror bridge tests passed (${checks} checks: an empty registry answered rather than refused, enabled replacement refused before repository access, the repository and visibility taken from the PROVIDER rather than the caller, unknown separated from unconfirmed with different remedies, an unbound environment forwarding its own reason, and a caller-supplied repository refused outright).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
