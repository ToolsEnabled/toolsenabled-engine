'use strict';
require('./lib/isolated-environment').activate('linux-sandbox-workspace');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMap, mappedId, aclEntries, verifyAcl, assertDirectoryIdentity, selectEndpoint } = require('../src/lib/linux-sandbox-workspace');
test('fresh profile selects per-UID rootless candidate without trusting environment paths', () => {
  const inspect = () => ({ name: 'default', endpoint: 'unix:///var/run/docker.sock' });
  assert.equal(selectEndpoint({ HOME: '/foreign', XDG_RUNTIME_DIR: '/foreign' }, inspect, 1000),
    'unix:///run/user/1000/docker.sock');
  for (const uid of [0, -1, '1000', NaN]) assert.throws(() => selectEndpoint({}, inspect, uid));
});
test('explicit endpoints and contexts never silently fall back to another daemon', () => {
  const inspect = name => ({ name, endpoint: 'unix:///var/run/docker.sock' });
  assert.equal(selectEndpoint({ DOCKER_CONTEXT: 'default', DOCKER_HOST: 'tcp://unused' }, inspect, 1000),
    'unix:///var/run/docker.sock');
  for (const endpoint of ['tcp://remote:2375', 'unix:///foreign/docker.sock', 'unix:///var/run/docker.sock']) {
    assert.equal(selectEndpoint({ DOCKER_HOST: endpoint }, () => assert.fail('must not inspect'), 1000), endpoint);
  }
  const custom = { name: 'custom', endpoint: 'unix:///var/run/docker.sock' };
  assert.equal(selectEndpoint({}, () => custom, 1000), custom.endpoint);
});
test('kernel mapping resolves rootless non-root UID without assuming host UID10001', () => {
  const rows = parseMap('0 1000 1\n1 100000 65536\n');
  assert.equal(mappedId(rows, 0), 1000);
  assert.equal(mappedId(rows, 10001), 110000);
  assert.throws(() => mappedId(rows, 999999));
});
test('ambiguous, overlapping, malformed and overflow mappings refuse', () => {
  for (const input of ['', '0 1 0', '0 1000 2\n1 3000 5', '0 1000 2\n5 1001 8', '0 1 4294967295', '0 -1 1', '0 1 1 extra']) {
    assert.throws(() => parseMap(input), { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
  }
});
test('ACL verifies exact numeric grants and refuses added public rights or weakened mask', () => {
  const entries = aclEntries(1000, 110000);
  verifyAcl(entries.join('\n'), entries);
  assert.ok(entries.includes('other::---') && entries.includes('default:other::---'));
  assert.throws(() => verifyAcl([...entries, 'user:9999:rwx'].join('\n'), entries));
  assert.throws(() => verifyAcl(entries.join('\n').replace('mask::rwx', 'mask::r--'), entries));
});
test('injected Docker alone cannot accidentally invoke the real Linux daemon or grant ACLs', () => {
  const { createSandboxProvider } = require('../src/lib/providers/agent-sandbox');
  let calls = 0;
  const provider = createSandboxProvider({ platform: 'linux', runDocker() { calls++; throw new Error('must not run'); } });
  const result = provider.doctor();
  assert.equal(result.available, null);
  assert.equal(result.imageReady, false);
  assert.equal(result.code, 'SANDBOX_LINUX_WORKSPACE_REFUSED');
  assert.match(result.message, /rootless Docker endpoint, Python 3, and the setfacl\/getfacl/);
  assert.equal(calls, 0);
});
test('pre-ACL directory checks retain exact large inode identity and refuse replacements or wrong owners', () => {
  const stat = (ino, extras = {}) => ({ dev: 12n, ino, uid: 1000n,
    isDirectory: () => true, isSymbolicLink: () => false, ...extras });
  const original = stat(9007199254740992n);
  assertDirectoryIdentity(original, original, original, 1000);
  assert.throws(() => assertDirectoryIdentity(original, stat(9007199254740993n), original, 1000));
  assert.throws(() => assertDirectoryIdentity(original, original, stat(9007199254740993n), 1000));
  assert.throws(() => assertDirectoryIdentity(original, stat(original.ino, { uid: 110000n }), original, 1000));
  assert.throws(() => assertDirectoryIdentity(original, original, stat(original.ino, { isSymbolicLink: () => true }), 1000));
});
