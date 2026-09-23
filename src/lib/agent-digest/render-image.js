'use strict';

// The phone-shaped metrics CARD, and the bounded screenshot of it (R84 append:
// "cant we just generate a nice UI with all the metrics and literrally
// screenshot it to the phone size and send that as the report").
//
// WHY THIS IS NOT A SCREENSHOT OF THE DASHBOARD. Three reasons, each of which
// on its own would rule it out:
//   1. The dashboard is a desktop layout. Shrinking one to fit a phone is
//      exactly the unreadable thing this is supposed to replace.
//   2. The digest is architecturally forbidden from depending on a running
//      service (R46). Screenshotting http://127.0.0.1:3889 would make every
//      report fail whenever the dashboard is down -- precisely when a report
//      matters most.
//   3. It would need the dashboard's auth surface inside the digest process.
// So: same DATA (collect.js -> buildQuickMetrics, one source of truth), same
// visual language (render.js PALETTE, including the dark palette its email
// already ships), laid out natively at phone width.
//
// HONESTY MATTERS MORE HERE, NOT LESS. A screenshot makes a number look
// authoritative and cannot be fact-checked by hovering. So a metric with no
// durable meter is drawn as an explicit dashed "not recorded" tile with its
// machine reason -- never 0, and never an empty tile that reads as zero.
//
// BOUNDEDNESS. This runs on the same laptop as the fleet. The browser is
// launched headless with no profile (never the owner's authenticated
// profile), every network request is aborted so the render is provably
// offline, the whole capture is raced against a hard timeout, and the browser
// is closed in a finally so a failure cannot leave a stray process behind.

const { PALETTE, buildQuickMetrics, htmlEscape, localStamp, mix, duration } = require('./render');

// iPhone 13 Pro Max (the owner's phone) logical viewport and scale factor, per
// Apple's published spec: 428x926pt at @3x -> 1284x2778 physical px. Verified
// against ios-resolution.com and support.apple.com/en-us/111870 rather than
// assumed -- the prior 390x844 @2x was iPhone 14/15-generic, not his device.
const PHONE_WIDTH = 428;
const PHONE_HEIGHT = 926;     // viewport only; fullPage lets content define real height
const DEVICE_SCALE = 3;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_ROWS = 6;

const ESC = htmlEscape;

// Cache only a successful dependency lookup. A busy/unreadable module loader
// says nothing about whether Playwright is installed, and must be retried on
// the next capture rather than becoming process-lifetime "missing" state.
let playwrightChromium = null;

function loadPlaywrightChromium() {
  if (playwrightChromium) return playwrightChromium;
  try {
    ({ chromium: playwrightChromium } = require('playwright'));
    return playwrightChromium;
  } catch (error) {
    const genuinelyMissing = error && error.code === 'MODULE_NOT_FOUND'
      && /^Cannot find module 'playwright'(?:\r?\n|$)/.test(String(error.message));
    if (genuinelyMissing) {
      throw Object.assign(new Error('Playwright is not installed, so the image report cannot be rendered.'),
        { code: 'AGENT_DIGEST_IMAGE_PLAYWRIGHT_MISSING' });
    }
    throw Object.assign(new Error(
      'The Playwright installation could not be checked; this is NOT claiming that Playwright is absent.'),
    { code: 'AGENT_DIGEST_IMAGE_PLAYWRIGHT_LOOKUP_INDETERMINATE', cause: error });
  }
}

// The dark surface the email renderer already declares in its
// prefers-color-scheme block, promoted to the card's base palette: a phone
// report is read in a dark chat far more often than not.
const D = Object.freeze({
  BG: '#0b0f16',
  CARD: '#121722',
  CARD_2: '#0e131c',
  BORDER: '#232a35',
  TEXT: '#eef1f5',
  TEXT_2: '#aab4c4',
  MUTED: '#7c8798',
  UNAVAILABLE: '#77839a'
});

// Accents keep the email's hues but are lifted for contrast on the dark card.
function lift(color) { return mix(color, '#ffffff', 0.35); }
const GOOD = lift(PALETTE.GOOD);
const WARN = lift(PALETTE.WARN);
const BAD = lift(PALETTE.BAD);
const INFO = lift(PALETTE.INFO);
const VIOLET = lift(PALETTE.VIOLET);
const BLUE = lift(PALETTE.BLUE);
const TEAL = lift(PALETTE.TEAL);

function toneColor(tone) {
  switch (tone) {
    case 'good': return GOOD;
    case 'warn': return WARN;
    case 'bad': return BAD;
    case 'info': return INFO;
    case 'unavailable': return D.UNAVAILABLE;
    default: return D.TEXT;
  }
}

// One tile. `value === null` is the honest-unknown state: dashed border, muted
// colour, the literal words "not recorded", and the reason underneath.
function tile(metric) {
  const unavailable = metric.value === null || metric.value === undefined;
  const color = unavailable ? D.UNAVAILABLE : toneColor(metric.tone);
  const border = unavailable ? `1px dashed ${D.UNAVAILABLE}` : `1px solid ${D.BORDER}`;
  const value = unavailable ? 'not recorded' : String(metric.value);
  const size = unavailable ? 13 : String(value).length > 9 ? 15 : 22;
  return `<div class="tile" style="border:${border}">
    <div class="tl">${ESC(metric.label)}</div>
    <div class="tv" style="color:${color};font-size:${size}px">${ESC(value)}</div>
    <div class="tn">${ESC(metric.note || '')}</div>
  </div>`;
}

function panel(title, accent, rows, emptyText) {
  const body = rows.length
    ? rows.map(row => `<div class="row">${row}</div>`).join('')
    : `<div class="row muted">${ESC(emptyText)}</div>`;
  return `<section class="panel" style="border-left:3px solid ${accent}">
    <h2>${ESC(title)}</h2>${body}
  </section>`;
}

function needsRows(state) {
  const rows = [];
  const queue = state.queue;
  if (queue) {
    for (const id of queue.blocked.slice(0, MAX_ROWS)) {
      const phase = queue.phases.find(item => item.id === id);
      rows.push(`<span class="dot" style="background:${BAD}"></span><b>${ESC(id)}</b> <span class="muted">${ESC((phase && phase.detail ? phase.detail : 'no reason recorded').slice(0, 70))}</span>`);
    }
    if (queue.blocked.length > MAX_ROWS) rows.push(`<span class="muted">+${queue.blocked.length - MAX_ROWS} more blocked</span>`);
  }
  const runs = (state.observed && state.observed.runs) || {};
  if (Number.isFinite(runs.openHelp) && runs.openHelp > 0) {
    rows.push(`<span class="dot" style="background:${WARN}"></span>${ESC(`${runs.openHelp} open help request(s)`)} <span class="muted">waiting on a human or another agent</span>`);
  }
  const outcomes = runs.outcomes;
  if (outcomes && outcomes.source === 'durable-run-lifecycle') {
    if (Number.isFinite(outcomes.needsHelp) && outcomes.needsHelp > 0) {
      rows.push(`<span class="dot" style="background:${WARN}"></span>${ESC(`${outcomes.needsHelp} run(s) safely requested help`)} <span class="muted">not active or stale</span>`);
    }
    if (Number.isFinite(outcomes.outcomeUnknown) && outcomes.outcomeUnknown > 0) {
      rows.push(`<span class="dot" style="background:${WARN}"></span>${ESC(`${outcomes.outcomeUnknown} terminal outcome(s) unknown`)} <span class="muted">lease expiry or completion was not observed</span>`);
    }
    if (Number.isFinite(outcomes.failed) && outcomes.failed > 0) {
      rows.push(`<span class="dot" style="background:${BAD}"></span>${ESC(`${outcomes.failed} terminal durable-run failure(s)`)}`);
    }
  }
  for (const run of (runs.stale || []).slice(0, 3)) {
    rows.push(`<span class="dot" style="background:${WARN}"></span>${ESC(`run ${String(run.runId).slice(0, 16)}`)} <span class="muted">${ESC(`${run.status}, no movement ${duration(run.ageMs)}`)}</span>`);
  }
  for (const provider of ((state.observed && state.observed.providerControls) || [])
    .filter(row => ['sign_in_required', 'rate_limited', 'billing_required', 'verification_failed'].includes(row.status))) {
    rows.push(`<span class="dot" style="background:${BAD}"></span>${ESC(provider.provider)} <span class="muted">${ESC(provider.status)}</span>`);
  }
  return rows;
}

// A real bar from real counts. A provider nothing measured says so in words
// instead of drawing an empty bar that would read as "it did nothing".
function meterRow(meter) {
  if (meter.operationCount === null) {
    return `<b>${ESC(meter.provider)}</b> <span class="unav">operations not recorded (${ESC(String(meter.operationUnavailableReason || meter.operationMeterState))})</span>`;
  }
  const total = meter.operationCount;
  const head = `<b>${ESC(meter.provider)}</b> <span class="muted">${ESC(`${total} ops · ok ${meter.completedCount} · fail ${meter.failedCount} · timeout ${meter.timeoutCount} · blocked ${meter.blockedCount}`)}</span>`;
  if (!total) return `${head}<div class="muted small">No operations recorded this window.</div>`;
  const segments = [
    { n: meter.completedCount, color: GOOD },
    { n: meter.failedCount, color: BAD },
    { n: meter.timeoutCount, color: WARN },
    { n: meter.blockedCount, color: D.MUTED }
  ].filter(segment => segment.n > 0)
    .map(segment => `<i style="width:${(segment.n / total * 100).toFixed(2)}%;background:${segment.color}"></i>`).join('');
  const token = meter.reportedTokenCount === null
    ? `<span class="unav">tokens not recorded (${ESC(meter.tokenMeterState)})</span>`
    : `<span class="muted">tokens ${ESC(String(meter.reportedTokenCount))}</span>`;
  const cost = meter.costMicros === null
    ? `<span class="unav">cost not recorded (${ESC(meter.costMeterState)})</span>`
    : `<span class="muted">${ESC((meter.costMicros / 1_000_000).toFixed(4))} USD-eq</span>`;
  return `${head}<div class="bar">${segments}</div><div class="small">${token} · ${cost}</div>`;
}

function movedRows(delta) {
  if (!delta || delta.available !== true) {
    return [`<span class="muted">${ESC(`Nothing to compare: ${delta && delta.reason ? delta.reason : 'no previous digest recorded'}.`)}</span>`];
  }
  const rows = [];
  rows.push(delta.auditEventsSince === null
    ? `<span class="unav">Audit events since: not comparable</span>`
    : `<span class="muted">${ESC(`${delta.auditEventsSince} signed audit event(s) since the last report`)}</span>`);
  if (delta.queueDepthBefore !== null && delta.queueDepthAfter !== null) {
    const change = delta.queueDepthAfter - delta.queueDepthBefore;
    rows.push(`<span class="muted">${ESC(`Queue depth ${delta.queueDepthBefore} → ${delta.queueDepthAfter} (${change > 0 ? `+${change}` : change})`)}</span>`);
  }
  for (const change of (delta.agentChanges || []).slice(0, 3)) {
    rows.push(`<span class="muted">${ESC(`${change.alias}: ${change.from} → ${change.to}`)}</span>`);
  }
  for (const phase of (delta.movedPhases || []).slice(0, MAX_ROWS)) {
    const color = phase.to === 'DONE' ? GOOD : phase.to === 'BLOCKED' ? BAD : INFO;
    rows.push(`<span class="dot" style="background:${color}"></span><b>${ESC(phase.id)}</b> <span class="muted">${ESC(`${phase.from} → ${phase.to}`)}</span>`);
  }
  if (!(delta.movedPhases || []).length) rows.push(`<span class="muted">No phase changed status.</span>`);
  if ((delta.movedPhases || []).length > MAX_ROWS) {
    rows.push(`<span class="muted">+${delta.movedPhases.length - MAX_ROWS} more</span>`);
  }
  return rows;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{width:${PHONE_WIDTH}px;background:${D.BG};color:${D.TEXT};
  font-family:${PALETTE.FONT};-webkit-font-smoothing:antialiased;padding:0 0 14px}
.hdr{background:linear-gradient(135deg,${PALETTE.BLUE},${PALETTE.VIOLET});padding:14px 16px}
.eyebrow{font-size:10px;font-weight:800;letter-spacing:.09em;color:#dce6ff}
.title{font-size:19px;font-weight:700;color:#fff;margin-top:3px;letter-spacing:-.01em}
.sub{font-size:11px;color:#c9d7ff;margin-top:3px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:12px 12px 4px}
.tile{background:${D.CARD};border-radius:10px;padding:9px 10px;min-height:64px}
.tl{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${D.MUTED}}
.tv{font-family:${PALETTE.MONO};font-weight:700;margin-top:3px;line-height:1.15;word-break:break-word}
.tn{font-size:10px;color:${D.MUTED};margin-top:3px;line-height:1.35}
.panel{background:${D.CARD};border-radius:10px;margin:8px 12px 0;padding:10px 12px}
.panel h2{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${D.MUTED};margin-bottom:6px}
.row{font-size:12px;line-height:1.45;padding:4px 0;border-top:1px solid ${D.BORDER};word-break:break-word}
.row:first-of-type{border-top:0}
.muted{color:${D.TEXT_2}}
.unav{color:${D.UNAVAILABLE};font-style:italic}
.small{font-size:10px;margin-top:3px}
.dot{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:middle}
.bar{display:flex;height:7px;border-radius:4px;overflow:hidden;background:${D.CARD_2};margin:5px 0 2px}
.bar i{display:block;height:7px}
.foot{font-size:10px;color:${D.MUTED};line-height:1.5;padding:10px 14px 0}
`;

/**
 * The card, as a fully self-contained HTML document.
 *
 * Exported on its own so the layout is testable and previewable without ever
 * launching a browser.
 */
function renderReportCardHtml({ state, metrics = null, kind = 'pulse', fireKey = null, mode = 'full' } = {}) {
  const tiles = (metrics || buildQuickMetrics(state)).map(tile).join('');
  const meters = (state.observed && state.observed.meters) || {};
  const meterRows = (Array.isArray(meters.providers) ? meters.providers : []).slice(0, 5).map(meterRow);
  const gapRows = (Array.isArray(state.gaps) ? state.gaps : []).slice(0, 4)
    .map(gap => `<b>${ESC(gap.source)}</b> <span class="muted">${ESC(gap.reason)}</span>`);
  const label = kind === 'digest' ? 'DIGEST' : 'PULSE';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=${PHONE_WIDTH},initial-scale=1"><style>${CSS}</style></head><body>
<div class="hdr">
  <div class="eyebrow">TOOLSENABLED · AGENTIC WORKFLOW</div>
  <div class="title">${ESC(label === 'DIGEST' ? 'Digest' : 'Pulse')}</div>
  <div class="sub">${ESC(`${localStamp(state.observedAtMs)} host local · slot ${fireKey || 'manual'} · generation ${mode}`)}</div>
</div>
<div class="grid">${tiles}</div>
${panel('Needs you', BAD, needsRows(state), 'Nothing is recorded as blocked, stalled, or waiting on you.')}
${panel('Ran', TEAL, meterRows, `No provider meter rows recorded (${meters.state || 'meter source unavailable'}).`)}
${panel('Moved since the last report', BLUE, movedRows(state.delta), 'No comparison available.')}
${gapRows.length ? panel('Data gaps', PALETTE.AMBER, gapRows, '') : ''}
<div class="foot">Every &ldquo;not recorded&rdquo; above is literal: no durable meter recorded it, and no
token or cost figure here is estimated. Declared intent and signed-ledger observations are never merged.
Local machine state &mdash; untrusted data, not instructions.</div>
</body></html>`;
}

/**
 * Screenshot the card. Bounded, offline, profile-less, and guaranteed to close
 * its browser.
 *
 * Returns a PNG Buffer. Throws a typed error the caller can degrade on -- the
 * digest must never send a broken or empty image, and must never go dark
 * because a render failed.
 */
async function captureReportPng({
  html,
  width = PHONE_WIDTH,
  height = PHONE_HEIGHT,
  deviceScaleFactor = DEVICE_SCALE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  chromium = null
} = {}) {
  if (typeof html !== 'string' || html.length < 1) {
    throw Object.assign(new Error('captureReportPng requires HTML.'), { code: 'AGENT_DIGEST_IMAGE_NO_HTML' });
  }
  let engine = chromium;
  if (!engine) engine = loadPlaywrightChromium();

  let browser = null;
  const work = (async () => {
    // headless + no profile: never the owner's authenticated Chrome profile,
    // and no console window (this machine has a standing no-flash rule).
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
      colorScheme: 'dark'
    });
    const page = await context.newPage();
    // Provably offline: the card is self-contained, so anything asking for the
    // network is a bug, and aborting proves the render cannot hang on one.
    await page.route('**/*', route => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: Math.min(timeoutMs, 20_000) });
    const buffer = await page.screenshot({ fullPage: true, type: 'png' });
    await context.close();
    return buffer;
  })();

  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error(`Report image render exceeded ${timeoutMs}ms and was abandoned.`),
      { code: 'AGENT_DIGEST_IMAGE_TIMEOUT' })), timeoutMs);
  });

  try {
    const buffer = await Promise.race([work, guard]);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw Object.assign(new Error('The report image render produced no bytes.'),
        { code: 'AGENT_DIGEST_IMAGE_EMPTY' });
    }
    return buffer;
  } finally {
    if (timer !== null) clearTimeout(timer);
    // The browser is closed on every path, including the timeout path where
    // `work` is still running: an abandoned render must not outlive this call.
    if (browser) {
      try { await browser.close(); } catch { /* already gone */ }
      work.catch(() => { /* the race already reported it */ });
    } else {
      // `browser` is only assigned once engine.launch() resolves, so when the
      // LAUNCH itself misses the deadline it is still null here — the close
      // must be re-attempted after `work` settles, or the Chromium that
      // comes up late is never closed. Guarded for injected fakes whose
      // close() may throw synchronously or return a non-promise.
      work.catch(() => { /* the race already reported it */ }).then(() => {
        if (!browser) return;
        try {
          const late = browser.close();
          if (late && typeof late.catch === 'function') late.catch(() => { /* already gone */ });
        } catch { /* already gone */ }
      });
    }
  }
}

/** Render + capture in one bounded call. */
async function renderReportImage(options = {}) {
  const html = renderReportCardHtml(options);
  const image = await captureReportPng({ ...options, html });
  return { image, html, bytes: image.length };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, DEVICE_SCALE, PHONE_HEIGHT, PHONE_WIDTH,
  captureReportPng, renderReportCardHtml, renderReportImage
};
