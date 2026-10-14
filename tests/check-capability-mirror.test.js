'use strict';

// Behavioural test for tools/check-capability-mirror.js -- the engine-side
// wrapper that binds this checkout's exact HEAD commit and forwards to an app
// checkout's tools/check-payload-current.mjs (R70).
//
// The subject under test is the WRAPPER's own logic: does it refuse a missing
// app checker, refuse a dirty engine tree, and forward the exact commit plus
// the checker's own exit code and output untouched. None of that requires the
// real ~400-file capability payload or the real app repo's checker, so this
// builds a tiny, real Git fixture for the engine side (actual `git status`
// and `git rev-parse`, not a stubbed git) and a tiny stand-in checker script
// for the app side that only needs to prove what it received and echo a
// controllable exit code -- exercising the same child-process contract
// (argv, env, exit code, stdout) the real checker uses, without repeating
// its ~400-file sha256 walk in a second place.
//
// See evidence/controller5-r70-20260908/REPORT.md for the separate proof run
// against the real app checkout's real staged capability/ payload.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCheck, resolveEngineBinding, resolveEngineRoot } = require('../tools/check-capability-mirror');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeEngineFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capability-mirror-engine-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'engine source content\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'initial']);
  return root;
}

// A stand-in for the app's tools/check-payload-current.mjs. It prints the
// staged directory it was given and the two env vars the wrapper is
// responsible for binding, then exits STALE (naming a fixed file) when the
// staged directory contains a `drift.marker` file, otherwise exits current.
const STUB_CHECKER = `
import path from 'node:path';
import fs from 'node:fs';
const staged = process.argv[2];
console.log('staged=' + staged);
console.log('source=' + process.env.TOOLSENABLED_SOURCE);
console.log('sourceRef=' + process.env.TOOLSENABLED_SOURCE_REF);
console.log('billingEnvironmentPresent=' + Object.keys(process.env).some(name => name.toUpperCase() === 'ANTHROPIC_API_KEY'));
if (fs.existsSync(path.join(staged, 'drift.marker'))) {
  console.error('[stub] REFUSING: staged/only-in-payload.txt has no counterpart');
  process.exitCode = 1;
} else {
  console.log('[stub] staged payload is current');
}
`;

function makeAppFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capability-mirror-app-'));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'check-payload-current.mjs'), STUB_CHECKER);
  fs.mkdirSync(path.join(root, 'capability'), { recursive: true });
  return root;
}

function cleanup(...roots) {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${label}`);
}

const engineRoot = makeEngineFixture();
const appRoot = makeAppFixture();

try {
  check('refuses when the app checkout has no checker script', () => {
    const missingAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capability-mirror-no-checker-'));
    try {
      const result = runCheck({ appRoot: missingAppRoot, engineRoot });
      assert.equal(result.ok, false);
      assert.match(result.message, /does not look like a toolsenabled app checkout/);
    } finally {
      cleanup(missingAppRoot);
    }
  });

  check('reports current and forwards the exact bound commit when the stub checker exits clean', () => {
    const head = git(engineRoot, ['rev-parse', 'HEAD']);
    const result = runCheck({ appRoot, engineRoot });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.split(/\r?\n/).includes(`source=${engineRoot}`));
    assert.match(result.stdout, new RegExp(`sourceRef=${head}`));
    assert.match(result.stdout, /staged payload is current/);
  });

  check('names the drifted file and exits non-zero when the stub checker reports staleness', () => {
    const marker = path.join(appRoot, 'capability', 'drift.marker');
    fs.writeFileSync(marker, 'x');
    try {
      const result = runCheck({ appRoot, engineRoot });
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /only-in-payload\.txt has no counterpart/);
    } finally {
      fs.rmSync(marker);
    }
  });

  check('the actual checker child cannot inherit a mixed-case ambient provider key', () => {
    const name = 'anthropic_api_key';
    const previous = process.env[name];
    process.env[name] = 'synthetic-mirror-test-key';
    try {
      const result = runCheck({ appRoot, engineRoot });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /billingEnvironmentPresent=false/);
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  });

  check('refuses to bind a dirty engine checkout', () => {
    const untracked = path.join(engineRoot, 'untracked.txt');
    fs.writeFileSync(untracked, 'uncommitted\n');
    try {
      assert.throws(() => resolveEngineBinding(engineRoot), /not a clean checkout/);
    } finally {
      fs.rmSync(untracked);
    }
  });

  check('resolveEngineBinding returns the exact HEAD once the tree is clean again', () => {
    const head = git(engineRoot, ['rev-parse', 'HEAD']);
    const binding = resolveEngineBinding(engineRoot);
    assert.equal(binding.head, head);
    assert.equal(binding.engineRoot, engineRoot);
  });

  check('resolveEngineRoot defaults to this repository, not a hardcoded path', () => {
    const defaultRoot = resolveEngineRoot(undefined);
    assert.equal(defaultRoot, path.resolve(__dirname, '..'));
    const overridden = resolveEngineRoot('/some/other/checkout');
    assert.equal(overridden, path.resolve('/some/other/checkout'));
  });

  // Subprocess-level smoke test for main() itself (review finding 5,
  // evidence/controller5-r70-review-20260908/REVIEW.md): every check above
  // calls runCheck/resolveEngineBinding directly, in-process. None of them
  // would notice a bug confined to main()'s own argv/exit-code/output glue
  // -- e.g. a hardcoded `process.exitCode = 0` -- because none of them ever
  // run tools/check-capability-mirror.js as a real child process. This does:
  // it spawns the real CLI file with execFileSync against a throwaway,
  // clean `git worktree add` checkout of THIS engine repo at HEAD (this
  // worktree's own tree may be dirty at test time, e.g. mid-edit, and the
  // tool refuses a dirty tree by design), removed again in `finally`.
  {
    const REPO_ROOT = path.resolve(__dirname, '..');
    const SMOKE_STUB = `
import fs from 'node:fs';
process.stdout.write('TOOLSENABLED_SOURCE=' + process.env.TOOLSENABLED_SOURCE + '\\n');
process.stdout.write('TOOLSENABLED_SOURCE_REF=' + process.env.TOOLSENABLED_SOURCE_REF + '\\n');
const code = parseInt(fs.readFileSync('exit-code.txt', 'utf8').trim(), 10);
process.exitCode = code;
`;

    let smokeAppRoot;
    let smokeEngineParent;
    let smokeEngineRoot;
    try {
      smokeAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capability-mirror-smoke-app-'));
      fs.mkdirSync(path.join(smokeAppRoot, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(smokeAppRoot, 'tools', 'check-payload-current.mjs'), SMOKE_STUB);

      smokeEngineParent = fs.mkdtempSync(path.join(os.tmpdir(), 'check-capability-mirror-smoke-engine-'));
      const worktreePath = path.join(smokeEngineParent, 'worktree');
      git(REPO_ROOT, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);
      smokeEngineRoot = fs.realpathSync(worktreePath);
      const smokeHead = git(smokeEngineRoot, ['rev-parse', 'HEAD']);

      for (const expectedCode of [0, 1, 7]) {
        check(
          `subprocess smoke test: main() propagates child exit code ${expectedCode} unchanged and binds `
            + 'TOOLSENABLED_SOURCE/_REF from the throwaway clean worktree even when the ambient '
            + 'environment sets TOOLSENABLED_SOURCE=/evil',
          () => {
            fs.writeFileSync(path.join(smokeAppRoot, 'exit-code.txt'), String(expectedCode));
            let result;
            try {
              const stdout = execFileSync(
                process.execPath,
                [path.join(smokeEngineRoot, 'tools', 'check-capability-mirror.js'), smokeAppRoot],
                {
                  cwd: smokeEngineRoot,
                  encoding: 'utf8',
                  env: { ...process.env, TOOLSENABLED_SOURCE: '/evil', TOOLSENABLED_SOURCE_REF: 'deadbeef' },
                },
              );
              result = { status: 0, stdout };
            } catch (error) {
              result = { status: error.status, stdout: error.stdout || '' };
            }
            assert.equal(result.status, expectedCode);
            assert.ok(
              result.stdout.includes(`TOOLSENABLED_SOURCE=${smokeEngineRoot}`),
              `expected stdout to bind TOOLSENABLED_SOURCE to ${smokeEngineRoot}, not the ambient /evil; got: ${result.stdout}`,
            );
            assert.ok(
              result.stdout.includes(`TOOLSENABLED_SOURCE_REF=${smokeHead}`),
              `expected stdout to bind TOOLSENABLED_SOURCE_REF to ${smokeHead}, not the ambient deadbeef; got: ${result.stdout}`,
            );
          },
        );
      }
    } finally {
      if (smokeEngineRoot) {
        try {
          git(REPO_ROOT, ['worktree', 'remove', '--force', smokeEngineRoot]);
        } catch {
          // Best-effort; the rmSync of smokeEngineParent below still removes
          // the files even if `git worktree remove` itself fails.
        }
      }
      if (smokeAppRoot) cleanup(smokeAppRoot);
      if (smokeEngineParent) fs.rmSync(smokeEngineParent, { recursive: true, force: true });
    }
  }

  console.log(`check-capability-mirror tests passed (${checks} checks)`);
} finally {
  cleanup(engineRoot, appRoot);
}
