// EXECUTABLE CHANGE
'use strict';

/*
Test-can-fail audit (testcanfail-tests-cloud-mirror-test-js)

FOUND — shape 6, an expected value computed by the same code under test:
- `listed.length === selection.included.length` allowed `selectMirrorEntries()`
  to silently drop `src/b.js` from both sides. Mutation: inserted
  `if (entry.path === 'src/b.js') continue` in the scratch copy of
  `selectMirrorEntries()`. Before this change the suite remained GREEN:
  "cloud-mirror tests passed (112 checks: ...)." The independent fixture
  inventory assertion below makes that mutation RED:
  "AssertionError [ERR_ASSERTION]: tree build: the built tree must contain the complete independently specified fixture inventory"
- The remote cardinality was compared with `publication.mirroredEntries`, but
  both are consequences of the publisher's selected inventory. Mutation:
  removed `src/b.js` from `selection.included` inside the scratch copy of
  `publishMirror()`, making both the receipt and remote consistently incomplete.
  The independent remote inventory assertion below makes that mutation RED:
  "AssertionError [ERR_ASSERTION]: publish: the remote must contain the complete independently specified fixture inventory"

NOT-FOUND — shape 1: no assertion is confined to a loop/forEach over a
possibly empty collection. Map construction is followed by direct keyed checks.
NOT-FOUND — shape 2: no test treats a bare non-zero exit or truthy process
return as proof; `raises()` requires the domain error code, and real git output
is inspected where git is the subject.
NOT-FOUND — shape 3: no try/catch or optional chain swallows the failure under
test. `raises()` captures only to assert that an error exists and has its named
code; the final cleanup catch is not test evidence.
NOT-FOUND — shape 4: no assertion checks the mock's own answer as the subject.
The injected read-only git seam drives and checks registration's refusal and
no-write behavior.
NOT-FOUND — shape 5: there is no skip or platform precondition guard.

PRECONDITIONS: none unmet. Both product mutations were temporary; the source
file was restored byte-for-byte after each run (verified with `cmp`). After
restoration the final run was GREEN:
"cloud-mirror tests passed (114 checks: ...)."
*/

// Behavioural tests for the OUTBOUND cloud-mirror path.
//
// THESE RUN AGAINST REAL GIT, DELIBERATELY, and that is the opposite choice
// from tests/cloud-lane.test.js. That file injects a fake exec because its
// subject is custody arithmetic -- manifests, proofs, diff parsing -- and real
// git would add nothing. This file's subject IS git plumbing: whether
// `update-index --index-info` into a temporary GIT_INDEX_FILE really produces
// the filtered tree, whether it really leaves the source checkout's HEAD, index
// and working tree alone, and whether a push and an `ls-remote` really agree. A
// fake git would answer all four questions by construction and prove none of
// them. So each block builds a throwaway repository under a temp root, and
// nothing here touches any real checkout or any real remote.
//
// The behaviours pinned here are the ones that make the lane trustworthy:
//   - an UNCLASSIFIED path refuses the publish; it is never sent and never
//     silently skipped;
//   - a credential-shaped value in a selected file refuses, and an
//     acknowledgement with a stated reason -- and only that -- suppresses it;
//   - withhold beats mirror, so an exception inside a mirrored directory holds;
//   - the source checkout is byte-identical after a publish;
//   - a mirror behind local HEAD REFUSES BY NAME, and the same check passes
//     once it is republished. That pair is the whole point of the file: the
//     refusal proves nothing unless the identical call succeeds when it should.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const mirror = require('../src/lib/cloud-agent/cloud-mirror');
const mirrorCli = require('../tools/cloud-mirror');
const { installationProfileRoot } = require('../src/lib/agent-session-confinement');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown at all)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

const TEMP_ROOT = fs.mkdtempSync(path.join(
  process.platform === 'win32'
    ? path.join(installationProfileRoot(), 'AppData', 'Local', 'Temp')
    : isolatedTemporaryRoot(),
  'cloud-mirror-test-'
));

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file:https' }, ...options
  });
}

// A source repository with a shape that exercises every rule: a mirrored
// directory, a withheld file INSIDE it, an unclassifiable stray, a fixture that
// trips the credential detector, and a root file.
function makeSourceRepo(name) {
  const root = path.join(TEMP_ROOT, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'config', 'public.json'), '{"open":true}\n');
  fs.writeFileSync(path.join(root, 'config', 'owner-private.json'), '{"missionAuthorization":"internal"}\n');
  fs.writeFileSync(path.join(root, 'tests', 'fixture.js'), "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n");
  fs.writeFileSync(path.join(root, 'README.md'), 'source\n');
  git(root, ['init', '--quiet', '-b', 'main', '.'], { cwd: root });
  // Off so the suite does not print a CRLF warning per file per block. It also
  // keeps the blob ids stable across machines, which matters here: several
  // assertions compare TREE ids, and a line-ending rewrite would change them.
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'seed']);
  return root;
}

function makeBareMirror(name) {
  const root = path.join(TEMP_ROOT, name);
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', root], { windowsHide: true });
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

const GOOD_BOUNDARY = {
  schemaVersion: 1,
  mirror: { prefixes: ['src/', 'config/', 'tests/'], paths: ['README.md'] },
  withhold: { paths: ['config/owner-private.json'], prefixes: [] },
  credentialScanAcknowledged: {
    'tests/': 'Fixtures under this prefix carry credential-shaped strings on purpose so the scrubbers have something realistic to be tested against.'
  }
};

const MIRROR_BRANCH = 'cloud-mirror/demo';
const MIRROR_HTTPS_REMOTE = 'https://github.com/Example/mirror.git';

function registryFor({ file, sourceRoot, mirrorRemote = MIRROR_HTTPS_REMOTE, boundaryManifest, mirrorBranch = MIRROR_BRANCH, cloudRepository = 'Example/mirror' }) {
  return writeJson(file, {
    schemaVersion: mirror.REGISTRY_SCHEMA,
    projects: { demo: {
      sourceRoot, mirrorRemote, mirrorBranch, boundaryManifest, cloudRepository,
      githubRepository: cloudRepository, privacyVerifiedAt: '2026-08-30T00:00:00.000Z'
    } }
  });
}

const PRIVATE_REPOSITORY = Object.freeze({
  fullName: 'Example/mirror', private: true, visibility: 'private', archived: false, disabled: false
});
async function localNetworkGit(repoRoot, args) {
  const invocation = repoRoot ? ['-C', repoRoot, ...args] : args;
  const result = spawnSync('git', invocation, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file:https' }
  });
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '', stderr: result.stderr || '', timedOut: false
  };
}
function localPublishPrivacy(localRemote) {
  return Object.freeze({
    githubRepoGetImpl: async () => PRIVATE_REPOSITORY,
    networkGitImpl: (repoRoot, args, options) => mirror.defaultNetworkGit(repoRoot,
      args.map((value) => value === MIRROR_HTTPS_REMOTE ? localRemote : value), options)
  });
}

(async () => {
  // ---------------------------------------------------------------------
  // 1. The manifest refuses to be ambiguous, empty, or unexplained.
  // ---------------------------------------------------------------------
  {
    const dir = path.join(TEMP_ROOT, 'manifests');
    await raises('CLOUD_MIRROR_BOUNDARY_MISSING',
      () => mirror.loadBoundary(path.join(dir, 'nope.json')),
      'manifest: an absent manifest must refuse rather than pass a tree containing anything at all');

    await raises('CLOUD_MIRROR_BOUNDARY_INVALID',
      () => mirror.loadBoundary(writeJson(path.join(dir, 'empty.json'), { schemaVersion: 1, mirror: { paths: [] } })),
      'manifest: a manifest that selects nothing must refuse -- an empty mirror class is an unwritten manifest, not a strict one');

    await raises('CLOUD_MIRROR_BOUNDARY_INVALID',
      () => mirror.loadBoundary(writeJson(path.join(dir, 'both.json'), {
        schemaVersion: 1, mirror: { prefixes: ['src/'] }, withhold: { prefixes: ['src/'] }
      })),
      'manifest: one path in two classes must refuse -- precedence would resolve it silently, and a silent boundary is unreadable');

    await raises('CLOUD_MIRROR_BOUNDARY_INVALID',
      () => mirror.loadBoundary(writeJson(path.join(dir, 'bareack.json'), {
        schemaVersion: 1, mirror: { prefixes: ['src/'] }, credentialScanAcknowledged: { 'src/x.js': 'ok' }
      })),
      'manifest: an acknowledgement without a real reason must refuse -- an unexplained exception is how a temporary list becomes permanent');

    await raises('CLOUD_MIRROR_BOUNDARY_INVALID',
      () => mirror.loadBoundary(writeJson(path.join(dir, 'backslash.json'), {
        schemaVersion: 1, mirror: { paths: ['src\\a.js'] }
      })),
      'manifest: a backslash entry must refuse -- git names files with forward slashes everywhere, so it would match nothing and classify nothing');

    const loaded = mirror.loadBoundary(writeJson(path.join(dir, 'good.json'), GOOD_BOUNDARY));
    check(loaded.manifestSha256.length === 64,
      'manifest: a loaded boundary must carry its own sha256 so a publication can record WHICH decision produced it');
    check(mirror.classifyForMirror('config/owner-private.json', loaded).klass === 'withhold',
      'manifest: withhold must beat a mirror prefix, or an exception inside a mirrored directory is not an exception');
    check(mirror.classifyForMirror('config/public.json', loaded).klass === 'mirror',
      'manifest: a file under a mirror prefix with no withhold rule must be mirrored');
    check(mirror.classifyForMirror('secrets/leak.txt', loaded).klass === 'unclassified',
      'manifest: a path matching no rule must be unclassified, never defaulted into the mirror');
  }

  // ---------------------------------------------------------------------
  // 2. Selection: unclassified and non-regular entries refuse by name.
  // ---------------------------------------------------------------------
  {
    const boundary = mirror.loadBoundary(path.join(TEMP_ROOT, 'manifests', 'good.json'));
    const stray = [
      { mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 10, path: 'src/a.js' },
      { mode: '100644', type: 'blob', oid: 'b'.repeat(40), size: 10, path: 'nowhere/x.txt' }
    ];
    const selection = mirror.selectMirrorEntries(stray, boundary);
    check(selection.unclassified.length === 1 && selection.unclassified[0] === 'nowhere/x.txt',
      'selection: an unmatched path must land in unclassified, named');
    await raises('CLOUD_MIRROR_UNCLASSIFIED',
      () => mirror.assertSelectable(selection, 'boundary.json'),
      'selection: an unclassified path must REFUSE the publish -- assumed-safe-by-default is exactly the silence this gate exists to end');

    const linked = mirror.selectMirrorEntries([
      { mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 10, path: 'src/a.js' },
      { mode: '120000', type: 'blob', oid: 'c'.repeat(40), size: 12, path: 'src/link' }
    ], boundary);
    await raises('CLOUD_MIRROR_NONREGULAR_REFUSED',
      () => mirror.assertSelectable(linked, 'boundary.json'),
      'selection: a symlink must refuse -- it is classified by its name while its bytes are a path that may point anywhere');

    const gitlinked = mirror.selectMirrorEntries([
      { mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 10, path: 'src/a.js' },
      { mode: '160000', type: 'commit', oid: 'd'.repeat(40), size: null, path: 'src/vendor' }
    ], boundary);
    await raises('CLOUD_MIRROR_NONREGULAR_REFUSED',
      () => mirror.assertSelectable(gitlinked, 'boundary.json'),
      'selection: a gitlink must refuse -- dropping it hands a cloud agent a tree with a hole nothing in the tree explains');

    // The refusal above turns on the word "unexplained". `withhold` is how a
    // path stops being unexplained: named, with a reason, in a manifest that
    // itself travels in the mirror. A withheld gitlink publishes no bytes and
    // leaves no unanswerable hole, so it must pass -- otherwise a tree that
    // legitimately contains a submodule can never be mirrored at all, which is
    // precisely why cloud-mirror/website had never once published.
    const withheldLink = mirror.selectMirrorEntries([
      { mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 10, path: 'src/a.js' },
      { mode: '160000', type: 'commit', oid: 'e'.repeat(40), size: null, path: 'config/owner-private.json' }
    ], boundary);
    check(withheldLink.nonRegular.length === 0,
      'selection: a gitlink the manifest withholds BY NAME must not be reported as non-regular -- the manifest has explained it');
    check(withheldLink.withheld.length === 1
      && withheldLink.withheld[0].path === 'config/owner-private.json'
      && withheldLink.withheld[0].mode === '160000',
      'selection: a withheld non-regular entry must still be RECORDED in withheld, carrying its mode, so a plan shows it rather than hiding it');
    mirror.assertSelectable(withheldLink, 'boundary.json');
    check(true, 'selection: a withheld gitlink must not refuse the publish');

    // The dangerous directions stay closed. Silence is not an explanation.
    const strayLink = mirror.selectMirrorEntries([
      { mode: '100644', type: 'blob', oid: 'a'.repeat(40), size: 10, path: 'src/a.js' },
      { mode: '120000', type: 'blob', oid: 'f'.repeat(40), size: 9, path: 'nowhere/link' }
    ], boundary);
    await raises('CLOUD_MIRROR_NONREGULAR_REFUSED',
      () => mirror.assertSelectable(strayLink, 'boundary.json'),
      'selection: an UNCLASSIFIED symlink must still refuse -- only an explicit withhold explains a hole, never silence');

    await raises('CLOUD_MIRROR_EMPTY_SELECTION',
      () => mirror.assertSelectable({ included: [], withheld: [{ path: 'x' }], unclassified: [], nonRegular: [] }, 'boundary.json'),
      'selection: a boundary that withholds everything must refuse -- an empty mirror is a lane that silently diffs against nothing');
  }

  // ---------------------------------------------------------------------
  // 3. The content refusal, and what an acknowledgement does and does not do.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('scan-src');
    const boundary = mirror.loadBoundary(path.join(TEMP_ROOT, 'manifests', 'good.json'));
    const entries = require('../src/lib/cloud-agent/cloud-lane')
      .parseLsTreeOutput(String(mirror.runGitSync(source, ['ls-tree', '-r', '-l', '-z', 'HEAD'])));
    const selection = mirror.selectMirrorEntries(entries, boundary);
    mirror.assertSelectable(selection, 'good.json');

    const scan = mirror.scanBlobsForCredentials({ repoRoot: source, included: selection.included, boundary });
    check(scan.violations.length === 0,
      'content scan: an acknowledged fixture must not refuse the publish');
    check(scan.acknowledgedHits.length === 1 && scan.acknowledgedHits[0].path === 'tests/fixture.js',
      'content scan: an acknowledged hit must still be REPORTED -- suppressing it entirely would hide a rule acknowledging more than its reason claims');
    check(!JSON.stringify(scan).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      'content scan: the matched VALUE must never appear in the result -- a refusal that quotes the secret writes it somewhere new');
    check(/ghp_/.test(scan.acknowledgedHits[0].shape),
      'content scan: the reported shape must be specific enough to act on');

    // The mutation: remove the acknowledgement and the identical tree refuses.
    const unacknowledged = mirror.loadBoundary(writeJson(path.join(TEMP_ROOT, 'manifests', 'noack.json'), {
      ...GOOD_BOUNDARY, credentialScanAcknowledged: {}
    }));
    const strict = mirror.scanBlobsForCredentials({ repoRoot: source, included: selection.included, boundary: unacknowledged });
    check(strict.violations.length === 1 && strict.violations[0].path === 'tests/fixture.js',
      'content scan: without the acknowledgement the SAME file must be a violation, or the acknowledgement is not what suppressed it');

    await raises('CLOUD_MIRROR_GIT_FAILED',
      () => mirror.scanBlobsForCredentials({
        repoRoot: source,
        included: [selection.included[0]],
        boundary,
        runGitImpl: () => Buffer.from(`${selection.included[0].oid} blob 20\nshort\n`)
      }),
      'content scan: a truncated batch body must refuse rather than count the partial bytes as a complete clean scan');

    await raises('CLOUD_MIRROR_REMOTE_UNREADABLE',
      () => mirror.readMirrorRef({
        remote: 'example.invalid/mirror', branch: 'main',
        networkGitImpl: async () => ({ exitCode: 0, stdout: 'not-an-object-id\trefs/heads/main\n', stderr: '' })
      }),
      'mirror ref: malformed successful output must refuse rather than collapse into the definite answer that the branch is absent');

    const malformedReceipts = path.join(TEMP_ROOT, 'malformed-receipts');
    writeJson(path.join(malformedReceipts, 'demo.json'), {
      schemaVersion: mirror.RECEIPT_SCHEMA, latest: null, history: { publicationCommit: 'lost' }
    });
    await raises('CLOUD_MIRROR_RECEIPT_INVALID',
      () => mirror.readReceipts(malformedReceipts, 'demo'),
      'receipts: an unreadable history must refuse rather than collapse into a definite empty history');
  }

  // ---------------------------------------------------------------------
  // 4. The tree is filtered, and the source checkout is untouched.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('build-src');
    const before = {
      head: git(source, ['rev-parse', 'HEAD']).trim(),
      status: git(source, ['status', '--porcelain']),
      indexTree: git(source, ['write-tree']).trim()
    };
    const boundary = mirror.loadBoundary(path.join(TEMP_ROOT, 'manifests', 'good.json'));
    const entries = require('../src/lib/cloud-agent/cloud-lane')
      .parseLsTreeOutput(String(mirror.runGitSync(source, ['ls-tree', '-r', '-l', '-z', 'HEAD'])));
    const selection = mirror.selectMirrorEntries(entries, boundary);
    // Supply an explicit owned bare scratch so the test can inspect the tree
    // before removing it. The product's default scratch is intentionally
    // ephemeral; looking the returned tree up in the source repository would
    // assert the source-object mutation this boundary now forbids.
    const treeScratch = path.join(TEMP_ROOT, 'build-tree-scratch.git');
    git(TEMP_ROOT, ['init', '--bare', '--quiet', treeScratch]);
    const tree = mirror.buildMirrorTree({
      repoRoot: source,
      included: selection.included,
      scratchRepository: { root: treeScratch, alternateObjects: path.join(source, '.git', 'objects') }
    });
    const listed = git(treeScratch, ['ls-tree', '-r', '--name-only', tree], {
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file:https', GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(source, '.git', 'objects') }
    }).split('\n').filter(Boolean).sort();

    check(!listed.includes('config/owner-private.json'),
      'tree build: the withheld file must be ABSENT from the built tree, not merely unlisted in a manifest');
    check(listed.includes('config/public.json') && listed.includes('src/a.js') && listed.includes('README.md'),
      'tree build: every mirrored file must be present in the built tree');
    check(listed.length === selection.included.length,
      'tree build: the tree must hold exactly the selected entries and nothing else');
    check(JSON.stringify(listed) === JSON.stringify([
      'README.md', 'config/public.json', 'src/a.js', 'src/b.js', 'tests/fixture.js'
    ]),
      'tree build: the built tree must contain the complete independently specified fixture inventory');

    check(git(source, ['rev-parse', 'HEAD']).trim() === before.head,
      'tree build: HEAD must not move -- this runs in checkouts other agents are using at the same time');
    check(git(source, ['status', '--porcelain']) === before.status,
      'tree build: the working tree must be byte-identical afterwards');
    check(git(source, ['write-tree']).trim() === before.indexTree,
      'tree build: the real index must be untouched, which is what GIT_INDEX_FILE is for');
  }

  // ---------------------------------------------------------------------
  // 5. THE HEADLINE: publish, then refuse a dispatch when the mirror falls
  //    behind, then pass again once it is republished.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('lane-src');
    const remote = makeBareMirror('lane-mirror.git');
    const manifest = writeJson(path.join(source, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const registryPath = registryFor({
      file: path.join(TEMP_ROOT, 'lane-registry.json'),
      sourceRoot: source, boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const stateRoot = path.join(TEMP_ROOT, 'lane-state');
    const firstCommit = git(source, ['rev-parse', 'HEAD']).trim();
    const localPublish = localPublishPrivacy(remote);

    // A dispatch before anything is published must refuse, not proceed.
    await raises('CLOUD_MIRROR_BRANCH_ABSENT',
      () => mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish }),
      'freshness: with nothing published, a dispatch must refuse -- a cloud task would diff against an empty branch');

    const published = await mirror.publishMirror({
      projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(), ...localPublish
    });
    check(published.publication.sourceCommit === firstCommit,
      'publish: the receipt must record the source commit the tree was actually built from');
    check(git(remote, ['ls-tree', '-r', '--name-only', MIRROR_BRANCH]).split('\n').filter(Boolean).length === published.publication.mirroredEntries,
      'publish: the remote must hold exactly the entries the publication claims');
    const remotePaths = git(remote, ['ls-tree', '-r', '--name-only', MIRROR_BRANCH]).split('\n').filter(Boolean).sort();
    check(JSON.stringify(remotePaths) === JSON.stringify([
      'README.md', 'config/public.json', 'src/a.js', 'src/b.js', 'tests/fixture.js'
    ]),
      'publish: the remote must contain the complete independently specified fixture inventory');
    check(!git(remote, ['ls-tree', '-r', '--name-only', MIRROR_BRANCH]).includes('owner-private'),
      'publish: the withheld file must be absent from the REMOTE, which is the only place that matters');

    const privateHead = git(remote, ['rev-parse', MIRROR_BRANCH]).trim();
    await raises('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
      () => mirror.publishMirror({
        projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(),
        ...localPublish,
        githubRepoGetImpl: async () => ({ fullName: 'Example/mirror', private: false, visibility: 'public', archived: false, disabled: false })
      }),
      'publish: privacy is rechecked immediately before every publish and a repository made public refuses');
    await raises('CLOUD_MIRROR_REPOSITORY_ARCHIVED',
      () => mirror.publishMirror({
        projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(),
        ...localPublish,
        githubRepoGetImpl: async () => ({ fullName: 'Example/mirror', private: true, visibility: 'private', archived: true, disabled: false })
      }),
      'publish: an archived destination refuses at the final authenticated GitHub gate');
    await raises('CLOUD_MIRROR_REPOSITORY_DISABLED',
      () => mirror.publishMirror({
        projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(),
        ...localPublish,
        githubRepoGetImpl: async () => ({ fullName: 'Example/mirror', private: true, visibility: 'private', archived: false, disabled: true })
      }),
      'publish: a disabled destination refuses at the final authenticated GitHub gate');
    check(git(remote, ['rev-parse', MIRROR_BRANCH]).trim() === privateHead,
      'publish: a failed privacy recheck leaves the remote head untouched');

    const fresh = await mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish });
    check(fresh.fresh === true && fresh.witness === 'receipt',
      'freshness: a mirror at local HEAD must pass, or every refusal below proves nothing');

    // THE MUTATION. One new commit locally and nothing republished: the mirror
    // is now exactly one commit behind, which is the shape of the 467-commit
    // drift that produced empty applies on the app repository.
    fs.writeFileSync(path.join(source, 'src', 'c.js'), 'module.exports = 3;\n');
    git(source, ['add', '-A']);
    git(source, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'a local change nobody mirrored']);
    const secondCommit = git(source, ['rev-parse', 'HEAD']).trim();
    check(secondCommit !== firstCommit, 'freshness: the mutation must actually move HEAD');

    const stale = await raises('CLOUD_MIRROR_STALE',
      () => mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish }),
      'freshness: A MIRROR BEHIND LOCAL HEAD MUST REFUSE BY NAME -- this is the defect the whole lane exists to close');
    check(stale.details && stale.details.commitsBehind === 1,
      'freshness: the refusal must say HOW FAR behind, so the reader can tell one commit from four hundred');
    check(stale.message.includes(firstCommit.slice(0, 12)) && stale.message.includes(secondCommit.slice(0, 12)),
      'freshness: the refusal must name both commits, or it cannot be acted on without a second investigation');

    // And the other half of the mutation: republishing makes the identical
    // call pass. A gate that only ever says no is indistinguishable from one
    // that is broken.
    await mirror.publishMirror({ projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(), ...localPublish });
    const again = await mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish });
    check(again.fresh === true && again.localHead === secondCommit,
      'freshness: republishing must make the same check pass at the new HEAD');

    // A boundary that moves after a publish is the case where HEAD matches and
    // the mirror still holds a different set of files.
    writeJson(manifest, { ...GOOD_BOUNDARY, withhold: { paths: ['config/owner-private.json', 'config/public.json'], prefixes: [] } });
    await raises('CLOUD_MIRROR_BOUNDARY_DRIFTED',
      () => mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish }),
      'freshness: a boundary changed after the publish must refuse -- HEAD matching is not the same as the mirror holding the approved files');
    writeJson(manifest, GOOD_BOUNDARY);

    // Work on the mirror that no publication accounts for is a harvest nobody
    // has done. Republishing over it would put it behind a commit nobody reads.
    const agentClone = path.join(TEMP_ROOT, 'agent-clone');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--branch', MIRROR_BRANCH, '-c', 'core.autocrlf=false', remote, agentClone], { windowsHide: true });
    fs.writeFileSync(path.join(agentClone, 'src', 'agent.js'), 'module.exports = 4;\n');
    git(agentClone, ['add', '-A']);
    git(agentClone, ['-c', 'user.email=a@a', '-c', 'user.name=agent', 'commit', '--quiet', '-m', 'agent work']);
    git(agentClone, ['push', '--quiet', 'origin', `HEAD:${MIRROR_BRANCH}`]);

    await raises('CLOUD_MIRROR_UNHARVESTED_WORK',
      () => mirror.publishMirror({ projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(), ...localPublish }),
      'publish: a mirror head no publication accounts for must refuse -- overwriting it discards a cloud agent\'s only copy');
    await raises('CLOUD_MIRROR_PUBLICATION_UNKNOWN',
      () => mirror.checkMirrorFreshness({ projectKey: 'demo', registryPath, stateRoot, ...localPublish }),
      'freshness: a mirror head with no publication binding must refuse -- nothing states which local commit it was built from');

    // Recovery is outside the ordinary publisher. This fixture models the
    // owner explicitly resetting the dedicated private workspace branch; the
    // product itself has no force/supersede argument.
    git(remote, ['update-ref', '-d', `refs/heads/${MIRROR_BRANCH}`]);
    const recovered = await mirror.publishMirror({
      projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(), ...localPublish
    });
    check(git(remote, ['rev-parse', MIRROR_BRANCH]).trim() === recovered.publication.publicationCommit,
      'publish: after an explicit external reset, the ordinary publisher creates the authoritative workspace branch again');

    // The local receipt is the only freshness authority. Delete it while the
    // remote still points at our trailered commit: dispatch must fail closed
    // after ls-remote, without fetching or adopting the remote object.
    fs.rmSync(path.join(stateRoot, 'demo.json'), { force: true });
    const freshnessNetworkCalls = [];
    const unreceiptedFreshness = await raises('CLOUD_MIRROR_PUBLICATION_UNKNOWN',
      () => mirror.checkMirrorFreshness({
        projectKey: 'demo', registryPath, stateRoot,
        ...localPublish,
        networkGitImpl: async (repoRoot, args) => {
          freshnessNetworkCalls.push([...args]);
          return localPublish.networkGitImpl(repoRoot, args);
        }
      }),
      'freshness: deleting the local receipt must refuse even though the remote commit carries valid publication trailers');
    check(/Remote commit trailers are informational human provenance and are not trusted as freshness authority/.test(unreceiptedFreshness.message),
      'freshness: the refusal explicitly states why a valid-looking remote trailer cannot authorize dispatch');
    check(freshnessNetworkCalls.length === 1 && freshnessNetworkCalls[0][0] === 'ls-remote',
      'freshness: an unreceipted head permits only the ref observation; it is not fetched, adopted, pushed or otherwise inspected');

    // Publish uses the same local-current authority: a remote trailer is not
    // write provenance and cannot become the next publication's parent.
    const publishNetworkCalls = [];
    const unreceipted = await raises('CLOUD_MIRROR_UNHARVESTED_WORK',
      () => mirror.publishMirror({
        projectKey: 'demo', registryPath, stateRoot, publishedAt: new Date().toISOString(),
        ...localPublish,
        networkGitImpl: async (repoRoot, args) => {
          publishNetworkCalls.push([...args]);
          return localPublish.networkGitImpl(repoRoot, args);
        }
      }),
      'publish: a remote trailer is not trusted as authority to parent or overwrite local work');
    check(/Remote trailers are not trusted/.test(unreceipted.message),
      'publish: the refusal states that remote provenance was deliberately not trusted');
    check(publishNetworkCalls.every((args) => args[0] !== 'fetch' && args[0] !== 'push'),
      'publish: an unreceipted remote head is neither fetched nor pushed');
  }

  // A replacement ref can make ordinary Git show a different tree while
  // rev-parse still prints the original commit id. Cloud Mirror must never put
  // those substituted bytes behind a receipt that names the original source.
  {
    const source = makeSourceRepo('replace-ref-source');
    const originalCommit = git(source, ['rev-parse', 'HEAD']).trim();
    const originalBytes = fs.readFileSync(path.join(source, 'src', 'a.js'), 'utf8');
    fs.writeFileSync(path.join(source, 'src', 'a.js'), 'module.exports = "replacement-ref";\n');
    git(source, ['add', '-A']);
    git(source, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'replacement object graph']);
    const replacementCommit = git(source, ['rev-parse', 'HEAD']).trim();
    git(source, ['reset', '--hard', '--quiet', originalCommit]);
    git(source, ['replace', originalCommit, replacementCommit]);
    check(git(source, ['show', `${originalCommit}:src/a.js`]) !== originalBytes,
      'replace-ref oracle precondition: ordinary Git substitutes replacement bytes under the original commit id');

    writeJson(path.join(source, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const remote = makeBareMirror('replace-ref-mirror.git');
    const registryPath = registryFor({
      file: path.join(TEMP_ROOT, 'replace-ref-registry.json'),
      sourceRoot: source,
      boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const published = await mirror.publishMirror({
      projectKey: 'demo',
      registryPath,
      stateRoot: path.join(TEMP_ROOT, 'replace-ref-state'),
      publishedAt: '2026-09-01T00:00:00.000Z',
      ...localPublishPrivacy(remote)
    });
    check(published.publication.sourceCommit === originalCommit,
      'replace-ref oracle: the receipt names the actual HEAD commit');
    check(git(remote, ['show', `${MIRROR_BRANCH}:src/a.js`]) === originalBytes,
      'replace-ref oracle: the pushed tree carries actual HEAD bytes, never replacement content under that source id');
  }

  // ---------------------------------------------------------------------
  // 6. A commit that is not one of ours carries no binding.
  // ---------------------------------------------------------------------
  {
    check(mirror.parsePublicationTrailers('agent: fixed a thing\n\nSigned-off-by: someone\n') === null,
      'trailers: an ordinary commit must produce no binding, so it can never be read as a publication');
    check(mirror.parsePublicationTrailers(`x\n\n${mirror.TRAILER_MARKER}: v1\nSource-Commit: not-a-sha\n`) === null,
      'trailers: a malformed source commit must produce no binding rather than a plausible one');
    const good = mirror.parsePublicationTrailers(mirror.buildPublicationMessage({
      sourceCommit: 'f'.repeat(40), sourceBranch: 'main', sourceLabel: 'Example/mirror',
      boundarySha256: '0'.repeat(64), mirroredCount: 3, withheldCount: 1, publishedAt: '2026-08-24T00:00:00.000Z'
    }));
    check(good && good.sourceCommit === 'f'.repeat(40),
      'trailers: informational human provenance must round-trip through the parser without becoming freshness authority');
  }

  // ---------------------------------------------------------------------
  // 7. An unregistered repository cannot be dispatched against.
  // ---------------------------------------------------------------------
  {
    const registryPath = path.join(TEMP_ROOT, 'lane-registry.json');
    await raises('CLOUD_MIRROR_NOT_REGISTERED',
      () => mirror.checkMirrorFreshness({ cloudRepository: 'Nobody/unknown', registryPath, stateRoot: path.join(TEMP_ROOT, 'lane-state') }),
      'registry: a repository with no registered mirror must refuse -- whether a cloud agent would see the current tree cannot be answered, and unanswerable is not fresh');
    await raises('CLOUD_MIRROR_NOT_REGISTERED',
      () => mirror.checkMirrorFreshness({ cloudRepository: 'Example/mirror', registryPath: path.join(TEMP_ROOT, 'no-such-registry.json') }),
      'registry: an absent registry must refuse, never read as "no mirrors are needed"');

    const parsedRemote = mirror.githubRepositoryFromRemote('https://github.com/CustomerOwner/private-mirror.git');
    check(parsedRemote.fullName === 'CustomerOwner/private-mirror'
      && parsedRemote.httpsUrl === 'https://github.com/CustomerOwner/private-mirror.git',
      'registry: the backend canonicalizes exact owner/name from a credential-free HTTPS GitHub remote');
    await raises('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      () => mirror.githubRepositoryFromRemote('git@github.com:CustomerOwner/private-mirror.git'),
      'registry: SSH is refused because SSH config can redirect github.com after privacy was checked');
    await raises('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      () => mirror.githubRepositoryFromRemote('https://github.com.evil.example/CustomerOwner/private-mirror.git'),
      'registry: a GitHub-looking hostname is not github.com and must refuse');
    await raises('CLOUD_MIRROR_REMOTE_NOT_GITHUB',
      () => mirror.githubRepositoryFromRemote('https://github.com:444/CustomerOwner/private-mirror.git'),
      'registry: a non-default GitHub port is not the exact HTTPS destination and must refuse');
    const sentinel = 'do-not-repeat-this-secret';
    const credentialError = await raises('CLOUD_MIRROR_REMOTE_CREDENTIALS_REFUSED',
      () => mirror.githubRepositoryFromRemote(`https://user:${sentinel}@github.com/CustomerOwner/private-mirror.git`),
      'registry: a credential-bearing HTTPS URL is refused');
    check(!credentialError.message.includes(sentinel),
      'registry: rejecting a credential-bearing URL never repeats the credential in an error');
    const sshCredentialError = await raises('CLOUD_MIRROR_REMOTE_CREDENTIALS_REFUSED',
      () => mirror.githubRepositoryFromRemote(`ssh://git:${sentinel}@github.com/CustomerOwner/private-mirror.git`),
      'registry: an SSH URL carrying a password is refused before transport selection');
    check(!sshCredentialError.message.includes(sentinel),
      'registry: the SSH credential refusal also keeps the rejected secret out of diagnostics');

    await raises('CLOUD_MIRROR_USAGE',
      () => mirrorCli.parseCliArgs(['register', '--project', 'demo']),
      'CLI: registration is absent because only the authenticated mission action can establish GitHub privacy');
    const disableCommand = mirrorCli.parseCliArgs([
      'disable', '--project', 'demo', '--registry', path.join(TEMP_ROOT, 'registry.json'),
      '--state-root', path.join(TEMP_ROOT, 'receipts')
    ]);
    check(disableCommand.command === 'disable' && disableCommand.options.project === 'demo',
      'CLI: the local disable lifecycle is available for an explicitly selected customer mirror binding');
    await raises('CLOUD_MIRROR_USAGE',
      () => mirrorCli.parseCliArgs(['disable', '--project', 'demo', '--delete-remote']),
      'CLI: disable has no remote-delete flag; it only turns off the local binding and receipt authority');
    await raises('CLOUD_MIRROR_USAGE',
      () => mirrorCli.parseCliArgs(['publish', '--project', 'demo', '--supersede']),
      'CLI: supersede is no longer an accepted publication escape flag');

    const legacyPath = path.join(TEMP_ROOT, 'legacy-registry.json');
    writeJson(legacyPath, {
      schemaVersion: mirror.REGISTRY_SCHEMA,
      projects: { legacy: {
        sourceRoot: TEMP_ROOT, mirrorRemote: 'https://github.com/Example/legacy.git',
        mirrorBranch: 'cloud-mirror/legacy', boundaryManifest: 'boundary.json', cloudRepository: 'Example/legacy'
      } }
    });
    const legacy = mirror.loadRegistry({ registryPath: legacyPath });
    await raises('CLOUD_MIRROR_REVERIFY_REQUIRED',
      () => mirror.projectFor({ registry: legacy, projectKey: 'legacy' }),
      'registry: a legacy entry is disabled until exact GitHub privacy is reverified');
    check(mirror.listRegisteredProjects({ registryPath: legacyPath }).projects[0].enabled === false,
      'registry: the setup surface can show a legacy entry as disabled instead of silently using it');

    const unsafePath = path.join(TEMP_ROOT, 'unsafe-registry.json');
    const verified = {
      sourceRoot: TEMP_ROOT, mirrorRemote: 'https://github.com/Example/verified.git',
      mirrorBranch: 'cloud-mirror/verified', boundaryManifest: 'boundary.json',
      cloudRepository: 'Example/verified', githubRepository: 'Example/verified',
      privacyVerifiedAt: '2026-08-30T00:00:00.000Z'
    };
    writeJson(unsafePath, {
      schemaVersion: mirror.REGISTRY_SCHEMA,
      projects: {
        nongithub: { ...verified, mirrorRemote: 'https://example.invalid/Example/verified.git', mirrorBranch: 'cloud-mirror/nongithub' },
        wrongidentity: { ...verified, mirrorBranch: 'cloud-mirror/wrongidentity', githubRepository: 'Example/somewhere-else' },
        wrongbranch: { ...verified, mirrorBranch: 'main' }
      }
    });
    const unsafe = mirror.listRegisteredProjects({ registryPath: unsafePath });
    check(unsafe.projects.every((project) => project.enabled === false),
      'registry: non-GitHub remotes, remote/repository identity mismatches and non-derived branches all remain disabled even with hand-written privacy fields');
  }

  // ---------------------------------------------------------------------
  // 8. REGISTRATION -- the setup path that replaces hand-editing the registry.
  //
  // These run against REAL git remotes for the same reason the rest of this
  // file does: the whole value of registration is that it establishes, at the
  // moment a person can still fix it, facts that a stored string cannot carry.
  // A fake git would grant reach and write access by construction and prove
  // neither. The measured case this exists for: a private repository under an
  // owner whose credential this machine does not hold answers "Repository not
  // found" -- indistinguishable, to a string check, from a typo.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('register-source');
    const boundaryFile = writeJson(path.join(source, 'config', 'mirror.json'), GOOD_BOUNDARY);
    git(source, ['add', '-A']);
    git(source, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'boundary']);
    const remote = makeBareMirror('register-mirror.git');
    const registryPath = path.join(TEMP_ROOT, 'register', 'registry.json');
    const base = {
      sourceRoot: source,
      mirrorRemote: remote,
      boundaryManifest: path.relative(source, boundaryFile).split(path.sep).join('/'),
      registryPath,
      /* The core, not the caller, invokes this authenticated metadata boundary
         and asserts the exact typed destination itself. */
      githubRepoGetImpl: async () => PRIVATE_REPOSITORY,
      githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror', fullName: 'Example/mirror' }),
      networkGitImpl: localNetworkGit,
      runGitImpl: mirror.runGitSync
    };

    // -- the happy path, and the ROUND TRIP that is the whole point ----------
    const registered = await mirror.registerMirrorProject({
      ...base, projectKey: 'demo', cloudRepository: 'Example/mirror'
    });
    check(registered.ok === true, 'register: a reachable, writable mirror with a real boundary registers');
    check(registered.replaced === false, 'register: a first registration is not a replacement');

    // THIS IS THE ASSERTION THAT MATTERS. A setup path that writes something
    // the dispatch path will not accept has moved the hand-editing one step
    // later rather than removing it.
    const loaded = mirror.loadRegistry({ registryPath });
    check(loaded.projects.has('demo'), 'register: loadRegistry accepts exactly what registerMirrorProject wrote');
    const resolvedProject = mirror.projectFor({ registry: loaded, cloudRepository: 'Example/mirror' });
    check(resolvedProject.key === 'demo', 'register: a dispatch resolves the registered project by its cloud repository');
    check(!!mirror.loadBoundary(resolvedProject.boundaryManifest),
      'register: the boundary manifest path it stored resolves to a manifest that loads');

    // -- API privacy/lifecycle and Git transport facts are all established --
    const states = new Map(registered.checks.map((entry) => [entry.name, entry.state]));
    check(states.get('mirror repository is private') === 'OK',
      'register: authenticated GitHub metadata establishes private visibility');
    check(states.get('mirror repository is active') === 'OK',
      'register: authenticated GitHub metadata establishes that the destination is neither archived nor disabled');
    check(states.get('typed remote and Cloud environment name the same repository') === 'OK',
      'register: the typed destination and selected Cloud environment are mechanically cross-checked');
    check(states.get('this machine can push to the mirror') === 'OK',
      'register: write access is established at entry, not left to fail at push time');

    // -- THE TWO GUARDS THAT 2026-08-25 BOUGHT -----------------------------
    //
    // Both of these describe one incident. A mirror was registered with the
    // default branch 'main' against a PUBLIC repository whose visibility
    // nobody had established, and the next publish replaced that repository's
    // entire history with an orphan snapshot. Neither guard existed; both
    // states printed and neither stopped anything.
    {
      // 1. A WORKSPACE BRANCH IS DERIVED, NOT TYPED. The mirror is a shared
      //    launch workspace and several projects may live in one repository,
      //    so the branch is computed from the project key: two projects cannot
      //    collide, and no workspace can be aimed at a publication branch.
      const onMain = await mirror.registerMirrorProject({
        ...base, projectKey: 'demo', cloudRepository: 'Example/mirror',
        mirrorBranch: 'main', replace: true
      }).then(() => null, (error) => error);
      check(onMain && onMain.code === 'CLOUD_MIRROR_BRANCH_NOT_A_WORKSPACE',
        'register: pointing a mirror at main is refused by name -- the exact registration that replaced a public history');
      check(onMain && /cloud-mirror\/demo/.test(onMain.message),
        'register: the refusal names the branch the project WOULD have used, so the remedy is in the sentence');

      const derived = await mirror.registerMirrorProject({
        ...base, projectKey: 'demo2', cloudRepository: 'Example/mirror-two', replace: true,
        githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-two', private: true, visibility: 'private', archived: false, disabled: false }),
        githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-two', fullName: 'Example/mirror-two' })
      });
      check(derived.ok === true && derived.project.mirrorBranch === 'cloud-mirror/demo2',
        'register: omitting the branch derives it from the project key rather than defaulting to main');

      // 2. UNVERIFIED VISIBILITY STOPS, with no public override.
      const blind = { ...base, githubRepoGetImpl: null };
      blind.githubRemoteParserImpl = () => ({ owner: 'Example', repo: 'mirror-three', fullName: 'Example/mirror-three' });
      const unverified = await mirror.registerMirrorProject({
        ...blind, projectKey: 'demo3', cloudRepository: 'Example/mirror-three', replace: true
      }).then(() => null, (error) => error);
      check(unverified && unverified.code === 'CLOUD_MIRROR_PRIVACY_UNVERIFIED',
        'register: an unestablished repository visibility refuses instead of printing a word and proceeding');

      const acknowledged = await mirror.registerMirrorProject({
        ...blind, projectKey: 'demo3', cloudRepository: 'Example/mirror-three',
        acknowledgePublic: true, replace: true
      }).then(() => null, (error) => error);
      check(acknowledged && acknowledged.code === 'CLOUD_MIRROR_PUBLIC_OVERRIDE_REFUSED',
        'register: the retired acknowledgePublic field gets a typed refusal; public Cloud Mirror has no product path');

      const callerCertified = await mirror.registerMirrorProject({
        ...base, projectKey: 'demo3', cloudRepository: 'Example/mirror-three',
        repositoryMetadata: PRIVATE_REPOSITORY, replace: true
      }).then(() => null, (error) => error);
      check(callerCertified && callerCertified.code === 'CLOUD_MIRROR_CALLER_METADATA_REFUSED',
        'register: caller-supplied repository metadata cannot substitute for the core invoking github.repo_get');
    }

    // -- an unreachable remote refuses AND WRITES NOTHING -------------------
    const virginRegistry = path.join(TEMP_ROOT, 'register-virgin', 'registry.json');
    await raises('CLOUD_MIRROR_REMOTE_UNREACHABLE',
      () => mirror.registerMirrorProject({
        ...base, registryPath: virginRegistry, projectKey: 'demo',
        mirrorRemote: path.join(TEMP_ROOT, 'no-such-mirror.git'), cloudRepository: 'Example/absent',
        githubRepoGetImpl: async () => ({ fullName: 'Example/absent', private: true, visibility: 'private', archived: false, disabled: false }),
        githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'absent', fullName: 'Example/absent' })
      }),
      'register: a mirror this machine cannot reach refuses by name rather than storing a registry that reads as configured and fails at the first dispatch');
    check(fs.existsSync(virginRegistry) === false,
      'register: a refused registration leaves NO registry file -- a half-written one would read as configured');

    // -- ONE REPOSITORY MAY SERVE MANY PROJECTS; THE BRANCH TELLS THEM APART -
    // CHANGED 2026-08-27, with the reason stated rather than the assertion quietly
    // flipped. This used to require a refusal, and its own message carried the
    // premise: projectFor takes the FIRST match. That is no longer true --
    // projectFor resolves on the repository AND the branch, and refuses
    // CLOUD_MIRROR_REPOSITORY_AMBIGUOUS rather than picking one, so the property
    // this line protected is intact and is asserted directly in
    // tests/cloud-mirror-one-repository-many-projects.test.js.
    // It mattered: the mirror branch is DERIVED per project precisely so that one
    // private mirror can serve several projects, and this guard was refusing the
    // design it was built to support -- telling an owner who had one mirror to go
    // and create a second repository for his second project.
    const secondProject = await mirror.registerMirrorProject({
      ...base, projectKey: 'shares-the-mirror', cloudRepository: 'Example/mirror'
    });
    check(secondProject.ok === true,
      'register: a second project may share one private mirror repository -- its branch is derived from its own key, so the pair a dispatch resolves on stays unique');
    check(secondProject.project.mirrorBranch === 'cloud-mirror/shares-the-mirror',
      'register: the second project did not get its own derived branch, so the two would collide on the pair after all');

    // -- replacement is recovery for a DISABLED legacy row, never a way to
    //    repoint an enabled binding ------------------------------------------
    await raises('CLOUD_MIRROR_ALREADY_REGISTERED',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'demo', cloudRepository: 'Example/mirror' }),
      'register: re-registering an existing key without replace refuses rather than silently repointing a live mirror');

    const enabledRegistryBytes = fs.readFileSync(registryPath, 'utf8');
    const refusedReplacementCalls = { github: 0, git: 0, network: [] };
    const activeReplacement = await raises('CLOUD_MIRROR_ACTIVE_REPLACEMENT_REFUSED',
      () => mirror.registerMirrorProject({
        ...base,
        projectKey: 'demo', cloudRepository: 'Example/mirror', replace: true,
        githubRepoGetImpl: async () => { refusedReplacementCalls.github += 1; throw new Error('enabled replacement reached GitHub'); },
        runGitImpl: () => { refusedReplacementCalls.git += 1; throw new Error('enabled replacement inspected or published Git data'); },
        networkGitImpl: async (_repoRoot, args) => {
          refusedReplacementCalls.network.push([...args]);
          throw new Error('enabled replacement reached a remote');
        }
      }),
      'register: replace=true cannot repoint an existing enabled, reverified binding');
    check(/enabled, reverified registration/.test(activeReplacement.message)
      && /no repository was contacted and nothing was published/.test(activeReplacement.message),
      'register: the active-replacement refusal states both the protected state and that no external effect occurred');
    check(refusedReplacementCalls.github === 0 && refusedReplacementCalls.git === 0
      && refusedReplacementCalls.network.length === 0,
      'register: enabled replacement refuses before github.repo_get, ls-remote, fetch, push, local Git inspection or publication');
    check(fs.readFileSync(registryPath, 'utf8') === enabledRegistryBytes,
      'register: an enabled replacement refusal leaves the registry byte-identical');

    const legacyRegistry = JSON.parse(enabledRegistryBytes);
    delete legacyRegistry.projects.demo.githubRepository;
    delete legacyRegistry.projects.demo.privacyVerifiedAt;
    fs.writeFileSync(registryPath, `${JSON.stringify(legacyRegistry, null, 2)}\n`, 'utf8');
    const disabledBeforeRecovery = mirror.listRegisteredProjects({ registryPath })
      .projects.find((project) => project.key === 'demo');
    check(disabledBeforeRecovery && disabledBeforeRecovery.enabled === false,
      'register: the recovery fixture is mechanically disabled before replace is permitted');

    const recoveredLegacy = await mirror.registerMirrorProject({
      ...base, projectKey: 'demo', cloudRepository: 'Example/mirror', replace: true
    });
    check(recoveredLegacy.replaced === true,
      'register: replace repairs an existing disabled legacy registration and reports the replacement');
    const enabledAfterRecovery = mirror.listRegisteredProjects({ registryPath })
      .projects.find((project) => project.key === 'demo');
    check(enabledAfterRecovery && enabledAfterRecovery.enabled === true
      && enabledAfterRecovery.githubRepository === 'Example/mirror',
      'register: disabled legacy recovery writes a newly reverified, enabled exact destination');

    // -- a second project is ADDED, not substituted -------------------------
    const secondRemote = makeBareMirror('register-mirror-2.git');
    await mirror.registerMirrorProject({
      ...base, projectKey: 'second', mirrorRemote: secondRemote, cloudRepository: 'Example/mirror-2',
      githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-2', private: true, visibility: 'private', archived: false, disabled: false }),
      githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-2', fullName: 'Example/mirror-2' })
    });
    const both = mirror.loadRegistry({ registryPath });
    check(both.projects.has('demo') && both.projects.has('second'),
      'register: registering a second project preserves the first -- the file is rewritten whole, so losing a sibling is the obvious way this goes wrong');

    const concurrentRegistry = path.join(TEMP_ROOT, 'register-concurrent', 'registry.json');
    let concurrentLockReleased = 0;
    const concurrent = await mirror.registerMirrorProject({
      ...base,
      registryPath: concurrentRegistry,
      projectKey: 'concurrent',
      cloudRepository: 'Example/concurrent',
      githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'concurrent', fullName: 'Example/concurrent' }),
      githubRepoGetImpl: async () => ({
        fullName: 'Example/concurrent', private: true, visibility: 'private', archived: false, disabled: false
      }),
      acquireLockImpl: () => {
        writeJson(concurrentRegistry, {
          schemaVersion: mirror.REGISTRY_SCHEMA,
          projects: {
            sibling: {
              sourceRoot: source,
              mirrorRemote: 'https://github.com/Example/sibling.git',
              mirrorBranch: 'cloud-mirror/sibling',
              boundaryManifest: path.relative(source, boundaryFile).split(path.sep).join('/'),
              cloudRepository: 'Example/sibling',
              githubRepository: 'Example/sibling',
              privacyVerifiedAt: '2026-08-30T00:00:00.000Z'
            }
          }
        });
        return { release: () => { concurrentLockReleased += 1; } };
      }
    });
    const concurrentBytes = JSON.parse(fs.readFileSync(concurrentRegistry, 'utf8'));
    check(concurrent.ok === true && concurrentLockReleased === 1,
      'register: the serialized registration completes and releases the exact mutation lock once');
    check(Object.hasOwn(concurrentBytes.projects, 'sibling')
      && Object.hasOwn(concurrentBytes.projects, 'concurrent'),
      'register: a sibling registration completed before lock ownership is re-read and preserved instead of being lost to a stale whole-file write');

    // -- the local facts, each refusing by its own name ----------------------
    await raises('CLOUD_MIRROR_SOURCE_ROOT_ABSENT',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'x', sourceRoot: path.join(TEMP_ROOT, 'no-such-folder'), cloudRepository: 'Example/x' }),
      'register: a folder that does not exist refuses by name');
    const notACheckout = path.join(TEMP_ROOT, 'not-a-checkout');
    fs.mkdirSync(notACheckout, { recursive: true });
    await raises('CLOUD_MIRROR_SOURCE_ROOT_NOT_A_CHECKOUT',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'x', sourceRoot: notACheckout, cloudRepository: 'Example/x' }),
      'register: a folder with no history refuses -- the manifest is built from git ls-tree, so there would be nothing to publish');
    await raises('CLOUD_MIRROR_BOUNDARY_ABSENT',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'x', boundaryManifest: 'config/no-such-manifest.json', cloudRepository: 'Example/x' }),
      'register: an absent boundary manifest refuses -- every file entering a mirror is a publication decision, and there would be nothing recording them');
    await raises('CLOUD_MIRROR_REPOSITORY_MALFORMED',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'x', cloudRepository: 'not-owner-slash-name' }),
      'register: a cloud repository that is not owner/name refuses -- that string is the key a dispatch is resolved under');
    await raises('CLOUD_MIRROR_PROJECT_KEY_MALFORMED',
      () => mirror.registerMirrorProject({ ...base, projectKey: 'Has Capitals', cloudRepository: 'Example/x' }),
      'register: a malformed project key refuses');

    const traversalCalls = { github: 0, git: 0, network: 0 };
    await raises('CLOUD_MIRROR_BOUNDARY_PATH_REFUSED',
      () => mirror.registerMirrorProject({
        ...base,
        projectKey: 'traversal',
        registryPath: path.join(TEMP_ROOT, 'register-traversal', 'registry.json'),
        boundaryManifest: '../outside.json',
        cloudRepository: 'Example/traversal',
        githubRepoGetImpl: async () => { traversalCalls.github += 1; return PRIVATE_REPOSITORY; },
        runGitImpl: () => { traversalCalls.git += 1; throw new Error('traversal reached git'); },
        networkGitImpl: async () => { traversalCalls.network += 1; throw new Error('traversal reached a remote'); }
      }),
      'register: a boundary manifest cannot traverse out of the customer-selected checkout');
    check(traversalCalls.github === 0 && traversalCalls.git === 0 && traversalCalls.network === 0,
      'register: traversal refuses before GitHub metadata, local Git or any remote transport is touched');

    const foreignRegistry = path.join(TEMP_ROOT, 'register-foreign-profile', 'registry.json');
    const foreignCalls = { exists: [], github: 0, git: 0, network: 0 };
    const foreignSource = process.platform === 'win32'
      ? 'C:\\Users\\fixture-user\\mirror-source'
      : 'relative-foreign-profile-source';
    await raises('CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED',
      () => mirror.registerMirrorProject({
        ...base,
        projectKey: 'foreign',
        registryPath: foreignRegistry,
        sourceRoot: foreignSource,
        cloudRepository: 'Example/foreign',
        existsImpl: (candidate) => {
          foreignCalls.exists.push(path.resolve(candidate));
          return false;
        },
        githubRepoGetImpl: async () => { foreignCalls.github += 1; return PRIVATE_REPOSITORY; },
        runGitImpl: () => { foreignCalls.git += 1; throw new Error('foreign source reached git'); },
        networkGitImpl: async () => { foreignCalls.network += 1; throw new Error('foreign source reached a remote'); }
      }),
      'register: a source path outside the installation account is refused lexically');
    check(foreignCalls.exists.length === 1
      && foreignCalls.exists[0].toLowerCase() === path.resolve(foreignRegistry).toLowerCase(),
      'register: the foreign source string is never probed; only the permitted registry path is checked for presence');
    check(foreignCalls.github === 0 && foreignCalls.git === 0 && foreignCalls.network === 0,
      'register: an account-boundary refusal occurs before GitHub metadata, Git inspection or remote transport');

    // -- a registry it cannot understand is never overwritten ----------------
    const corrupt = path.join(TEMP_ROOT, 'register-corrupt', 'registry.json');
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, '{ this is not json', 'utf8');
    await raises('CLOUD_MIRROR_REGISTRY_INVALID',
      () => mirror.registerMirrorProject({ ...base, registryPath: corrupt, projectKey: 'x', cloudRepository: 'Example/x' }),
      'register: an unparseable existing registry refuses rather than being discarded -- whatever it holds is somebody\'s only copy');
    check(fs.readFileSync(corrupt, 'utf8') === '{ this is not json',
      'register: the unparseable registry is byte-identical after the refusal');

    // -- AUTHENTICATED GITHUB METADATA: identity, lifecycle and privacy ------
    {
      const privateRegistry = path.join(TEMP_ROOT, 'register-private', 'registry.json');
      const stated = await mirror.registerMirrorProject({
        ...base, registryPath: privateRegistry, projectKey: 'stated',
        cloudRepository: 'Example/mirror-private',
        githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-private', private: true, visibility: 'private', archived: false, disabled: false }),
        githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-private', fullName: 'Example/mirror-private' })
      });
      const statedStates = new Map(stated.checks.map((entry) => [entry.name, entry.state]));
      check(statedStates.get('mirror repository is private') === 'OK',
        'register: a provider-stated private visibility turns the caveat into an established fact');

      const publicRegistry = path.join(TEMP_ROOT, 'register-public', 'registry.json');
      const refusal = await raises('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
        () => mirror.registerMirrorProject({
          ...base, registryPath: publicRegistry, projectKey: 'publicmirror',
          cloudRepository: 'Example/mirror-public',
          githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-public', private: false, visibility: 'public', archived: false, disabled: false }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-public', fullName: 'Example/mirror-public' })
        }),
        'register: a repository the provider reports as PUBLIC must refuse -- a mirror receives a classified tracked snapshot, and publishing it is not recoverable');
      check(/selected, boundary-classified tracked snapshot/.test(refusal.message),
        'register: the not-private refusal says WHY it matters, not merely that a value mismatched');
      check(fs.existsSync(publicRegistry) === false,
        'register: a registration refused for visibility leaves no registry file');

      const changedPrivacyRegistry = path.join(TEMP_ROOT, 'register-private-then-public', 'registry.json');
      let changedPrivacyCalls = 0;
      await raises('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
        () => mirror.registerMirrorProject({
          ...base,
          registryPath: changedPrivacyRegistry,
          projectKey: 'privacychanged',
          cloudRepository: 'Example/mirror-privacychanged',
          githubRemoteParserImpl: () => ({
            owner: 'Example', repo: 'mirror-privacychanged', fullName: 'Example/mirror-privacychanged'
          }),
          githubRepoGetImpl: async () => {
            changedPrivacyCalls += 1;
            return changedPrivacyCalls === 1
              ? { fullName: 'Example/mirror-privacychanged', private: true, visibility: 'private', archived: false, disabled: false }
              : { fullName: 'Example/mirror-privacychanged', private: false, visibility: 'public', archived: false, disabled: false };
          }
        }),
        'register: a repository made public during the reach/write probes refuses at the final authenticated check');
      check(changedPrivacyCalls === 2,
        'register: privacy is established once before transport probes and again while the registry mutation lock is held');
      check(!fs.existsSync(changedPrivacyRegistry) && !fs.existsSync(`${changedPrivacyRegistry}.lock`),
        'register: a failed final privacy check writes no enabled row and releases its registry lock');

      // An unrecognised value is NOT read as private. Failing open on a string
      // nobody anticipated is how a public repository gets registered by a
      // provider wording change.
      await raises('CLOUD_MIRROR_REPOSITORY_NOT_PRIVATE',
        () => mirror.registerMirrorProject({
          ...base, registryPath: path.join(TEMP_ROOT, 'register-odd', 'registry.json'),
          projectKey: 'odd', cloudRepository: 'Example/mirror-odd',
          githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-odd', private: true, visibility: 'internal', archived: false, disabled: false }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-odd', fullName: 'Example/mirror-odd' })
        }),
        'register: a visibility value that is not exactly private refuses -- anything else read as private would fail open on a provider wording change');

      await raises('CLOUD_MIRROR_REPOSITORY_MISMATCH',
        () => mirror.registerMirrorProject({
          ...base, registryPath: path.join(TEMP_ROOT, 'register-mismatch', 'registry.json'),
          projectKey: 'mismatch', cloudRepository: 'Example/mirror-mismatch',
          githubRepoGetImpl: async () => ({ fullName: 'Example/somewhere-else', private: true, visibility: 'private', archived: false, disabled: false }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-mismatch', fullName: 'Example/mirror-mismatch' })
        }),
        'register: github.repo_get metadata must name the exact typed destination, not merely another private repository');
      await raises('CLOUD_MIRROR_REPOSITORY_ARCHIVED',
        () => mirror.registerMirrorProject({
          ...base, registryPath: path.join(TEMP_ROOT, 'register-archived', 'registry.json'),
          projectKey: 'archived', cloudRepository: 'Example/mirror-archived',
          githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-archived', private: true, visibility: 'private', archived: true, disabled: false }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-archived', fullName: 'Example/mirror-archived' })
        }),
        'register: an archived private repository cannot be enabled as a mirror');
      await raises('CLOUD_MIRROR_REPOSITORY_DISABLED',
        () => mirror.registerMirrorProject({
          ...base, registryPath: path.join(TEMP_ROOT, 'register-disabled', 'registry.json'),
          projectKey: 'disabled', cloudRepository: 'Example/mirror-disabled',
          githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-disabled', private: true, visibility: 'private', archived: false, disabled: true }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-disabled', fullName: 'Example/mirror-disabled' })
        }),
        'register: a disabled private repository cannot be enabled as a mirror');
    }

    // -- THE NEGATIVE CONTROL FOR WRITE ACCESS, and it is injected on purpose.
    //
    // A MEASURED GAP IN THIS FILE, recorded because the fix is only meaningful
    // beside it. The positive assertion above -- that the push check reports OK
    // -- does NOT prove the check exists: deleting the whole refusal branch
    // leaves the OK line behind it running, so the state stays OK and the
    // assertion still passes. Mutation proved exactly that: neutering
    // the write.exitCode refusal left this file GREEN. That is the same defect
    // class this repository keeps re-finding -- an assertion that pins a LABEL
    // rather than the BEHAVIOUR the label is supposed to describe.
    //
    // It has to be injected because the case cannot be built locally: a bare
    // repository on this disk is writable by construction, and a read-only
    // remote is exactly what a local fixture cannot be. So the fake grants
    // reach and refuses the push, which is the real shape of a credential that
    // can read a repository and not publish to it.
    {
      const readableNotWritable = async (repoRoot, args) => (args[0] === 'push'
        ? { exitCode: 128, stdout: '', stderr: 'remote: Permission to Example/mirror-3.git denied.' }
        : { exitCode: 0, stdout: '', stderr: '' });
      const readOnlyRegistry = path.join(TEMP_ROOT, 'register-readonly', 'registry.json');
      const refusal = await raises('CLOUD_MIRROR_REMOTE_NOT_WRITABLE',
        () => mirror.registerMirrorProject({
          ...base, registryPath: readOnlyRegistry, projectKey: 'readonly',
          cloudRepository: 'Example/mirror-3', networkGitImpl: readableNotWritable,
          githubRepoGetImpl: async () => ({ fullName: 'Example/mirror-3', private: true, visibility: 'private', archived: false, disabled: false }),
          githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'mirror-3', fullName: 'Example/mirror-3' })
        }),
        'register: a mirror this machine can READ but cannot PUSH TO must refuse -- reach is not write access, and the difference otherwise surfaces at the first dispatch, long after the registry reads as complete');
      check(/cannot publish to it/.test(refusal.message),
        'register: the not-writable refusal says what is actually wrong, rather than repeating the reachability sentence');
      check(fs.existsSync(readOnlyRegistry) === false,
        'register: a registration refused for want of write access leaves no registry file');
    }

    // -- the former --no-network escape is rejected, not silently ignored ---
    const offline = await mirror.registerMirrorProject({
      ...base, registryPath: path.join(TEMP_ROOT, 'register-offline', 'registry.json'),
      projectKey: 'offline', cloudRepository: 'Example/offline', checkNetwork: false,
      githubRepoGetImpl: async () => ({ fullName: 'Example/offline', private: true, visibility: 'private', archived: false, disabled: false }),
      githubRemoteParserImpl: () => ({ owner: 'Example', repo: 'offline', fullName: 'Example/offline' })
    }).then(() => null, (error) => error);
    check(offline && offline.code === 'CLOUD_MIRROR_NETWORK_CHECK_REQUIRED',
      'register: a stale no-network caller gets a typed refusal and cannot write an unchecked registry entry');
  }

  // ---------------------------------------------------------------------
  // 9. A binding changed after classification refuses before remote access.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('binding-change-source');
    writeJson(path.join(source, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const changedSource = makeSourceRepo('binding-change-other-source');
    writeJson(path.join(changedSource, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const registryPath = registryFor({
      file: path.join(TEMP_ROOT, 'binding-change', 'registry.json'),
      sourceRoot: source,
      boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const stateRoot = path.join(TEMP_ROOT, 'binding-change', 'receipts');
    const calls = { network: 0, github: 0, release: 0 };
    await raises('CLOUD_MIRROR_BINDING_CHANGED',
      () => mirror.publishMirror({
        projectKey: 'demo',
        registryPath,
        stateRoot,
        publishedAt: '2026-09-01T00:00:00.000Z',
        acquireLockImpl: () => {
          const changed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
          changed.projects.demo.sourceRoot = changedSource;
          writeJson(registryPath, changed);
          return { release: () => { calls.release += 1; } };
        },
        networkGitImpl: async () => {
          calls.network += 1;
          throw new Error('changed binding reached a remote');
        },
        githubRepoGetImpl: async () => {
          calls.github += 1;
          throw new Error('changed binding reached GitHub');
        }
      }),
      'publish: a source or destination binding changed after tree classification is named and refused');
    check(calls.network === 0 && calls.github === 0 && calls.release === 1,
      'publish: binding drift refuses under the mutation lock before ls-remote, GitHub privacy lookup or push, then releases once');
  }

  // The manifest is a live customer decision, not just a path in the registry.
  // Mutating it while the final destination check is in flight must stop before
  // the exact-ref push even though the earlier classification itself succeeded.
  {
    const source = makeSourceRepo('boundary-race-source');
    const boundaryFile = writeJson(path.join(source, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const registryPath = registryFor({
      file: path.join(TEMP_ROOT, 'boundary-race', 'registry.json'),
      sourceRoot: source,
      boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const calls = { network: [], github: 0 };
    await raises('CLOUD_MIRROR_BOUNDARY_CHANGED',
      () => mirror.publishMirror({
        projectKey: 'demo',
        registryPath,
        stateRoot: path.join(TEMP_ROOT, 'boundary-race', 'receipts'),
        publishedAt: '2026-09-01T00:00:00.000Z',
        networkGitImpl: async (_repoRoot, args) => {
          calls.network.push([...args]);
          if (args[0] === 'ls-remote') return { exitCode: 2, stdout: '', stderr: '' };
          throw new Error('boundary race reached push');
        },
        githubRepoGetImpl: async () => {
          calls.github += 1;
          writeJson(boundaryFile, {
            ...GOOD_BOUNDARY,
            withhold: { paths: ['config/owner-private.json', 'src/a.js'], prefixes: [] }
          });
          return PRIVATE_REPOSITORY;
        }
      }),
      'publish: a boundary edited during the final destination check refuses before the remote write');
    check(calls.github === 1 && calls.network.length === 1 && calls.network[0][0] === 'ls-remote',
      'publish: the final boundary recheck allows the read-only remote observation but no push after the decision changes');
  }

  // ---------------------------------------------------------------------
  // 10. Disable is a local, durable, retryable reset -- never remote delete.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('disable-source');
    writeJson(path.join(source, 'config', 'cloud-mirror-boundary.json'), GOOD_BOUNDARY);
    const registryPath = registryFor({
      file: path.join(TEMP_ROOT, 'disable', 'registry.json'),
      sourceRoot: source,
      boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const stateRoot = path.join(TEMP_ROOT, 'disable', 'receipts');
    const receiptFile = writeJson(path.join(stateRoot, 'demo.json'), {
      schemaVersion: mirror.RECEIPT_SCHEMA,
      latest: { publicationCommit: 'a'.repeat(40) },
      history: []
    });
    const disabledAt = '2026-09-01T00:01:00.000Z';
    const disabled = mirror.disableMirrorProject({
      projectKey: 'demo', registryPath, stateRoot, disabledAt
    });
    const disabledRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const disabledRow = disabledRegistry.projects.demo;
    check(disabled.ok === true && disabled.project.enabled === false
      && disabledRow.locallyDisabledAt === disabledAt,
      'disable: the selected local binding is durably marked disabled');
    check(!Object.hasOwn(disabledRow, 'githubRepository')
      && !Object.hasOwn(disabledRow, 'privacyVerifiedAt')
      && disabledRow.mirrorRemote === MIRROR_HTTPS_REMOTE
      && disabledRow.mirrorBranch === MIRROR_BRANCH,
      'disable: verification authority is removed while the customer repository and workspace branch remain an informational recovery record');
    check(!fs.existsSync(receiptFile) && !fs.existsSync(`${registryPath}.lock`),
      'disable: local publication authority is removed and the registry lock is released');
    const listedDisabled = mirror.listRegisteredProjects({ registryPath }).projects[0];
    check(listedDisabled.enabled === false && /Disabled locally/.test(listedDisabled.disabledReason),
      'disable: Settings can list the binding as locally disabled instead of making it disappear or implying GitHub was changed');

    const stoppedCalls = { git: 0, network: 0, github: 0 };
    await raises('CLOUD_MIRROR_REVERIFY_REQUIRED',
      () => mirror.publishMirror({
        projectKey: 'demo', registryPath, stateRoot,
        publishedAt: '2026-09-01T00:02:00.000Z',
        runGitImpl: () => { stoppedCalls.git += 1; throw new Error('disabled binding reached git'); },
        networkGitImpl: async () => { stoppedCalls.network += 1; throw new Error('disabled binding reached remote'); },
        githubRepoGetImpl: async () => { stoppedCalls.github += 1; throw new Error('disabled binding reached GitHub'); }
      }),
      'disable: publish refuses until the customer explicitly re-registers a private repository');
    check(stoppedCalls.git === 0 && stoppedCalls.network === 0 && stoppedCalls.github === 0,
      'disable: a disabled binding refuses before local Git, GitHub metadata or remote transport');

    const retryRegistry = registryFor({
      file: path.join(TEMP_ROOT, 'disable-retry', 'registry.json'),
      sourceRoot: source,
      boundaryManifest: 'config/cloud-mirror-boundary.json'
    });
    const retryState = path.join(TEMP_ROOT, 'disable-retry', 'receipts');
    const retryReceipt = writeJson(path.join(retryState, 'demo.json'), {
      schemaVersion: mirror.RECEIPT_SCHEMA, latest: null, history: []
    });
    const firstDisabledAt = '2026-09-01T00:03:00.000Z';
    await raises('CLOUD_MIRROR_LOCAL_RESET_FAILED',
      () => mirror.disableMirrorProject({
        projectKey: 'demo', registryPath: retryRegistry, stateRoot: retryState,
        disabledAt: firstDisabledAt,
        unlinkImpl: () => {
          const error = new Error('simulated receipt handle still open');
          error.code = 'EACCES';
          throw error;
        }
      }),
      'disable: a receipt cleanup failure is explicit and asks for a retry');
    const safeAfterCleanupFailure = JSON.parse(fs.readFileSync(retryRegistry, 'utf8')).projects.demo;
    check(safeAfterCleanupFailure.locallyDisabledAt === firstDisabledAt
      && !Object.hasOwn(safeAfterCleanupFailure, 'githubRepository')
      && fs.existsSync(retryReceipt),
      'disable: cleanup failure leaves the registry safely disabled before reporting the retained receipt');
    const retried = mirror.disableMirrorProject({
      projectKey: 'demo', registryPath: retryRegistry, stateRoot: retryState,
      disabledAt: '2026-09-01T00:04:00.000Z'
    });
    check(retried.ok === true && retried.project.locallyDisabledAt === firstDisabledAt
      && !fs.existsSync(retryReceipt) && !fs.existsSync(`${retryRegistry}.lock`),
      'disable: retry is idempotent, preserves the original disable time, completes receipt cleanup and releases the lock');
  }

  // ---------------------------------------------------------------------
  // 11. Network Git ignores ambient URL rewrites without contacting a remote.
  // ---------------------------------------------------------------------
  {
    const source = makeSourceRepo('git-config-isolation');
    const globalConfig = path.join(TEMP_ROOT, 'malicious-global.gitconfig');
    execFileSync('git', ['config', '--file', globalConfig,
      'url.https://global-redirect.invalid/.insteadOf', 'https://github.com/'], { windowsHide: true });
    execFileSync('git', ['config', '--file', globalConfig,
      'url.https://global-push.invalid/.pushInsteadOf', 'https://github.com/'], { windowsHide: true });
    git(source, ['config', 'url.https://local-redirect.invalid/.insteadOf', 'https://github.com/']);
    git(source, ['config', 'url.https://local-push.invalid/.pushInsteadOf', 'https://github.com/']);

    const hostileEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_ALLOW_PROTOCOL: 'file:https' };
    const ordinaryReadUrl = git(source, ['ls-remote', '--get-url', MIRROR_HTTPS_REMOTE], { env: hostileEnv }).trim();
    const ordinaryRules = git(source, ['config', '--get-regexp', '^url\.'], { env: hostileEnv });
    check(ordinaryReadUrl !== MIRROR_HTTPS_REMOTE && /pushinsteadof/i.test(ordinaryRules),
      'git-config isolation: the temporary user/local fixture redirects ordinary Git resolution and contains a push rewrite');

    const hadGlobal = Object.hasOwn(process.env, 'GIT_CONFIG_GLOBAL');
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    const temporaryEnvironment = ['TEMP', 'TMP', 'TMPDIR'].map((key) => ({
      key,
      present: Object.hasOwn(process.env, key),
      value: process.env[key]
    }));
    const ambientTemp = path.join(source, 'ambient-temp');
    fs.mkdirSync(ambientTemp, { recursive: true });
    for (const { key } of temporaryEnvironment) process.env[key] = ambientTemp;
    const originalMkdtemp = fs.mkdtempSync;
    const createdNetworkRoots = [];
    fs.mkdtempSync = function recordedMkdtemp(prefix, ...args) {
      const created = originalMkdtemp.call(this, prefix, ...args);
      if (String(prefix).includes('toolsenabled-cloud-mirror-git-')) createdNetworkRoots.push(created);
      return created;
    };
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const isolatedRead = await mirror.defaultNetworkGit(source, ['ls-remote', '--get-url', MIRROR_HTTPS_REMOTE]);
      const isolatedRules = await mirror.defaultNetworkGit(source, ['config', '--get-regexp', '^url\.']);
      const previousCwd = process.cwd();
      let cwdIsolatedRead;
      try {
        process.chdir(source);
        cwdIsolatedRead = await mirror.defaultNetworkGit(null, ['ls-remote', '--get-url', MIRROR_HTTPS_REMOTE]);
      } finally {
        process.chdir(previousCwd);
      }
      check(isolatedRead.exitCode === 0 && isolatedRead.stdout.trim() === MIRROR_HTTPS_REMOTE,
        'git-config isolation: user/global and repository insteadOf rules cannot change the effective read destination');
      check(isolatedRules.exitCode === 1 && isolatedRules.stdout.trim() === '',
        'git-config isolation: no user/global/repository url rule, including pushInsteadOf, exists in the effective push context');
      check(cwdIsolatedRead.exitCode === 0 && cwdIsolatedRead.stdout.trim() === MIRROR_HTTPS_REMOTE,
        'git-config isolation: a read-only operation with no source root cannot inherit a repository-local URL rewrite from the process working directory');
    } finally {
      fs.mkdtempSync = originalMkdtemp;
      for (const saved of temporaryEnvironment) {
        if (saved.present) process.env[saved.key] = saved.value;
        else delete process.env[saved.key];
      }
      if (hadGlobal) process.env.GIT_CONFIG_GLOBAL = priorGlobal;
      else delete process.env.GIT_CONFIG_GLOBAL;
    }
    const expectedTemporaryRoot = process.platform === 'win32'
      ? path.join(installationProfileRoot(), 'AppData', 'Local', 'Temp')
      : path.resolve(ambientTemp);
    check(createdNetworkRoots.length === 3
      && createdNetworkRoots.every((root) => path.dirname(root).toLowerCase() === expectedTemporaryRoot.toLowerCase()),
      'git-config isolation: network Git scratch repositories are rooted in the installation account temp directory, not ambient TEMP/TMP input');
    check(createdNetworkRoots.every((root) => !fs.existsSync(root)),
      'git-config isolation: successful and refused read-side network operations remove every temporary bare repository');

    let failedTemporaryRoot = null;
    fs.mkdtempSync = function recordedFailedMkdtemp(prefix, ...args) {
      const created = originalMkdtemp.call(this, prefix, ...args);
      if (String(prefix).includes('toolsenabled-cloud-mirror-git-')) failedTemporaryRoot = created;
      return created;
    };
    const isolationFailure = await Promise.resolve()
      .then(() => mirror.defaultNetworkGit(path.join(TEMP_ROOT, 'missing-object-source'), ['status']))
      .then(() => null, (error) => error);
    fs.mkdtempSync = originalMkdtemp;
    const leakedFailedRoot = Boolean(failedTemporaryRoot && fs.existsSync(failedTemporaryRoot));
    if (leakedFailedRoot) fs.rmSync(failedTemporaryRoot, { recursive: true, force: true });
    check(isolationFailure && isolationFailure.code === 'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE',
      'git-config isolation: a source object database that cannot be established refuses by name');
    check(!leakedFailedRoot,
      'git-config isolation: a failure after temporary bare-repository creation removes that owned scratch directory');
  }

  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`cloud-mirror tests passed (${checks} checks: exact private HTTPS GitHub binding, active-state and publish-time rechecks, disabled-only registration recovery, derived workspace branches, no credential echo, no caller metadata/public/offline escape, isolated Git URL resolution, filtered publication, freshness, and unreceipted remote-head refusal without fetch or force).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
