/* Mutation check:
 * Changed `if (!remote || !expected || remote !== expected)` in ssrf-guard.js
 * to `if (false && (!remote || !expected || remote !== expected))`.
 * The mutation landed: yes. This isolated test went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const guard = require('../src/lib/ssrf-guard');

let checks = 0;

function check(label, assertion) {
  assertion();
  checks += 1;
  void label;
}

async function checkAsync(label, assertion) {
  await assertion();
  checks += 1;
  void label;
}

(async () => {
  check('hostnames are normalized for DNS and URL comparisons', () => {
    assert.equal(guard.normalizedHostname('  [2001:DB8::1]  '), '2001:db8::1');
    assert.equal(guard.normalizedHostname('Example.COM.'), 'example.com');
    assert.equal(guard.sameHost('https://EXAMPLE.com/a', 'https://example.com:443/b'), true);
    assert.equal(guard.sameHost('https://example.com', 'http://example.com'), false);
  });

  check('only publicly routable IPv4 and IPv6 values are accepted', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.equal(guard.isPublicAddress(address), true, `${address} should be public`);
      assert.equal(guard.assertPublicAddress(address), address);
    }
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(guard.isPublicAddress(address), false, `${address} should be forbidden`);
      assert.throws(() => guard.assertPublicAddress(address), error =>
        error instanceof guard.SsrfGuardError && error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN');
    }
  });

  check('IPv6 transition and special-purpose ranges inside 2000::/3 are not public', () => {
    /* 2000::/3 IS GLOBAL UNICAST, BUT NOT ALL OF IT IS A DESTINATION.
       6to4 was already refused here with its reason written down -- it embeds an
       IPv4 route -- and that reason applies word for word to Teredo, which was
       not refused. A Teredo address carries an IPv4 server and an obfuscated
       client IPv4 and tunnels IPv6 over IPv4, so admitting one admits whatever
       IPv4 destination it encodes AFTER every IPv4 rule has been passed over.
       Measured 2026-08-27, before this: 2001:0:5ef5:79fd:: was accepted as public
       while 2002:7f00:1:: was refused, on identical grounds. */
    for (const [address, what] of [
      ['2001:0:5ef5:79fd::', 'Teredo 2001::/32 -- tunnels IPv6 over an embedded IPv4'],
      ['2001:20::1', 'ORCHIDv2 2001:20::/28 -- not a routable destination'],
      ['2001:db8::1', 'documentation 2001:db8::/32'],
      ['2002:7f00:1::', '6to4 embedding 127.0.0.1'],
    ]) {
      assert.equal(guard.isPublicAddress(address), false, `${address} accepted as public: ${what}`);
      assert.throws(() => guard.assertPublicAddress(address), error =>
        error instanceof guard.SsrfGuardError && error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN');
    }

    /* THE CONTROLS, AND THEY ARE THE POINT. 2001::/16 contains an enormous amount
       of real address space -- Google's resolver is 2001:4860:4860::8888 -- so a
       rule written as "refuse anything starting 2001" would pass every assertion
       above while blackholing a large part of the routable internet. These fail
       the moment the refusal is written too wide. */
    for (const address of ['2001:4860:4860::8888', '2400:cb00::1', '2600:1f18::1', '2606:4700:4700::1111']) {
      assert.equal(guard.isPublicAddress(address), true, `${address} is real routable space and was refused`);
    }
  });

  check('comparable addresses canonicalize IPv6 and IPv4-mapped IPv6', () => {
    assert.equal(guard.comparableAddress('2606:4700:4700::1111'),
      '6:2606:4700:4700:0000:0000:0000:0000:1111');
    assert.equal(guard.comparableAddress('::ffff:8.8.8.8'), '4:8.8.8.8');
    assert.equal(guard.comparableAddress('not-an-address'), null);
  });

  await checkAsync('DNS results are validated and retain their address families', async () => {
    const addresses = await guard.resolveAddresses('Example.COM.', {
      resolve: async (hostname, options) => {
        assert.equal(hostname, 'example.com');
        assert.deepEqual(options, { all: true, verbatim: true });
        return [{ address: '2606:4700:4700::1111' }, { address: '8.8.8.8' }];
      }
    });
    assert.deepEqual(addresses, [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '8.8.8.8', family: 4 }
    ]);
    await assert.rejects(
      guard.resolveAddresses('internal.example', { resolve: async () => [{ address: '127.0.0.1' }] }),
      error => error.code === 'HTTP_SSRF_ADDRESS_FORBIDDEN'
    );
  });

  await checkAsync('targets enforce HTTPS URL safety and pin the preferred public IPv4 result', async () => {
    const dependencies = {
      resolve: async () => [
        { address: '2606:4700:4700::1111' },
        { address: '8.8.8.8' }
      ]
    };
    const target = await guard.resolveTarget('https://Example.COM./path?q=1', dependencies);
    assert.equal(target.hostname, 'example.com');
    assert.equal(target.address, '8.8.8.8');
    assert.equal(target.family, 4);
    assert.equal(target.port, 443);

    await assert.rejects(guard.resolveTarget('http://example.com', dependencies), error => error.code === 'HTTP_HTTPS_REQUIRED');
    await assert.rejects(guard.resolveTarget('https://user:pass@example.com', dependencies), error => error.code === 'HTTP_URL_CREDENTIALS_FORBIDDEN');
    await assert.rejects(guard.resolveTarget('https://example.com:444', dependencies), error => error.code === 'HTTP_PORT_FORBIDDEN');
  });

  await checkAsync('the pinned lookup refuses host and family changes', async () => {
    const target = await guard.resolveTarget('https://example.com', {
      resolve: async () => [{ address: '8.8.8.8' }]
    });
    const lookup = (hostname, options) => new Promise((resolve, reject) => {
      target.lookup(hostname, options, (error, address, family) => error ? reject(error) : resolve({ address, family }));
    });
    assert.deepEqual(await lookup('EXAMPLE.COM.', { family: 4 }), { address: '8.8.8.8', family: 4 });
    await assert.rejects(lookup('attacker.example', { family: 4 }), error => error.code === 'HTTP_DNS_REBIND_BLOCKED');
    await assert.rejects(lookup('example.com', { family: 6 }), error => error.code === 'HTTP_DNS_REBIND_BLOCKED');
  });

  check('the connected peer must equal the vetted address', () => {
    assert.equal(guard.assertPinnedRemote('8.8.8.8', { address: '8.8.8.8' }), undefined);
    assert.throws(() => guard.assertPinnedRemote('1.1.1.1', { address: '8.8.8.8' }),
      error => error.code === 'HTTP_DNS_REBIND_BLOCKED');
  });

  await checkAsync('custom transports are given the pin and return normalized headers', async () => {
    const target = await guard.resolveTarget('https://example.com/resource', {
      resolve: async () => [{ address: '8.8.8.8' }]
    });
    const response = await guard.requestPinned(target, {
      method: 'POST', headers: { Accept: 'application/json' }, body: 'payload', timeoutMs: 500
    }, {
      transport: async request => {
        assert.equal(request.hostname, 'example.com');
        assert.equal(request.address, '8.8.8.8');
        assert.equal(request.method, 'POST');
        assert.equal(request.body, 'payload');
        return { status: 201, headers: { 'X-Items': ['one', 'two'] }, remoteAddress: '8.8.8.8', body: 'ok' };
      }
    });
    assert.equal(response.status, 201);
    assert.deepEqual(response.headers, { 'x-items': 'one, two' });
    assert.equal(response.body, 'ok');
  });

  check('guard errors expose stable type, name, code, and message', () => {
    const error = guard.guardError('EXAMPLE_CODE', 'example message');
    assert.equal(error instanceof guard.SsrfGuardError, true);
    assert.equal(error.name, 'SsrfGuardError');
    assert.equal(error.code, 'EXAMPLE_CODE');
    assert.equal(error.message, 'example message');
  });

  console.log(`SSRF guard tests passed (${checks} checks).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
