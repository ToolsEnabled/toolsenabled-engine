"""Inventory-proven runtime uninstall with adapter-owned registration policy.

No current Claude registration target binding is claimed. The JavaScript
adapter owns the qualified removal/absence contract and Codex target preflight;
this driver adds complete runtime ownership, retained descriptor custody and
durable partial outcomes.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys

sys.dont_write_bytecode = True

import fleet_fs as fs
from fleet_install import (InstallError, absolute, digest, strict_json, read_at,
                           generated_files, read_receipt, require_state_record,
                           validate_context, bounded_command)


PROVIDERS = ('claude', 'codex')


def refuse(code, message):
    raise InstallError(code, message)


def parse_args(argv):
    flags = [word for word in argv if word.startswith('--')]
    if len(flags) != len(set(flags)) or any('=' in word for word in flags):
        refuse('UNINSTALL', 'Repeated options or --flag=value are refused')
    parser = argparse.ArgumentParser(allow_abbrev=False,
        epilog='Before uninstall, stop other writers to this runtime. Fleet holds its own lifecycle lock '
               'and rechecks retained identities, but exclusive writer quiescence is required.')
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--keep-state', required=True, action='store_true')
    parser.add_argument('--archive')
    parser.add_argument('--sha256')
    options = parser.parse_args(argv)
    options.prefix = absolute(options.prefix)
    if bool(options.archive) != bool(options.sha256):
        refuse('INTEGRITY', 'An archive and its independent published SHA256 are required together')
    if options.archive:
        options.archive, options.sha256 = absolute(options.archive), digest(options.sha256)
    return options


def validate_inspection(value, prefix):
    if not isinstance(value, dict) or set(value) != {'context', 'providers'}:
        refuse('INTEGRITY', 'Uninstall inspection returned an unexpected schema')
    validate_context(value['context'], prefix)
    providers = value['providers']
    if not isinstance(providers, dict) or set(providers) != set(PROVIDERS):
        refuse('INTEGRITY', 'Uninstall inspection omitted a supported provider')
    for provider in PROVIDERS:
        item = providers[provider]
        if not isinstance(item, dict) or set(item) != {'available', 'history'} or type(item['available']) is not bool:
            refuse('INTEGRITY', 'Uninstall provider inspection schema is invalid')
        if item['available']:
            if item['history'] is not None:
                refuse('INTEGRITY', 'Available provider has unexpected setup-history evidence')
        elif item['history'] != 'never':
            refuse('DEREGISTER', 'Unavailable provider lacks sealed never-attempted history; runtime retained')
    expected_available = {provider for provider in PROVIDERS if providers[provider]['available']}
    if set(value['context']['availableProviders']) != expected_available:
        refuse('INTEGRITY', 'Provider availability disagrees with the selected context')
    return value


def validate_outcome(value, provider):
    if (not isinstance(value, dict) or set(value) != {'provider', 'outcome', 'version'}
            or value['provider'] != provider or value['outcome'] not in ('removed', 'absent', 'never')):
        refuse('DEREGISTER', 'Registration adapter returned an unknown outcome')
    if value['outcome'] == 'absent':
        if value['version'] != {'claude': '2.1.284', 'codex': '0.158.0'}[provider]:
            refuse('DEREGISTER', 'Registration absence has no qualified version')
    elif value['version'] is not None:
        refuse('DEREGISTER', 'Registration adapter returned unexpected version evidence')
    return value


class Adapter:
    def __init__(self, engine, lock, *, env=None):
        self.engine, self.lock = absolute(engine), lock
        self.env = dict(os.environ if env is None else env)
        self.node = shutil.which('node', path=self.env.get('PATH', ''))
        if not self.node:
            refuse('UNINSTALL', 'Node.js is required to inspect and remove registrations')
        self.script = self.engine / 'src/lib/openshell-uninstall-adapter.js'

    def command(self, prefix, phase, provider=None):
        argv = [self.node, str(self.script), '--prefix', str(prefix), '--phase', phase]
        if provider is not None:
            argv += ['--provider', provider]
        code, stdout, stderr = bounded_command(argv, env=self.lock.child_env(self.env),
                                               pass_fds=self.lock.pass_fds,
                                               timeout=45 if phase == 'remove' else 20)
        if code:
            reported = stderr.decode('utf8', 'replace').partition(':')[0]
            known = {'DEREGISTER', 'OUTCOME_UNCERTAIN', 'SCOPE_UNSAFE', 'SCOPE_CHANGED',
                     'SCOPE_BUSY', 'INSPECTION_UNAVAILABLE', 'INTEGRITY', 'RECOVERY_REQUIRED',
                     'CODEX_TARGET_UNPROVEN'}
            code = reported if reported in known else 'DEREGISTER'
            if code == 'CODEX_TARGET_UNPROVEN':
                refuse(code, 'Codex target inspection refused; runtime and state retained; inspect the selected target before retrying')
            guidance = ''
            if code == 'DEREGISTER' and provider in PROVIDERS:
                command = 'claude mcp remove --scope user toolsenabled' if provider == 'claude' else 'codex mcp remove toolsenabled'
                guidance = '; manual command for this selected profile: ' + command
            refuse(code,
                   'Registration adapter refused; runtime and state retained; earlier outcomes and pending evidence were kept' + guidance)
        if stderr:
            refuse('DEREGISTER', 'Registration adapter produced unexpected diagnostic output')
        return strict_json(stdout)

    def inspect(self, prefix):
        return self.command(prefix, 'inspect')

    def remove(self, prefix, provider):
        return self.command(prefix, 'remove', provider)


class Uninstaller:
    def __init__(self, prefix, lock, adapter, *, archive_path=None, sha256=None, checkpoint=None):
        self.prefix, self.lock, self.adapter = absolute(prefix), lock, adapter
        self.archive_path = absolute(archive_path) if archive_path is not None else None
        self.sha256 = digest(sha256) if sha256 is not None else None
        if (self.archive_path is None) != (self.sha256 is None):
            refuse('INTEGRITY', 'An archive and its independent published SHA256 are required together')
        self.record = None
        self.checkpoint = checkpoint or (lambda: None)

    def save(self, phase, **changes):
        self.record.update(changes)
        self.record['phase'] = phase
        self.lock.write_pending(self.record)

    def protected_context(self, context):
        homes = {context['home'], context['accountHome']}
        selected = {context[key] for key in ('stateRoot', 'servicesRoot', 'codexProfile', 'claudeProfile', 'workspace')}
        for home in homes:
            if self.prefix == Path(home) or self.prefix in Path(home).parents:
                refuse('PROTECTED_PATH', 'Runtime contains a protected home')
        # A value serving both HOME and profile/state roles must retain the
        # stronger symmetric protection. Only home-only values are excluded.
        return set(context['protectedPaths']) - (homes - selected)

    def run(self):
        self.checkpoint()
        if self.lock.pending is not None:
            refuse('RECOVERY_REQUIRED', 'An earlier lifecycle operation is unresolved; uninstall was not replayed')
        fs.assert_target_safe(str(self.prefix), protected_paths=(self.lock.protected_root,))
        if self.archive_path is not None and (self.archive_path == self.prefix or self.prefix in self.archive_path.parents):
            refuse('INTEGRITY', 'The independent archive must be outside the runtime being removed')
        with ExitStack() as stack:
            parent = stack.enter_context(fs.SafeDirectory.open(self.prefix.parent))
            observed = stack.enter_context(parent.child(self.prefix.name))
            manifest, _ = read_at(observed, 'manifest.json')
            if self.archive_path is not None:
                archive = stack.enter_context(fs.VerifiedArchive.open(self.archive_path, self.sha256))
            else:
                # An old manifest selects a known independent catalog only;
                # its claims never constitute ownership proof by themselves.
                archive = fs.load_legacy_catalog(strict_json(manifest))
            receipt, anchors = read_receipt(observed, archive, with_anchors=True)
            receipt_value = strict_json(receipt) if receipt is not None else None
            recorded_context = receipt_value['context'] if receipt_value is not None else None
            protected = {self.lock.protected_root}
            if self.archive_path is not None:
                protected.add(str(self.archive_path))
            if recorded_context is not None:
                validate_context(recorded_context, self.prefix)
                protected.update(self.protected_context(recorded_context))
            inventory = archive.runtime_inventory(str(self.prefix), generated_files(
                fs, self.prefix, legacy=receipt is None, receipt=receipt))
            root_identity = dict(observed.identity)
            retained = stack.enter_context(fs.RetainedTree(parent, self.prefix.name, inventory, root_identity,
                                                          protected_paths=tuple(sorted(protected)),
                                                          expected_snapshots=anchors,
                                                          legacy_runtime=receipt is None or receipt_value['schema'] == 1))
            retained.revalidate()
            if receipt_value is not None:
                require_state_record(receipt_value, receipt, seed_c10=receipt_value['schema'] == 1)
            try:
                self.checkpoint()
                inspection = validate_inspection(self.adapter.inspect(self.prefix), self.prefix)
                self.checkpoint()
            except BaseException as error:
                if getattr(error, 'code', None) == 'OUTCOME_UNCERTAIN' and self.lock.pending is None:
                    self.lock.write_pending({'nonce': self.lock.nonce, 'kind': 'fleet-inspection',
                                             'phase': 'OUTCOME_UNCERTAIN'})
                raise
            context = inspection['context']
            retained.protect(self.protected_context(context))
            self.checkpoint()
            self.record = {'nonce': self.lock.nonce, 'kind': 'fleet-uninstall', 'schemaVersion': 1,
                           'prefix': str(self.prefix), 'rootIdentity': root_identity,
                           'archiveSha256': archive.archive_sha256,
                           'archivePath': str(self.archive_path) if self.archive_path else None,
                           'context': context, 'recordedContext': recorded_context,
                           'providerOutcomes': {provider: None for provider in PROVIDERS},
                           'activeProvider': None, 'removedEntries': 0}
            self.save('PREPARED')
            try:
                for provider in PROVIDERS:
                    # Recheck held identities before each external mutation.
                    self.checkpoint()
                    retained.revalidate()
                    if receipt_value is not None:
                        require_state_record(receipt_value, receipt)
                    current = validate_inspection(self.adapter.inspect(self.prefix), self.prefix)
                    if current != inspection:
                        refuse('SCOPE_CHANGED', 'Selected uninstall context changed before provider removal')
                    self.checkpoint()
                    self.save('DEREGISTERING', activeProvider=provider)
                    outcome = validate_outcome(self.adapter.remove(self.prefix, provider), provider)
                    if outcome['outcome'] == 'never' and inspection['providers'][provider]['available']:
                        refuse('DEREGISTER', 'Provider availability changed during removal')
                    self.record['providerOutcomes'][provider] = outcome
                    self.save('DEREGISTERING', activeProvider=None)
                self.save('PROVIDERS_REMOVED')
                self.checkpoint()
                after = validate_inspection(self.adapter.inspect(self.prefix), self.prefix)
                if after != inspection:
                    refuse('SCOPE_CHANGED', 'Selected uninstall context changed; runtime retained')
                retained.revalidate()
                if receipt_value is not None:
                    require_state_record(receipt_value, receipt)
                self.checkpoint()
                self.save('REMOVING', removedEntries=None)
                result = retained.remove(_before_remove=lambda _relative: self.checkpoint())
                if not result.complete:
                    self.save('INCOMPLETE', removedEntries=result.removed,
                              retainedCodes=[item['code'] for item in result.retained])
                    refuse('RECOVERY_REQUIRED', 'Runtime removal is incomplete; remaining entries and pending evidence were retained')
                self.save('REMOVED', removedEntries=result.removed)
                self.lock.clear_pending(self.lock.nonce)
                return {'outcome': 'REMOVED', 'prefix': str(self.prefix), 'state': 'kept',
                        'archiveSha256': archive.archive_sha256,
                        'providers': self.record['providerOutcomes']}
            except BaseException as error:
                code = getattr(error, 'code', 'OUTCOME_UNCERTAIN')
                if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}', code):
                    code = 'OUTCOME_UNCERTAIN'
                if self.record['phase'] not in ('INCOMPLETE', 'REMOVED'):
                    try:
                        self.save('OUTCOME_UNCERTAIN' if code == 'OUTCOME_UNCERTAIN' else 'REFUSED', errorCode=code)
                    except BaseException:
                        pass  # The preceding durable intent remains a barrier.
                raise


def own_engine():
    directory = Path(__file__).resolve().parent
    staged = directory / 'payload/engine'
    # Both are fixed packaging layouts. Target-prefix metadata never chooses
    # executable helper code, and no old runtime is invoked for staged removal.
    return staged if staged.is_dir() else directory.parent


@contextmanager
def lifecycle_lock(engine):
    location = engine / 'src/lib/openshell_lifecycle_lock.py'
    spec = importlib.util.spec_from_file_location('fleet_uninstall_lock', location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.FD_ENV in os.environ:
        lock = module.inherited()
        try:
            yield lock
        finally:
            lock.__exit__(None, None, None)
    else:
        with module.LifecycleLock() as lock:
            yield lock


def main(argv=None):
    options = parse_args(sys.argv[1:] if argv is None else argv)
    if os.environ.get('OPENSHELL_SANDBOX') != '1' or platform.system() != 'Linux' or platform.machine() != 'x86_64':
        refuse('TARGET', 'Run uninstall inside your Linux x86_64 OpenShell sandbox')
    os.umask(0o077)
    engine = own_engine()
    # Shared nested signal scopes use one nonraising latch. A second signal
    # cannot interrupt the initial uncertainty barrier or descriptor cleanup.
    from fleet_install import deferred_signals
    with deferred_signals() as cancellation:
        with lifecycle_lock(engine) as lock:
            result = Uninstaller(options.prefix, lock, Adapter(engine, lock),
                                 archive_path=options.archive, sha256=options.sha256,
                                 checkpoint=cancellation.checkpoint).run()
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(getattr(error, 'code', 'UNINSTALL') + ': ' + str(error), file=sys.stderr)
        raise SystemExit(1)
