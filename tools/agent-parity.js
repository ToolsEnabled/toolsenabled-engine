'use strict';

// PROVIDER PARITY CHECK -- owner request R118, verbatim:
//   "not just codex though. any/all agents should be able to use it. that is a
//    hard and permannent rule to apply. unless smething simply cant be expanded
//    to be usable by all agents it should"
//
// The rule is permanent, so it needs a mechanical check rather than a habit.
//
// WHAT WENT WRONG (measured 2026-07-30). There is no canonical tool allowlist.
// Six hand-maintained copies exist -- .mcp.json, .gemini/settings.json, two in
// .codex/config.toml, ~/.codex/config.toml, and the adapters/*.example pair --
// and they had drifted. The code.* LSP layer was reachable by claude (7 explicit
// tools) and gemini (code.*) and by NOBODY on codex, which is exactly the
// "we built it for Claude" failure the rule forbids. Nothing detected it because
// nothing compared the copies.
//
// This does not try to unify the copies: profiles legitimately differ (a
// read-only profile should not carry outward-capable namespaces). It checks the
// weaker, honest property the rule actually asks for -- every capability is
// reachable by every agent, OR the exemption is written down here on purpose.
//
// Usage:
//   node tools/agent-parity.js            human-readable
//   node tools/agent-parity.js --json     machine-readable
//   exit 1 when an unexempted namespace is missing for some agent

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const asJson = process.argv.includes('--json');

// Namespaces a profile may legitimately lack, with the reason. An entry here is
// a DECISION, not a silencer: it has to say why expansion is impossible or
// unwanted, which is the escape hatch the rule allows ("unless something simply
// cant be expanded").
const EXEMPT = {
  'toolsenabled-readonly': {
    reason: 'Deliberately read-only. It exists so a client can be given inspection without write or '
      + 'outward authority, so write/outward namespaces are absent BY DESIGN, not by drift.',
    namespaces: null // null = every write/outward namespace is exempt for this profile
  }
};

// Namespaces that carry no write or outward effect. These are the ones the rule
// bites hardest on: there is no defensible reason for one agent to be able to
// read code structure and another not to.
const READ_ONLY_NAMESPACES = ['code', 'search', 'memory', 'task', 'audit', 'system'];

function parseJsonAllowlists(file, label, unavailable) {
  const out = [];
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, cfg] of Object.entries(json.mcpServers || {})) {
      const raw = cfg && cfg.env && cfg.env.TOOLSENABLED_TOOL_ALLOWLIST;
      out.push({ profile: `${label}:${name}`, file, allowlist: raw ? raw.split(',').map(s => s.trim()) : null });
    }
    if (!out.some(p => p.allowlist && p.allowlist.length)) {
      unavailable.push({ source: label, file, reason: 'no non-empty TOOLSENABLED_TOOL_ALLOWLIST was found' });
    }
  } catch (error) {
    unavailable.push({ source: label, file, reason: error.code === 'ENOENT' ? 'configuration file is missing' : `configuration cannot be read: ${error.message}` });
  }
  return out;
}

function parseTomlAllowlists(file, label, unavailable) {
  const out = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    const matches = [...text.matchAll(/TOOLSENABLED_TOOL_ALLOWLIST\s*=\s*"([^"]*)"/g)];
    matches.forEach((m, index) => {
      out.push({
        profile: `${label}#${index + 1}`,
        file,
        allowlist: m[1].split(',').map(s => s.trim()).filter(Boolean)
      });
    });
    if (!out.some(p => p.allowlist.length)) {
      unavailable.push({ source: label, file, reason: 'no non-empty TOOLSENABLED_TOOL_ALLOWLIST was found' });
    }
  } catch (error) {
    unavailable.push({ source: label, file, reason: error.code === 'ENOENT' ? 'configuration file is missing' : `configuration cannot be read: ${error.message}` });
  }
  return out;
}

function collectProfiles() {
  const unavailable = [];
  const profiles = [
    ...parseJsonAllowlists(path.join(ROOT, '.mcp.json'), 'claude/.mcp.json', unavailable),
    ...parseJsonAllowlists(path.join(ROOT, '.gemini', 'settings.json'), 'gemini/.gemini', unavailable),
    ...parseTomlAllowlists(path.join(ROOT, '.codex', 'config.toml'), 'codex/repo', unavailable),
    ...parseTomlAllowlists(path.join(os.homedir(), '.codex', 'config.toml'), 'codex/user', unavailable)
  ].filter(p => p.allowlist && p.allowlist.length);
  return { profiles, unavailable };
}

function grants(allowlist, namespace) {
  return allowlist.some(entry => {
    if (entry === `${namespace}.*` || entry === '*') return true;
    return entry.startsWith(`${namespace}.`);
  });
}

function exemptFor(profile, namespace) {
  for (const [key, rule] of Object.entries(EXEMPT)) {
    if (!profile.includes(key)) continue;
    if (rule.namespaces === null) return rule.reason;
    if (rule.namespaces.includes(namespace)) return rule.reason;
  }
  return null;
}

const { profiles, unavailable } = collectProfiles();
const findings = [];
let namespacesChecked = 0;
for (const namespace of READ_ONLY_NAMESPACES) {
  const missing = profiles.filter(p => !grants(p.allowlist, namespace));
  const reachable = profiles.length - missing.length;
  // A namespace nobody has is not a parity problem; it is simply unused here.
  if (reachable === 0) continue;
  namespacesChecked += 1;
  for (const p of missing) {
    const exemption = exemptFor(p.profile, namespace);
    findings.push({
      namespace,
      profile: p.profile,
      file: path.relative(ROOT, p.file) || p.file,
      exempt: Boolean(exemption),
      reason: exemption || `reachable by ${reachable} of ${profiles.length} profiles but not this one, `
        + 'and it carries no write or outward effect, so there is no reason it cannot be expanded (R118).'
    });
  }
}

// Refuse a vacuous pass if allowlist syntax or namespace names drift so far that
// none of the configured read-only namespaces is actually compared.
if (namespacesChecked === 0) {
  unavailable.push({
    source: 'parity scan',
    file: __filename,
    reason: 'zero configured read-only namespaces were reachable; no parity comparison was possible'
  });
}

const violations = findings.filter(f => !f.exempt);

if (asJson) {
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: 'R118 - every capability reachable by every agent unless expansion is impossible',
    profiles: profiles.map(p => ({ profile: p.profile, entries: p.allowlist.length })),
    unavailable: unavailable.map(item => ({
      source: item.source,
      file: path.relative(ROOT, item.file) || item.file,
      reason: item.reason
    })),
    findings,
    violations: violations.length,
    available: unavailable.length === 0
  }, null, 2)}\n`);
} else {
  const L = ['# Agent parity (owner rule R118)', ''];
  L.push(`profiles checked: ${profiles.length}`);
  for (const p of profiles) L.push(`  ${p.profile} (${p.allowlist.length} entries)`);
  L.push('');
  if (unavailable.length) {
    L.push(`UNAVAILABLE - ${unavailable.length} required parity source(s) could not be checked:`);
    for (const item of unavailable) {
      L.push(`  ${item.source} [${path.relative(ROOT, item.file) || item.file}] - ${item.reason}`);
    }
  } else if (!violations.length) {
    L.push('PASS - every read-only namespace reachable by one agent is reachable by all of them,');
    L.push('       except where an exemption is recorded on purpose.');
  } else {
    L.push(`FAIL - ${violations.length} namespace/profile pair(s) violate the rule:`);
    for (const v of violations) L.push(`  ${v.namespace}.*  missing from ${v.profile}  [${v.file}]\n      ${v.reason}`);
  }
  const exempted = findings.filter(f => f.exempt);
  if (exempted.length) {
    L.push('');
    L.push(`recorded exemptions: ${exempted.length} (${[...new Set(exempted.map(e => e.profile))].join(', ')})`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
}

process.exitCode = violations.length || unavailable.length ? 1 : 0;
