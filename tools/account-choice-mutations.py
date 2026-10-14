#!/usr/bin/env python3
"""Focused, reversible mutations for task 27; no real provider or app runs.

Each mutation restores the exact original bytes in a finally block, then runs
the same regression file again. The report receives TAP count/name excerpts,
not stack traces or provider diagnostics. Run only in the assigned worktree.
"""
import argparse
from pathlib import Path
import re
import subprocess

ENGINE = Path(__file__).resolve().parents[1]
APP = ENGINE.parent / 'app'

MUTATIONS = [
    ('A2 engine durable choose-again', 'engine', 'src/lib/multi-account/switcher.js', 'const state = emptyState(unreadableChoices());', 'const state = emptyState();', 'engine'),
    ('A2 engine interrupted quarantine', 'engine', 'src/lib/multi-account/switcher.js', 'return fsImpl.readdirSync(path.dirname(statePath)).some(name => name.startsWith(prefix));', 'return false;', 'engine'),
    ('A2 engine Start refusal', 'engine', 'src/lib/multi-account/rotation.js', 'if (state.selectionUnreadableByProvider?.[spec.id])', 'if (false)', 'engine'),
    ('A2 engine direct launch refusal', 'engine', 'src/lib/multi-account/switcher.js', 'if (state.selectionUnreadableByProvider?.[served])', 'if (false)', 'engine'),
    ('A2 engine selection schema', 'engine', 'src/lib/multi-account/switcher.js', 'if (parsed && !validSelectionRecord(parsed))', 'if (false)', 'engine'),
    ('A2 app durable choose-again', 'app', 'shell/account-registry.cjs', 'selectionUnreadableByProvider: Object.fromEntries(PROVIDER_IDS.map(id => [id, true]))', 'selectionUnreadableByProvider: null', 'app'),
    ('A2 app interrupted quarantine', 'app', 'shell/account-registry.cjs', 'return fsImpl.readdirSync(path.dirname(privatePath(stateFile))).some(name => name.startsWith(prefix))', 'return false', 'app'),
    ('A2 app selection schema', 'app', 'shell/account-registry.cjs', 'if (state !== null && validSelectionRecord(state)) return state', 'if (state !== null) return state', 'app'),
    ('A3 selection revision comparison', 'engine', 'src/lib/multi-account/switcher.js', "|| choiceSnapshot(state) !== selection.choiceSnapshot", '|| false', 'engine'),
    ('A3 missing choice snapshot refusal', 'engine', 'src/lib/multi-account/switcher.js', "|| typeof selection.choiceSnapshot !== 'string'", '|| false', 'engine'),
    ('A3 engine manual revision', 'engine', 'src/lib/multi-account/switcher.js', 'selectionRevision: randomUUID(),', 'selectionRevision: state.selectionRevision,', 'engine'),
    ('A3 app manual revision', 'app', 'shell/account-registry.cjs', 'selectionRevision: randomUUID(),', 'selectionRevision: state?.selectionRevision,', 'app'),
    ('A4 manual pin migration', 'app', 'shell/account-registry.cjs', '[spec.id]: renameLabel(chosen[spec.id])', '[spec.id]: chosen[spec.id]', 'app'),
    ('A4 legacy history migration', 'app', 'shell/account-registry.cjs', 'state.history.map(migrateEntry)', 'state.history', 'app'),
    ('A4 old label home binding', 'engine', 'src/lib/multi-account/rotation.js', 'entry.name === wanted || entry.previousNames?.includes(wanted)', 'entry.name === wanted', 'app'),
    ('A4 engine alias conflicts', 'engine', 'src/lib/multi-account/registry.js', 'if (labelOwners.has(key) && labelOwners.get(key) !== account)', 'if (false)', 'engine'),
    ('A4 engine alias validation', 'engine', 'src/lib/multi-account/registry.js', "if (aliases != null && (!Array.isArray(aliases) || aliases.length > 64\n        || aliases.some(name => !nonEmptyString(name) || name.length > 120)))", 'if (false)', 'engine'),
    ('A4 app alias conflicts', 'app', 'shell/account-registry.cjs', 'if (labelOwners.has(key) && labelOwners.get(key) !== entry)', 'if (false)', 'app'),
    ('A4 app alias validation', 'app', 'shell/account-registry.cjs', "if (aliases != null && (!Array.isArray(aliases) || aliases.length > MAX_PREVIOUS_NAMES\n      || aliases.some(label => !nonEmptyString(label) || label.length > MAX_PREVIOUS_NAME_LENGTH)))", 'if (false)', 'app'),
    ('A4 rename history bound', 'app', 'shell/account-registry.cjs', 'if (previousNames.length > MAX_PREVIOUS_NAMES)', 'if (false)', 'app'),
    ('A4 rename reserves old labels', 'app', 'shell/account-registry.cjs', 'if (conflicting) throw refusal', 'if (false) throw refusal', 'app'),
    ('A4 additions reserve old labels', 'app', 'shell/account-registry.cjs', '[item.name, ...(item.entry.previousNames || [])].some(label => label.toLowerCase() === cleanName.toLowerCase())', 'item.name.toLowerCase() === cleanName.toLowerCase()', 'app'),
    ('A5 native API authentication', 'engine', 'src/lib/multi-account/rotation.js', "if (!observed || typeof observed !== 'object') return STATUS.TRANSIENT;", "if (!observed || typeof observed !== 'object') return STATUS.TRANSIENT;\n  if (observed.billingSource === 'api_key') return STATUS.EXHAUSTED;", 'engine'),
    ('A5 subscription allowance separation', 'engine', 'src/lib/multi-account/rotation.js', "if (['api_key', 'cloud', 'key_helper'].includes(observed?.billingSource)) { allowance = NO_CLAUDE_ALLOWANCE; liveMeasured = false; }", 'if (false) { allowance = NO_CLAUDE_ALLOWANCE; liveMeasured = false; }', 'engine'),
    ('A6 successful status discriminator', 'engine', 'src/lib/multi-account/rotation.js', 'observed.state === STATE.INDETERMINATE && observed.statusSucceeded === true', 'observed.state === STATE.INDETERMINATE', 'engine'),
    ('A6 classifier status exit evidence', 'engine', 'src/lib/providers/claude-auth-probe.js', 'statusSucceeded: statusExit === 0 && status.loggedIn === true,', 'statusSucceeded: status.loggedIn === true,', 'engine'),
    ('A7 measured signed-out code', 'engine', 'src/lib/multi-account/switcher.js', "code: 'ACCOUNT_SIGNED_OUT'", "code: 'ACCOUNT_NONE_USABLE'", 'engine'),
    ('A7 resolver preserves code', 'engine', 'src/lib/multi-account/rotation.js', 'if (!selection.ok) return refusal(selection.code,', 'if (!selection.ok) return refusal(CODE.NONE_USABLE,', 'engine'),
    ('A7 exact slot host preserves code', 'app', 'shell/agent-host.cjs', "fail(resolvedAccount.blocked === true ? (resolvedAccount.code || 'AGENT_ACCOUNT_UNAVAILABLE') : 'AGENT_ACCOUNT_UNAVAILABLE',", "fail('AGENT_ACCOUNT_UNAVAILABLE',", 'app'),
    ('A7 renderer preserves signed-out remedy', 'app', 'src/agent-availability-copy.js', '  ACCOUNT_SIGNED_OUT:', '  MUTANT_ACCOUNT_SIGNED_OUT:', 'app'),
    ('A7 contradictory readiness refusal', 'engine', 'src/lib/multi-account/switcher.js', 'result?.status === STATUS.HEALTHY && result.canServe !== false', 'result?.status === STATUS.HEALTHY', 'engine'),
    ('A8 request fields refusal', 'engine', 'src/lib/multi-account/switcher.js', "['excludeAccounts', 'keepTryingAccounts'].some(field => Object.hasOwn(request, field))", 'false', 'engine'),
    ('A8 resolver refuses before reads', 'engine', 'src/lib/multi-account/rotation.js', 'if (retired) return refusal(retired.code, retired.reason);', 'if (false) return refusal(retired.code, retired.reason);', 'engine'),
    ('A8 direct selector refuses before probes', 'engine', 'src/lib/multi-account/switcher.js', 'if (retired) return Object.freeze({ ok: false, account: null, probe: null, attempts: Object.freeze([]), switched: false, ...retired });', 'if (false) return Object.freeze({ ok: false, account: null, probe: null, attempts: Object.freeze([]), switched: false, ...retired });', 'engine'),
    ('A8 direct launch refuses before state writes', 'engine', 'src/lib/multi-account/switcher.js', 'if (retired) return Object.freeze({ ok: false, account: null, attempts: Object.freeze([]), ...retired });', 'if (false) return Object.freeze({ ok: false, account: null, attempts: Object.freeze([]), ...retired });', 'engine'),
    ('A4 legacy rename length bound', 'app', 'shell/account-registry.cjs', 'if (match.name.length > MAX_PREVIOUS_NAME_LENGTH)', 'if (false)', 'app'),
    ('A5 native helper mode identity', 'engine', 'src/lib/providers/claude-auth-probe.js', "return /helper/i.test(status.apiKeySource) ? 'key_helper' : 'api_key';", "return 'api_key';", 'engine'),
    ('A5 native cloud mode identity', 'engine', 'src/lib/providers/claude-auth-probe.js', "if (/^(?:bedrock|vertex|foundry|mantle|gateway|anthropic_aws|anthropic_google_cloud)$/i.test(status.apiProvider || '')) return 'cloud';", "if (false) return 'cloud';", 'engine'),
    ('A5 native API method identity', 'engine', 'src/lib/providers/claude-auth-probe.js', "if (/api.?key/i.test(status.authMethod || '')) return 'api_key';", "if (false) return 'api_key';", 'engine'),
]


def run(suite):
    cwd = ENGINE if suite == 'engine' else APP
    args = ['node', 'tests/run-isolated.js', 'tests/account-choice-correctness.test.js'] if suite == 'engine' else [
        'node', '--import=./tools/test/lib/isolate-native-state-root.mjs', '--test', 'tools/test/account-choice-correctness.test.mjs']
    result = subprocess.run(['nice', '-n', '10', 'env', '-u', 'CLAUDE_CONFIG_DIR',
        'NODE_OPTIONS=--max-old-space-size=4096', f'TOOLSENABLED_SOURCE={ENGINE}', *args],
        cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    counts = {kind: int(value) for kind, value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$', result.stdout, re.M)}
    failed = re.findall(r'^not ok \d+ - (.*)$', result.stdout, re.M)
    return result.returncode, counts, failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--end', type=int, default=len(MUTATIONS))
    options = parser.parse_args()
    for label, repo, relative, old, new, suite in MUTATIONS[options.start:options.end]:
        target = (ENGINE if repo == 'engine' else APP) / relative
        original = target.read_bytes()
        eol = '\r\n' if b'\r\n' in original else '\n'
        old_bytes = old.replace('\n', eol).encode()
        new_bytes = new.replace('\n', eol).encode()
        if not original.count(old_bytes):
            raise RuntimeError(f'Mutation target absent: {label}')
        try:
            target.write_bytes(original.replace(old_bytes, new_bytes))
            red = run(suite)
        finally:
            target.write_bytes(original)
        green = run(suite)
        if red[0] == 0 or not red[2] or green[0] != 0 or green[1].get('fail') != 0:
            raise RuntimeError(f'Mutation not proved RED/GREEN: {label}; RED={red}; GREEN={green}')
        excerpt = (f'| {label} | `{repo}/{relative}` | RED exit {red[0]}: '
            f'`# tests {red[1]["tests"]}; # pass {red[1]["pass"]}; # fail {red[1]["fail"]}; # skipped {red[1]["skipped"]}`; '
            f'`not ok: {red[2][0]}` | Restored GREEN exit {green[0]}: '
            f'`# tests {green[1]["tests"]}; # pass {green[1]["pass"]}; # fail {green[1]["fail"]}; # skipped {green[1]["skipped"]}` |\n')
        with options.report.open('a') as report:
            report.write(excerpt)
        print(f'{label}: RED {red[1]["pass"]}/{red[1]["tests"]}, GREEN {green[1]["pass"]}/{green[1]["tests"]}', flush=True)


if __name__ == '__main__':
    main()
