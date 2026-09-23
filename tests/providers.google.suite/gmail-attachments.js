'use strict';

// Gmail attachment support (multipart/mixed) and — the load-bearing half —
// proof that every message WITHOUT an attachment is still byte-for-byte what
// the pre-attachment implementation produced. The agent-digest email path is
// an existing caller and must not shift by a single byte.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const google = require('../../src/lib/providers/google');

const googleModulePath = require.resolve('../../src/lib/providers/google');
const providerRoot = path.dirname(googleModulePath);

function loadGoogleWithFailedTransport(record) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent && path.dirname(parent.filename) === providerRoot) {
      if (request === '../policy') return { assertActive() {} };
      if (request === '../audit') return { record };
      if (request === '../google-accounts') return { oauthKeysFor() { return { account: 'attachment-audit-test' }; } };
      if (request === '../google-oauth') {
        return { authenticatedRequest: async () => { throw new Error('synthetic send failure'); } };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[googleModulePath];
  try { return require('../../src/lib/providers/google'); }
  finally { Module._load = originalLoad; }
}

// ---------------------------------------------------------------------------
// The oracle: a verbatim copy of buildMimeEmail as it existed BEFORE attachment
// support was added. Copied, not imported, so the comparison stays valid even
// as the live implementation is refactored further.
// ---------------------------------------------------------------------------
function legacyEncodeBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function legacyBuildMimeEmail({ to, subject, cc = '', bcc = '', text = '', html = null }) {
  const lines = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0'];
  if (cc) lines.splice(1, 0, `Cc: ${cc}`);
  if (bcc) lines.splice(1, 0, `Bcc: ${bcc}`);
  if (html === null || html === undefined) {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    return legacyEncodeBase64Url(`${lines.join('\r\n')}\r\n\r\n${text || ''}`);
  }
  if (typeof html !== 'string') throw new Error('html must be a string when provided.');
  let boundary = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `=_toolsenabled_${crypto.randomBytes(12).toString('hex')}`;
    if (!String(text || '').includes(candidate) && !html.includes(candidate)) { boundary = candidate; break; }
  }
  if (!boundary) throw new Error('Could not choose a safe MIME boundary.');
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text || '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
    ''
  ].join('\r\n');
  return legacyEncodeBase64Url(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

const decode = raw => Buffer.from(raw, 'base64url').toString('utf8');
const BOUNDARY_TOKEN = /=_toolsenabled_[a-f0-9]{24}/g;
const normalizeBoundaries = message => message.replace(BOUNDARY_TOKEN, '=_BOUNDARY_');

function headerValue(message, name) {
  const match = new RegExp(`^${name}: (.*)$`, 'mi').exec(message.split('\r\n\r\n')[0]);
  return match ? match[1] : null;
}

// Minimal multipart splitter: returns the raw text of each part between
// --boundary delimiters, per RFC 2046.
function splitParts(body, boundary) {
  const open = `--${boundary}\r\n`;
  const close = `--${boundary}--`;
  const start = body.indexOf(open);
  assert.notEqual(start, -1, 'opening boundary delimiter missing');
  const end = body.indexOf(close);
  assert.notEqual(end, -1, 'closing boundary delimiter missing');
  return body.slice(start, end).split(`--${boundary}\r\n`).slice(1)
    .map(part => part.replace(/\r\n$/, ''));
}

function splitPartHeaders(part) {
  const separator = part.indexOf('\r\n\r\n');
  assert.notEqual(separator, -1, 'part is missing its header/body separator');
  return { headers: part.slice(0, separator), body: part.slice(separator + 4) };
}

let checks = 0;
const ok = label => { checks += 1; console.log(`  ok  ${label}`); };

const tempDir = fs.mkdtempSync(path.join(process.platform === 'linux' ? os.userInfo().homedir : os.tmpdir(), '.toolsenabled-gmail-attach-'));
const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } };

try {
  // =========================================================================
  // 1. The existing (no-attachment) path is byte-for-byte unchanged.
  // =========================================================================
  const matrix = [
    { label: 'plain text', to: 'a@example.com', subject: 'Status', text: 'Body' },
    { label: 'plain text, empty body', to: 'a@example.com', subject: 'Status', text: '' },
    { label: 'plain text, no body key', to: 'a@example.com', subject: 'Status' },
    { label: 'plain text with cc', to: 'a@example.com', subject: 'S', text: 'B', cc: 'c@example.com' },
    { label: 'plain text with bcc', to: 'a@example.com', subject: 'S', text: 'B', bcc: 'd@example.com' },
    { label: 'plain text with cc+bcc', to: 'a@example.com', subject: 'S', text: 'B', cc: 'c@example.com', bcc: 'd@example.com' },
    { label: 'plain text, unicode body', to: 'a@example.com', subject: 'S', text: 'héllo — wörld 🚀\r\nline two' },
    { label: 'plain text, multiline', to: 'a@e.com, b@e.com', subject: 'S', text: 'one\r\ntwo\r\nthree' }
  ];

  for (const entry of matrix) {
    const { label, ...input } = entry;
    // No boundary is generated on this branch, so equality is literal.
    assert.equal(google.buildMimeEmail(input), legacyBuildMimeEmail(input), `plain-text output drifted for: ${label}`);
    ok(`byte-identical to legacy — ${label}`);
  }

  // The agent-digest message shape: text + HTML, no attachment. A fresh random
  // boundary is generated per call, so equality is asserted modulo that one
  // token — everything else must match exactly.
  const digestShaped = [
    { label: 'digest text+html', to: 'owner@example.com', subject: 'Agent digest', text: 'Metric: 42', html: '<!doctype html><html><body><strong>Metric</strong>: 42</body></html>' },
    { label: 'text+html with cc/bcc', to: 'owner@example.com', subject: 'D', text: 'T', html: '<p>H</p>', cc: 'c@example.com', bcc: 'd@example.com' },
    { label: 'text+html, unicode', to: 'owner@example.com', subject: 'D', text: 'héllo 🚀', html: '<p>héllo 🚀</p>' },
    { label: 'text+html, empty text', to: 'owner@example.com', subject: 'D', text: '', html: '<p>H</p>' }
  ];

  for (const entry of digestShaped) {
    const { label, ...input } = entry;
    const current = normalizeBoundaries(decode(google.buildMimeEmail(input)));
    const legacy = normalizeBoundaries(decode(legacyBuildMimeEmail(input)));
    assert.equal(current, legacy, `multipart/alternative output drifted for: ${label}`);
    ok(`byte-identical to legacy (boundary-normalized) — ${label}`);
  }

  // Explicitly: an absent, null, or empty attachments list all take the legacy path.
  const base = { to: 'a@example.com', subject: 'S', text: 'B' };
  for (const variant of [undefined, null, []]) {
    assert.equal(
      google.buildMimeEmail({ ...base, attachments: variant }),
      legacyBuildMimeEmail(base),
      `attachments=${JSON.stringify(variant)} must not change the message`
    );
  }
  ok('attachments undefined/null/[] all take the unchanged legacy path');

  // And the real digest caller's exact argument shape still yields no multipart/mixed.
  const digestRaw = google.buildMimeEmail({
    to: 'owner@example.com', subject: 'Agent digest', text: 'plain', html: '<p>rich</p>', attachments: null
  });
  assert.doesNotMatch(decode(digestRaw), /multipart\/mixed/);
  assert.match(decode(digestRaw), /multipart\/alternative/);
  ok('agent-digest argument shape still produces multipart/alternative, never mixed');

  // =========================================================================
  // 2. An attachment produces a valid, correctly-encoded multipart/mixed.
  // =========================================================================
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(4096), Buffer.from('\n%%EOF\n')]);
  const pdfPath = path.join(tempDir, 'LEAN-BENCH-AUDIT.pdf');
  fs.writeFileSync(pdfPath, pdfBytes);

  const mixedRaw = google.buildMimeEmail({
    to: 'print@example.com', subject: 'Print job', text: 'bw\r\n', attachments: [{ path: pdfPath }]
  });
  const mixed = decode(mixedRaw);
  const mixedBoundary = /boundary="(=_toolsenabled_[a-f0-9]{24})"/.exec(mixed)[1];

  assert.match(headerValue(mixed, 'Content-Type'), /^multipart\/mixed; boundary="=_toolsenabled_[a-f0-9]{24}"$/);
  assert.equal(headerValue(mixed, 'MIME-Version'), '1.0');
  ok('top-level Content-Type is multipart/mixed with a quoted boundary');

  const mixedBody = mixed.slice(mixed.indexOf('\r\n\r\n') + 4);
  const parts = splitParts(mixedBody, mixedBoundary);
  assert.equal(parts.length, 2, 'expected exactly a body part and one attachment part');

  const bodyPart = splitPartHeaders(parts[0]);
  assert.match(bodyPart.headers, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.equal(bodyPart.body, 'bw\r\n');
  ok('body part preserves the text/plain body exactly (first-line print settings intact)');

  const attachPart = splitPartHeaders(parts[1]);
  assert.match(attachPart.headers, /^Content-Type: application\/pdf; name="LEAN-BENCH-AUDIT\.pdf"$/m);
  assert.match(attachPart.headers, /^Content-Transfer-Encoding: base64$/m);
  assert.match(attachPart.headers, /^Content-Disposition: attachment; filename="LEAN-BENCH-AUDIT\.pdf"$/m);
  ok('attachment part carries Content-Type from the extension, base64 CTE, and a filename disposition');

  const decodedAttachment = Buffer.from(attachPart.body.replace(/\r\n/g, ''), 'base64');
  assert.ok(decodedAttachment.equals(pdfBytes), 'attachment bytes did not survive the round trip');
  ok(`attachment round-trips byte-exactly (${pdfBytes.length} bytes in, ${decodedAttachment.length} out)`);

  const base64Lines = attachPart.body.split('\r\n');
  assert.ok(base64Lines.every(line => line.length <= 76), 'a base64 line exceeded 76 characters');
  assert.ok(base64Lines.slice(0, -1).every(line => line.length === 76), 'base64 lines are not packed to 76 characters');
  ok(`base64 wrapped at 76 chars (${base64Lines.length} lines, longest ${Math.max(...base64Lines.map(l => l.length))})`);

  // The closing delimiter must be the terminal one, and CRLF must be used throughout.
  assert.ok(mixed.includes(`--${mixedBoundary}--\r\n`), 'missing terminal close-delimiter');
  assert.equal((mixed.match(/(?<!\r)\n/g) || []).length, 0, 'found a bare LF; MIME requires CRLF');
  ok('CRLF line endings throughout and a terminal close-delimiter');

  // text+html+attachment nests multipart/alternative inside multipart/mixed.
  const nestedRaw = google.buildMimeEmail({
    to: 'a@example.com', subject: 'S', text: 'plain', html: '<p>rich</p>', attachments: [{ path: pdfPath }]
  });
  const nested = decode(nestedRaw);
  assert.match(headerValue(nested, 'Content-Type'), /^multipart\/mixed/);
  assert.match(nested, /Content-Type: multipart\/alternative; boundary="=_toolsenabled_[a-f0-9]{24}"/);
  assert.match(nested, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(nested, /Content-Type: text\/html; charset=UTF-8/);
  ok('text+html+attachment nests multipart/alternative inside multipart/mixed');

  // Filenames with spaces and unicode encode per RFC 2231 / RFC 6266.
  const oddPath = path.join(tempDir, 'plain.bin');
  fs.writeFileSync(oddPath, Buffer.from('x'));
  const spaced = decode(google.buildMimeEmail({
    to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath, filename: 'my report v2.pdf' }]
  }));
  assert.match(spaced, /Content-Disposition: attachment; filename="my report v2\.pdf"/);
  assert.doesNotMatch(spaced, /filename\*=/);
  ok('a filename with spaces uses a plain quoted-string (no needless RFC 2231)');

  const unicodeName = 'répôrt — 研究 🚀.pdf';
  const unicode = decode(google.buildMimeEmail({
    to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath, filename: unicodeName }]
  }));
  const extended = /filename\*=UTF-8''([^\r\n;]+)/.exec(unicode);
  assert.ok(extended, 'expected an RFC 2231 extended filename* parameter');
  assert.equal(decodeURIComponent(extended[1]), unicodeName);
  assert.match(unicode, /Content-Disposition: attachment; filename="[\x20-\x7E]+"; filename\*=UTF-8''/);
  ok('a unicode filename emits an ASCII fallback plus a correct RFC 2231 filename*');

  // A filename containing a quote cannot break out of the quoted-string.
  const quoted = decode(google.buildMimeEmail({
    to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath, filename: 'a"b\\c.pdf' }]
  }));
  const dispositionLine = /^Content-Disposition: .*$/m.exec(quoted)[0];
  assert.equal((dispositionLine.match(/"/g) || []).length % 2, 0, 'unbalanced quotes in Content-Disposition');
  assert.doesNotMatch(dispositionLine, /filename="[^"]*"[^;]/);
  ok('a filename containing a quote/backslash cannot break the quoted-string');

  // Path traversal in a caller-supplied filename is reduced to a basename.
  const traversed = decode(google.buildMimeEmail({
    to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath, filename: '../../etc/passwd' }]
  }));
  assert.match(traversed, /filename="passwd"/);
  assert.doesNotMatch(traversed, /\.\.\//);
  ok('a traversal-shaped filename is reduced to its basename');

  // =========================================================================
  // 3. Boundary collision.
  // =========================================================================
  // Structural guarantee: base64 output uses only [A-Za-z0-9+/=], and every
  // boundary contains "_", so a boundary can never occur inside an encoded
  // attachment body regardless of the file's bytes.
  assert.ok(!/^[A-Za-z0-9+/=]*$/.test('_'), 'the underscore assumption behind the structural guarantee is wrong');
  const adversarialBytes = Buffer.from(`--=_toolsenabled_${'a'.repeat(24)}\r\nContent-Type: text/plain\r\n\r\nboom\r\n`);
  const adversarialPath = path.join(tempDir, 'adversarial.txt');
  fs.writeFileSync(adversarialPath, adversarialBytes);
  const adversarial = decode(google.buildMimeEmail({
    to: 'a@example.com',
    subject: 'S',
    text: `body containing --=_toolsenabled_${'b'.repeat(24)} inline`,
    html: `<p>--=_toolsenabled_${'c'.repeat(24)}</p>`,
    attachments: [{ path: adversarialPath }]
  }));
  const usedBoundaries = [...new Set((adversarial.match(BOUNDARY_TOKEN) || []))]
    .filter(token => /boundary="/.test(adversarial.slice(0, adversarial.indexOf(token))) || true);
  const declared = [...adversarial.matchAll(/boundary="(=_toolsenabled_[a-f0-9]{24})"/g)].map(m => m[1]);
  assert.equal(declared.length, 2, 'expected a distinct outer and inner boundary');
  assert.notEqual(declared[0], declared[1]);
  ok(`outer and inner boundaries are distinct (${declared.length} declared, ${usedBoundaries.length} tokens seen)`);

  for (const boundary of declared) {
    // The boundary must not appear anywhere in the caller-controlled content —
    // only in the delimiter lines and the Content-Type header that declares it.
    const occurrences = adversarial.split(boundary).length - 1;
    const delimiterLines = (adversarial.match(new RegExp(`^--${boundary}(--)?$`, 'gm')) || []).length;
    assert.equal(occurrences, delimiterLines + 1, `boundary ${boundary} leaked into part content`);
  }
  ok('neither boundary appears in any caller-controlled body, even adversarial ones');

  // The attachment's boundary-shaped bytes still round-trip exactly.
  const advParts = splitParts(adversarial.slice(adversarial.indexOf('\r\n\r\n') + 4), declared.find(b => adversarial.indexOf(`multipart/mixed; boundary="${b}"`) !== -1));
  const advAttachment = splitPartHeaders(advParts[advParts.length - 1]);
  assert.ok(Buffer.from(advAttachment.body.replace(/\r\n/g, ''), 'base64').equals(adversarialBytes));
  ok('an attachment whose literal bytes are a boundary delimiter round-trips intact');

  // Over many draws the boundary is always fresh and never repeats.
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) {
    const sample = decode(google.buildMimeEmail({ to: 'a@e.com', subject: 'S', text: 'x', html: '<p>x</p>' }));
    drawn.add(/boundary="(=_toolsenabled_[a-f0-9]{24})"/.exec(sample)[1]);
  }
  assert.equal(drawn.size, 200, 'boundaries repeated across draws');
  ok('200 independent draws produced 200 distinct boundaries (96 bits of entropy each)');

  // =========================================================================
  // 4. Oversize is refused with a typed error, before any network call.
  // =========================================================================
  const oversizePath = path.join(tempDir, 'oversize.bin');
  fs.writeFileSync(oversizePath, Buffer.alloc(google.MAX_ATTACHMENT_TOTAL_BYTES + 1, 0x41));
  assert.throws(
    () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oversizePath }] }),
    error => {
      assert.equal(error.code, 'GMAIL_ATTACHMENT_TOO_LARGE');
      assert.match(error.message, /limit is 2750000 bytes/);
      return true;
    }
  );
  ok('a single oversize attachment is refused with GMAIL_ATTACHMENT_TOO_LARGE');

  const halfPath = path.join(tempDir, 'half.bin');
  fs.writeFileSync(halfPath, Buffer.alloc(Math.ceil(google.MAX_ATTACHMENT_TOTAL_BYTES * 0.6), 0x42));
  assert.throws(
    () => google.buildMimeEmail({
      to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: halfPath }, { path: halfPath }]
    }),
    error => { assert.equal(error.code, 'GMAIL_ATTACHMENT_TOO_LARGE'); return true; }
  );
  ok('two attachments that individually fit but jointly exceed the cap are refused');

  assert.throws(
    () => google.buildMimeEmail({
      to: 'a@example.com', subject: 'S', text: '',
      attachments: Array.from({ length: google.MAX_ATTACHMENT_COUNT + 1 }, () => ({ path: oddPath }))
    }),
    error => { assert.equal(error.code, 'GMAIL_ATTACHMENT_INVALID'); return true; }
  );
  ok('more than MAX_ATTACHMENT_COUNT attachments is refused with GMAIL_ATTACHMENT_INVALID');

  assert.throws(
    () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: path.join(tempDir, 'nope.pdf') }] }),
    error => { assert.equal(error.code, 'GMAIL_ATTACHMENT_NOT_FOUND'); return true; }
  );
  ok('a missing attachment file is refused with GMAIL_ATTACHMENT_NOT_FOUND');

  // A busy or unhealthy filesystem did not establish absence. Keep these
  // failures distinct from ENOENT/ENOTDIR, and exercise every transient code
  // accepted by this provider contract. Repeated calls also prove that an
  // indeterminate result is not latched in this process.
  const originalStatSync = fs.statSync;
  let statCalls = 0;
  try {
    for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
      fs.statSync = () => {
        statCalls += 1;
        const error = new Error(`synthetic ${code}`);
        error.code = code;
        throw error;
      };
      assert.throws(
        () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath }] }),
        error => {
          assert.equal(error.code, 'GMAIL_ATTACHMENT_READ_UNAVAILABLE');
          assert.match(error.message, /does NOT claim that the file is absent/);
          assert.equal(error.cause.code, code);
          return true;
        }
      );
    }
  } finally {
    fs.statSync = originalStatSync;
  }
  assert.equal(statCalls, 5, 'an indeterminate filesystem result was cached or latched');
  assert.doesNotThrow(
    () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: oddPath }] }),
    'a successful retry after transient failures must inspect and read the attachment normally'
  );
  ok('filesystem could-not-tell errors are typed, explicit, and never latched; missing remains NOT_FOUND');

  for (const bad of [{ attachments: 'nope' }, { attachments: [null] }, { attachments: [{ path: oddPath, contentType: 'not a mime type' }] }, { attachments: [{ path: oddPath, filename: 'a\r\nX-Injected: 1' }] }, { attachments: [{ content: Buffer.from('x') }] }]) {
    assert.throws(
      () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', ...bad }),
      error => { assert.equal(error.code, 'GMAIL_ATTACHMENT_INVALID'); return true; },
      `expected GMAIL_ATTACHMENT_INVALID for ${JSON.stringify(bad)}`
    );
  }
  ok('malformed attachment inputs (incl. CRLF header injection) are refused with GMAIL_ATTACHMENT_INVALID');

  // =========================================================================
  // 4b. Containment: a path outside the owner profile tree, or a path shaped
  // like a bounded credential/session/environment-secret store, must never
  // reach fs.readFileSync — refused before the read, not merely before the
  // network send. No fixture is created outside the owned temp directory:
  // containment runs BEFORE any existence check, so a path that is merely
  // OUTSIDE the profile is refused on that basis alone, real file or not.
  // =========================================================================
  const outsideProfilePath = process.platform === 'win32'
    ? path.win32.join(path.win32.parse(os.homedir()).root, 'toolsenabled-containment-test-outside-profile.pdf')
    : path.resolve('/toolsenabled-containment-test-outside-profile.pdf');
  assert.ok(
    path.relative(os.homedir(), outsideProfilePath).startsWith('..'),
    'test setup error: the constructed path must actually be outside the home directory'
  );
  assert.throws(
    () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: outsideProfilePath }] }),
    error => {
      assert.equal(error.code, 'GMAIL_ATTACHMENT_OUTSIDE_PROFILE');
      assert.doesNotMatch(error.message, /ENOENT|not found/i, 'must refuse on containment, not on absence, even though the file also does not exist');
      return true;
    }
  );
  ok('an attachment path outside the owner profile tree is refused before any existence check');

  // A REAL fixture, inside the owned temp directory, but named like a bounded
  // credential store. Harmless synthetic content only — this proves the gate
  // fires before the read, not that a real secret can be moved.
  const credentialShapedPath = path.join(tempDir, 'credentials.json');
  fs.writeFileSync(credentialShapedPath, JSON.stringify({ note: 'synthetic fixture, not a real credential' }));
  let readAttempted = false;
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (args[0] === credentialShapedPath) readAttempted = true;
    return originalReadFileSync.apply(fs, args);
  };
  try {
    assert.throws(
      () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: credentialShapedPath }] }),
      error => {
        assert.equal(error.code, 'GMAIL_ATTACHMENT_FORBIDDEN');
        return true;
      }
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(readAttempted, false, 'a credential-shaped attachment path must never reach fs.readFileSync');
  ok('an attachment path shaped like a credential store is refused, and the file is never read');

  // An ordinary document from the owner's own working folder — a real file,
  // inside the owned temp directory (itself inside the profile tree), with a
  // perfectly normal name — must still work exactly as before.
  const ordinaryPath = path.join(tempDir, 'quarterly-report.pdf');
  fs.writeFileSync(ordinaryPath, pdfBytes);
  assert.doesNotThrow(
    () => google.buildMimeEmail({ to: 'a@example.com', subject: 'S', text: '', attachments: [{ path: ordinaryPath }] }),
    'containment must not refuse an ordinary attachment from inside the owner profile tree'
  );
  ok('an ordinary attachment from the owner profile tree is unaffected by the new containment check');

  // =========================================================================
  // 5. No byte or credential leakage into audit records.
  // =========================================================================
  const secretBytes = Buffer.from('SUPER-SECRET-ATTACHMENT-PAYLOAD-DO-NOT-LOG');
  const secretPath = path.join(tempDir, 'secret.bin');
  fs.writeFileSync(secretPath, secretBytes);

  const recorded = [];
  const patched = loadGoogleWithFailedTransport((...args) => recorded.push(args));

  // Two-argument .then, deliberately: the earlier `.then(() => { throw ... })
  // .catch(() => {})` shape swallowed its own guard — the .catch that exists
  // to absorb the EXPECTED transport failure also absorbed the thrown
  // "unexpectedly succeeded" error, so a send that reached the network could
  // never fail this test. The transport is injected so this behavior check
  // does not depend on credentials installed on the machine running it.
  patched.gmailSend({ to: 'a@example.com', subject: 'S', text: 'B', attachments: [{ path: secretPath }] })
    .then(
      () => {
        console.error('expected the send to fail before the network');
        process.exitCode = 1;
      },
      () => { /* expected: injected transport failure */ }
    )
    .finally(() => {
      const serialized = JSON.stringify(recorded);
      assert.equal(recorded.length, 1, 'the send failure must reach exactly one audit record');
      assert.equal(recorded[0][0], 'gmail.send.failed');
      assert.equal(recorded[0][2].attachmentCount, 1);
      assert.ok(recorded[0][2].encodedMessageBytes > 0);
      assert.doesNotMatch(serialized, /SUPER-SECRET-ATTACHMENT-PAYLOAD/, 'raw attachment bytes reached the audit record');
      assert.doesNotMatch(serialized, new RegExp(secretBytes.toString('base64').slice(0, 24)), 'base64 attachment content reached the audit record');
      assert.doesNotMatch(serialized, /refresh_token|access_token|client_secret|Bearer /i, 'credential material reached the audit record');
      ok('audit records carry attachment metadata only — no bytes, no base64, no credentials');

      console.log(`\nGmail attachment tests passed (${checks} checks).`);
      cleanup();
    });
} catch (error) {
  cleanup();
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
