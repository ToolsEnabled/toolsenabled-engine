'use strict';

/* ONE PRIVATE MIRROR SERVES MANY PROJECTS, AND THE BRANCH IS WHAT TELLS THEM APART.
 *
 * The mirror branch is DERIVED from the project key -- cloud-mirror/<key> -- and the
 * design comment says why in as many words: so that two projects can share one
 * private mirror without overwriting each other.
 *
 * It did not work. projectFor() resolved a dispatch by repository ALONE and returned
 * the FIRST match, so sharing really would have landed one project's work in another
 * -- and registration was made to refuse a shared repository to stop that happening.
 * The rule was right and the place was wrong. The cost was concrete: an owner with
 * one private mirror, created for exactly this, was told by the product to go and
 * create a second repository for his second project.
 *
 * The refusal now lives where the ambiguity is. A repository serving several projects
 * is fine. Resolving one AMBIGUOUSLY is not: with a branch the answer is exact, and
 * without one this refuses BY NAME and lists the candidates. It never takes the first
 * match -- that is the property the old entry guard was protecting, and it is kept.
 *
 * THE ASYMMETRY IS DELIBERATE. Registration now refuses only a duplicate
 * (repository, BRANCH) pair, which derived branches make unreachable for two
 * distinct projects, so it fires only for a caller that forced one.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mirror = require('../src/lib/cloud-agent/cloud-mirror');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { installationProfileRoot } = require('../src/lib/agent-session-confinement');

const TEMP = fs.mkdtempSync(path.join(
  process.platform === 'win32'
    ? path.join(installationProfileRoot(), 'AppData', 'Local', 'Temp')
    : isolatedTemporaryRoot(),
  'one-mirror-many-projects-'
));
let checks = 0;

function registryWith(projects) {
  const file = path.join(TEMP, `registry-${Object.keys(projects).join('-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: mirror.REGISTRY_SCHEMA, projects }, null, 1));
  return mirror.loadRegistry({ registryPath: file });
}

function entry(key, { repository = 'Owner/one-mirror', branch = `cloud-mirror/${key}` } = {}) {
  return {
    sourceRoot: path.join(TEMP, key),
    mirrorRemote: `https://github.com/${repository}.git`,
    mirrorBranch: branch,
    boundaryManifest: 'config/cloud-mirror-boundary.json',
    cloudRepository: repository,
    githubRepository: repository,
    privacyVerifiedAt: '2026-08-30T00:00:00.000Z'
  };
}

function refusalFrom(run) {
  try { run(); } catch (error) { return error; }
  return null;
}

try {
  /* ---- 1. ONE MIRROR, TWO PROJECTS, AND THE BRANCH DECIDES -------------- */
  const shared = registryWith({ engine: entry('engine'), app: entry('app') });

  assert.equal(mirror.projectFor({ registry: shared, cloudRepository: 'Owner/one-mirror', mirrorBranch: 'cloud-mirror/app' }).key, 'app',
    'a dispatch on the app branch did not resolve to the app project, so one mirror cannot serve two projects');
  assert.equal(mirror.projectFor({ registry: shared, cloudRepository: 'Owner/one-mirror', mirrorBranch: 'cloud-mirror/engine' }).key, 'engine',
    'a dispatch on the engine branch did not resolve to the engine project');
  checks += 2;

  /* ---- 2. NO BRANCH IS A REFUSAL, NEVER A GUESS ------------------------- */
  /* THE PROPERTY THE OLD ENTRY GUARD EXISTED TO PROTECT. If this ever returns a
     project instead of refusing, the first-match defect is back and a dispatch can
     silently land in the wrong tree -- which is worse than the refusal it replaced,
     because nothing says so. */
  const blind = refusalFrom(() => mirror.projectFor({ registry: shared, cloudRepository: 'Owner/one-mirror' }));
  assert.ok(blind, 'a shared repository with no branch RESOLVED instead of refusing: first-match is back');
  assert.equal(blind.code, 'CLOUD_MIRROR_REPOSITORY_AMBIGUOUS');
  assert.match(blind.message, /engine on cloud-mirror\/engine/,
    'the refusal does not name the candidates, so nobody can tell which project they meant');
  assert.match(blind.message, /app on cloud-mirror\/app/);
  checks += 4;

  /* ---- 3. A BRANCH THAT MATCHES NOBODY IS ALSO A REFUSAL ---------------- */
  const wrong = refusalFrom(() => mirror.projectFor({
    registry: shared, cloudRepository: 'Owner/one-mirror', mirrorBranch: 'cloud-mirror/nobody',
  }));
  assert.ok(wrong, 'an unknown branch on a shared repository resolved to something');
  assert.equal(wrong.code, 'CLOUD_MIRROR_REPOSITORY_AMBIGUOUS');
  checks += 2;

  /* ---- 4. THE UNSHARED CASE IS UNCHANGED -------------------------------- */
  /* THE CONTROL. Every existing caller resolves against a registry holding one
     project per repository and passes no branch; if that stopped working, this
     change would have broken every dispatch in the product to fix a registration. */
  const single = registryWith({ engine: entry('engine') });
  assert.equal(mirror.projectFor({ registry: single, cloudRepository: 'Owner/one-mirror' }).key, 'engine',
    'a repository serving exactly one project no longer resolves without a branch');
  checks += 1;

  /* ---- 5. AN UNREGISTERED REPOSITORY STILL SAYS SO --------------------- */
  const absent = refusalFrom(() => mirror.projectFor({ registry: single, cloudRepository: 'Owner/never-registered' }));
  assert.equal(absent && absent.code, 'CLOUD_MIRROR_NOT_REGISTERED',
    'an unregistered repository must keep its own refusal, distinct from the ambiguous one');
  checks += 1;

  console.log(`cloud-mirror one repository many projects: ${checks} checks passed`);
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
