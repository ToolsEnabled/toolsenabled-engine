'use strict';

// Shared HTTPS/DNS-pinning primitives for outward fetchers. A host allowlist is
// necessary but insufficient: the socket itself must be pinned to a vetted public
// address so a DNS answer cannot change between validation and connection.
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

class SsrfGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SsrfGuardError';
    this.code = code;
  }
}

function guardError(code, message) {
  return new SsrfGuardError(code, message);
}

function normalizedHostname(value) {
  let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

function ipv4Parts(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split('.').map(part => Number(part));
}

function expandedIpv6(value) {
  const source = String(value || '').toLowerCase().split('%')[0];
  if (net.isIP(source) !== 6) return null;
  let normalized = source;
  const lastColon = normalized.lastIndexOf(':');
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = ipv4Parts(tail);
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => group.padStart(4, '0'));
}

function mappedIpv4(groups) {
  if (!groups || groups.length !== 8 || !groups.slice(0, 5).every(group => group === '0000') || groups[5] !== 'ffff') return null;
  const upper = Number.parseInt(groups[6], 16);
  const lower = Number.parseInt(groups[7], 16);
  return [upper >> 8, upper & 0xff, lower >> 8, lower & 0xff].join('.');
}

function publicIpv4(parts) {
  if (!parts || parts.length !== 4) return false;
  const [first, second, third] = parts;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function publicIpv6(groups) {
  if (!groups) return false;
  const mapped = mappedIpv4(groups);
  if (mapped) return publicIpv4(ipv4Parts(mapped));
  const first = Number.parseInt(groups[0], 16);
  const allZero = groups.every(group => group === '0000');
  const loopback = groups.slice(0, 7).every(group => group === '0000') && groups[7] === '0001';
  if (allZero || loopback) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  // Global unicast is 2000::/3. Refusing other special-purpose ranges keeps
  // the broker from becoming a route to local, documentation, or transition nets.
  if (first < 0x2000 || first > 0x3fff) return false;
  /* THE TRANSITION AND SPECIAL-PURPOSE RANGES INSIDE 2000::/3, which is otherwise
     global unicast. 6to4 was already here with its reason written down -- "6to4
     embeds an IPv4 route" -- and that reason applies word for word to Teredo,
     which was not. A Teredo address carries an IPv4 server and an obfuscated
     client IPv4 inside it and tunnels IPv6 over IPv4, so admitting one is
     admitting whatever IPv4 destination it encodes, after every IPv4 rule above
     has been passed over. Measured 2026-08-27: 2001:0:5ef5:79fd:: was accepted as
     public while 2002:7f00:1:: was refused, on identical grounds.
     2001::/23 is the IETF protocol-assignment block (RFC 6890) and covers Teredo
     at 2001::/32 and ORCHIDv2 at 2001:20::/28; 2001:db8::/32 is documentation and
     sits outside it, so it is named separately. None of these is a destination a
     broker should reach, and each was accepted before this line. */
  const second = Number.parseInt(groups[1], 16);
  if (first === 0x2002) return false;                      // 6to4, embeds an IPv4 route
  if (first === 0x2001 && second <= 0x01ff) return false;   // 2001::/23 IETF protocol assignments (Teredo, ORCHIDv2)
  if (first === 0x2001 && second === 0x0db8) return false;  // 2001:db8::/32 documentation
  return true;
}

function isPublicAddress(address) {
  const value = String(address || '').split('%')[0];
  const family = net.isIP(value);
  if (family === 4) return publicIpv4(ipv4Parts(value));
  if (family === 6) return publicIpv6(expandedIpv6(value));
  return false;
}

function comparableAddress(address) {
  const value = String(address || '').split('%')[0].toLowerCase();
  if (net.isIP(value) === 4) return `4:${value}`;
  const groups = expandedIpv6(value);
  if (!groups) return null;
  const mapped = mappedIpv4(groups);
  return mapped ? `4:${mapped}` : `6:${groups.join(':')}`;
}

function assertPublicAddress(address) {
  if (!isPublicAddress(address)) throw guardError('HTTP_SSRF_ADDRESS_FORBIDDEN', 'The resolved address is not publicly routable.');
  return address;
}

async function resolveAddresses(hostname, dependencies = {}) {
  const host = normalizedHostname(hostname);
  if (!host) throw guardError('HTTP_HOST_INVALID', 'The HTTPS URL host is invalid.');
  if (net.isIP(host)) return [{ address: assertPublicAddress(host), family: net.isIP(host) }];
  const resolver = dependencies.resolve || dns.promises.lookup;
  let raw;
  try {
    raw = await resolver(host, { all: true, verbatim: true });
  } catch {
    throw guardError('HTTP_DNS_LOOKUP_FAILED', 'The HTTPS host could not be resolved.');
  }
  const values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  if (!values.length) throw guardError('HTTP_DNS_NO_ADDRESS', 'The HTTPS host did not resolve to an address.');
  const addresses = [];
  for (const item of values) {
    const address = typeof item === 'string' ? item : item && item.address;
    const family = net.isIP(address || '');
    if (!family) throw guardError('HTTP_DNS_INVALID_ADDRESS', 'The HTTPS host returned an invalid address.');
    assertPublicAddress(address);
    addresses.push({ address: String(address), family });
  }
  return addresses;
}

function pinnedLookup(target) {
  return (hostname, options, callback) => {
    let done = callback;
    let requested = options;
    if (typeof options === 'function') { done = options; requested = {}; }
    if (normalizedHostname(hostname) !== target.hostname) {
      done(guardError('HTTP_DNS_REBIND_BLOCKED', 'The connection host differed from the vetted HTTPS host.'));
      return;
    }
    const family = requested && Number(requested.family);
    if (family && family !== target.family) {
      done(guardError('HTTP_DNS_REBIND_BLOCKED', 'The connection requested an unvetted address family.'));
      return;
    }
    done(null, target.address, target.family);
  };
}

function defaultPort(protocol) {
  return protocol === 'http:' ? '80' : '443';
}

// HTTPS remains the default and is the only protocol used by the generic
// vault HTTP broker. A separate caller can explicitly opt into plain HTTP for
// a tightly scoped use case while retaining DNS pinning and address checks.
async function resolveTarget(value, dependencies = {}, options = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value.toString()) : new URL(String(value)); }
  catch { throw guardError('HTTP_URL_INVALID', 'url must be a valid HTTPS URL.'); }
  const allowHttp = options && options.allowHttp === true;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw guardError('HTTP_HTTPS_REQUIRED', 'url must use HTTPS.');
  }
  if (url.username || url.password) throw guardError('HTTP_URL_CREDENTIALS_FORBIDDEN', 'url must not contain embedded credentials.');
  if (url.port && url.port !== defaultPort(url.protocol)) {
    throw guardError('HTTP_PORT_FORBIDDEN', 'url may use only its default protocol port.');
  }
  const hostname = normalizedHostname(url.hostname);
  const addresses = await resolveAddresses(hostname, dependencies);
  // Prefer a vetted IPv4 address when both families are available. The pinning
  // guarantee is identical, while many local Windows setups have IPv6 DNS but
  // no reliable IPv6 egress.
  const selected = addresses.find(item => item.family === 4) || addresses[0];
  const target = {
    url, hostname, address: selected.address, family: selected.family,
    port: Number(url.port || defaultPort(url.protocol))
  };
  target.lookup = pinnedLookup(target);
  return target;
}

function assertPinnedRemote(remoteAddress, target) {
  const remote = comparableAddress(remoteAddress);
  const expected = comparableAddress(target && target.address);
  if (!remote || !expected || remote !== expected) {
    throw guardError('HTTP_DNS_REBIND_BLOCKED', 'The HTTPS socket did not connect to the vetted address.');
  }
}

function safeHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== 'object') return result;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.map(item => String(item)).join(', ') : String(value);
  }
  return result;
}

function connectionError(error) {
  if (error instanceof SsrfGuardError) return error;
  if (error && error.code === 'HTTP_TIMEOUT') return guardError('HTTP_TIMEOUT', 'The HTTPS request timed out.');
  return guardError('HTTP_CONNECTION_FAILED', 'The HTTPS connection failed.');
}

function nodeTransport(target, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      fn(value);
    };
    const client = target.url.protocol === 'http:' ? http : https;
    const requestOptions = {
      protocol: target.url.protocol, hostname: target.hostname, port: target.port || Number(defaultPort(target.url.protocol)),
      path: `${target.url.pathname}${target.url.search}`,
      method: options.method, headers: options.headers,
      lookup: target.lookup, family: target.family, agent: false,
      signal: options.signal
    };
    if (target.url.protocol === 'https:') {
      requestOptions.servername = net.isIP(target.hostname) ? undefined : target.hostname;
      requestOptions.rejectUnauthorized = true;
    }
    const request = client.request(requestOptions, response => {
      try {
        assertPinnedRemote(response.socket && response.socket.remoteAddress, target);
        finish(resolve, {
          status: response.statusCode,
          headers: safeHeaders(response.headers),
          stream: response,
          remoteAddress: response.socket && response.socket.remoteAddress
        });
      } catch (error) {
        response.destroy();
        finish(reject, error);
      }
    });
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 1);
    deadlineTimer = setTimeout(() => request.destroy(guardError('HTTP_TIMEOUT', 'The HTTPS request timed out.')), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(guardError('HTTP_TIMEOUT', 'The HTTPS request timed out.')));
    request.once('error', error => finish(reject, connectionError(error)));
    if (options.body === undefined || options.body === null || options.body === '') request.end();
    else request.end(options.body);
  });
}

async function requestPinned(target, options = {}, dependencies = {}) {
  try {
    if (typeof dependencies.transport === 'function') {
      const result = await dependencies.transport({
        url: target.url, hostname: target.hostname, address: target.address, family: target.family,
        lookup: target.lookup, method: options.method, headers: options.headers, body: options.body, timeoutMs: options.timeoutMs,
        signal: options.signal
      });
      if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
        throw guardError('HTTP_RESPONSE_INVALID', 'The HTTPS transport returned an invalid response.');
      }
      assertPinnedRemote(result.remoteAddress, target);
      return { ...result, headers: safeHeaders(result.headers) };
    }
    return await nodeTransport(target, options);
  } catch (error) {
    throw connectionError(error);
  }
}

function sameHost(left, right) {
  try {
    const a = left instanceof URL ? left : new URL(String(left));
    const b = right instanceof URL ? right : new URL(String(right));
    return a.protocol === b.protocol && normalizedHostname(a.hostname) === normalizedHostname(b.hostname)
      && (a.port || defaultPort(a.protocol)) === (b.port || defaultPort(b.protocol));
  } catch {
    throw guardError('HTTP_URL_INVALID', 'Both URLs must be valid before their hosts can be compared.');
  }
}

module.exports = {
  SsrfGuardError,
  assertPinnedRemote,
  assertPublicAddress,
  comparableAddress,
  guardError,
  isPublicAddress,
  normalizedHostname,
  requestPinned,
  resolveAddresses,
  resolveTarget,
  sameHost
};
