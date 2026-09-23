'use strict';

// HOW the agentic-workflow digest reads.
//
// Every message keeps a complete text/plain view for phones, logs, and mail
// clients that disable HTML. The richer view is a self-contained HTML
// multipart/alternative companion (the multipart MIME envelope itself is
// built by src/lib/providers/google.js -- this module only produces the two
// bodies): inline CSS + tables only, no remote assets, no scripts, and no
// dynamic markup from local state that has not been HTML-escaped.
//
// The layout below borrows its visual language -- table-based tiles and
// bars, a colour-coded left accent per panel, a hidden inbox preheader, a
// gradient header band with a solid bgcolor fallback -- from the renderer
// the owner already praised (Portfolio Dashboard's app/services/
// email_render.py). Two things are deliberately NOT copied from it, because
// this digest's honesty rules outrank house style:
//
//   * A metric with no durable meter renders as a labelled "not recorded"
//     state with its reason, in a dashed, muted tile -- NEVER as 0 and never
//     as a blank tile that reads as zero.
//   * There is no fabricated trend line. This digest has no time-series
//     history to draw a sparkline from -- only a single before/after pair
//     from the last delivered digest -- so that pair is drawn as two
//     labelled bars (a real two-point comparison), never as a smoothed
//     curve implying continuous history that was never recorded.
//
// The rendering rules mirror the collection rules:
//   * DECLARED and OBSERVED get separate, labelled sections with distinct
//     accent colours (violet vs blue) so the two are never visually
//     conflated. Nothing is presented as "the state of the system" without
//     saying where it came from.
//   * A token or cost number appears ONLY when a durable meter recorded it.
//     Otherwise the line says "not recorded" and prints the machine reason
//     the projection supplied. Nothing is inferred, averaged, or estimated
//     into a number that looks measured.
//   * Data gaps are a section, not a silence.
//
// Reading order (both the text and HTML bodies): what changed since the
// last digest, then what is blocked or stale, then the headline metrics --
// because the owner scans this hourly on a phone and those are the three
// things worth a glance before he decides whether to open it further.
//
// R84 ADDED A THIRD VIEW. Every message also carried `telegram` and
// `telegramCaption` -- a short, phone-shaped rendering produced by
// ./render-telegram.js -- built from the same buildQuickMetrics() array as the
// tiles below so the two could never disagree.
//
// BOTH VIEWS WERE REMOVED 2026-08-23, with ./render-telegram.js and the rest of
// the Telegram connector (owner ruling: "you can rip out telegram"). Two views
// remain, `text` and `html`, and they are the pair the surviving email channel
// sends. The honesty rules above are unchanged and still apply to both.

const RUN_STATE_LABEL = Object.freeze({
  queued: 'queued', leased: 'leased', running: 'running', retry_wait: 'retry-wait',
  uncertain: 'uncertain', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled'
});

// The collector gets this aggregate from the same canonical controller
// projection used by the dashboard.  Keep terminal `uncertain` outcomes
// separate from a real `failed` result: HELP_REQUIRED is a safe handoff, not
// a dead worker, and lease expiry is an honestly unknown outcome.
function safeRunOutcomes(runs) {
  const outcomes = runs && runs.outcomes;
  if (!outcomes || outcomes.source !== 'durable-run-lifecycle') return null;
  const keys = ['completed', 'failed', 'cancelled', 'needsHelp', 'outcomeUnknown'];
  if (!keys.every(key => Number.isSafeInteger(outcomes[key]) && outcomes[key] >= 0)) return null;
  return outcomes;
}

function runOutcomeSummary(runs) {
  const outcomes = safeRunOutcomes(runs);
  if (!outcomes) return null;
  return `completed ${outcomes.completed}, failed ${outcomes.failed}, cancelled ${outcomes.cancelled}, ` +
    `needs help ${outcomes.needsHelp}, outcome unknown ${outcomes.outcomeUnknown}`;
}

function runOutcomeAlerts(runs) {
  const outcomes = safeRunOutcomes(runs);
  if (!outcomes) return [];
  const alerts = [];
  if (outcomes.needsHelp) alerts.push(`${outcomes.needsHelp} durable run(s) safely stopped and requested help; they are not active or stale.`);
  if (outcomes.outcomeUnknown) alerts.push(`${outcomes.outcomeUnknown} durable run(s) have an unknown terminal outcome after lease expiry or an unobserved completion.`);
  if (outcomes.failed) alerts.push(`${outcomes.failed} durable run(s) recorded a terminal failure.`);
  return alerts;
}

function pad2(value) { return String(value).padStart(2, '0'); }

function localStamp(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function heading(title) {
  return `${title}\n${'-'.repeat(Math.min(title.length, 72))}`;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

// A meter line never prints a number the ledger did not record -- and that now
// includes the operation counts themselves. A provider nothing has measured
// sends `operationCount: null`, and printing that as `ops 0` would tell the
// owner the provider sat idle when the truth is that no source ever looked.
function meterLine(meter) {
  const parts = meter.operationCount === null
    ? [`${meter.provider.padEnd(8)} operations not recorded (${meter.operationUnavailableReason || meter.operationMeterState})`]
    : [
      `${meter.provider.padEnd(8)} ops ${meter.operationCount}`,
      `ok ${meter.completedCount}`,
      `fail ${meter.failedCount}`,
      `timeout ${meter.timeoutCount}`,
      `blocked ${meter.blockedCount}`
    ];
  parts.push(meter.reportedTokenCount === null
    ? `tokens not recorded (${meter.tokenMeterState})`
    : `tokens ${meter.reportedTokenCount} (provider-reported)`);
  parts.push(meter.costMicros === null
    ? `cost not recorded (${meter.costMeterState})`
    : `cost ${(meter.costMicros / 1_000_000).toFixed(4)} USD-equivalent (${meter.costMeterState})`);
  return `  ${parts.join(' · ')}`;
}

function renderDelta(delta) {
  if (!delta || delta.available !== true) {
    return `${heading('SINCE THE LAST DIGEST')}\n  No previous digest recorded, so nothing can be compared. ` +
      `Reason: ${delta && delta.reason ? delta.reason : 'unknown'}.`;
  }
  const lines = [heading(`SINCE THE LAST DIGEST (${delta.since || 'unknown time'})`)];
  lines.push(delta.auditEventsSince === null
    ? '  Audit events since: not comparable (the ledger head moved backwards or is unavailable).'
    : `  Signed audit events recorded since: ${delta.auditEventsSince}`);
  if (delta.queueDepthBefore !== null && delta.queueDepthAfter !== null) {
    const change = delta.queueDepthAfter - delta.queueDepthBefore;
    lines.push(`  Queue depth: ${delta.queueDepthBefore} -> ${delta.queueDepthAfter} (${signed(change)})`);
  }
  if (delta.activeRunsBefore !== null && delta.activeRunsAfter !== null) {
    lines.push(`  Active durable runs: ${delta.activeRunsBefore} -> ${delta.activeRunsAfter}`);
  }
  if (delta.movedPhases.length) {
    lines.push('  Phases that moved:');
    for (const phase of delta.movedPhases.slice(0, 20)) lines.push(`    ${phase.id}: ${phase.from} -> ${phase.to}`);
  } else {
    lines.push('  Phases that moved: none');
  }
  if (delta.agentChanges.length) {
    lines.push('  Observed agent-state changes:');
    for (const change of delta.agentChanges) lines.push(`    ${change.alias}: ${change.from} -> ${change.to}`);
  }
  return lines.join('\n');
}

function renderDeclared(declared) {
  if (!declared) return `${heading('DECLARED ORG (owner-authored intent)')}\n  Unavailable -- see DATA GAPS.`;
  const lines = [heading(`DECLARED ORG (owner-authored intent, ${declared.source} rev ${declared.revision ?? '?'})`)];
  lines.push('  This section states who the owner SAYS is who. It is intent, not activity,');
  lines.push('  and it grants no authority.');
  for (const agent of declared.agents) {
    const phase = agent.assignedPhase ? ` · phase ${agent.assignedPhase}` : '';
    lines.push(`    ${agent.displayName} (${agent.id}) — ${agent.role} on ${agent.provider} · ${agent.enabled ? 'enabled' : 'disabled'}${phase}`);
  }
  const manages = declared.relationships.filter(edge => edge.type === 'manages').map(edge => `${edge.from}->${edge.to}`);
  if (manages.length) lines.push(`    manages: ${manages.join(', ')}`);
  return lines.join('\n');
}

function renderObserved(observed) {
  const lines = [heading('OBSERVED (derived from the signed audit ledger)')];
  lines.push(`  Ledger: ${observed.auditState} · provenance ${observed.provenance.state} · freshness ${observed.freshness}`);
  lines.push(`  Head sequence ${observed.provenance.headSequence} · ${observed.eventsInWindow} event(s) in the read window`);
  lines.push(`  Worker lifecycle: ${observed.lifecycle}`);
  lines.push('  Observed agent lanes (projection roles, not the declared names above):');
  for (const agent of observed.agents) {
    lines.push(`    ${agent.alias.padEnd(12)} ${agent.agentKind.padEnd(12)} ${agent.state}`);
  }
  const phases = observed.phases.map(phase => `${phase.safeLabel}=${phase.state}`).join(', ');
  lines.push(`  Projection phases in flight: ${phases || 'none'}`);
  const runs = observed.runs;
  // summarizeRuns answers {available:false, byStatus:null} when no durable-run
  // control adapter is configured; that gap must render, not crash.
  if (!runs || runs.available !== true) {
    lines.push('  Durable runs: Unavailable -- see DATA GAPS.');
  } else {
    const byStatus = Object.entries(runs.byStatus)
      .filter(([status]) => status !== 'uncertain')
      .map(([status, count]) => `${RUN_STATE_LABEL[status] || status} ${count}`).join(', ');
    lines.push(`  Durable runs: ${runs.total} total, ${runs.active} active${byStatus ? ` (${byStatus})` : ''}`);
    const outcomeSummary = runOutcomeSummary(runs);
    if (outcomeSummary) lines.push(`  Durable-run terminal outcomes: ${outcomeSummary}.`);
    if (runs.openHelp) lines.push(`  Open durable-run help requests: ${runs.openHelp} -- these wait on a human or another agent.`);
  }
  // collect answers null here when no provider cache is configured; the gap
  // must render, not crash, and must not read as "none reported".
  if (observed.providerControls === null || observed.providerControls === undefined) {
    lines.push('  Provider controls: Unavailable -- see DATA GAPS.');
  } else {
    const controls = observed.providerControls.map(row => `${row.provider}=${row.status}`).join(', ');
    lines.push(`  Provider controls: ${controls || 'none reported'}`);
  }
  return lines.join('\n');
}

function renderMeters(meters) {
  const lines = [heading('PROVIDER / TOOL METERS')];
  lines.push(`  Meter source state: ${meters.state}`);
  if (meters.unavailableReason) lines.push(`  Reason no meter is available: ${meters.unavailableReason}`);
  if (meters.skippedCount) lines.push(`  Meter records skipped as unparseable: ${meters.skippedCount}`);
  lines.push(`  Subscription usage: ${meters.subscriptionUsage}`);
  lines.push(`  Savings accounting: ${meters.savingsState}`);
  for (const meter of meters.providers) lines.push(meterLine(meter));
  lines.push('  Any "not recorded" above is the literal truth: no durable meter record exists');
  lines.push('  for it in this window. No token or cost figure in this digest is estimated.');
  const waste = meters.waste;
  lines.push(`  Retries/failures ${waste.retryOrFailureCount} · duplicate reviews ${waste.duplicateReviewCount} · ` +
    `cache misses ${waste.cacheMissCount} · measured evidence ${waste.measuredEvidenceCount} (${waste.sourceState})`);
  return lines.join('\n');
}

function renderQueue(queue) {
  if (!queue) return `${heading('QUEUE (BUILD-QUEUE.md)')}\n  Unavailable -- see DATA GAPS.`;
  const lines = [heading(`QUEUE (${queue.source}, declared)`)];
  lines.push(`  Depth (phases not DONE): ${queue.depth} of ${queue.phases.length} tracked`);
  lines.push(`  ${Object.entries(queue.counts).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`).join(' · ')}`);
  if (queue.inFlight.length) lines.push(`  In flight: ${queue.inFlight.join(', ')}`);
  if (queue.open.length) lines.push(`  Open: ${queue.open.join(', ')}`);
  return lines.join('\n');
}

function renderBlocked(state) {
  const lines = [heading('BLOCKED OR STALE')];
  let any = false;
  let complete = true;
  if (!state.queue) {
    complete = false;
    lines.push('  Queue blocked status is unavailable -- see DATA GAPS.');
  }
  if (!Array.isArray(state.observed?.runs?.stale)) {
    complete = false;
    lines.push('  Observed stale-run status is unavailable -- see DATA GAPS.');
  }
  if (!Array.isArray(state.observed?.providerControls)) {
    complete = false;
    lines.push('  Observed provider status is unavailable -- see DATA GAPS.');
  }
  if (state.queue && state.queue.blocked.length) {
    any = true;
    for (const id of state.queue.blocked) {
      const phase = state.queue.phases.find(row => row.id === id);
      lines.push(`  ${id} BLOCKED — ${phase && phase.detail ? phase.detail : 'no reason recorded'}`);
    }
  }
  const stale = state.observed?.runs?.stale || [];
  for (const run of stale) {
    any = true;
    lines.push(`  Durable run ${run.runId} is ${run.status} but has not moved for ${duration(run.ageMs)}.`);
  }
  for (const alert of runOutcomeAlerts(state.observed?.runs)) {
    any = true;
    lines.push(`  ${alert}`);
  }
  const blockedProviders = (state.observed?.providerControls || []).filter(row =>
    ['sign_in_required', 'rate_limited', 'billing_required', 'verification_failed'].includes(row.status));
  for (const provider of blockedProviders) {
    any = true;
    lines.push(`  Provider ${provider.provider} is ${provider.status}.`);
  }
  if (!any && complete) lines.push('  Nothing is recorded as blocked or stale.');
  return lines.join('\n');
}

function renderGaps(gaps) {
  const lines = [heading('DATA GAPS')];
  if (!gaps || !gaps.length) {
    lines.push('  None. Every source this digest reads was readable.');
    return lines.join('\n');
  }
  for (const gap of gaps) lines.push(`  ${gap.source}: ${gap.reason}`);
  return lines.join('\n');
}

function hasGap(state, source) {
  return Array.isArray(state && state.gaps) && state.gaps.some(gap => gap && gap.source === source);
}

function previousFailureDetails(previousFailure) {
  if (!previousFailure) return null;
  const count = Number.isSafeInteger(previousFailure.consecutiveFailures) && previousFailure.consecutiveFailures > 0
    ? previousFailure.consecutiveFailures : 1;
  const channel = typeof previousFailure.channel === 'string' ? previousFailure.channel : 'owner channel';
  const code = typeof previousFailure.code === 'string' ? previousFailure.code : 'error';
  const when = Number.isSafeInteger(previousFailure.atMs) ? ` at ${localStamp(previousFailure.atMs)}` : '';
  return { count, channel, code, when };
}

function renderPreviousFailure(previousFailure) {
  const failure = previousFailureDetails(previousFailure);
  if (!failure) return '';
  return `${heading('PREVIOUS DELIVERY FAILED')}\n` +
    `  ${failure.count} consecutive scheduled delivery attempt(s) failed; last failure was ` +
    `${failure.channel} (${failure.code})${failure.when}. This message is the first subsequent report to reach you.`;
}

function htmlPreviousFailure(previousFailure) {
  const failure = previousFailureDetails(previousFailure);
  if (!failure) return '';
  return panel({
    title: 'Previous delivery failed', accent: BAD, badge: pill('delivery gap', 'bad'),
    body: `<p style="margin:2px 0;font-size:13px;color:${TEXT}">` +
      `<strong>${failure.count} consecutive scheduled delivery attempt(s) failed.</strong> Last failure was ` +
      `${htmlEscape(failure.channel)} (${htmlEscape(failure.code)})${htmlEscape(failure.when)}. ` +
      `This message is the first subsequent report to reach you.</p>`
  });
}

// Shared, structured headline numbers so the text QUICK METRICS block and
// the HTML tile grid can never silently disagree about what "the metrics"
// are. `value: null` means genuinely unrecorded/unreadable -- callers must
// render that as an explicit unavailable state, never as 0.
function buildQuickMetrics(state) {
  const queue = state.queue;
  const observed = state.observed || {};
  const meters = observed.meters || {};
  const runs = observed.runs || {};
  const inFlight = queue ? queue.inFlight.length : null;
  const blocked = queue ? queue.blocked.length : null;
  const queueDepth = queue ? queue.depth : null;
  const queueTotal = queue ? queue.phases.length : null;
  const active = Number.isFinite(runs.active) ? runs.active : null;
  const ledger = observed.auditState || null;
  const ledgerTone = ledger === null ? 'unavailable' : ['verified', 'valid'].includes(String(ledger).toLowerCase()) ? 'good' : 'warn';
  return [
    { key: 'inFlight', label: 'In flight', value: inFlight, note: queue ? 'BUILD-QUEUE · declared' : 'BUILD-QUEUE unavailable', tone: inFlight === null ? 'unavailable' : inFlight === 0 ? 'good' : 'info' },
    { key: 'blocked', label: 'Blocked', value: blocked, note: queue ? 'BUILD-QUEUE · declared' : 'BUILD-QUEUE unavailable', tone: blocked === null ? 'unavailable' : blocked === 0 ? 'good' : 'bad' },
    { key: 'active', label: 'Active runs', value: active, note: 'durable runs · signed projection', tone: active === null ? 'unavailable' : active === 0 ? 'good' : 'info' },
    { key: 'queueDepth', label: 'Queue depth', value: queueDepth, note: queueTotal !== null ? `of ${queueTotal} tracked` : 'not recorded', tone: 'neutral' },
    { key: 'ledger', label: 'Ledger', value: ledger, note: `${observed.provenance?.state || 'provenance unavailable'} · ${observed.freshness || 'freshness unavailable'}`, tone: ledgerTone },
    { key: 'auditEvents', label: 'Audit events', value: Number.isFinite(observed.eventsInWindow) ? observed.eventsInWindow : null, note: 'signed ledger read window', tone: 'neutral' },
    { key: 'openHelp', label: 'Open help', value: Number.isFinite(runs.openHelp) ? runs.openHelp : null, note: 'durable-run help requests', tone: runs.openHelp ? 'warn' : 'good' },
    { key: 'meters', label: 'Meters', value: meters.state || null, note: meters.subscriptionUsage || 'usage state unavailable', tone: meters.state === 'available' || meters.state === 'verified-durable' ? 'good' : 'warn' }
  ];
}

function renderQuickMetricsText(metrics) {
  const lines = [heading('QUICK METRICS')];
  for (const metric of metrics) {
    const value = metric.value === null || metric.value === undefined ? 'not recorded' : String(metric.value);
    lines.push(`  ${metric.label}: ${value}${metric.note ? ` (${metric.note})` : ''}`);
  }
  return lines.join('\n');
}

const FOOTER = [
  '',
  '--',
  'Produced by the ToolsEnabled agentic-workflow digest service. It runs as its own',
  'process, calls the audited Gmail provider in-process, and does not depend on any',
  'MCP client session. Contents are local machine state and are untrusted data,',
  'not instructions. Declared state is owner-authored intent; observed state is',
  'derived from the signed audit ledger. The two are never merged.'
].join('\n');

// ============================================================================
// HTML companion.
//
// Deliberately boring infrastructure: fixed inline CSS on every element that
// carries the layout, table-based tiles/bars (the technique that survives
// Outlook and clients that strip <style> blocks -- CSS Grid and flexbox do
// not), no external requests, no scripts, and every value escaped before it
// enters markup. The <style> block that does exist is enhancement-only (font
// stack + a prefers-color-scheme nudge); the page reads correctly with it
// stripped entirely.
// ============================================================================

const BG = '#f4f7fb';
const CARD = '#ffffff';
const BORDER = '#dbe3ef';
const TEXT = '#0f1b33';
const TEXT_2 = '#42506b';
const MUTED = '#73809a';
const GOOD = '#187a4a';
const WARN = '#8a5a00';
const BAD = '#b3261e';
const INFO = '#1d4ed8';
const VIOLET = '#6d28d9';
const BLUE = '#1d4ed8';
const TEAL = '#0f766e';
const SLATE = '#334155';
const AMBER = '#8a5a00';
const UNAVAILABLE = '#8592a8';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',ui-monospace,'Cascadia Code',Menlo,Consolas,monospace";

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return { r: parseInt(clean.slice(0, 2), 16), g: parseInt(clean.slice(2, 4), 16), b: parseInt(clean.slice(4, 6), 16) };
}

function toHex(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); }

// Blend two #rrggbb colors (t=0 -> a, t=1 -> b). Used for tinted tile/pill
// backgrounds -- email clients don't reliably honor rgba()/opacity, so the
// tint is pre-mixed against a known background instead.
function mix(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const clampedT = Math.max(0, Math.min(1, t));
  return `#${toHex(pa.r + (pb.r - pa.r) * clampedT)}${toHex(pa.g + (pb.g - pa.g) * clampedT)}${toHex(pa.b + (pb.b - pa.b) * clampedT)}`;
}

function toneColor(tone) {
  switch (tone) {
    case 'good': return GOOD;
    case 'warn': return WARN;
    case 'bad': return BAD;
    case 'info': return INFO;
    case 'unavailable': return UNAVAILABLE;
    default: return TEXT_2;
  }
}

function pill(text, tone) {
  const color = toneColor(tone);
  return `<span style="display:inline-block;background:${mix(color, '#ffffff', 0.85)};color:${color};` +
    `font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:20px;white-space:nowrap">` +
    `${htmlEscape(text)}</span>`;
}

// One metric tile. `value === null` is rendered as an explicit "not
// recorded" state in a dashed border and a muted color -- never as 0 and
// never as a tile that merely looks empty.
function tile(metric) {
  const unavailable = metric.value === null || metric.value === undefined;
  const color = unavailable ? UNAVAILABLE : toneColor(metric.tone);
  const border = unavailable ? `1px dashed ${mix(UNAVAILABLE, '#ffffff', 0.3)}` : `1px solid ${BORDER}`;
  const displayValue = unavailable ? 'not recorded' : String(metric.value);
  return `<td width="25%" valign="top" style="padding:5px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:${border};border-radius:10px">` +
    `<tr><td style="padding:10px 11px">` +
    `<div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${htmlEscape(metric.label)}</div>` +
    `<div style="font-family:${MONO};font-size:${unavailable ? 13 : 19}px;font-weight:700;color:${color};margin-top:4px;word-break:break-word">${htmlEscape(displayValue)}</div>` +
    (metric.note ? `<div style="font-size:10px;color:${MUTED};margin-top:4px">${htmlEscape(metric.note)}</div>` : '') +
    `</td></tr></table></td>`;
}

function tileGrid(metrics, cols = 4) {
  if (!metrics.length) return '';
  const padWidthPct = (100 / cols).toFixed(2);
  const rows = [];
  for (let index = 0; index < metrics.length; index += cols) {
    const chunk = metrics.slice(index, index + cols);
    const padding = `<td width="${padWidthPct}%"></td>`.repeat(cols - chunk.length);
    rows.push(`<tr>${chunk.map(tile).join('')}${padding}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:-5px">${rows.join('')}</table>`;
}

// A titled panel with a coloured left accent bar, so DECLARED (violet),
// OBSERVED (blue), and every other section stay visually distinct at a
// glance -- never merged into one undifferentiated grey block.
function panel({ title, subtitle, accent, body, badge = '' }) {
  if (!body) return '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;background:${CARD};border:1px solid ${BORDER};border-radius:12px;overflow:hidden">
      <tr>
        <td width="4" style="background:${accent};font-size:0;line-height:0">&nbsp;</td>
        <td style="padding:14px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:15px;font-weight:700;color:${TEXT}">${htmlEscape(title)}</td>
            ${badge ? `<td align="right">${badge}</td>` : ''}
          </tr></table>
          ${subtitle ? `<div style="font-size:11px;color:${MUTED};margin:2px 0 10px">${htmlEscape(subtitle)}</div>` : '<div style="height:8px;font-size:0;line-height:0">&nbsp;</div>'}
          ${body}
        </td>
      </tr>
    </table>`;
}

function listBlock(items, empty) {
  if (!items.length) return `<p style="margin:2px 0;color:${MUTED};font-size:13px">${htmlEscape(empty)}</p>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    items.map((row, index) => `<tr><td style="padding:6px 0;font-size:13px;color:${TEXT};line-height:1.45${index < items.length - 1 ? `;border-bottom:1px solid ${BORDER}` : ''}">${row}</td></tr>`).join('') +
    '</table>';
}

// A stacked ops bar from REAL observed counts (ok/failed/timeout/blocked).
// This is not a fabricated visualization -- every segment is a durable
// count the projection already produced; a provider with zero ops this
// window says so in words instead of drawing an empty bar.
function opsBar(meter) {
  // "Nothing measured this provider" and "this provider did nothing" are
  // different facts and get different words. Collapsing them was the whole
  // defect.
  if (meter.operationCount === null) {
    return `<div style="font-size:12px;color:${UNAVAILABLE};margin-top:4px">Operations not recorded (${htmlEscape(String(meter.operationUnavailableReason || meter.operationMeterState))}).</div>`;
  }
  const total = meter.operationCount;
  if (!total) return `<div style="font-size:12px;color:${MUTED};margin-top:4px">No operations recorded this window.</div>`;
  const segments = [
    { n: meter.completedCount, color: GOOD, label: 'ok' },
    { n: meter.failedCount, color: BAD, label: 'fail' },
    { n: meter.timeoutCount, color: WARN, label: 'timeout' },
    { n: meter.blockedCount, color: SLATE, label: 'blocked' }
  ].filter(segment => segment.n > 0);
  const cells = segments.map((segment, index) => {
    const radius = index === 0 ? 'border-radius:5px 0 0 5px' : index === segments.length - 1 ? 'border-radius:0 5px 5px 0' : '';
    return `<td width="${(segment.n / total * 100).toFixed(2)}%" style="background:${segment.color};height:9px;font-size:0;line-height:0;${radius}">&nbsp;</td>`;
  }).join('');
  const legend = segments.map(segment =>
    `<span style="display:inline-block;margin:5px 10px 0 0;font-size:11px;color:${TEXT_2};white-space:nowrap">` +
    `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${segment.color};vertical-align:middle;margin-right:4px"></span>` +
    `${htmlEscape(segment.label)} ${segment.n}</span>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:5px;overflow:hidden;margin-top:6px"><tr>${cells}</tr></table>` +
    `<div style="margin-top:2px">${legend}</div>`;
}

function meterCard(meter) {
  const tokenLine = meter.reportedTokenCount === null
    ? `<span style="color:${UNAVAILABLE}">Tokens not recorded (${htmlEscape(meter.tokenMeterState)})</span>`
    : `<span style="color:${TEXT};font-weight:600">Tokens ${htmlEscape(String(meter.reportedTokenCount))}</span> <span style="color:${MUTED}">(provider-reported)</span>`;
  const costLine = meter.costMicros === null
    ? `<span style="color:${UNAVAILABLE}">Cost not recorded (${htmlEscape(meter.costMeterState)})</span>`
    : `<span style="color:${TEXT};font-weight:600">${htmlEscape((meter.costMicros / 1_000_000).toFixed(4))} USD-equivalent</span> <span style="color:${MUTED}">(${htmlEscape(meter.costMeterState)})</span>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};border:1px solid ${BORDER};border-radius:10px;margin:8px 0"><tr><td style="padding:10px 12px">` +
    `<div style="font-family:${MONO};font-size:13px;font-weight:700;color:${TEXT};text-transform:uppercase;letter-spacing:.03em">${htmlEscape(meter.provider)}</div>` +
    `<div style="font-size:11px;color:${MUTED};margin-top:2px">${meter.operationCount === null
      ? 'operations not recorded'
      : `ops ${meter.operationCount} · ok ${meter.completedCount} · fail ${meter.failedCount} · timeout ${meter.timeoutCount} · blocked ${meter.blockedCount}`}</div>` +
    opsBar(meter) +
    `<div style="font-size:12px;margin-top:7px">${tokenLine}</div>` +
    `<div style="font-size:12px;margin-top:3px">${costLine}</div>` +
    '</td></tr></table>';
}

// A real two-point before/after comparison (never a smoothed trend -- this
// digest has no time-series history, only the single prior fingerprint).
function twoPointBars(labelBefore, before, labelAfter, after, color) {
  const max = Math.max(Math.abs(before), Math.abs(after), 1);
  const row = (label, value) => {
    const pct = Math.max(3, Math.min(100, Math.abs(value) / max * 100));
    return `<tr>
      <td width="46" style="padding:3px 8px 3px 0;font-size:11px;color:${MUTED};white-space:nowrap">${htmlEscape(label)}</td>
      <td style="padding:3px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};border-radius:4px"><tr>
          <td width="${pct.toFixed(1)}%" style="background:${color};height:8px;border-radius:4px;font-size:0;line-height:0">&nbsp;</td>
          <td style="font-size:0;line-height:0">&nbsp;</td>
        </tr></table>
      </td>
      <td width="34" align="right" style="padding:3px 0 3px 8px;font-family:${MONO};font-size:11px;color:${TEXT_2}">${htmlEscape(String(value))}</td>
    </tr>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row(labelBefore, before)}${row(labelAfter, after)}</table>`;
}

function htmlDelta(delta) {
  if (!delta || delta.available !== true) {
    const reason = delta && delta.reason ? delta.reason : 'unknown';
    return `<p style="margin:2px 0;color:${MUTED};font-size:13px">No previous digest recorded, so nothing can be compared. Reason: ${htmlEscape(reason)}.</p>`;
  }
  const parts = [];
  parts.push(`<p style="margin:2px 0 10px;font-size:12px;color:${MUTED}">Compared with ${htmlEscape(delta.since || 'the previous digest')}.</p>`);
  parts.push(`<p style="margin:4px 0;font-size:13px;color:${TEXT}">Signed audit events since: <strong>${delta.auditEventsSince === null ? 'not comparable' : htmlEscape(String(delta.auditEventsSince))}</strong></p>`);
  if (delta.queueDepthBefore !== null && delta.queueDepthAfter !== null) {
    const change = delta.queueDepthAfter - delta.queueDepthBefore;
    parts.push(`<div style="margin:10px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Queue depth (${htmlEscape(signed(change))})</div>`);
    parts.push(twoPointBars('before', delta.queueDepthBefore, 'now', delta.queueDepthAfter, change > 0 ? WARN : change < 0 ? GOOD : MUTED));
  }
  if (delta.activeRunsBefore !== null && delta.activeRunsAfter !== null) {
    parts.push(`<div style="margin:10px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Active durable runs</div>`);
    parts.push(twoPointBars('before', delta.activeRunsBefore, 'now', delta.activeRunsAfter, INFO));
  }
  const phaseRows = delta.movedPhases.slice(0, 20).map(phase => {
    const toneColorValue = phase.to === 'DONE' ? GOOD : phase.to === 'BLOCKED' ? BAD : phase.to === 'removed' ? MUTED : INFO;
    return `<strong style="font-family:${MONO}">${htmlEscape(phase.id)}</strong> <span style="color:${MUTED}">${htmlEscape(phase.from)} &rarr;</span> <span style="color:${toneColorValue};font-weight:600">${htmlEscape(phase.to)}</span>`;
  });
  parts.push(`<div style="margin:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Phases that moved</div>`);
  parts.push(listBlock(phaseRows, 'none'));
  if (delta.agentChanges.length) {
    const agentRows = delta.agentChanges.map(change =>
      `<strong>${htmlEscape(change.alias)}</strong> <span style="color:${MUTED}">${htmlEscape(change.from)} &rarr; ${htmlEscape(change.to)}</span>`);
    parts.push(`<div style="margin:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Observed agent-state changes</div>`);
    parts.push(listBlock(agentRows, 'none'));
  }
  return parts.join('');
}

function htmlBlocked(state) {
  const rows = [];
  if (!state.queue) rows.push(`<span style="color:${UNAVAILABLE}">Queue blocked status is unavailable; see DATA GAPS.</span>`);
  if (!Array.isArray(state.observed?.runs?.stale)) rows.push(`<span style="color:${UNAVAILABLE}">Observed stale-run status is unavailable; see DATA GAPS.</span>`);
  if (!Array.isArray(state.observed?.providerControls)) rows.push(`<span style="color:${UNAVAILABLE}">Observed provider status is unavailable; see DATA GAPS.</span>`);
  if (state.queue && state.queue.blocked.length) {
    for (const id of state.queue.blocked) {
      const phase = state.queue.phases.find(row => row.id === id);
      rows.push(`<strong style="font-family:${MONO};color:${BAD}">${htmlEscape(id)}</strong> BLOCKED &mdash; ${htmlEscape(phase && phase.detail ? phase.detail : 'no reason recorded')}`);
    }
  }
  const stale = state.observed?.runs?.stale || [];
  for (const run of stale) {
    rows.push(`Durable run <strong style="font-family:${MONO}">${htmlEscape(run.runId)}</strong> is ${htmlEscape(run.status)} but has not moved for ${htmlEscape(duration(run.ageMs))}.`);
  }
  for (const alert of runOutcomeAlerts(state.observed?.runs)) rows.push(htmlEscape(alert));
  const blockedProviders = (state.observed?.providerControls || []).filter(row =>
    ['sign_in_required', 'rate_limited', 'billing_required', 'verification_failed'].includes(row.status));
  for (const provider of blockedProviders) {
    rows.push(`Provider <strong>${htmlEscape(provider.provider)}</strong> is ${htmlEscape(provider.status)}.`);
  }
  if (!rows.length) {
    return `<p style="margin:2px 0;font-size:13px;color:${GOOD}">Nothing is recorded as blocked or stale.</p>`;
  }
  return listBlock(rows, 'Nothing is recorded as blocked or stale.');
}

function htmlDeclared(declared) {
  if (!declared) return `<p style="margin:2px 0;color:${MUTED};font-size:13px">Unavailable; see DATA GAPS.</p>`;
  const rows = declared.agents.map(agent => {
    const phase = agent.assignedPhase ? ` &middot; phase ${htmlEscape(agent.assignedPhase)}` : '';
    return `<strong>${htmlEscape(agent.displayName)}</strong> <span style="color:${MUTED}">(${htmlEscape(agent.id)})</span> &mdash; ${htmlEscape(agent.role)} on ${htmlEscape(agent.provider)} &middot; ${agent.enabled ? `<span style="color:${GOOD}">enabled</span>` : `<span style="color:${MUTED}">disabled</span>`}${phase}`;
  });
  const manages = declared.relationships.filter(edge => edge.type === 'manages').map(edge => `${htmlEscape(edge.from)}&rarr;${htmlEscape(edge.to)}`);
  return `<p style="margin:2px 0 10px;font-size:12px;color:${MUTED}">This is owner-authored intent, revision ${htmlEscape(String(declared.revision ?? '?'))}. It is intent, not activity, and it grants no authority.</p>` +
    listBlock(rows, 'No declared agents.') +
    (manages.length ? `<p style="margin:10px 0 0;font-size:12px;color:${MUTED}">manages: ${manages.join(', ')}</p>` : '');
}

function htmlObserved(observed) {
  const agentRows = (Array.isArray(observed.agents) ? observed.agents : []).map(agent =>
    `<strong>${htmlEscape(agent.alias)}</strong> <span style="color:${MUTED}">${htmlEscape(agent.agentKind)}</span> &middot; ${htmlEscape(agent.state)}`);
  const providerRows = (Array.isArray(observed.providerControls) ? observed.providerControls : []).map(row => {
    const bad = ['sign_in_required', 'rate_limited', 'billing_required', 'verification_failed'].includes(row.status);
    return `<strong>${htmlEscape(row.provider)}</strong> &middot; <span style="color:${bad ? BAD : GOOD}">${htmlEscape(row.status)}</span>`;
  });
  const outcomeSummary = runOutcomeSummary(observed.runs);
  return `<p style="margin:2px 0 10px;font-size:12px;color:${MUTED}">Ledger ${htmlEscape(observed.auditState)} &middot; provenance ${htmlEscape(observed.provenance.state)} &middot; freshness ${htmlEscape(observed.freshness)} &middot; Worker lifecycle <strong>${htmlEscape(observed.lifecycle)}</strong>.</p>` +
    `<div style="margin:8px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Observed agent lanes</div>` +
    listBlock(agentRows, 'No observed agent lanes recorded.') +
    (outcomeSummary
      ? `<div style="margin:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Durable-run terminal outcomes</div>${listBlock([htmlEscape(outcomeSummary)], 'Not recorded.')}`
      : '') +
    `<div style="margin:12px 0 4px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">Provider controls</div>` +
    listBlock(providerRows, 'No provider controls reported.');
}

function htmlQueue(queue) {
  if (!queue) return `<p style="margin:2px 0;color:${MUTED};font-size:13px">Unavailable; see DATA GAPS.</p>`;
  const counts = Object.entries(queue.counts).filter(([, count]) => count > 0).map(([status, count]) => `${htmlEscape(status)} ${count}`).join(' &middot; ');
  const rows = [
    `Depth: <strong>${queue.depth}</strong> of ${queue.phases.length} tracked ${counts ? `<span style="color:${MUTED}">(${counts})</span>` : ''}`,
    queue.inFlight.length ? `In flight: ${htmlEscape(queue.inFlight.join(', '))}` : 'In flight: none',
    queue.open.length ? `Open: ${htmlEscape(queue.open.join(', '))}` : 'Open: none',
    queue.blocked.length ? `Blocked: <span style="color:${BAD}">${htmlEscape(queue.blocked.join(', '))}</span>` : 'Blocked: none'
  ];
  return listBlock(rows, 'Queue unavailable; see DATA GAPS.');
}

function htmlGaps(gaps) {
  if (!gaps || !gaps.length) return `<p style="margin:2px 0;font-size:13px;color:${GOOD}">None. Every source this digest reads was readable.</p>`;
  const rows = gaps.map(gap => `<strong>${htmlEscape(gap.source)}</strong> &middot; ${htmlEscape(gap.reason)}`);
  return listBlock(rows, 'None recorded.');
}

const HEAD_STYLE = [
  `body,table,td,div,p,h1,h2,span,strong,em{font-family:${FONT}}`,
  // Enhancement only: a dark-mode nudge for clients that honor it. Every
  // element above already carries a working inline light-theme colour, so
  // this block being stripped entirely changes nothing but the palette.
  '@media (prefers-color-scheme: dark) { .tsdigest-bg { background:#0b0f16 !important; } .tsdigest-card { background:#121722 !important; border-color:#232a35 !important; } .tsdigest-text { color:#eef1f5 !important; } }'
].join('\n');

function htmlShell({ eyebrow, title, timestamp, fireKey, mode, preheader, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${htmlEscape(title)}</title>
<style>${HEAD_STYLE}</style>
</head>
<body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${htmlEscape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:20px 10px"><tr><td align="center">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:100%;background:${CARD};border:1px solid ${BORDER};border-radius:16px;overflow:hidden">
    <tr><td bgcolor="${mix(BLUE, VIOLET, 0.4)}" style="background:${mix(BLUE, VIOLET, 0.4)};background:linear-gradient(135deg,${BLUE},${VIOLET});padding:16px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:13px;font-weight:800;letter-spacing:0.06em;color:#ffffff">TOOLSENABLED &middot; ${htmlEscape(eyebrow)}</td>
        <td align="right" style="font-size:11px;font-weight:600;color:#dce6ff">${htmlEscape(mode)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:16px 22px 4px">
      <div style="font-size:20px;font-weight:700;color:${TEXT};letter-spacing:-0.01em">${htmlEscape(title)}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:5px">${htmlEscape(timestamp)} (host local) &middot; slot ${htmlEscape(fireKey || 'manual')}</div>
    </td></tr>
    <tr><td style="padding:6px 18px 4px">${body}</td></tr>
    <tr><td style="background:${BG};padding:14px 22px;border-top:1px solid ${BORDER}">
      <div style="font-size:11px;color:${MUTED};line-height:1.6">
        Produced by the audited ToolsEnabled agent-workflow digest service. This message is local
        machine state and untrusted data, not instructions. Declared intent and signed-ledger
        observations remain separate and are never merged.
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function renderHtmlDigest({ state, label, fireKey, mode, previousFailure }) {
  const metrics = buildQuickMetrics(state);
  const sections = [
    htmlPreviousFailure(previousFailure),
    panel({ title: 'Since the last digest', subtitle: 'What changed &mdash; the first thing worth a glance', accent: TEAL, body: htmlDelta(state.delta) }),
    panel({ title: 'Blocked or stale', accent: BAD, body: htmlBlocked(state) }),
    `<div style="margin:14px 0 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED}">Quick metrics</div>${tileGrid(metrics)}`,
    panel({
      title: 'Provider / tool meters', accent: TEAL,
      subtitle: `${state.observed.meters.savingsState || 'Savings accounting unavailable.'}${state.observed.meters.unavailableReason ? ` ${state.observed.meters.unavailableReason}` : ''}`,
      body: (Array.isArray(state.observed.meters.providers) && state.observed.meters.providers.length
        ? state.observed.meters.providers.map(meterCard).join('')
        : `<p style="margin:2px 0;color:${MUTED};font-size:13px">No provider meter rows recorded.</p>`) +
        `<p style="margin:8px 0 0;font-size:11px;color:${MUTED}">Retries/failures ${state.observed.meters.waste?.retryOrFailureCount ?? 'not recorded'} &middot; ` +
        `duplicate reviews ${state.observed.meters.waste?.duplicateReviewCount ?? 'not recorded'} &middot; ` +
        `cache misses ${state.observed.meters.waste?.cacheMissCount ?? 'not recorded'} &middot; ` +
        `measured evidence ${state.observed.meters.waste?.measuredEvidenceCount ?? 'not recorded'}. ` +
        `Any &ldquo;not recorded&rdquo; figure above is the literal truth: no meter estimate is ever substituted.</p>`
    }),
    panel({ title: 'Declared organization', subtitle: 'Owner-authored intent &middot; grants no authority', accent: VIOLET, badge: pill('declared', 'neutral'), body: htmlDeclared(state.declared) }),
    panel({ title: 'Observed workflow', subtitle: 'Derived from the signed audit ledger', accent: BLUE, badge: pill('observed', 'info'), body: htmlObserved(state.observed) }),
    panel({ title: 'Queue', subtitle: 'BUILD-QUEUE.md &middot; declared work list', accent: SLATE, body: htmlQueue(state.queue) }),
    panel({ title: 'Data gaps', subtitle: 'Unreadable sources are named, never hidden', accent: AMBER, body: htmlGaps(state.gaps) })
  ].filter(Boolean).join('');
  const preheader = `${state.queue ? state.queue.inFlight.length : '?'} in flight, ${state.queue ? state.queue.blocked.length : '?'} blocked, ` +
    `${hasGap(state, 'durable-runs') ? '?' : (state.observed?.runs?.active ?? '?')} active runs.`;
  return htmlShell({
    eyebrow: label, title: `Agentic workflow ${label.toLowerCase()}`, timestamp: localStamp(state.observedAtMs),
    fireKey, mode: `generation ${mode}`, preheader, body: sections
  });
}

function renderHtmlFallback({ state, label, fireKey, previousFailure }) {
  const queue = state.queue;
  const known = [
    state.auditStatus ? `Signed audit head: <strong style="font-family:${MONO}">${htmlEscape(String(state.auditStatus.headSequence))}</strong>` : 'Signed audit ledger: unreadable.',
    queue ? `In flight: ${htmlEscape(queue.inFlight.join(', ') || 'none recorded')}` : 'In flight: unreadable.',
    queue ? `Blocked: ${htmlEscape(queue.blocked.join(', ') || 'none recorded')}` : 'Blocked: unreadable.',
    queue ? `Queue depth: <strong>${queue.depth}</strong> of ${queue.phases.length} tracked` : 'Queue depth: unreadable.'
  ];
  const metrics = [
    { label: 'Snapshot', value: 'degraded', note: 'full generation did not complete', tone: 'warn' },
    { label: 'Queue depth', value: queue ? queue.depth : null, note: 'BUILD-QUEUE · declared', tone: queue ? 'info' : 'unavailable' },
    { label: 'In flight', value: queue ? queue.inFlight.length : null, note: 'cheap fallback read', tone: 'neutral' },
    { label: 'Blocked', value: queue ? queue.blocked.length : null, note: 'cheap fallback read', tone: queue?.blocked?.length ? 'warn' : 'good' }
  ];
  const body = [
    htmlPreviousFailure(previousFailure),
    panel({
      title: 'Why this is a snapshot', accent: WARN,
      body: `<p style="margin:2px 0;font-size:13px;color:${TEXT}">The full read did not complete: <strong>${htmlEscape(state.degradedReason || 'reason not recorded')}</strong>.</p>` +
        `<p style="margin:6px 0 0;font-size:12px;color:${MUTED}">The scheduled slot still sends, by design, so a silent digest never gets mistaken for a quiet system. Everything below is read directly and cheaply.</p>`
    }),
    `<div style="margin:14px 0 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED}">What is still known</div>${tileGrid(metrics)}`,
    panel({ title: 'What is still known', accent: SLATE, body: listBlock(known, 'Nothing recorded.') }),
    panel({ title: 'Not in this snapshot', accent: MUTED, body: `<p style="margin:2px 0;font-size:13px;color:${TEXT}">Provider/tool meters, observed agent lanes, and the since-last-digest comparison are deliberately omitted rather than guessed.</p>` }),
    panel({ title: 'Declared organization', subtitle: 'Owner-authored intent &middot; grants no authority', accent: VIOLET, badge: pill('declared', 'neutral'), body: htmlDeclared(state.declared) }),
    panel({ title: 'Data gaps', subtitle: 'Unreadable sources are named', accent: AMBER, body: htmlGaps(state.gaps) })
  ].filter(Boolean).join('');
  return htmlShell({
    eyebrow: label, title: `Agentic workflow ${label.toLowerCase()} (degraded snapshot)`, timestamp: localStamp(state.observedAtMs),
    fireKey, mode: 'generation fallback', preheader: `Degraded snapshot: ${state.degradedReason || 'reason not recorded'}.`, body
  });
}

function renderDigest({
  state, kind = 'pulse', fireKey = null, mode = 'full',
  dashboardUrl = undefined, previousFailure = null
} = {}) {
  const label = kind === 'digest' ? 'DIGEST' : 'PULSE';
  const inFlight = state.queue ? state.queue.inFlight.length : 'unknown';
  const blocked = state.queue ? state.queue.blocked.length : 'unknown';
  const runsReadable = !hasGap(state, 'durable-runs');
  const active = runsReadable && Number.isFinite(state.observed?.runs?.active) ? state.observed.runs.active : 'unknown';
  const subject = `Agentic workflow ${label.toLowerCase()} — ${inFlight} in flight · ${blocked} blocked · ` +
    `${active} active run${active === 1 ? '' : 's'} · ${localStamp(state.observedAtMs)}`;
  const metrics = buildQuickMetrics(state);
  const body = [
    `AGENTIC WORKFLOW ${label} — ${localStamp(state.observedAtMs)} (host local)`,
    `Slot ${fireKey || 'manual'} · generation ${mode}`,
    '',
    renderPreviousFailure(previousFailure),
    ...(previousFailure ? [''] : []),
    renderDelta(state.delta),
    '',
    renderBlocked(state),
    '',
    renderQuickMetricsText(metrics),
    '',
    renderMeters(state.observed.meters),
    '',
    renderDeclared(state.declared),
    '',
    renderObserved(state.observed),
    '',
    renderQueue(state.queue),
    '',
    renderGaps(state.gaps),
    FOOTER
  ].join('\n');
  // THE `telegram` AND `telegramCaption` VIEWS WERE REMOVED 2026-08-23 with
  // ./render-telegram.js and the rest of the connector. What is left is the pair
  // the email channel uses -- `text` and `html` -- which is what
  // config/owner-delivery.json now selects. See src/lib/owner-delivery.js for the
  // open question about the phone-shaped IMAGE this digest used to send.
  return {
    subject,
    text: body,
    html: renderHtmlDigest({ state, label, fireKey, mode, previousFailure }),
    kind, mode, fireKey
  };
}

// Invariant 4: a scheduled slot ALWAYS sends. When rich generation fails or
// times out, this data-only snapshot goes out instead, and it says plainly
// that it is degraded and why. The pulse never goes dark.
function renderFallback({
  state, kind = 'pulse', fireKey = null, dashboardUrl = undefined, previousFailure = null
} = {}) {
  const label = kind === 'digest' ? 'DIGEST' : 'PULSE';
  const depth = state.queue ? state.queue.depth : null;
  const subject = `Agentic workflow ${label.toLowerCase()} (degraded snapshot) — ${localStamp(state.observedAtMs)}`;
  const lines = [
    `AGENTIC WORKFLOW ${label} — DEGRADED SNAPSHOT — ${localStamp(state.observedAtMs)} (host local)`,
    `Slot ${fireKey || 'manual'} · generation fallback`,
    '',
    renderPreviousFailure(previousFailure),
    ...(previousFailure ? [''] : []),
    heading('WHY THIS IS A SNAPSHOT'),
    `  The full read did not complete: ${state.degradedReason || 'reason not recorded'}.`,
    '  The scheduled slot still sends, by design, so a silent digest never gets',
    '  mistaken for a quiet system. Everything below is read directly and cheaply.',
    '',
    heading('WHAT IS STILL KNOWN'),
    state.auditStatus
      ? `  Signed audit ledger head sequence: ${state.auditStatus.headSequence}${state.auditStatus.disabled ? ' (auditing disabled)' : ''}`
      : '  Signed audit ledger: unreadable.',
    depth === null ? '  Queue: unreadable.' : `  Queue depth (phases not DONE): ${depth}`,
    !state.queue ? '  In flight: unreadable.' : state.queue.inFlight.length ? `  In flight: ${state.queue.inFlight.join(', ')}` : '  In flight: none recorded',
    !state.queue ? '  Blocked: unreadable.' : state.queue.blocked.length ? `  Blocked: ${state.queue.blocked.join(', ')}` : '  Blocked: none recorded',
    state.declared
      ? `  Declared agents (owner intent, rev ${state.declared.revision ?? '?'}): ` +
        state.declared.agents.map(agent => `${agent.id}=${agent.enabled ? 'enabled' : 'disabled'}`).join(', ')
      : '  Declared agents: unreadable.',
    '',
    heading('NOT IN THIS SNAPSHOT'),
    '  Provider and tool meters, observed agent lanes, and the since-last-digest',
    '  delta are omitted rather than guessed. No token or cost figure is estimated.',
    '',
    renderGaps(state.gaps),
    FOOTER
  ];
  const body = lines.join('\n');
  return {
    subject,
    text: body,
    html: renderHtmlFallback({ state, label, fireKey, previousFailure }),
    kind, mode: 'fallback', fireKey
  };
}

// The palette is exported so the phone card in ./render-image.js paints the
// SAME visual language instead of inventing a second one. The metrics it draws
// come from buildQuickMetrics() for the same reason: one source of truth for
// what "the metrics" are, across all three channels.
const PALETTE = Object.freeze({
  BG, CARD, BORDER, TEXT, TEXT_2, MUTED, GOOD, WARN, BAD, INFO,
  VIOLET, BLUE, TEAL, SLATE, AMBER, UNAVAILABLE, FONT, MONO
});

module.exports = {
  PALETTE, buildQuickMetrics, duration, htmlEscape, localStamp, mix, renderDigest, renderFallback
};
