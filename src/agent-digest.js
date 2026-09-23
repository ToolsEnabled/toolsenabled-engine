#!/usr/bin/env node
'use strict';

// The agentic-workflow digest service (owner request R46).
//
// Its own process, on purpose. It calls the selected owner-delivery transport
// through plain in-process requires -- NOT through any MCP client session,
// whose tool set is restricted and whose lifetime is bounded, so a digest
// behind one would stop working silently. This process survives session exits,
// and the Windows task in tools/agent-digest-task.ps1 brings it back after a
// reboot.
//
// Modes:
//   --serve            30-second tick loop (default). One tick, one slot, at most.
//   --once             Run a single tick and exit. Use this when the scheduler
//                      itself provides the cadence.
//   --dry-run          Generate and print a digest without sending. Implies --once
//                      semantics and never touches the fired-slot state.
//   --status           Print schedule/next-slot state as JSON and exit. This is
//                      where a FAILED owner delivery becomes visible: a dropped
//                      report nobody notices is worse than an email.
//   --render-image     Render the phone card and write the PNG to disk without
//                      sending anything. For visual inspection only.
//
// Nothing here spawns a child process. If that ever changes, pass
// { windowsHide: true } -- this machine has a standing complaint about console
// windows flashing, and the scheduled task is registered with a non-interactive
// (S4U) logon type for the same reason.

const { rootPath } = require('./lib/runtime');
const { createAgentDigestService, loadConfig, resolveRecipient } = require('./lib/agent-digest');
const { AgentDigestLockError, acquireLock } = require('./lib/process-claim-lock');
const { digestSchedulingStatus } = require('./lib/agent-digest/scheduling-status');
const ownerDelivery = require('./lib/owner-delivery');

const LOCK_FILE = () => rootPath('state', 'agent-digest.lock');

const MODES = new Set(['--serve', '--once', '--dry-run', '--status', '--render-image', '--help']);

function log(level, message) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`[${new Date().toISOString()}] ${level} agent-digest: ${message}\n`);
}

function usage() {
  process.stdout.write([
    'Usage: node src/agent-digest.js [--serve|--once|--dry-run|--status|--render-image]',
    '',
    '  --serve         30s tick loop; fires at most one scheduled slot per tick (default)',
    '  --once          single tick, then exit',
    '  --dry-run       render a digest to stdout without sending or marking a slot fired',
    '  --status        print the schedule + owner-delivery state as JSON',
    '  --render-image  write the phone report card to a PNG without sending it',
    ''
  ].join('\n'));
}

async function main(argv) {
  const flags = argv.filter(argument => argument.startsWith('--'));
  const unknown = flags.filter(flag => !MODES.has(flag));
  if (unknown.length) { process.stderr.write(`Unknown option(s): ${unknown.join(', ')}\n`); usage(); return 2; }
  const requestedModes = flags.filter(flag => flag !== '--help');
  if (requestedModes.length > 1) {
    process.stderr.write(`Choose only one mode: ${requestedModes.join(', ')}\n`);
    usage();
    return 2;
  }
  const mode = requestedModes[0] || '--serve';
  if (flags.includes('--help')) { usage(); return 0; }

  const config = loadConfig();
  const wiring = createAgentDigestService({ config, log });
  const { schedule, service } = wiring;

  if (mode === '--status') {
    // Resolve the maintained delivery path without claiming that a configured
    // account is the selected destination when channel resolution disagrees.
    let recipientAlias = null;
    let recipientError = null;
    try { recipientAlias = resolveRecipient(config).alias; }
    catch (error) { recipientError = error && error.code ? error.code : 'unresolved'; }
    let delivery = null;
    let deliveryError = null;
    try { delivery = ownerDelivery.deliveryStatus(); }
    catch (error) { deliveryError = error && error.code ? error.code : 'unreadable'; }
    process.stdout.write(`${JSON.stringify({
      enabled: config.enabled,
      // R84: `transport` is the one selected destination. `delivery` records
      // only attempts on that selected channel; standby email is not a send.
      transport: {
        selected: delivery && delivery.channel ? delivery.channel : null,
        source: delivery && delivery.channelSource ? delivery.channelSource : null,
        reason: delivery && delivery.channelReason ? delivery.channelReason : null,
        standbyEmail: {
          selected: delivery && delivery.channel === 'email',
          accountAlias: recipientAlias,
          resolutionError: recipientError
        }
      },
      delivery,
      deliveryError,
      scheduling: digestSchedulingStatus(),
      tickMs: config.tickMs,
      generationTimeoutMs: config.generationTimeoutMs,
      lastFired: schedule.lastFired() || null,
      nextSlot: schedule.nextSlot(new Date()),
      summary: schedule.summary()
    }, null, 2)}\n`);
    return 0;
  }

  if (mode === '--dry-run') {
    // Deliberately bypasses the slot machinery: a dry run must never consume a
    // real slot or advance the delta baseline.
    const message = await wiring.generate({ fireKey: null, kind: 'digest', now: new Date() });
    const resolved = wiring.channel();
    process.stdout.write(`Channel: ${resolved.channel} (${resolved.source}${resolved.reason ? `: ${resolved.reason}` : ''})\n\n`);
    process.stdout.write(`--- SUBJECT ---\n${message.subject}\n\n--- PLAIN TEXT BODY (${message.text.length} chars) ---\n${message.text}\n`);
    return 0;
  }

  if (mode === '--render-image') {
    const output = argv.find(argument => !argument.startsWith('--')) || rootPath('state', 'agent-digest-card.png');
    const message = await wiring.generate({ fireKey: null, kind: 'digest', now: new Date() });
    const image = await wiring.renderImage(message);
    require('node:fs').writeFileSync(output, image);
    process.stdout.write(`${JSON.stringify({
      wrote: output, bytes: image.length,
      subjectCharacters: message.subject.length
    }, null, 2)}\n`);
    return 0;
  }

  if (!config.enabled) {
    // HONEST ABOUT WHICH ABSENCE. "Disabled in config/agent-digest.json" is a
    // lie when there IS no config/agent-digest.json, and it sends whoever reads
    // this line to edit a file that does not exist. loadConfig now states the
    // reason it withheld; print that instead of guessing at it.
    log('info', `digest is not enabled; nothing will be sent (${config.enabledReason || 'no reason was recorded'}).`);
    return 0;
  }

  // Only --once and --serve ever call service.tick(), i.e. only they can mark
  // a slot fired and send. Both must hold this single-instance lock: the
  // schedule's JsonSettingsStore has no cross-process locking of its own, so
  // two ticking processes (e.g. a manually-started one still alive when the
  // registered Scheduled Task's own trigger fires) could otherwise both see
  // the same unfired slot and both send -- a real double-send. --dry-run and
  // --status never touch the fired-slot marker and are exempt on purpose.
  let lock;
  try {
    lock = acquireLock(LOCK_FILE());
  } catch (error) {
    if (error instanceof AgentDigestLockError) {
      log('error', error.message);
      return 4;
    }
    throw error;
  }

  try {
    // Do not retroactively fire a slot whose boundary passed before this
    // service was ever installed.
    if (schedule.seedIfMissing(new Date())) log('info', `seeded the fired-slot marker at ${schedule.lastFired()}`);

    if (mode === '--once') {
      const result = await service.tick();
      log('info', `tick result: ${JSON.stringify(result)}`);
      // A non-fired result is successful only when the schedule was actually
      // measured and reported that no slot is due. Inputs such as an unreadable
      // schedule or an unexpected tick failure also arrive as `fired: false`;
      // treating every one of those as exit 0 used to turn "could not tick"
      // into the definite answer "nothing needed sending".
      const completed = (result.fired === true && result.sent === true)
        || (result.fired === false && result.reason === 'no-due-slot');
      return completed ? 0 : 1;
    }

    log('info', `serving; tick every ${Math.round(config.tickMs / 1000)}s, generation timeout ${config.generationTimeoutMs}ms`);
    service.start();
    const stop = signal => {
      log('info', `received ${signal}; stopping`);
      service.stop();
      lock.release();
      process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    // A synchronous backstop: if the process exits some other way, still
    // release the lock rather than leaving a stale one behind (harmless --
    // acquireLock reclaims a dead holder's lock automatically -- but a clean
    // release lets the next start skip that reclaim step entirely).
    process.on('exit', () => lock.release());
    return new Promise(() => { /* serve until signalled */ });
  } catch (error) {
    lock.release();
    throw error;
  } finally {
    if (mode === '--once') lock.release();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { if (Number.isInteger(code)) process.exitCode = code; })
    .catch(error => {
      log('error', `fatal: ${error && error.message ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    });
}

module.exports = { main };
