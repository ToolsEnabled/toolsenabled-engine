'use strict';

function ledgerPlace() {
  if (require('./openshell-inside').isOpenShellHost()) return 'with `toolsenabled-authority ledger` on the machine that runs OpenShell';
  if (process.env.TOOLSENABLED_RUNTIME_MODE === 'host') return process.env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
    ? 'by typing /ledger in Claude Code' : 'with `toolsenabled ledger` in the host terminal';
  return require('./openshell-inside').isInsideOpenShellSandbox()
    ? 'with `toolsenabled ledger` in the sandbox terminal'
    : 'on the Ledger page';
}

module.exports = { ledgerPlace };
