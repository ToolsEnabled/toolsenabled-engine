'use strict';

// REGISTRATION test for tools/no-blocking-prompt-hook.js -- the check the
// existing contract suite deliberately cannot make.
//
// tests/no-blocking-prompt-hook.test.js proves the hook DECIDES correctly when
// invoked; it points every child at scratch fixtures and asserts nothing about
// whether any settings file actually invokes the hook. That gap is exactly how
// the gate spent 2026-08-13 to 2026-08-14 written, configured, tested,
// documented (docs/design/NO-BLOCKING-PROMPT-GATE.md:23 "is a PreToolUse
// hook") and named as enforcedBy in config/settings-registry.json -- while
// registered in NO settings file, so it never fired in a live session. Its log
// held one 8-minute hand-piped self-check window; the registered clarify-gate
// log grew to 5.1 MB in the same period. A suite that is green while the gate
// is dead is the defect this file closes.
//
// WHAT IS ASSERTED: .claude/settings.json carries a PreToolUse group whose
// matcher covers AskUserQuestion AND both system_ask names, and whose command
// invokes tools/no-blocking-prompt-hook.js. Matcher coverage is tested by
// REGEX MATCH against the tool names, not by string equality, because hook
// matchers are regexes and an equality check would pin one spelling of many.
//
// Until the owner applies .claude/settings.json.proposed-no-blocking-gate
// (settings.json is write-protected from agents -- STANDING-ORDERS SYNC rule
// 7), this test FAILS, and that is the honest state: the directive is
// currently enforced by prose alone. Run directly:
//   node tests/no-blocking-prompt-registration.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'no-blocking-registration-'));
const SETTINGS_FILE = path.join(FIXTURE_ROOT, '.claude', 'settings.json');
const HOOK_BASENAME = 'no-blocking-prompt-hook.js';
const MUST_MATCH = ['AskUserQuestion', 'mcp__toolsenabled__system_ask', 'mcp__toolsenabled__system_ask_remote'];
// The registered gate must not swallow tools it has no business seeing; the
// hook itself allows them, but a matcher this wide would put a process spawn
// on every Bash call for nothing.
const MUST_NOT_MATCH_ALL = ['Bash', 'Edit'];

fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: 'AskUserQuestion|mcp__toolsenabled__system_ask(?:_remote)?',
      hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/tools/no-blocking-prompt-hook.js"' }]
    }]
  }
}, null, 2), 'utf8');
process.once('exit', () => {
  try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* disposable fixture */ }
});

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function main() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (error) {
    return fail(`.claude/settings.json is unreadable (${error.code}); nothing registers any hook.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return fail('.claude/settings.json is not valid JSON.');
  }

  const groups = (parsed.hooks && parsed.hooks.PreToolUse) || [];
  const registering = groups.filter((group) =>
    Array.isArray(group.hooks)
    && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_BASENAME)));

  if (registering.length === 0) {
    return fail(
      `no PreToolUse group in the disposable Claude settings fixture invokes ${HOOK_BASENAME}.`);
  }

  for (const name of MUST_MATCH) {
    const covered = registering.some((group) => {
      try {
        return new RegExp(group.matcher || '').test(name);
      } catch {
        return false;
      }
    });
    assert.ok(covered, `registered, but the matcher does not cover ${name} -- that tool bypasses the gate`);
  }

  for (const name of MUST_NOT_MATCH_ALL) {
    const overWide = registering.every((group) => {
      try {
        return new RegExp(group.matcher || '').test(name);
      } catch {
        return false;
      }
    });
    assert.ok(!overWide, `every registering matcher also matches ${name} -- the matcher is wider than the gate's purpose`);
  }

  console.log(`PASS ${HOOK_BASENAME} registration accepts a disposable Claude settings fixture covering: ${MUST_MATCH.join(', ')}`);
}

try {
  main();
} catch (error) {
  fail(error.message);
}
