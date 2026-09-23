// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-secrets-payment-card-security-code-never-stored-js):
// - EMPTY-COLLECTION mutations: changing every `[ordered]@{` opener and renaming
//   every payment-card prompt made the formerly vacuous offender scans stay
//   PASS. The scans now carry their own cardinality assertions; under those
//   mutations the RED output was "FAIL (a) no persisted payment payload
//   construction carries a security-code key: no persisted payload literal
//   found; the security-code-key scan did not execute" and "FAIL (a) neither
//   capture form creates a field that asks for the security code: no
//   Invoke-PaymentCardPrompt definition found; the form-field scan did not
//   execute".
// - FAILED-SPAWN mutation: resolving powershell.exe to a nonexistent executable
//   previously left "the scrub output and access log carry no PAN" green. It now
//   reports "scrub exited null: spawnSync powershell.exe ENOENT".
// - WRONG-KEY/FAILED-LOAD mutation: resolving powershell.exe to a nonexistent
//   executable satisfied the old non-zero-only assertion. The strengthened
//   assertion now reports "the scrub process did not start: spawnSync
//   powershell.exe ENOENT" and also requires the action's own refusal text.
// - ANCHOR-SCOPE mutation (this change): CARD_PROMPT_BODIES split the source on
//   the Invoke-PaymentCardPrompt header and never bounded the result, so the LAST
//   capture body ran to end of file and every later declaration was read as though
//   it sat inside a card capture form. Two [ordered]@{...} | ConvertTo-Json result
//   envelopes added to Invoke-VaultAction by the device-credential-clear work were
//   swept in, and check (a) failed on records that are not card records. Bounding
//   each body at the next top-level `function` header --
//   `.map(body => body.split(/^function /m)[0])` -- is the fix. Measured with the
//   fence's own extraction: literals seen INSIDE capture forms fall 4 -> 2 and both
//   survivors carry cardNumber; at LIVE d9b44f96 the same bounding is a no-op (2
//   before, 2 after). Removing the bound is RED "15 passed, 1 failed"; restoring it
//   is GREEN "16 passed, 0 failed". The security scan is untouched and still reads
//   payloadLiterals over the WHOLE executable source (4 literals), so this narrows
//   only the anchor, never the fence. Reviewer additionally proved the bound
//   discriminates: renaming each real card literal separately is seen in both
//   cases; injecting securityCode into a real literal is RED 13/3; and an
//   unrelated [ordered]@{...} | ConvertTo-Json placed after the last card prompt
//   stays GREEN 16/0 -- which is precisely the regression this bound targets.
// - NOT-FOUND: swallowed failures via try/catch or optional chaining; mocks of
//   the subject; file-wide skips/platform guards; expected values computed by
//   the same product code. The comment-stripper's catches are helpers rather
//   than swallowed subject failures, and exact expected field/status values are
//   independently written in this test.
// - PRECONDITIONS-NOT-MET here: powershell.exe/DPAPI are unavailable and this
//   Node lacks node:sqlite, so the full Windows run could not be green. On this
//   host the restored-source run still confirms all source-fence checks green;
//   its environmental failures include "spawnSync powershell.exe ENOENT" and
//   "No such built-in module: node:sqlite". Product source was restored
//   byte-for-byte after every mutation (git diff -- src tools was empty).

'use strict';

// THE CARD SECURITY CODE IS NEVER STORED. THIS FILE IS THE GATE THAT SAYS SO.
//
// Owner ruling Q-O4 (2026-08-14) and legal's X3 launch gate (2026-08-18): the
// card security code (CVC / CVV) is never persisted, anywhere, by anyone. PCI
// DSS Requirement 3.2 bars storing it after authorisation categorically -- not
// encrypted, not hashed, not for a moment longer than the authorisation that
// needs it. Both launch documents state "the security code is never stored" and
// neither may publish until the code makes that sentence true.
//
// Measured at HEAD before this gate existed: tools/secrets.ps1 collected the
// security code in BOTH of its payment-card capture forms, put it in the payload
// hashtable next to the PAN, Protect-PlainText'd the whole thing and wrote it to
// the DPAPI vault -- and nothing in the product ever read it back. Collected,
// stored, never used: pure liability. So the fix is not "read it out later"; it
// is "never ask for it at capture, never write it, and remove it from any record
// captured before the fix". A spend path that needs the code asks the owner for
// it live, at the moment of spend, and discards it after use.
//
// THREE MEASUREMENTS, ONE INVARIANT.
//   (a) SOURCE FENCE on tools/secrets.ps1. Fails if any persisted payment
//       payload construction carries a cvc/cvv/security-code key, if any
//       argument that reaches Protect-PlainText can be traced to a security
//       code, or if either capture form still creates a field to ask for one.
//       Proven RED against the pre-fix source and GREEN after.
//   (b) FORM CONTRACT. src/lib/owner-form-contract.js describes the capture
//       form to agents through owner_forms.describe; it must not list a
//       security-code field, or agents would tell the owner to expect one.
//   (c) SCRUB. `secrets.ps1 scrub-payment-card-cvc` removes the field from a
//       record captured before the fix, under the vault lock, and answers
//       scrubbed | clean | absent. Measured against a SCRATCH vault only.
//
// THE VALUE USED HERE IS A PUBLISHED STRIPE TEST PAN (4242...) AND NOTHING
// ELSE. It is not a card, it authorises nothing, and it exists so the leak hunts
// have a known needle. No real card number, expiry or security code may ever be
// written into this file, a fixture, a log or a report.
//
// THE VAULT UNDER TEST IS THE ISOLATED SCRATCH VAULT. tests/lib/isolated-
// environment points TOOLSENABLED_VAULT_PATH at a temp file (the variable
// tools/secrets.ps1 reads first) and TOOLSENABLED_STATE_ROOT is pointed under
// the same scratch root BEFORE the first require of anything in src/lib, so no
// probe can resolve into real user state. Nothing here touches, reads, decrypts
// or deletes the owner's vault, and no interactive prompt is ever opened.

const isolated = require('../lib/isolated-environment').activate('payment-card-security-code');

const path = require('node:path');
process.env.TOOLSENABLED_STATE_ROOT = path.join(isolated.root, 'state-root');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_SCRIPT = path.join(ROOT, 'tools', 'secrets.ps1');
const VAULT_FILE = process.env.TOOLSENABLED_VAULT_PATH;
const VAULT_DIR = path.dirname(VAULT_FILE);
const ACCESS_LOG = `${VAULT_FILE}.access.log`;
const CARD_KEY = 'payment_card_default';

// Published Stripe test PAN. See the header: this is the needle, not a card.
const TEST_PAN = '4242424242424242';
const NEEDLES = [
  { label: 'digits', bytes: Buffer.from(TEST_PAN, 'utf8') },
  { label: 'digits-utf16le', bytes: Buffer.from(TEST_PAN, 'utf16le') },
  { label: 'spaced', bytes: Buffer.from('4242 4242 4242 4242', 'utf8') },
  { label: 'hyphenated', bytes: Buffer.from('4242-4242-4242-4242', 'utf8') }
];

// A record shaped exactly like the one the PRE-FIX dialog wrote (its version 2),
// security code included. This is the thing the scrub exists to clean up. The
// three-digit value is synthetic and appears nowhere else.
const LEGACY_RECORD_WITH_CODE = JSON.stringify({
  version: 2,
  cardholder: { givenName: 'Test', familyName: 'Owner' },
  cardholderName: 'Test Owner',
  cardNumber: TEST_PAN,
  expMonth: 12,
  expYear: 2099,
  cvc: '123',
  postalCode: 'SW1A 1AA'
});

const SECURITY_CODE_WORD = /cvc|cvv|security[_ -]?code|securitycode/i;

let passed = 0;
const failures = [];
function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

// Quiet-desktop rule (STANDING-ORDERS LOCAL-WORK rule 3): every powershell
// spawn here is windowsHide + shell:false, so no console ever flashes, and no
// action invoked here can open a dialog.
function vault(args, options = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SECRETS_SCRIPT, ...args
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnError: result.error ? result.error.message : null
  };
}

function needleHits(buffer) {
  return NEEDLES.filter(needle => buffer.includes(needle.bytes)).map(needle => needle.label);
}

function accessLogLines() {
  if (!fs.existsSync(ACCESS_LOG)) return [];
  return fs.readFileSync(ACCESS_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { unparsable: true, raw: line }; }
  });
}

function truncateAccessLog() {
  try { fs.writeFileSync(ACCESS_LOG, ''); } catch { /* not yet created */ }
}

// ---------------------------------------------------------------------------
// (a) SOURCE FENCE: tools/secrets.ps1 can no longer write a security code.
// ---------------------------------------------------------------------------

const SOURCE = fs.readFileSync(SECRETS_SCRIPT, 'utf8');

// Comments explain; they do not execute. Strip `# ...` and `<# ... #>` before
// looking for executable mentions, so the file may still SAY "no security code
// is collected here" without tripping the fence that enforces it. Strings are
// deliberately NOT stripped: a field label is a string.
function withoutComments(text) {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map(line => {
      // A '#' inside a quoted string is not a comment; be conservative and only
      // strip from a '#' that is preceded by start-of-line or whitespace and is
      // not inside quotes on that line.
      let inSingle = false;
      let inDouble = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === "'" && !inDouble) inSingle = !inSingle;
        else if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(line[index - 1]))) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

const EXECUTABLE_SOURCE = withoutComments(SOURCE);

// Every payment-card capture form in the file, live or shadowed. The fence
// covers ALL of them: a shadowed definition that still asks for the code is one
// edit away from being the live one.
//
// EACH BODY IS BOUNDED AT THE NEXT TOP-LEVEL `function` HEADER, and that bound
// is the point rather than tidiness. Splitting on the prompt header alone gives
// a LAST body that runs to end of file, so every serialised payload declared
// after the last card prompt was being read as if it were a card record. That
// was invisible while nothing down there serialised anything; when the device
// credential clear work added its own `[ordered]@{ ok = ... } | ConvertTo-Json`
// result envelopes inside Invoke-VaultAction, the per-literal cardNumber check
// below started failing on records that are not card records and never were.
// Bounding the body fixes the extraction rather than loosening the assertion:
// the check stays universal over the literals that really are inside a capture
// form, so renaming cardNumber still turns it red.
const CARD_PROMPT_BODIES = EXECUTABLE_SOURCE
  .split(/^function Invoke-PaymentCardPrompt\b/m)
  .slice(1)
  .map(body => body.split(/^function /m)[0]);

// Every hashtable literal that is serialised into a persisted payload:
// `[ordered]@{ ... } | ConvertTo-Json`. Captures the literal text between the
// opening brace and the pipe so its keys can be inspected.
function payloadLiterals(text) {
  const literals = [];
  const opener = /\[ordered\]@\{/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let cursor = start;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      cursor += 1;
    }
    const body = text.slice(start, cursor - 1);
    const tail = text.slice(cursor, cursor + 40);
    if (/^\s*\|\s*ConvertTo-Json/.test(tail)) literals.push({ offset: match.index, body });
  }
  return literals;
}

// A key assignment inside a hashtable literal: `cvc = $x`, `; cvv = $y`, or a
// quoted key `'securityCode' = ...`.
function keysOf(literalBody) {
  const keys = [];
  const keyRe = /(?:^|[{;\n\r])\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*=/g;
  let match;
  while ((match = keyRe.exec(literalBody)) !== null) keys.push(match[1]);
  return keys;
}

check('(a) at least one persisted payment payload construction is still present to fence', () => {
  assert.ok(CARD_PROMPT_BODIES.length >= 1, 'no Invoke-PaymentCardPrompt definition found -- the capture feature must not be removed to pass this gate');
  const literals = CARD_PROMPT_BODIES.flatMap(payloadLiterals);
  assert.ok(literals.length >= 1, 'no persisted payload literal found inside a card capture form; the fence has nothing to hold');
  for (const literal of literals) {
    const keys = keysOf(literal.body);
    assert.ok(keys.includes('cardNumber'), `the payload literal at offset ${literal.offset} inside a card capture form does not carry cardNumber; the keys it does carry are: ${keys.join(', ') || '(none)'}. Either the card record shape moved and this fence must move with it, or CARD_PROMPT_BODIES has swept in a literal that is not a card record -- check the bound below before changing the record.`);
  }
});

check('(a) no persisted payment payload construction carries a security-code key', () => {
  const literals = payloadLiterals(EXECUTABLE_SOURCE);
  assert.ok(literals.length >= 1, 'no persisted payload literal found; the security-code-key scan did not execute');
  const offenders = [];
  for (const literal of literals) {
    for (const key of keysOf(literal.body)) {
      if (SECURITY_CODE_WORD.test(key)) offenders.push(key);
    }
  }
  assert.deepEqual(offenders, [], `a persisted payload still carries a security-code key: ${offenders.join(', ')}`);
});

// Trace every Protect-PlainText argument back through the assignments in its
// enclosing block. A block is the text between one top-level `function` /
// switch-arm header and the next; assignments to the argument variable and to
// any `$script:` payload variable it copies from are followed one hop.
function enclosingBlock(text, offset) {
  const headers = [];
  const headerRe = /^(?:function\s+[\w-]+\s*\{|\s{4}'[a-z-]+'\s*\{)/gm;
  let match;
  while ((match = headerRe.exec(text)) !== null) headers.push(match.index);
  let start = 0;
  let end = text.length;
  for (const header of headers) {
    if (header <= offset) start = header;
    else { end = header; break; }
  }
  return text.slice(start, end);
}

function protectPlainTextArgumentPaths(text) {
  const paths = [];
  const callRe = /Protect-PlainText\s+([^\r\n|)]+)/g;
  let match;
  while ((match = callRe.exec(text)) !== null) {
    const argument = match[1].trim();
    const block = enclosingBlock(text, match.index);
    const trail = [argument];
    const variables = argument.match(/\$(?:script:)?[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const variable of variables) {
      const bare = variable.replace(/^\$(?:script:)?/, '');
      const assignRe = new RegExp(`\\$(?:script:)?${bare}\\s*=\\s*([^\\r\\n]+)`, 'g');
      let assignment;
      while ((assignment = assignRe.exec(block)) !== null) {
        trail.push(assignment[1]);
        // One more hop: `$plain = $script:Payload` -> the payload literal.
        const inner = assignment[1].match(/\$script:([A-Za-z_][A-Za-z0-9_]*)/);
        if (inner) {
          const payloadRe = new RegExp(`\\$script:${inner[1]}\\s*=\\s*\\[ordered\\]@\\{`, 'g');
          let payloadStart;
          while ((payloadStart = payloadRe.exec(text)) !== null) {
            const literal = payloadLiterals(text.slice(payloadStart.index)).find(item => item.offset < 80);
            if (literal) trail.push(literal.body);
          }
        }
      }
    }
    paths.push({ call: match[0], trail });
  }
  return paths;
}

check('(a) no argument path into Protect-PlainText mentions a security code', () => {
  const paths = protectPlainTextArgumentPaths(EXECUTABLE_SOURCE);
  assert.ok(paths.length >= 3, `expected the vault script's several Protect-PlainText call sites, found ${paths.length}`);
  const offenders = paths
    .filter(item => item.trail.some(step => SECURITY_CODE_WORD.test(step)))
    .map(item => item.call);
  assert.deepEqual(offenders, [], `a Protect-PlainText argument path still reaches a security code: ${offenders.join(' | ')}`);
});

check('(a) neither capture form creates a field that asks for the security code', () => {
  assert.ok(CARD_PROMPT_BODIES.length >= 1, 'no Invoke-PaymentCardPrompt definition found; the form-field scan did not execute');
  const offenders = [];
  CARD_PROMPT_BODIES.forEach((body, index) => {
    // A form field: `Add-Field 'Label' ...` or `& $field 'Label' ...`.
    const fieldRe = /(?:Add-Field|&\s*\$field)\s+'([^']*)'/g;
    let match;
    while ((match = fieldRe.exec(body)) !== null) {
      if (SECURITY_CODE_WORD.test(match[1])) offenders.push(`form#${index + 1} field '${match[1]}'`);
    }
    // A variable that would hold one, e.g. $cvc / $normalizedCvc.
    const variableRe = /\$[A-Za-z_]*(?:cvc|cvv|securitycode)[A-Za-z0-9_]*/gi;
    while ((match = variableRe.exec(body)) !== null) offenders.push(`form#${index + 1} variable ${match[0]}`);
  });
  assert.deepEqual(offenders, [], `a capture form still asks for or holds the security code: ${offenders.join(', ')}`);
});

check('(a) the record version was bumped past the last shape that carried the code', () => {
  const versions = CARD_PROMPT_BODIES.flatMap(payloadLiterals)
    .map(literal => literal.body.match(/(?:^|[{;\s])version\s*=\s*(\d+)/))
    .filter(Boolean)
    .map(match => Number(match[1]));
  assert.ok(versions.length >= 1, 'no payload literal declares a version');
  // Version 2 was the last shape written with a security code. The live form
  // must write a later one so a reader can tell a post-fix record by its label.
  assert.ok(versions.some(version => version >= 3), `no capture form writes a record version >= 3 (found ${versions.join(', ')})`);
});

// ---------------------------------------------------------------------------
// (b) THE FORM CONTRACT AGENTS READ describes no security-code field.
// ---------------------------------------------------------------------------

check('(b) owner-form-contract payment_card_default lists no security-code field', () => {
  const forms = require('../../src/lib/owner-form-contract');
  const description = forms.describe('payment_card_default');
  const offenders = description.fields
    .filter(field => SECURITY_CODE_WORD.test(field.id) || SECURITY_CODE_WORD.test(field.label) || SECURITY_CODE_WORD.test(field.instruction))
    .map(field => field.id);
  assert.deepEqual(offenders, [], `the public card form contract still describes a security-code field: ${offenders.join(', ')}`);
  assert.deepEqual(
    description.fields.map(field => field.id),
    ['given_name', 'family_name', 'card_number', 'expiration', 'postal_code']
  );
  assert.ok(description.contractVersion >= 2, 'the field set changed; the contract version must say so');
  assert.deepEqual(description.acknowledgement.fieldIds, description.fields.map(field => field.id));
});

check('(b) the MCP register tool schema accepts exactly the five-field acknowledgement', () => {
  const { TOOL_REGISTRY } = require('../../src/lib/tool-registry');
  const tool = TOOL_REGISTRY.find(entry => entry.name === 'payment_method.card_register');
  assert.ok(tool, 'payment_method.card_register is not registered');
  const acknowledgement = tool.inputSchema.properties.acknowledgement;
  assert.equal(acknowledgement.properties.fieldIds.minItems, 5);
  assert.equal(acknowledgement.properties.fieldIds.maxItems, 5);
  const forms = require('../../src/lib/owner-form-contract');
  const version = forms.describe('payment_card_default').contractVersion;
  assert.ok(acknowledgement.properties.contractVersion.maximum >= version, 'the tool schema refuses the current contract version');
  assert.ok(acknowledgement.properties.contractVersion.minimum <= version);
});

// ---------------------------------------------------------------------------
// (c) SCRUB: a record captured before the fix loses its security code, in place.
// ---------------------------------------------------------------------------

// Read back the SCRATCH record's property NAMES (never values) plus a boolean
// that says whether the PAN survived the rewrite intact. The PAN itself never
// leaves the PowerShell process: it is compared inside and only true/false is
// printed. Only meaningful against the isolated vault this file created.
function scratchRecordShape() {
  const script = [
    '$raw = Get-Content -LiteralPath $env:PROBE_VAULT -Raw -Encoding UTF8',
    '$data = $raw | ConvertFrom-Json',
    "$blob = $data.PSObject.Properties['payment_card_default'].Value",
    'if ($null -eq $blob) { Write-Output "ABSENT"; exit 0 }',
    '$secure = ConvertTo-SecureString -String $blob',
    '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
    '$record = $plain | ConvertFrom-Json',
    '$names = @($record.PSObject.Properties | ForEach-Object { $_.Name }) -join ","',
    '$panIntact = [string]$record.cardNumber -eq $env:PROBE_PAN',
    '$holderIntact = [string]$record.cardholder.givenName -eq "Test" -and [string]$record.cardholder.familyName -eq "Owner"',
    'Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $names, $record.version, $record.expMonth, $record.expYear, $panIntact, $holderIntact)',
    '$plain = $null; $record = $null'
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], {
    encoding: 'utf8', windowsHide: true, shell: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PROBE_VAULT: VAULT_FILE, PROBE_PAN: TEST_PAN }
  });
  const line = String(result.stdout || '').trim();
  if (line === 'ABSENT') return { absent: true };
  const [names, version, expMonth, expYear, panIntact, holderIntact] = line.split('|');
  return {
    absent: false,
    names: names ? names.split(',') : [],
    version: Number(version),
    expMonth: Number(expMonth),
    expYear: Number(expYear),
    panIntact: panIntact === 'True',
    holderIntact: holderIntact === 'True'
  };
}

check('(c) setup: a pre-fix record carrying the code is planted in the scratch vault', () => {
  const stored = vault(['set-stdin', CARD_KEY], { input: LEGACY_RECORD_WITH_CODE });
  assert.equal(stored.status, 0, `could not plant the legacy record (${stored.stderr || stored.spawnError})`);
  const shape = scratchRecordShape();
  assert.equal(shape.absent, false);
  assert.ok(shape.names.includes('cvc'), 'the planted legacy record does not carry the field the scrub must remove -- setup is wrong');
});

check('(c) scrub-payment-card-cvc removes the code, keeps everything else, answers scrubbed', () => {
  truncateAccessLog();
  const result = vault(['scrub-payment-card-cvc']);
  assert.equal(result.status, 0, `scrub exited ${result.status}: ${result.stderr || result.spawnError}`);
  assert.deepEqual(JSON.parse(result.stdout), { key: CARD_KEY, status: 'scrubbed' });
  const shape = scratchRecordShape();
  assert.equal(shape.absent, false, 'the scrub deleted the record instead of cleaning it');
  assert.ok(!shape.names.some(name => SECURITY_CODE_WORD.test(name)), `the record still carries: ${shape.names.join(',')}`);
  assert.deepEqual(shape.names, ['version', 'cardholder', 'cardholderName', 'cardNumber', 'expMonth', 'expYear', 'postalCode']);
  assert.equal(shape.version, 2, 'the scrub must not relabel a record it did not capture');
  assert.equal(shape.expMonth, 12);
  assert.equal(shape.expYear, 2099);
  assert.equal(shape.panIntact, true, 'the PAN did not survive the rewrite intact');
  assert.equal(shape.holderIntact, true, 'the cardholder object did not survive the rewrite intact');
  const line = accessLogLines().find(entry => entry.action === 'scrub-payment-card-cvc' && entry.key === CARD_KEY);
  assert.ok(line, 'the scrub rewrote the card record and left no access-log line');
  assert.equal(line.replaced, true);
});

check('(c) the rewritten record is still a DPAPI blob and no spelling of the PAN is on disk', () => {
  const record = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'))[CARD_KEY];
  assert.match(record, /^[0-9a-fA-F]{256,}$/, 'the scrubbed record is not a DPAPI hex blob');
  const offenders = [];
  for (const entry of fs.readdirSync(VAULT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const hits = needleHits(fs.readFileSync(path.join(VAULT_DIR, entry.name)));
    if (hits.length) offenders.push(`${entry.name}:${hits.join('+')}`);
  }
  assert.deepEqual(offenders, [], `plaintext PAN on disk after scrub in: ${offenders.join(', ')}`);
});

check('(c) a second scrub answers clean and rewrites nothing', () => {
  const before = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'))[CARD_KEY];
  truncateAccessLog();
  const result = vault(['scrub-payment-card-cvc']);
  assert.equal(result.status, 0, `scrub exited ${result.status}: ${result.stderr || result.spawnError}`);
  assert.deepEqual(JSON.parse(result.stdout), { key: CARD_KEY, status: 'clean' });
  const after = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'))[CARD_KEY];
  assert.equal(after, before, 'a clean record was rewritten anyway');
  const line = accessLogLines().find(entry => entry.action === 'scrub-payment-card-cvc' && entry.key === CARD_KEY);
  assert.ok(line, 'the clean answer decrypted the record and left no access-log line');
  assert.equal(line.replaced, false);
});

check('(c) the scrub output and access log carry no PAN', () => {
  const result = vault(['scrub-payment-card-cvc']);
  assert.equal(result.status, 0, `scrub exited ${result.status}: ${result.stderr || result.spawnError}`);
  assert.equal(result.spawnError, null, `the scrub process did not start: ${result.spawnError}`);
  const hits = needleHits(Buffer.from(result.stdout + result.stderr, 'utf8'));
  assert.deepEqual(hits, [], `scrub output leaked the PAN as: ${hits.join(', ')}`);
  assert.deepEqual(needleHits(fs.readFileSync(ACCESS_LOG)), []);
});

check('(c) the scrub is bound to the default card key and refuses any other', () => {
  const other = vault(['scrub-payment-card-cvc', 'not_the_card_key']);
  assert.equal(other.spawnError, null, `the scrub process did not start: ${other.spawnError}`);
  assert.notEqual(other.status, 0, 'scrub accepted a different key');
  assert.match(other.stderr, /Action 'scrub-payment-card-cvc' only ever operates on 'payment_card_default'\./,
    'the failed process did not emit the scrub action\'s own wrong-key refusal');
  const explicit = vault(['scrub-payment-card-cvc', CARD_KEY]);
  assert.equal(explicit.status, 0);
  assert.deepEqual(JSON.parse(explicit.stdout), { key: CARD_KEY, status: 'clean' });
});

check('(c) the runtime wrapper the app can call answers the same three words, hidden', () => {
  // TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH were both set at the
  // top of this file before this first require, so nothing here can resolve to
  // real user state.
  const runtime = require('../../src/lib/runtime');
  assert.equal(typeof runtime.scrubPaymentCardSecurityCode, 'function', 'runtime exports no scrub wrapper for the app to call');
  const clean = runtime.scrubPaymentCardSecurityCode();
  assert.deepEqual(clean, { key: CARD_KEY, status: 'clean' });
  const planted = vault(['set-stdin', CARD_KEY], { input: LEGACY_RECORD_WITH_CODE });
  assert.equal(planted.status, 0);
  const scrubbed = runtime.scrubPaymentCardSecurityCode();
  assert.deepEqual(scrubbed, { key: CARD_KEY, status: 'scrubbed' });
  assert.ok(!scratchRecordShape().names.some(name => SECURITY_CODE_WORD.test(name)));
});

check('(c) the app-owned owner-host startup actually calls the legacy-record scrub', () => {
  const ownerHostSource = fs.readFileSync(path.join(ROOT, 'src', 'owner-host.js'), 'utf8');
  assert.match(
    ownerHostSource,
    /require\(['"]\.\/lib\/runtime['"]\)\.scrubPaymentCardSecurityCode\(\)/,
    'the scrub wrapper has no production startup caller'
  );
  const scrubOffset = ownerHostSource.indexOf('.scrubPaymentCardSecurityCode()');
  const listenOffset = ownerHostSource.indexOf('server.listen({ path: pipeName })');
  assert.ok(scrubOffset >= 0 && listenOffset > scrubOffset,
    'the owner host listens before legacy card records are scrubbed');
});

check('(c) with no card record on file the scrub answers absent', () => {
  const removed = vault(['del', CARD_KEY]);
  assert.equal(removed.status, 0);
  const result = vault(['scrub-payment-card-cvc']);
  assert.equal(result.status, 0, `scrub exited ${result.status}: ${result.stderr || result.spawnError}`);
  assert.deepEqual(JSON.parse(result.stdout), { key: CARD_KEY, status: 'absent' });
  const runtime = require('../../src/lib/runtime');
  assert.deepEqual(runtime.scrubPaymentCardSecurityCode(), { key: CARD_KEY, status: 'absent' });
});

// ---------------------------------------------------------------------------

console.log(`\npayment-card security code never stored: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.message}`);
  process.exitCode = 1;
}
