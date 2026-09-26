// Mutation check:
// In src/lib/policy.js, changed `if (listed.includes(action)) return true;`
// to `if (listed.includes(action)) return false;`.
// The edit landed, and this file went red with exit code 1.
// The module was then restored to its original SHA-256.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../src/lib/policy');

// Approval rules are ordered: an explicitly listed action remains gated even
// when the browser-start convenience setting would otherwise approve it.
const approvals = {
  approvals: {
    enabled: true,
    actions: ['browser.start'],
    autoApproveBrowserStart: true,
    externalWrites: true
  }
};
const confirmationOn = { loadSettings: () => ({ values: { 'agent.tool_approvals': true }, provenance: { 'agent.tool_approvals': { source: 'user' } }, rejected: [] }) };
assert.equal(policy.requiresApproval('browser.start', 'local-write', approvals, confirmationOn), true);
assert.equal(policy.requiresApproval('notes.read', 'read', approvals, confirmationOn), false);
assert.equal(policy.requiresApproval('github.publish', 'external-write', approvals, confirmationOn), true);

// Timeout values outside the documented safety range fall back rather than
// becoming an unbounded or effectively immediate approval window.
assert.equal(policy.approvalTimeoutSeconds({ approvals: { timeoutSeconds: 5 } }), 5);
assert.equal(policy.approvalTimeoutSeconds({ approvals: { timeoutSeconds: 901 } }), 60);
assert.equal(policy.approvalTimeoutSeconds({ approvals: { timeoutSeconds: 5.5 } }), 60);

// Host allowlisting is suffix-aware but label-boundary-safe: subdomains match,
// while strings that merely end with the same characters do not.
assert.equal(policy.httpHostAllowed('API.Example.COM.', ['example.com']), true);
assert.equal(policy.httpHostAllowed('example.com.evil.test', ['example.com']), false);
assert.equal(policy.httpHostAllowed('notexample.com', ['example.com']), false);

// URL validation returns the parsed HTTPS URL and refuses other protocols.
assert.equal(policy.assertHttps('https://example.com/path').hostname, 'example.com');
assert.throws(
  () => policy.assertHttps('http://example.com/path', 'callback URL'),
  /callback URL must use HTTPS\./
);

// A removed transport is not a policy provider that can be enabled by leaving
// a stale providers entry in an installation policy.
const policySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'policy.js'), 'utf8');
assert.doesNotMatch(policySource, /\btelegram\s*:\s*['"]telegram['"]/i);

console.log('policy behaviour passed (12 assertions)');
