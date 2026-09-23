'use strict';

require('./lib/isolated-environment').activate('http-request');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const httpRequest = require('../src/lib/providers/http-request');
const ssrf = require('../src/lib/ssrf-guard');
const { httpConfiguration } = require('../src/lib/policy');
const { getTool } = require('../src/lib/tool-registry');

const PUBLIC_IP = '93.184.216.34';
const SECRET = 'fixture secret/+?=value';
const POLICY = {
  mode: 'autonomous',
  http: {
    allowedHosts: ['public.example.test'],
    vaultKeys: {
      fixture_bearer: { hosts: ['api.example.test'], authStyle: 'bearer' },
      fixture_header: { hosts: ['api.example.test'], authStyle: 'header:X-Api-Key' },
      fixture_query: { hosts: ['api.example.test'], authStyle: 'query:api_key' }
    }
  }
};

function lookup(spec) {
  return new Promise((resolve, reject) => {
    spec.lookup(spec.hostname, {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

function fixture(overrides = {}) {
  const calls = { active: [], secrets: [], resolves: [], transports: [], audits: [] };
  const {
    assertActive: suppliedAssertActive,
    getSecret: suppliedGetSecret,
    resolve: suppliedResolve,
    transport: suppliedTransport,
    record: suppliedRecord,
    ...rest
  } = overrides;
  const dependencies = {
    policy: POLICY,
    assertActive: action => {
      calls.active.push(action);
      if (suppliedAssertActive) return suppliedAssertActive(action);
    },
    getSecret: key => {
      calls.secrets.push(key);
      return suppliedGetSecret ? suppliedGetSecret(key) : SECRET;
    },
    resolve: async hostname => {
      calls.resolves.push(hostname);
      return suppliedResolve ? suppliedResolve(hostname) : [{ address: PUBLIC_IP, family: 4 }];
    },
    transport: async spec => {
      calls.transports.push(spec);
      if (suppliedTransport) return suppliedTransport(spec);
      const pinned = await lookup(spec);
      assert.deepEqual(pinned, { address: PUBLIC_IP, family: 4 }, 'Connection must use the vetted address, not a fresh DNS result.');
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{}', remoteAddress: pinned.address
      };
    },
    record: (...args) => {
      calls.audits.push(args);
      if (suppliedRecord) return suppliedRecord(...args);
    },
    ...rest
  };
  return { calls, dependencies };
}

(async () => {
  {
    const body = '{\n  "message": "hello 雪"\n}\n';
    const test = fixture();
    await httpRequest.request({
      method: 'POST', url: 'https://public.example.test/multiline', body
    }, test.dependencies);
    assert.equal(test.calls.transports[0].body, body, 'A UTF-8 body must retain JSON whitespace and line endings.');
    assert.equal(test.calls.transports[0].headers['content-length'], String(Buffer.byteLength(body)));
  }

  {
    const test = fixture({ transport: async () => ({
      status: 200, headers: { 'content-type': 'text/plain; charset="UTF-8"' },
      body: 'hello 雪 😀 \ufffd', remoteAddress: PUBLIC_IP
    }) });
    const output = await httpRequest.request({ method: 'GET', url: 'https://public.example.test/quoted-charset' }, test.dependencies);
    assert.equal(output.body, 'hello 雪 😀 \ufffd', 'Quoted UTF-8 charset values and valid literal replacement characters must be retained.');
  }

  {
    const test = fixture({ transport: async () => ({
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from([0x61, 0xc3, 0x28]), remoteAddress: PUBLIC_IP
    }) });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://public.example.test/invalid-utf8' }, test.dependencies),
      error => error && error.code === 'HTTP_RESPONSE_DECODE_FAILED',
      'Invalid response bytes must not be silently replaced and reported as an intact successful body.'
    );
  }

  {
    const test = fixture({ transport: async () => ({
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'abc雪z', remoteAddress: PUBLIC_IP
    }) });
    const output = await httpRequest.request({
      method: 'GET', url: 'https://public.example.test/utf8-prefix', maxResponseBytes: 5
    }, test.dependencies);
    assert.equal(output.body, 'abc', 'A byte cap inside a character returns only the complete UTF-8 prefix.');
    assert.equal(output.truncated, true);
    assert.equal(output.bytes, 5);
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        const reflected = [
          `literal=${SECRET}`,
          `base64=${Buffer.from(SECRET, 'utf8').toString('base64')}`,
          `encoded=${encodeURIComponent(SECRET)}`
        ].join('\n');
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', etag: SECRET },
          body: zlib.gzipSync(Buffer.from(reflected, 'utf8')),
          remoteAddress: pinned.address
        };
      }
    });
    const output = await httpRequest.request({
      method: 'GET', url: 'https://api.example.test/v1/profile?filter=recent', vaultKey: 'fixture_bearer'
    }, test.dependencies);
    assert.equal(test.calls.active[0], 'http.request');
    assert.equal(test.calls.secrets[0], 'fixture_bearer');
    assert.equal(test.calls.transports[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(output.status, 200);
    assert.equal(output.contentTrust, 'untrusted');
    assert.equal(output.grantsAuthority, false);
    assert.match(output.body, /\[REDACTED\]/);
    assert.equal(output.body.includes(SECRET), false);
    assert.equal(output.body.includes(Buffer.from(SECRET, 'utf8').toString('base64')), false);
    assert.equal(output.body.includes(encodeURIComponent(SECRET)), false);
    assert.equal(output.headers.etag, '[REDACTED]');
    const audit = test.calls.audits.find(entry => entry[0] === 'http.request');
    assert.equal(audit[1], 'api.example.test');
    assert.equal(audit[2].vaultKey, 'fixture_bearer');
    assert.equal(audit[2].path, '/v1/profile');
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(audit), /filter=recent/);
  }

  {
    const test = fixture();
    await httpRequest.request({ method: 'GET', url: 'https://api.example.test/header', vaultKey: 'fixture_header', authStyle: 'header:X-Api-Key' }, test.dependencies);
    assert.equal(test.calls.transports[0].headers['x-api-key'], SECRET);
  }

  {
    const test = fixture();
    await httpRequest.request({ method: 'GET', url: 'https://api.example.test/query', vaultKey: 'fixture_query' }, test.dependencies);
    assert.equal(test.calls.transports[0].url.searchParams.get('api_key'), SECRET);
  }

  {
    const test = fixture();
    const output = await httpRequest.request({ method: 'GET', url: 'https://public.example.test/health' }, test.dependencies);
    assert.equal(output.status, 200);
    assert.equal(test.calls.secrets.length, 0, 'Uncredentialed allowlisted calls must never read the vault.');
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/header', vaultKey: 'fixture_header', authStyle: 'bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_AUTH_STYLE_MISMATCH'
    );
    assert.equal(test.calls.secrets.length, 0);
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/', vaultKey: 'fixture_bearer', headers: { Authorization: 'Bearer caller-secret' } }, test.dependencies),
      error => error && error.code === 'HTTP_CALLER_CREDENTIAL_FORBIDDEN'
    );
    assert.equal(test.calls.secrets.length, 0);
    assert.equal(test.calls.transports.length, 0);
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'POST', url: 'https://api.example.test/', vaultKey: 'fixture_bearer', headers: { 'x-note': SECRET }, body: `value=${SECRET}` }, test.dependencies),
      error => error && error.code === 'HTTP_CALLER_CREDENTIAL_FORBIDDEN'
    );
    assert.equal(test.calls.transports.length, 0);
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/?api_key=caller-secret', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_CALLER_CREDENTIAL_FORBIDDEN'
    );
    assert.equal(test.calls.secrets.length, 0);
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://off-allowlist.example.test/', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_HOST_NOT_ALLOWED'
    );
    assert.equal(test.calls.secrets.length, 0);
    assert.equal(test.calls.resolves.length, 0);
  }

  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fe80::1']) {
    const test = fixture({ resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/private', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN'
    );
    assert.equal(test.calls.transports.length, 0, `${address} must be refused before a connection starts.`);
  }

  {
    const test = fixture();
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'http://api.example.test/downgrade', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_HTTPS_REQUIRED'
    );
    assert.equal(test.calls.transports.length, 0);
  }

  {
    let resolutionCount = 0;
    const test = fixture({
      resolve: async hostname => {
        resolutionCount += 1;
        return [{ address: resolutionCount === 1 ? PUBLIC_IP : '169.254.169.254', family: 4, hostname }];
      },
      transport: async spec => {
        const pinned = await lookup(spec);
        assert.equal(resolutionCount, 1, 'A connection must not perform a second mutable DNS lookup.');
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'pinned', remoteAddress: pinned.address };
      }
    });
    const output = await httpRequest.request({ method: 'GET', url: 'https://api.example.test/rebind', vaultKey: 'fixture_bearer' }, test.dependencies);
    assert.equal(output.body, 'pinned');
    assert.equal(resolutionCount, 1);
  }

  {
    const test = fixture({
      transport: async () => ({
        status: 200, headers: { 'content-type': 'text/plain' }, body: 'should not arrive', remoteAddress: '169.254.169.254'
      })
    });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/rebind-mismatch', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_DNS_REBIND_BLOCKED'
    );
  }

  {
    const test = fixture({
      transport: async () => { throw new Error(`failed at https://api.example.test/?token=${SECRET}`); }
    });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/transport-failure', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_CONNECTION_FAILED' && !error.message.includes(SECRET)
    );
    assert.doesNotMatch(JSON.stringify(test.calls.audits), new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  {
    let phase = 0;
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        assert.equal(spec.url.searchParams.get('api_key'), SECRET, 'Query credentials must be re-injected on each same-host redirect.');
        phase += 1;
        if (phase === 1) return { status: 302, headers: { location: '/next?token=do-not-return' }, body: '', remoteAddress: pinned.address };
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'redirect complete', remoteAddress: pinned.address };
      }
    });
    const output = await httpRequest.request({ method: 'GET', url: 'https://api.example.test/start', vaultKey: 'fixture_query' }, test.dependencies);
    assert.equal(output.body, 'redirect complete');
    assert.equal(phase, 2);
    assert.equal(test.calls.resolves.length, 2, 'Every followed same-host redirect must be re-vetted.');
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        return {
          status: 302,
          headers: { location: `https://other.example.test/${encodeURIComponent(SECRET)}?token=never-return` },
          body: 'ignored redirect body', remoteAddress: pinned.address
        };
      }
    });
    const output = await httpRequest.request({ method: 'GET', url: 'https://api.example.test/cross-host', vaultKey: 'fixture_bearer' }, test.dependencies);
    assert.equal(output.status, 302);
    assert.equal(output.headers.location, 'https://other.example.test/[REDACTED]');
    assert.equal(output.body, '');
    assert.equal(test.calls.resolves.length, 1, 'Cross-host redirects must be returned, not followed.');
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        return {
          status: 302,
          headers: { location: 'https://[invalid' },
          body: 'must not become a successful empty redirect response', remoteAddress: pinned.address
        };
      }
    });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/invalid-redirect', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_REDIRECT_INVALID'
    );
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(100), remoteAddress: pinned.address };
      }
    });
    const output = await httpRequest.request({ method: 'GET', url: 'https://api.example.test/bounded', vaultKey: 'fixture_bearer', maxResponseBytes: 10 }, test.dependencies);
    assert.equal(output.bytes, 10);
    assert.equal(output.truncated, true);
    assert.equal(output.body, 'x'.repeat(10));
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: `safe-${SECRET}`, remoteAddress: pinned.address };
      }
    });
    const output = await httpRequest.request({ method: 'GET', url: 'https://api.example.test/partial-secret', vaultKey: 'fixture_bearer', maxResponseBytes: 10 }, test.dependencies);
    assert.equal(output.truncated, true);
    assert.equal(output.body, 'safe-');
    assert.equal(output.body.includes(SECRET.slice(0, 5)), false, 'A cap boundary must not reveal a secret prefix.');
  }

  {
    const test = fixture({
      transport: async spec => {
        const pinned = await lookup(spec);
        return { status: 200, headers: { 'content-type': 'image/png' }, body: 'not text', remoteAddress: pinned.address };
      }
    });
    await assert.rejects(
      httpRequest.request({ method: 'GET', url: 'https://api.example.test/binary', vaultKey: 'fixture_bearer' }, test.dependencies),
      error => error && error.code === 'HTTP_UNSUPPORTED_CONTENT_TYPE'
    );
  }

  async function refuses(code, value, overrides = {}, expected = {}) {
    const test = fixture(overrides);
    await assert.rejects(httpRequest.request(value, test.dependencies), error => error && error.code === code);
    assert.equal(test.calls.transports.length, expected.transports || 0, `${code}: transport call count`);
    assert.equal(test.calls.resolves.length, expected.resolves || 0, `${code}: DNS resolution count`);
    assert.equal(test.calls.secrets.length, expected.secrets || 0, `${code}: vault read count`);
    assert.equal(test.calls.audits.length, expected.audits || 0, `${code}: audit write count`);
    if (expected.audits) assert.equal(test.calls.audits[0][2].errorCode, code, `${code}: refusal audit code`);
  }

  await refuses('HTTP_INPUT_INVALID', null);
  await refuses('HTTP_METHOD_INVALID', { method: 'TRACE', url: 'https://public.example.test/' });
  await refuses('HTTP_URL_INVALID', { method: 'GET', url: 'not a URL' });
  await refuses('HTTP_HEADERS_INVALID', {
    method: 'GET', url: 'https://public.example.test/', headers: { 'bad header': 'value' }
  });
  await refuses('HTTP_BODY_TOO_LARGE', {
    method: 'POST', url: 'https://public.example.test/', body: '\u00e9'.repeat(httpRequest.MAX_REQUEST_BODY_BYTES / 2 + 1)
  });
  await refuses('HTTP_RESPONSE_LIMIT_INVALID', {
    method: 'GET', url: 'https://public.example.test/', maxResponseBytes: 0
  });
  await refuses('HTTP_AUTH_STYLE_FORBIDDEN', {
    method: 'GET', url: 'https://public.example.test/', authStyle: 'bearer'
  }, {}, { audits: 1 });
  await refuses('HTTP_VAULT_KEY_NOT_ALLOWED', {
    method: 'GET', url: 'https://api.example.test/', vaultKey: 'missing_key'
  }, {}, { audits: 1 });
  await refuses('HTTP_VAULT_SECRET_UNAVAILABLE', {
    method: 'GET', url: 'https://api.example.test/', vaultKey: 'fixture_bearer'
  }, { getSecret: () => '' }, { secrets: 1, audits: 1 });

  const unsafePolicy = {
    ...POLICY,
    http: { ...POLICY.http, vaultKeys: { unsafe: { hosts: ['api.example.test'], authStyle: 'header:Host' } } }
  };
  await refuses('HTTP_POLICY_AUTH_STYLE_FORBIDDEN', {
    method: 'GET', url: 'https://api.example.test/', vaultKey: 'unsafe'
  }, { policy: unsafePolicy }, { secrets: 1, audits: 1 });

  await refuses('HTTP_RESPONSE_INVALID', {
    method: 'GET', url: 'https://public.example.test/'
  }, { transport: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: {}, remoteAddress: PUBLIC_IP }) },
  { transports: 1, resolves: 1, audits: 1 });

  await refuses('HTTP_UNSUPPORTED_CONTENT_ENCODING', {
    method: 'GET', url: 'https://public.example.test/'
  }, { transport: async () => ({
    status: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'br' }, body: 'encoded', remoteAddress: PUBLIC_IP
  }) }, { transports: 1, resolves: 1, audits: 1 });

  await refuses('HTTP_RESPONSE_DECODE_FAILED', {
    method: 'GET', url: 'https://public.example.test/'
  }, { transport: async () => ({
    status: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, body: 'not gzip', remoteAddress: PUBLIC_IP
  }) }, { transports: 1, resolves: 1, audits: 1 });

  assert.throws(() => httpConfiguration({ http: { allowedHosts: ['api.example.test'], unsupported: true } }), /unsupported property/);
  assert.throws(() => httpConfiguration({ http: { vaultKeys: { fixture: { hosts: [], authStyle: 'bearer' } } } }), /must not be empty/);
  assert.equal(ssrf.isPublicAddress(PUBLIC_IP), true);
  assert.equal(ssrf.isPublicAddress('169.254.169.254'), false);

  const tool = getTool('http.request');
  assert.equal(tool.effect, 'external-write');
  assert.equal(tool.approvalEligible, true);
  assert.equal(tool.inputSchema.properties.headers.additionalProperties.type, 'string');
  assert.ok(tool.inputSchema.properties.approvalToken);

  console.log('Vault-sealed HTTP request tests passed.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
