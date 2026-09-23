'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const binding = require('../src/lib/fra-transport-binding');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected);
}

// The policy digest is a live cross-machine byte-equality check: both peers
// hash these files and the session is refused if the digests differ. That is
// only safe for files which genuinely gate execution and change rarely.
// STANDING-ORDERS.md and config/standing-orders.json are neither -- agents edit
// them whenever the owner gives an instruction, and no code in the FRA request
// path reads them -- so pinning them refused every session after any routine
// directive. Keep this set to enforcement configuration only.
assert.deepEqual([...binding.POLICY_FILES].sort(), [
  'config/toolsenabled.policy.json',
  'config/uac-delegation-allowlist.json'
], 'the policy digest covers enforcement configuration only');
for (const entry of binding.POLICY_FILES) {
  assert.equal(/\.(?:md|markdown|txt|rst)$/i.test(entry), false,
    `${entry}: no document file belongs in the policy digest`);
}

// The binding refuses any host pair the service registry does not declare as
// the exact two-machine direct link, so these tests need a registry that
// declares 203.0.113.2 and 203.0.113.1 as that pair. Inject one instead of
// reading config/service-registry.json: the test asserts against fixed
// documentation addresses and must not depend on the builder's machine.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryOptions = { registry: lab };

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-transport-binding-'));
  for (const relative of binding.POLICY_FILES) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${relative}\n`, 'utf8');
  }
  const allowedTools = ['system.status', 'workspace.list', 'workspace.read'];
  const profile = {
    schemaVersion: 5,
    registryNameDigest: digest('registry'),
    allowedToolNamesDigest: digest([...allowedTools].sort().join('\n')),
    allowedToolCount: allowedTools.length,
    allowedTools,
    excludedTools: ['host.exec', 'repo.read_file'],
    desktopCapabilities: {
      clipboard: false,
      ocr: false,
      screenCapture: false
    },
    transportPolicy: binding.TRANSPORT_POLICY_DESCRIPTOR
  };
  const session = {
    sessionId: Buffer.alloc(16, 0x41).toString('base64url'),
    generation: 9
  };
  const runtimeDigest = digest('runtime');
  const policyDigest = binding.policyDigestForRoot({ root });
  const rootIdentity = binding.rootIdentityReport({ root });
  const childDirectory = path.join(root, 'identity-child');
  fs.mkdirSync(childDirectory);
  assert.equal(binding.rootIdentityReport({ root }).rootIdentityDigest, rootIdentity.rootIdentityDigest,
    'creating a subdirectory must not change the root identity');
  assert.notEqual(binding.rootIdentityReport({ root: childDirectory }).rootIdentityDigest, rootIdentity.rootIdentityDigest,
    'a different directory must have a different identity');
  fs.rmdirSync(childDirectory);
  assert.equal(binding.rootIdentityReport({ root }).rootIdentityDigest, rootIdentity.rootIdentityDigest,
    'removing a subdirectory must not change the root identity');
  if (process.platform === 'linux') {
    const owned = path.join(root, 'owned');
    const alias = path.join(root, 'OWNED');
    fs.mkdirSync(path.join(owned, 'nested'), { recursive: true });
    fs.symlinkSync(owned, alias, 'dir');
    try {
      code(() => binding.rootIdentityReport({ root: alias }), 'FRA_ROOT_IDENTITY_INVALID');
      code(() => binding.rootIdentityReport({ root: path.join(alias, 'nested') }), 'FRA_ROOT_IDENTITY_INVALID');
    } finally {
      fs.unlinkSync(alias);
      fs.rmSync(owned, { recursive: true });
    }
  }
  const rootAccessReport = {
    schemaVersion: 1,
    valid: true,
    policyDigest: digest('root-policy'),
    descriptorDigest: digest('root-acl'),
    secretValuesEmitted: false
  };
  try {
    const serverBinding = binding.createServerBinding({
      session,
      serverHost: '203.0.113.2',
      clientHost: '203.0.113.1',
      serviceRegistryOptions,
      capabilityProfile: profile,
      runtimeDigest,
      policyDigest,
      rootIdentity,
      rootAccessReport
    });
    assert.equal(JSON.stringify(serverBinding).includes(root), false);
    assert.equal(/[A-Za-z]:\\/.test(JSON.stringify(serverBinding)), false);
    const validated = binding.validateServerBinding(serverBinding, {
      session,
      serverHost: '203.0.113.2',
      clientHost: '203.0.113.1',
      serviceRegistryOptions,
      capabilityProfile: profile,
      runtimeDigest,
      policyDigest,
      rootAccessPolicyDigest: rootAccessReport.policyDigest
    });
    assert.equal(validated.contextDigest, serverBinding.contextDigest);
    for (const relative of binding.POLICY_FILES) {
      const target = path.join(root, ...relative.split('/'));
      const original = fs.readFileSync(target);
      try {
        fs.appendFileSync(target, Buffer.from([0x20]));
        const changedPolicyDigest = binding.policyDigestForRoot({ root });
        assert.notEqual(changedPolicyDigest, policyDigest, `${relative} must affect the bound policy digest`);
        code(() => binding.validateServerBinding(serverBinding, {
          session,
          serverHost: '203.0.113.2',
          clientHost: '203.0.113.1',
          serviceRegistryOptions,
          capabilityProfile: profile,
          runtimeDigest,
          policyDigest: changedPolicyDigest,
          rootAccessPolicyDigest: rootAccessReport.policyDigest
        }), 'FRA_BINDING_MISMATCH');
      } finally {
        fs.writeFileSync(target, original);
        original.fill(0);
      }
    }
    const workspaceContext = binding.workspaceContextFromBinding(validated);
    assert.deepEqual(Object.keys(workspaceContext).sort(), [
      'clientHost', 'generation', 'serverHost', 'sessionContextDigest'
    ]);
    const acceptance = binding.createBindingAcceptance(serverBinding);
    assert.equal(binding.validateBindingAcceptance(
      acceptance,
      serverBinding
    ).contextDigest, serverBinding.contextDigest);
    code(() => binding.validateBindingAcceptance({
      ...acceptance,
      generation: acceptance.generation + 1
    }, serverBinding), 'FRA_BINDING_ACCEPTANCE_MISMATCH');

    code(() => binding.validateServerBinding({
      ...serverBinding,
      generation: 10
    }, {
      session,
      serverHost: '203.0.113.2',
      clientHost: '203.0.113.1',
      serviceRegistryOptions,
      capabilityProfile: profile,
      runtimeDigest,
      policyDigest,
      rootAccessPolicyDigest: rootAccessReport.policyDigest
    }), 'FRA_BINDING_MISMATCH');
    code(() => binding.validateServerBinding(serverBinding, {
      session,
      serverHost: '203.0.113.2',
      clientHost: '203.0.113.1',
      serviceRegistryOptions,
      capabilityProfile: profile,
      runtimeDigest,
      policyDigest,
      rootAccessPolicyDigest: rootAccessReport.policyDigest,
      priorBinding: {
        serverHost: '203.0.113.2',
        deviceIdentityDigest: digest('other'),
        rootIdentityDigest: serverBinding.rootIdentityDigest,
        rootAclDigest: serverBinding.rootAclDigest
      }
    }), 'FRA_DEVICE_CONTINUITY_MISMATCH');

    const request = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'workspace.read',
        arguments: {
          fileHandle: 'B'.repeat(43),
          expectedVersion: digest('file')
        }
      }
    };
    const envelope = binding.createBoundRequest(request, serverBinding.contextDigest);
    assert.equal(envelope.toolName, 'workspace.read');
    assert.equal(binding.validateBoundRequest(
      envelope,
      serverBinding.contextDigest
    ).requestDigest, envelope.requestDigest);
    code(() => binding.validateBoundRequest({
      ...envelope,
      message: {
        ...request,
        params: { ...request.params, arguments: { ...request.params.arguments, offset: 1 } }
      }
    }, serverBinding.contextDigest), 'FRA_BOUND_REQUEST_MISMATCH');

    const response = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: 'untrusted duplicate' }],
        structuredContent: { ok: true, bytes: 4 }
      }
    };
    const boundResponse = binding.createBoundResponse({
      requestEnvelope: envelope,
      response,
      allowedTools
    });
    assert.equal(
      boundResponse.response.result.content[0].text,
      JSON.stringify({ bytes: 4, ok: true })
    );
    const opened = binding.validateBoundResponse(boundResponse, {
      requestEnvelope: envelope,
      allowedTools
    });
    assert.deepEqual(opened.response.result.structuredContent, {
      bytes: 4,
      ok: true
    });
    code(() => binding.validateBoundResponse({
      ...boundResponse,
      response: {
        ...boundResponse.response,
        result: {
          ...boundResponse.response.result,
          structuredContent: { bytes: 5, ok: true }
        }
      }
    }, { requestEnvelope: envelope, allowedTools }), 'FRA_BOUND_RESPONSE_MISMATCH');

    const listedRequest = binding.createBoundRequest({
      jsonrpc: '2.0', id: 8, method: 'tools/list', params: {}
    }, serverBinding.contextDigest);
    code(() => binding.createBoundResponse({
      requestEnvelope: listedRequest,
      response: {
        jsonrpc: '2.0', id: 8,
        result: { tools: allowedTools.slice(0, 2).map(name => ({
          name, description: name, inputSchema: { type: 'object' }
        })) }
      },
      allowedTools
    }), 'FRA_RESULT_PROJECTION_INVALID');

    const rpcError = binding.createBoundResponse({
      requestEnvelope: envelope,
      response: {
        jsonrpc: '2.0', id: 7,
        error: {
          code: -32001,
          message: 'Remote unavailable.',
          data: { code: 'SAFE_CODE', leaked: 'stripped' }
        }
      },
      allowedTools
    });
    assert.deepEqual(rpcError.response.error.data, { code: 'SAFE_CODE' });
    process.stdout.write('fra transport binding tests passed\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
