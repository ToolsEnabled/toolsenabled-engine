#!/usr/bin/env python3
"""Create a one-commit fast-forward of the public branch and verify archives."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile


ROOT = Path(__file__).resolve().parents[1]
BRANCH = 'fleet-1.8.0-source'
BETA3_BRANCH = 'openshell-beta-source-20260930'
BETA3_TAG = 'openshell-beta3-20261001'
BETA3_COMMIT = '4967f70b34dc843e35c302249ad4bd63016e8ad2'
CURRENT_PUBLIC_COMMIT = '4bca48d6d3cfa87093957fa6fcb817e9ebc479b7'
PUBLIC_CARRY_FORWARD = (
    'adapters/openshell/deepseek-harness/README.md',
    'adapters/openshell/deepseek-harness/fleet-dsh-overlay.py',
)
PUBLIC_NAME = 'Joshua Pinckard'
PUBLIC_EMAIL = '146689379+JoshuaPinckard@users.noreply.github.com'


def run(*argv, cwd=ROOT, env=None):
    isolated = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
                'GIT_TEMPLATE_DIR': '/dev/null'}
    if env:
        isolated.update(env)
    return subprocess.check_output(argv, cwd=cwd, env=isolated, stderr=subprocess.STDOUT).decode().strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def member_map(path):
    result = {}
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            if item.name in result or not (item.isfile() or item.isdir()):
                raise ValueError(f'Unexpected archive member: {item.name}')
            result[item.name] = (item.type, item.mode, item.uid, item.gid, item.mtime,
                                 archive.extractfile(item).read() if item.isfile() else None)
    return result


def compare_archives(original, public, old_commit, new_commit):
    old, new = member_map(original), member_map(public)
    if old.keys() != new.keys():
        raise ValueError('Public archive member list differs from reviewed source archive')
    changed = []
    for name in old:
        before, after = old[name], new[name]
        if before == after:
            continue
        if name != 'toolsenabled-installer/manifest.json' or before[:5] != after[:5]:
            raise ValueError(f'Public archive differs outside manifest identity: {name}')
        left, right = json.loads(before[5]), json.loads(after[5])
        if left.get('source_commit') != old_commit or right.get('source_commit') != new_commit:
            raise ValueError('Archive source identities do not match the mapped commits')
        left['source_commit'] = right['source_commit']
        if left != right:
            raise ValueError('Public archive manifest differs beyond source_commit')
        changed.append(name)
    if changed != ['toolsenabled-installer/manifest.json']:
        raise ValueError('Expected exactly one changed archive manifest')
    return len(old)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--openshell-archive', required=True, type=Path)
    parser.add_argument('--host-archive', required=True, type=Path)
    parser.add_argument('--beta3-bundle', required=True, type=Path,
                        help='verified local bundle with the beta 3 public default branch and tag')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    old_commit = args.source_commit
    if run('git', 'rev-parse', 'HEAD') != old_commit or subprocess.run(
            ['git', 'diff', '--quiet'], cwd=ROOT).returncode or subprocess.run(
            ['git', 'diff', '--cached', '--quiet'], cwd=ROOT).returncode:
        raise ValueError('The exact source commit must be checked out with no tracked changes')
    epoch = run('git', 'show', '-s', '--format=%ct', old_commit)
    if not epoch.isdigit():
        raise ValueError('Source commit timestamp is invalid')
    output = args.output.resolve()
    if output.exists():
        raise ValueError('Output directory must not exist')
    original = {'openshell': args.openshell_archive.resolve(strict=True),
                'host': args.host_archive.resolve(strict=True)}
    beta3_bundle = args.beta3_bundle.resolve(strict=True)
    output.mkdir(parents=True)
    source = output / 'source'
    run(sys.executable, str(ROOT / 'public-source/build.py'), '--commit', old_commit,
        '--output', str(source), '--openshell-archive', str(original['openshell']),
        '--host-archive', str(original['host']))
    run('git', 'init', '-q', '-b', BRANCH, cwd=source)
    run('git', 'fetch', '-q', str(beta3_bundle),
        f'refs/tags/{BETA3_TAG}:refs/tags/{BETA3_TAG}',
        f'refs/heads/{BETA3_BRANCH}:refs/remotes/beta3/{BETA3_BRANCH}', cwd=source)
    beta3_commit = run('git', 'rev-parse', f'{BETA3_TAG}^{{commit}}', cwd=source)
    parent = run('git', 'rev-parse', f'refs/remotes/beta3/{BETA3_BRANCH}^{{commit}}', cwd=source)
    if (beta3_commit != BETA3_COMMIT or parent != CURRENT_PUBLIC_COMMIT
            or run('git', 'merge-base', beta3_commit, parent, cwd=source) != beta3_commit):
        raise ValueError('Beta 3 tag and current public default-branch tip differ from the reviewed ancestors')
    run('git', 'add', '-A', cwd=source)
    for name in PUBLIC_CARRY_FORWARD:
        previous = run('git', 'ls-tree', parent, '--', name, cwd=source).split()
        staged = run('git', 'ls-files', '--stage', '--', name, cwd=source).split()
        if len(previous) < 3 or len(staged) < 2 or previous[0] != staged[0] or previous[2] != staged[1]:
            raise ValueError(f'Public default-branch file changed unexpectedly: {name}')
    tree = run('git', 'write-tree', cwd=source)
    commit_env = {**os.environ, 'GIT_AUTHOR_NAME': PUBLIC_NAME, 'GIT_AUTHOR_EMAIL': PUBLIC_EMAIL,
                  'GIT_COMMITTER_NAME': PUBLIC_NAME, 'GIT_COMMITTER_EMAIL': PUBLIC_EMAIL,
                  'GIT_AUTHOR_DATE': '@' + epoch + ' +0000',
                  'GIT_COMMITTER_DATE': '@' + epoch + ' +0000'}
    public_commit = run('git', 'commit-tree', tree, '-p', parent, '-m',
                        'Release ToolsEnabled Fleet 1.8.0 source', cwd=source, env=commit_env)
    run('git', 'update-ref', f'refs/heads/{BRANCH}', public_commit, cwd=source)
    run('git', 'reset', '--mixed', public_commit, cwd=source)
    if run('git', 'rev-parse', 'HEAD^', cwd=source) != parent or run('git', 'rev-list', '--count', f'{parent}..HEAD', cwd=source) != '1':
        raise ValueError('Public source must be one fast-forward commit after beta 3')
    if run('git', 'show', '-s', '--format=%an <%ae>|%cn <%ce>|%at|%ct', cwd=source) != (
            f'{PUBLIC_NAME} <{PUBLIC_EMAIL}>|{PUBLIC_NAME} <{PUBLIC_EMAIL}>|{epoch}|{epoch}'):
        raise ValueError('Public commit identity or date differs from the beta 3 release identity')
    if run('git', 'status', '--porcelain', cwd=source):
        raise ValueError('Public source commit left untracked or modified files')
    run('git', 'fsck', '--full', '--strict', cwd=source)
    builds = output / 'archives'
    builds.mkdir()
    run('bash', 'installer/openshell/build.sh', str(builds / 'openshell'), cwd=source)
    run('bash', 'installer/host/build.sh', str(builds / 'host'), cwd=source)
    public = {'openshell': builds / 'openshell/toolsenabled-openshell-1.8.0-linux-x64.tar.gz',
              'host': builds / 'host/toolsenabled-host-1.8.0-linux-x64.tar.gz'}
    # The public commit is a separate repository, so verify_archive gets its
    # selected files from that repository's own immutable tree.
    import build
    build.ROOT = source
    names = build.manifest_at(public_commit, build.MANIFEST)
    runtime = build.manifest_at(public_commit, build.RUNTIME)
    blobs = build.selected_blobs(public_commit, names)
    mapping = {}
    for edition in ('openshell', 'host'):
        build.verify_archive(public[edition], public_commit, runtime, blobs, edition)
        mapping[edition] = {'reviewedSha256': digest(original[edition]),
                            'publicSha256': digest(public[edition]),
                            'membersMatched': compare_archives(original[edition], public[edition], old_commit, public_commit),
                            'difference': 'manifest.source_commit only'}
    release_tag = 'v1.8.0'
    tag_env = {**commit_env, 'GIT_COMMITTER_NAME': PUBLIC_NAME, 'GIT_COMMITTER_EMAIL': PUBLIC_EMAIL,
               'GIT_COMMITTER_DATE': '@' + epoch + ' +0000'}
    tag_message = ('ToolsEnabled Fleet 1.8.0 (Linux x64), OpenShell archive sha256 '
                   + mapping['openshell']['reviewedSha256'])
    run('git', 'tag', '-a', release_tag, public_commit, '-m', tag_message, cwd=source, env=tag_env)
    tag_type = run('git', 'cat-file', '-t', f'refs/tags/{release_tag}', cwd=source)
    if tag_type != 'tag' or run('git', 'rev-parse', f'{release_tag}^{{commit}}', cwd=source) != public_commit:
        raise ValueError('Public release tag must be annotated and point at the mapped commit')
    tag_object = run('git', 'cat-file', '-p', f'refs/tags/{release_tag}', cwd=source)
    expected_tag = (f'object {public_commit}\ntype commit\ntag {release_tag}\n'
                    f'tagger {PUBLIC_NAME} <{PUBLIC_EMAIL}> {epoch} +0000\n\n{tag_message}')
    if tag_object != expected_tag:
        raise ValueError('Public release tag identity, date or archive digest differs from the reviewed release')
    run('git', 'bundle', 'create', str(output / 'public-source.bundle'), BRANCH, release_tag, cwd=source)
    # Keep the one-parent delta reproducible across fresh clones: Git's
    # default pack window can select different bases for the same objects.
    run('git', '-c', 'pack.window=0', 'bundle', 'create',
        str(output / 'public-source-delta.bundle'), BRANCH, release_tag,
        f'^{parent}', cwd=source)
    receipt = {'sourceCommit': old_commit, 'publicCommit': public_commit,
               'publicParent': parent, 'beta3Commit': beta3_commit, 'beta3Tag': BETA3_TAG,
               'publicTag': release_tag,
               'branch': BRANCH, 'publicAuthor': f'{PUBLIC_NAME} <{PUBLIC_EMAIL}>',
               'sourceCommitEpoch': int(epoch), 'archives': mapping}
    (output / 'MAPPING-RECEIPT.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    print(json.dumps(receipt, sort_keys=True))


if __name__ == '__main__':
    main()
