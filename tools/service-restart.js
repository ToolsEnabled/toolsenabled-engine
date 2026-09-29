#!/usr/bin/env node
'use strict';

// CLI for the verified service restart (src/lib/service-control.js).
//
//   node tools/service-restart.js dashboard
//   node tools/service-restart.js dashboard --no-elevate
//   node tools/service-restart.js --status dashboard
//   node tools/service-restart.js --list
//
// It stops the task, waits for the socket to actually close, reaps a stale
// listener (without elevation first, then through the single allowlisted
// elevated operation), starts the task, and then PROVES the port is served by a
// process that was not serving it before and started after the restart began.
//
// Exit codes: 0 verified restart; 1 failure -- and a failure prints the exact
// diagnosis. It never prints success for a stale listener.

const control = require('../src/lib/service-control');

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main(argv) {
  const args = argv.filter(arg => arg !== '');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    print({ usage: 'node tools/service-restart.js <service> [--no-elevate] | --status <service> | --list', services: Object.keys(control.SERVICES) });
    return 0;
  }
  if (args[0] === '--list') {
    print({ services: Object.values(control.SERVICES).map(s => ({ id: s.id, port: s.port, taskName: s.taskName, elevatedReap: s.reapOperation })) });
    return 0;
  }
  if (args[0] === '--status') {
    let service;
    try { service = control.resolveService(args[1]); }
    catch (error) { print({ ok: false, error: error.message }); return 1; }
    const snapshot = control.defaultProbe(service.port);
    print({
      service: service.id, port: service.port, taskName: service.taskName,
      listeners: snapshot.listeners.map(listener => ({ ...listener, described: control.describeListener(listener) }))
    });
    return 0;
  }

  const serviceId = args[0];
  const allowElevation = !args.includes('--no-elevate');
  let report;
  try { report = await control.restartService(serviceId, { allowElevation }); }
  catch (error) { print({ ok: false, code: (error && error.code) || 'SERVICE_ERROR', error: error && error.message }); return 1; }
  print(report);
  if (!report.ok) process.stderr.write(`RESTART FAILED [${report.failure.code}] ${report.failure.message}\n`);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { print({ ok: false, error: error && error.message }); process.exitCode = 1; });
}

module.exports = Object.freeze({ main });
