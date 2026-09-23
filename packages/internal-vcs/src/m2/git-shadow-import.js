'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { VcsError, VCS_ERROR_CODES } = require('../errors');
const {
  canonicalEncode,
  deepFreeze,
  hashBytes,
  immutableClone,
} = require('../m1/canonical');
const {
  createRevisionManifest,
  verifyRevisionClosure,
} = require('./revision-manifest');

const OBSERVATION_SCHEMA = 'internal-vcs.git-observation/v1';
const LFS_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';

function fail(code, message, details = {}, safeNextActions = []) {
  throw new VcsError(code, message, details, safeNextActions);
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, `${field} must be a non-empty string`, { field });
  }
  return value;
}

function stdoutText(result) {
  return result.stdout.toString('utf8').trim();
}

function stderrText(result) {
  return result.stderr.toString('utf8').trim().slice(0, 4096);
}

function gitAlgorithm(objectFormat) {
  if (objectFormat === 'sha1') return 'git-sha1';
  if (objectFormat === 'sha256') return 'git-sha256';
  fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git object format is unsupported', { objectFormat });
}

function gitObjectId(objectFormat, oid) {
  const expectedLength = objectFormat === 'sha1' ? 40 : 64;
  if (typeof oid !== 'string' || !new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(oid)) {
    fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git returned an invalid object identifier', { objectFormat, oid });
  }
  return `${gitAlgorithm(objectFormat)}:${oid}`;
}

function artifactReference({ kind, authorityId, integrity, required = true, retentionClass = 'PERMANENT' }) {
  const artifactId = hashBytes(canonicalEncode({ kind, authorityId, integrity }));
  return deepFreeze({ artifactId, kind, authorityId, integrity, required, retentionClass });
}

function requirementArtifact(kind, authorityId) {
  const artifactId = hashBytes(canonicalEncode({ kind, namespaceId: authorityId }));
  return deepFreeze({
    artifactId,
    kind,
    authorityId,
    integrity: artifactId,
    required: true,
    retentionClass: 'PERMANENT',
  });
}

function namespaceMatches(namespaceId, refName) {
  if (namespaceId.endsWith('/*')) return refName.startsWith(namespaceId.slice(0, -1));
  if (namespaceId.endsWith('/')) return refName.startsWith(namespaceId);
  return refName === namespaceId;
}

function parseRefs(buffer, objectFormat) {
  const text = buffer.toString('utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 3 || !fields[0].startsWith('refs/')) {
      fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git returned an invalid ref observation', { line });
    }
    gitObjectId(objectFormat, fields[1]);
    return deepFreeze({ refName: fields[0], oid: fields[1], objectType: fields[2] });
  }).sort((left, right) => left.refName.localeCompare(right.refName));
}

function parseTree(buffer, objectFormat) {
  const entries = [];
  for (const segment of buffer.toString('utf8').split('\0')) {
    if (!segment) continue;
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/.exec(segment);
    if (!match) fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git returned an invalid tree entry');
    gitObjectId(objectFormat, match[3]);
    entries.push(deepFreeze({
      mode: match[1],
      type: match[2],
      oid: match[3],
      size: match[4] === '-' ? null : Number(match[4]),
      path: match[5],
    }));
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function parseBatchObjects(buffer, requestedOids) {
  const objects = new Map();
  let offset = 0;
  for (const requestedOid of requestedOids) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git cat-file batch output ended before its header');
    const header = buffer.subarray(offset, newline).toString('ascii');
    offset = newline + 1;
    if (header === `${requestedOid} missing`) {
      objects.set(requestedOid, null);
      continue;
    }
    const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(header);
    if (!match || match[1] !== requestedOid) {
      fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git cat-file batch output was not attributable', { header, requestedOid });
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= buffer.length) {
      fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git cat-file batch output had an invalid size', { header });
    }
    const content = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size;
    if (buffer[offset] !== 0x0a) fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git cat-file batch object lacked its delimiter');
    offset += 1;
    objects.set(requestedOid, content);
  }
  if (offset !== buffer.length) fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'git cat-file batch output contained unattributed bytes');
  return objects;
}

function parseLfsPointer(content) {
  const lines = content.toString('utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (lines[0] !== LFS_VERSION_LINE) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/.exec(lines[1] || '');
  const size = /^size (\d+)$/.exec(lines[2] || '');
  if (!oid || !size || !Number.isSafeInteger(Number(size[1]))) return null;
  return Object.freeze({ oid: oid[1], size: Number(size[1]) });
}

function parseGitmodules(content) {
  const byPath = new Map();
  if (!content) return byPath;
  let current = null;
  const sections = new Map();
  for (const rawLine of content.toString('utf8').split(/\r?\n/)) {
    const section = /^\s*\[submodule\s+"([^"]+)"\]\s*$/.exec(rawLine);
    if (section) {
      current = section[1];
      sections.set(current, {});
      continue;
    }
    const property = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (current && property) sections.get(current)[property[1]] = property[2];
  }
  for (const [name, descriptor] of sections) {
    if (descriptor.path) byPath.set(descriptor.path, descriptor.url || `submodule:${name}`);
  }
  return byPath;
}

function withinRoot(root, relative) {
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) return target;
  fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git submodule path escapes the observed repository', { relative });
}

function expirationFrom(observedAt, ttlMs) {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'clock returned an invalid timestamp', { observedAt });
  return new Date(observedMs + ttlMs).toISOString();
}

class GitShadowImporter {
  constructor({ runner, gitExecutable, evidenceTtlMs, timeoutMs, maxOutputBytes, clock = () => new Date().toISOString() }) {
    if (!runner || typeof runner.runChecked !== 'function') fail(VCS_ERROR_CODES.ADAPTER_UNAVAILABLE, 'Git shadow import requires a ProcessRunner');
    this.runner = runner;
    this.gitExecutable = nonEmptyString(gitExecutable, 'gitExecutable');
    if (!Number.isInteger(evidenceTtlMs) || evidenceTtlMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'evidenceTtlMs must be positive');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'timeoutMs must be positive');
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'maxOutputBytes must be positive');
    this.evidenceTtlMs = evidenceTtlMs;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.clock = clock;
  }

  _run(repositoryLocator, argv, { input = null, acceptedExitCodes = [0] } = {}) {
    const result = this.runner.runChecked({
      executable: this.gitExecutable,
      argv,
      cwd: repositoryLocator,
      input,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (result.state === 'indeterminate') {
      fail(VCS_ERROR_CODES.UNKNOWN, 'Git observation was indeterminate', {
        argv,
        errorCode: result.errorCode,
        timedOut: result.timedOut,
        outputLimited: result.outputLimited,
      });
    }
    if (!acceptedExitCodes.includes(result.exitCode)) {
      fail(VCS_ERROR_CODES.GIT_COMPATIBILITY, 'Git observation command failed', {
        argv,
        exitCode: result.exitCode,
        stderr: stderrText(result),
      });
    }
    return result;
  }

  observe({ repositoryLocator, requiredNamespaceIds }) {
    nonEmptyString(repositoryLocator, 'repositoryLocator');
    if (!Array.isArray(requiredNamespaceIds) || requiredNamespaceIds.some(value => typeof value !== 'string' || !value.startsWith('refs/'))) {
      fail(VCS_ERROR_CODES.CONTRACT_VIOLATION, 'requiredNamespaceIds must be Git ref namespaces');
    }
    const namespaces = [...new Set(requiredNamespaceIds)].sort();
    const absoluteGitDir = stdoutText(this._run(repositoryLocator, ['rev-parse', '--absolute-git-dir']));
    const bare = stdoutText(this._run(repositoryLocator, ['rev-parse', '--is-bare-repository'])) === 'true';
    const repositoryRoot = bare
      ? path.resolve(absoluteGitDir)
      : path.resolve(stdoutText(this._run(repositoryLocator, ['rev-parse', '--show-toplevel'])));
    const objectFormat = stdoutText(this._run(repositoryLocator, ['rev-parse', '--show-object-format']));
    const shallow = stdoutText(this._run(repositoryLocator, ['rev-parse', '--is-shallow-repository'])) === 'true';
    const headOid = stdoutText(this._run(repositoryLocator, ['rev-parse', '--verify', 'HEAD^{commit}']));
    const treeOid = stdoutText(this._run(repositoryLocator, ['rev-parse', '--verify', 'HEAD^{tree}']));
    gitObjectId(objectFormat, headOid);
    gitObjectId(objectFormat, treeOid);
    const refs = parseRefs(this._run(repositoryLocator, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(objecttype)',
    ]).stdout, objectFormat);
    const tree = parseTree(this._run(repositoryLocator, ['ls-tree', '-r', '-z', '-l', 'HEAD']).stdout, objectFormat);
    const commonDirOutput = stdoutText(this._run(repositoryLocator, ['rev-parse', '--git-common-dir']));
    const commonGitDir = path.isAbsolute(commonDirOutput)
      ? path.resolve(commonDirOutput)
      : path.resolve(repositoryRoot, commonDirOutput);

    const artifacts = [];
    const artifactStates = {};
    const namespaceStates = {};
    const addArtifact = (artifact, state) => {
      if (!artifacts.some(existing => existing.artifactId === artifact.artifactId)) artifacts.push(artifact);
      artifactStates[artifact.artifactId] = state;
    };
    addArtifact(artifactReference({
      kind: 'git-commit',
      authorityId: 'git:HEAD',
      integrity: gitObjectId(objectFormat, headOid),
    }), 'PRESENT');
    addArtifact(artifactReference({
      kind: 'git-tree',
      authorityId: `git:${headOid}^{tree}`,
      integrity: gitObjectId(objectFormat, treeOid),
    }), 'PRESENT');

    for (const namespaceId of namespaces) {
      const matches = refs.filter(ref => namespaceMatches(namespaceId, ref.refName));
      namespaceStates[namespaceId] = matches.length > 0 ? 'PRESENT' : 'MISSING';
      if (matches.length === 0) {
        addArtifact(requirementArtifact('git-namespace-requirement', namespaceId), 'MISSING');
      } else {
        for (const ref of matches) {
          addArtifact(artifactReference({
            kind: 'git-ref',
            authorityId: ref.refName,
            integrity: gitObjectId(objectFormat, ref.oid),
          }), 'PRESENT');
        }
      }
    }

    const smallBlobOids = [...new Set(tree
      .filter(entry => entry.type === 'blob' && entry.size !== null && entry.size <= 512)
      .map(entry => entry.oid))];
    const smallObjects = smallBlobOids.length === 0
      ? new Map()
      : parseBatchObjects(
        this._run(repositoryLocator, ['cat-file', '--batch'], {
          input: Buffer.from(`${smallBlobOids.join('\n')}\n`, 'ascii'),
        }).stdout,
        smallBlobOids,
      );
    const lfsPointers = [];
    for (const entry of tree) {
      const content = smallObjects.get(entry.oid);
      if (!content) continue;
      const pointer = parseLfsPointer(content);
      if (pointer) lfsPointers.push({ path: entry.path, ...pointer });
    }
    for (const pointer of lfsPointers) {
      const artifact = artifactReference({
        kind: 'git-lfs-object',
        authorityId: `git-lfs:${pointer.path}`,
        integrity: `sha256:${pointer.oid}`,
      });
      const objectPath = path.join(commonGitDir, 'lfs', 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
      let state = 'MISSING';
      if (fs.existsSync(objectPath)) {
        const stat = fs.lstatSync(objectPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(objectPath)).digest('hex');
          state = digest === pointer.oid && stat.size === pointer.size ? 'PRESENT' : 'CORRUPT';
        } else {
          state = 'CORRUPT';
        }
      }
      addArtifact(artifact, state);
    }

    const gitmodulesEntry = tree.find(entry => entry.path === '.gitmodules' && entry.type === 'blob');
    let submoduleDescriptors = new Map();
    if (gitmodulesEntry) {
      const result = this._run(repositoryLocator, ['show', 'HEAD:.gitmodules']);
      submoduleDescriptors = parseGitmodules(result.stdout);
    }
    for (const entry of tree.filter(candidate => candidate.mode === '160000')) {
      const authorityId = submoduleDescriptors.get(entry.path) || `submodule:${entry.path}`;
      const artifact = artifactReference({
        kind: 'git-submodule',
        authorityId,
        integrity: gitObjectId(objectFormat, entry.oid),
      });
      let state = 'MISSING';
      if (!bare) {
        const target = withinRoot(repositoryRoot, entry.path);
        if (fs.existsSync(target) && fs.lstatSync(target).isDirectory()) {
          const result = this.runner.runChecked({
            executable: this.gitExecutable,
            argv: ['cat-file', '-e', `${entry.oid}^{commit}`],
            cwd: target,
            timeoutMs: this.timeoutMs,
            maxOutputBytes: this.maxOutputBytes,
          });
          state = result.state === 'success' ? 'PRESENT' : result.state === 'indeterminate' ? 'MISSING' : 'MISSING';
        }
      }
      addArtifact(artifact, state);
    }

    const fsck = this.runner.runChecked({
      executable: this.gitExecutable,
      argv: ['fsck', '--connectivity-only', '--no-dangling', '--no-reflogs'],
      cwd: repositoryLocator,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    let objectClosureState = 'PRESENT';
    if (fsck.state === 'indeterminate') objectClosureState = 'MISSING';
    if (fsck.state === 'failure') objectClosureState = /missing|broken link|invalid sha/i.test(stderrText(fsck)) ? 'MISSING' : 'CORRUPT';
    const closureArtifact = requirementArtifact('git-object-closure', `git:${headOid}`);
    addArtifact(closureArtifact, objectClosureState);

    const observedAt = this.clock();
    const expiresAt = expirationFrom(observedAt, this.evidenceTtlMs);
    const observationBase = {
      schemaVersion: OBSERVATION_SCHEMA,
      mode: 'SHADOW_READ_ONLY',
      repositoryRoot,
      gitDirectory: path.resolve(absoluteGitDir),
      objectFormat,
      bare,
      shallow,
      headOid,
      treeOid,
      refs,
      requiredNamespaceIds: namespaces,
      namespaceStates,
      artifacts: artifacts.sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      artifactStates: Object.fromEntries(Object.entries(artifactStates).sort(([left], [right]) => left.localeCompare(right))),
      observedAt,
      expiresAt,
    };
    const observationId = hashBytes(canonicalEncode(observationBase));
    const completeness = verifyRevisionClosure({
      artifacts: observationBase.artifacts,
      artifactStates: observationBase.artifactStates,
      requiredNamespaceIds: namespaces,
      namespaceStates,
      authoritySnapshotId: observationId,
      observedAt,
      expiresAt,
      evidenceIds: [observationId],
    });
    return deepFreeze({ ...observationBase, observationId, completeness });
  }

  importRevision({
    repositoryLocator,
    requiredNamespaceIds,
    policyRevisionId,
    intendedConsumerIds,
  }) {
    const observation = this.observe({ repositoryLocator, requiredNamespaceIds });
    const manifest = createRevisionManifest({
      artifacts: observation.artifacts,
      requiredNamespaceIds: observation.requiredNamespaceIds,
      policyRevisionId,
      intendedConsumerIds,
      completeness: observation.completeness,
      state: 'PROPOSED',
      retentionState: 'PRESERVED',
    });
    return deepFreeze({ observation: immutableClone(observation), manifest });
  }
}

function createGitShadowImporter(options) {
  return new GitShadowImporter(options);
}

module.exports = Object.freeze({
  OBSERVATION_SCHEMA,
  GitShadowImporter,
  createGitShadowImporter,
  namespaceMatches,
  parseLfsPointer,
});
