'use strict';

require('../lib/isolated-environment').activate('npm-global-prefix-discovery');

/* WHY THIS SUITE EXISTS.
 *
 * npm's global prefix is configurable. `npm config set prefix`, an `npm_config_prefix`
 * in the environment, NVM for Windows, a distribution package and a per-user
 * `~/.npm-global` all put globally-installed packages somewhere other than
 * `%APPDATA%\npm\node_modules`. A person can run `claude auth login`, succeed,
 * and still be told by this product that the assistant program "is not installed
 * on this computer" -- because dispatch-time resolution looked in exactly one
 * place, found nothing, and degraded to the bare command name, which this
 * codebase's no-shell spawn cannot resolve.
 *
 * Every assertion below is about OBSERVABLE BEHAVIOUR: given a real package
 * installed at a real location that the supplied environment actually names,
 * does executableFor() hand back something spawnable? None of them pin a
 * spelling, a candidate ordering or an internal helper name, so a better
 * resolver than the one written for them still passes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executableFor } = require('../../src/lib/providers/cli-provider-gateway');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-global-prefix-'));
const made = [];

function place(...segments) {
  const file = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture package file', { mode: 0o755 });
  made.push(file);
  return file;
}

function spawnable(resolved, bareName) {
  // "Spawnable without a shell" is the property that matters: an absolute path
  // to a file that exists. The bare name is what today's fallback returns and
  // is precisely what spawn() without a shell cannot resolve.
  assert.notEqual(resolved.command, bareName,
    `resolution degraded to the bare name ${bareName}, which a no-shell spawn cannot resolve`);
  const target = resolved.prefixArgs.length > 0 ? resolved.prefixArgs[0] : resolved.command;
  assert.ok(path.isAbsolute(target), `expected an absolute location, got ${target}`);
  assert.ok(fs.existsSync(target), `expected an existing file, got ${target}`);
  return target;
}

try {
  /* 1. WINDOWS, CLAUDE, PREFIX RELOCATED (the reported defect).
   * APPDATA exists and is a perfectly ordinary Roaming directory; it just does
   * not hold the npm global root, because npm_config_prefix names another one.
   * Claude Code IS installed, under the prefix npm actually reports. */
  {
    const prefix = path.join(root, 'nvm-node-22');
    const installed = place('nvm-node-22', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.join(root, 'Roaming', 'npm'), { recursive: true });
    const resolved = executableFor('claude', {
      platform: 'win32',
      environment: { APPDATA: path.join(root, 'Roaming'), npm_config_prefix: prefix, PATH: '' }
    });
    assert.equal(spawnable(resolved, 'claude'), installed,
      'an installed Claude Code under the configured npm prefix must be the resolved executable');
  }

  /* 2. WINDOWS, GEMINI, SAME RELOCATED PREFIX.
   * The same helper backs both providers, so a Claude-only fix leaves this red. */
  {
    const prefix = path.join(root, 'nvm-node-22');
    const bundle = place('nvm-node-22', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    const resolved = executableFor('gemini', {
      platform: 'win32',
      environment: { APPDATA: path.join(root, 'Roaming'), npm_config_prefix: prefix, PATH: '' }
    });
    assert.equal(spawnable(resolved, 'gemini'), bundle,
      'an installed Gemini CLI under the configured npm prefix must be the resolved script');
  }

  /* 3. WINDOWS, NO APPDATA AT ALL.
   * A service or scrubbed environment can lack APPDATA entirely while npm's
   * prefix is still knowable. Absence of one variable is not absence of npm. */
  {
    const prefix = path.join(root, 'prefix-without-appdata');
    const installed = place('prefix-without-appdata', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const resolved = executableFor('claude', {
      platform: 'win32',
      environment: { npm_config_prefix: prefix, PATH: '' }
    });
    assert.equal(spawnable(resolved, 'claude'), installed,
      'a knowable npm prefix must resolve even when APPDATA is unset');
  }

  /* 4. LINUX, GEMINI (R1226: this product ships on Linux and Windows).
   * Today every non-win32 platform gets the bare name `gemini` and nothing else
   * is ever inspected, so a Linux install has no resolution at all. */
  {
    const prefix = path.join(root, 'linux-npm-global');
    const binary = place('linux-npm-global', 'bin', 'gemini');
    place('linux-npm-global', 'lib', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    const resolved = executableFor('gemini', {
      platform: 'linux',
      environment: { npm_config_prefix: prefix, PATH: '', HOME: path.join(root, 'nobody') }
    });
    const target = spawnable(resolved, 'gemini');
    assert.ok(target === binary || target.endsWith(path.join('gemini-cli', 'bundle', 'gemini.js')),
      `expected the installed Gemini CLI under the configured prefix, got ${target}`);
  }

  /* 5. FAILURE-CLOSED BEHAVIOUR IS PRESERVED.
   * Nothing installed anywhere the environment names: the answer is still the
   * bare provider command, so the caller still refuses with an installation
   * hint rather than inventing a path. This passes before and after the fix and
   * is here so a resolver cannot buy case 1 by fabricating candidates. */
  {
    const empty = path.join(root, 'prefix-with-nothing-installed');
    fs.mkdirSync(empty, { recursive: true });
    for (const platform of ['win32', 'linux']) {
      for (const provider of ['claude', 'gemini']) {
        const resolved = executableFor(provider, {
          platform,
          environment: { APPDATA: empty, npm_config_prefix: empty, PATH: '', HOME: path.join(root, 'nobody') },
          loginHome: path.join(root, 'nobody')
        });
        assert.deepEqual(resolved, { command: provider, prefixArgs: [] },
          `${provider}/${platform} with nothing installed must fail closed on the bare command`);
      }
    }
  }

  /* 6. THE NO-SHELL GUARANTEE IS PRESERVED.
   * A .cmd / .ps1 shim is not an executable this product may spawn: running one
   * requires a shell. A prefix holding only shims must still fail closed. */
  {
    const prefix = path.join(root, 'shims-only');
    place('shims-only', 'claude.cmd');
    place('shims-only', 'claude.ps1');
    place('shims-only', 'node_modules', '.bin', 'claude.cmd');
    place('shims-only', 'node_modules', '.bin', 'claude.ps1');
    place('shims-only', 'gemini.cmd');
    place('shims-only', 'node_modules', '.bin', 'gemini.ps1');
    for (const provider of ['claude', 'gemini']) {
      const resolved = executableFor(provider, {
        platform: 'win32',
        environment: { APPDATA: prefix, npm_config_prefix: prefix, PATH: '' }
      });
      assert.deepEqual(resolved, { command: provider, prefixArgs: [] },
        `${provider} must never resolve to a .cmd or .ps1 shim, which needs a shell`);
      assert.ok(!/\.(cmd|ps1)$/i.test(resolved.command), 'no shim may be returned as the command');
      for (const argument of resolved.prefixArgs) {
        assert.ok(!/\.(cmd|ps1)$/i.test(String(argument)), 'no shim may be returned as a prefix argument');
      }
    }
  }

  /* 7. HOST PLATFORM DOES NOT DECIDE A CALLER'S PLATFORM.
   * executableFor() takes `platform`. A resolver that consults the host's own
   * process.platform instead answers differently on a Linux build machine than
   * on a Windows one for identical inputs, which is how a cross-platform
   * regression hides. Same inputs, same answer, whatever host runs the suite. */
  {
    const prefix = path.join(root, 'nvm-node-22');
    const resolved = executableFor('claude', {
      platform: 'win32',
      environment: { npm_config_prefix: prefix, PATH: '' }
    });
    assert.equal(spawnable(resolved, 'claude'), path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      'a win32 caller must get the win32 npm layout on any host, not the host platform\'s layout');
  }

  /* 8. THE PRESENCE CHECK AND THE RESOLVER MUST AGREE.
   * detectClaudeCliPresence() gates a claude dispatch BEFORE executableFor() is
   * ever called, and it carried its own copy of the single-location assumption.
   * Measured on this branch before this case existed: with Claude Code really
   * installed under a relocated npm prefix and a GUI launcher's PATH that does
   * not carry the npm bin directory, the resolver found the executable and the
   * presence check still answered ABSENT -- so the dispatch was refused with
   * BRIDGE_CLAUDE_CLI_NOT_INSTALLED for an installation that was right there.
   * A presence check that looks in fewer places than the resolver is a refusal
   * the person cannot act on. */
  {
    const { detectClaudeCliPresence } = require('../../src/lib/mission-bridge/actions');
    const prefix = path.join(root, 'gui-launcher-prefix');
    place('gui-launcher-prefix', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const sterile = path.join(root, 'sterile-system-directory');
    fs.mkdirSync(sterile, { recursive: true });
    const environment = {
      APPDATA: path.join(root, 'Roaming'),
      npm_config_prefix: prefix,
      PATH: sterile,
      PATHEXT: '.COM;.EXE;.BAT;.CMD'
    };
    assert.equal(detectClaudeCliPresence(environment, fs, 'win32'), true,
      'an installed Claude Code under the configured npm prefix must read as present, not absent');
    const resolved = executableFor('claude', { platform: 'win32', environment });
    spawnable(resolved, 'claude');

    // The agreement holds in the negative direction too: nothing installed
    // anywhere the environment names reads as absent, not as unknown, and the
    // resolver fails closed on the same inputs.
    const barren = { APPDATA: sterile, npm_config_prefix: sterile, PATH: sterile, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(detectClaudeCliPresence(barren, fs, 'win32'), false,
      'a machine with no Claude Code must read as definitely absent, not unknown');
    assert.deepEqual(executableFor('claude', { platform: 'win32', environment: barren }),
      { command: 'claude', prefixArgs: [] },
      'presence and resolution must agree on the same inputs');
  }

  console.log('npm-global-prefix-discovery: all cases passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
