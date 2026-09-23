'use strict';

// R1162: a small local-only resource-alert primitive.  Rules and samples are
// runtime state by design; this module never supplies a default firing rule.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'resource-alerts');
const DEFAULT_RULES_FILE = path.join(DEFAULT_STATE_DIR, 'rules.json');
const DEFAULT_SAMPLES_FILE = path.join(DEFAULT_STATE_DIR, 'samples.jsonl');
const DEFAULT_ESCALATIONS_FILE = path.join(DEFAULT_STATE_DIR, 'escalations.jsonl');
const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 576; // 48 hours at the scheduled five-minute cadence.
const DEFAULT_MAX_SAMPLE_BYTES = 512 * 1024;
const DEFAULT_MAX_ESCALATIONS = 256;
const DEFAULT_MAX_ESCALATION_BYTES = 256 * 1024;
const MAX_COUNTER_OUTPUT_BYTES = 16 * 1024;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OPERATORS = new Set(['>', '>=', '<', '<=']);

class ResourceAlertsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ResourceAlertsError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new ResourceAlertsError(code, message, details);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value, field, max = 512) {
  if (typeof value !== 'string') fail('RESOURCE_ALERTS_INVALID', `${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) fail('RESOURCE_ALERTS_INVALID', `${field} must be 1 through ${max} characters.`);
  return trimmed;
}

function safeInteger(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('RESOURCE_ALERTS_INVALID', `${field} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function finiteNumber(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('RESOURCE_ALERTS_INVALID', `${field} must be a finite number from ${min} through ${max}.`);
  }
  return value;
}

function asTimestamp(value, field) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('RESOURCE_ALERTS_INVALID', `${field} must be a valid timestamp.`);
  return parsed;
}

function statePaths(options = {}) {
  const stateDir = path.resolve(options.stateDir || DEFAULT_STATE_DIR);
  return Object.freeze({
    stateDir,
    rulesFile: path.resolve(options.rulesFile || path.join(stateDir, 'rules.json')),
    samplesFile: path.resolve(options.samplesFile || path.join(stateDir, 'samples.jsonl')),
    escalationsFile: path.resolve(options.escalationsFile || path.join(stateDir, 'escalations.jsonl'))
  });
}

function errorCode(error, fallback) {
  return error && typeof error.code === 'string' ? error.code : fallback;
}

function writeTextAtomic(file, text, fsImpl = fs) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fsImpl.mkdirSync(directory, { recursive: true });
    const descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
    try {
      fsImpl.writeFileSync(descriptor, text, 'utf8');
      fsImpl.fsyncSync(descriptor);
    } finally {
      fsImpl.closeSync(descriptor);
    }
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
    fail('RESOURCE_ALERTS_STATE_WRITE_FAILED', `Runtime state could not be written atomically: ${errorCode(error, 'UNKNOWN')}.`);
  }
}

function readTextIfPresent(file, label, fsImpl = fs) {
  try {
    return fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('RESOURCE_ALERTS_STATE_READ_FAILED', `${label} could not be read: ${errorCode(error, 'UNKNOWN')}.`);
  }
}

function normalizeRule(value) {
  if (!plain(value)) fail('RESOURCE_ALERTS_RULE_INVALID', 'A resource alert rule must be an object.');
  const allowed = new Set(['id', 'metric', 'op', 'threshold', 'forMinutes', 'setBy', 'setAt', 'enabled', 'lastFiredAt', 'cooldown', 'cooldownClearedAt']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('RESOURCE_ALERTS_RULE_INVALID', 'A resource alert rule has unsupported fields.', { unknown });
  const id = boundedString(value.id, 'rule.id', 80);
  if (!RULE_ID.test(id)) fail('RESOURCE_ALERTS_RULE_INVALID', 'rule.id has unsupported characters.');
  if (value.metric !== 'cpu') fail('RESOURCE_ALERTS_RULE_INVALID', 'Only the cpu metric is supported by this alert primitive.');
  if (!OPERATORS.has(value.op)) fail('RESOURCE_ALERTS_RULE_INVALID', 'rule.op is unsupported.');
  const threshold = finiteNumber(value.threshold, 'rule.threshold', 0, 100);
  const forMinutes = safeInteger(value.forMinutes, 'rule.forMinutes', 1, 24 * 60);
  const setBy = boundedString(value.setBy, 'rule.setBy', 160);
  const setAtMs = asTimestamp(value.setAt, 'rule.setAt');
  if (typeof value.enabled !== 'boolean') fail('RESOURCE_ALERTS_RULE_INVALID', 'rule.enabled must be a boolean.');
  const lastFiredAt = value.lastFiredAt === undefined || value.lastFiredAt === null
    ? null : new Date(asTimestamp(value.lastFiredAt, 'rule.lastFiredAt')).toISOString();
  const cooldown = value.cooldown === undefined ? false : value.cooldown;
  if (typeof cooldown !== 'boolean') fail('RESOURCE_ALERTS_RULE_INVALID', 'rule.cooldown must be a boolean.');
  const cooldownClearedAt = value.cooldownClearedAt === undefined || value.cooldownClearedAt === null
    ? null : new Date(asTimestamp(value.cooldownClearedAt, 'rule.cooldownClearedAt')).toISOString();
  return Object.freeze({
    id,
    metric: 'cpu',
    op: value.op,
    threshold,
    forMinutes,
    setBy,
    setAt: new Date(setAtMs).toISOString(),
    enabled: value.enabled,
    lastFiredAt,
    cooldown,
    cooldownClearedAt
  });
}

function readRules(options = {}) {
  const { rulesFile } = statePaths(options);
  const text = readTextIfPresent(rulesFile, 'Rule state', options.fsImpl || fs);
  if (text === null) return Object.freeze([]);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail('RESOURCE_ALERTS_RULE_STATE_INVALID', 'Rule state is not valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length > 256) {
    fail('RESOURCE_ALERTS_RULE_STATE_INVALID', 'Rule state must be an array with at most 256 rules.');
  }
  const rules = parsed.map(normalizeRule);
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) fail('RESOURCE_ALERTS_RULE_STATE_INVALID', 'Rule state contains duplicate rule ids.');
    ids.add(rule.id);
  }
  return Object.freeze(rules);
}

function writeRules(rules, options = {}) {
  if (!Array.isArray(rules) || rules.length > 256) {
    fail('RESOURCE_ALERTS_RULE_STATE_INVALID', 'Rule state must contain at most 256 rules.');
  }
  const normalized = rules.map(normalizeRule);
  const ids = new Set();
  for (const rule of normalized) {
    if (ids.has(rule.id)) fail('RESOURCE_ALERTS_RULE_STATE_INVALID', 'Rule state contains duplicate rule ids.');
    ids.add(rule.id);
  }
  const { rulesFile } = statePaths(options);
  writeTextAtomic(rulesFile, `${JSON.stringify(normalized, null, 2)}\n`, options.fsImpl || fs);
  return Object.freeze(normalized);
}

function newRuleId(metric = 'cpu') {
  return `${metric}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function createRule(input = {}, options = {}) {
  const now = options.now === undefined ? Date.now() : asTimestamp(options.now, 'now');
  return normalizeRule({
    id: input.id || newRuleId(input.metric || 'cpu'),
    metric: input.metric || 'cpu',
    op: input.op,
    threshold: input.threshold,
    forMinutes: input.forMinutes,
    setBy: input.setBy || 'coordinator-cli',
    setAt: input.setAt || new Date(now).toISOString(),
    enabled: input.enabled === undefined ? true : input.enabled,
    lastFiredAt: null,
    cooldown: false,
    cooldownClearedAt: null
  });
}

function setRule(input, options = {}) {
  const existing = readRules(options);
  const rule = createRule(input, options);
  if (existing.some(item => item.id === rule.id)) fail('RESOURCE_ALERTS_RULE_EXISTS', `Rule ${rule.id} already exists.`);
  writeRules([...existing, rule], options);
  return rule;
}

function clearRule(id, options = {}) {
  const ruleId = boundedString(id, 'rule id', 80);
  const existing = readRules(options);
  const index = existing.findIndex(item => item.id === ruleId);
  if (index < 0) fail('RESOURCE_ALERTS_RULE_NOT_FOUND', `Rule ${ruleId} was not found.`);
  const removed = existing[index];
  writeRules(existing.filter(item => item.id !== ruleId), options);
  return removed;
}

function parseRuleExpression(value) {
  const text = boundedString(value, 'rule expression', 200);
  const match = /^\s*(cpu)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s+for\s+(\d+)\s*(m|min|mins|minute|minutes)\s*$/i.exec(text);
  if (!match) {
    fail('RESOURCE_ALERTS_RULE_EXPRESSION_INVALID', 'Rule expression must look like: cpu>90 for 10m.');
  }
  return Object.freeze({
    metric: match[1].toLowerCase(),
    op: match[2],
    threshold: Number(match[3]),
    forMinutes: Number(match[4])
  });
}

function normalizeSample(value) {
  if (!plain(value)) fail('RESOURCE_ALERTS_SAMPLE_INVALID', 'A resource sample must be an object.');
  const keys = Object.keys(value);
  const allowed = new Set(['at', 'cpu', 'freeRamMB']);
  const unknown = keys.filter(key => !allowed.has(key));
  const missing = ['at', 'cpu', 'freeRamMB'].filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail('RESOURCE_ALERTS_SAMPLE_INVALID', 'A resource sample has an invalid shape.', { unknown, missing });
  }
  const at = new Date(asTimestamp(value.at, 'sample.at')).toISOString();
  const cpu = finiteNumber(value.cpu, 'sample.cpu', 0, 100);
  const freeRamMB = finiteNumber(value.freeRamMB, 'sample.freeRamMB', 0, Number.MAX_SAFE_INTEGER);
  return Object.freeze({ at, cpu, freeRamMB });
}

function readSamples(options = {}) {
  const { samplesFile } = statePaths(options);
  const text = readTextIfPresent(samplesFile, 'Sample state', options.fsImpl || fs);
  if (text === null || text.trim() === '') return Object.freeze([]);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > DEFAULT_MAX_SAMPLES * 4) {
    fail('RESOURCE_ALERTS_SAMPLE_STATE_INVALID', 'Sample state exceeds its bounded retention limit.');
  }
  const samples = lines.map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { fail('RESOURCE_ALERTS_SAMPLE_STATE_INVALID', `Sample line ${index + 1} is not valid JSON.`); }
    return normalizeSample(parsed);
  });
  return Object.freeze(samples.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}

function boundedJsonl(items, { maxItems, maxBytes }) {
  safeInteger(maxItems, 'retention.maxItems', 1, Number.MAX_SAFE_INTEGER);
  safeInteger(maxBytes, 'retention.maxBytes', 1, Number.MAX_SAFE_INTEGER);
  const serialized = items.map(item => JSON.stringify(item));
  if (serialized.length && Buffer.byteLength(`${serialized[serialized.length - 1]}\n`, 'utf8') > maxBytes) {
    fail('RESOURCE_ALERTS_RETENTION_TOO_SMALL', 'The retention byte limit cannot hold the newest record.');
  }
  while (serialized.length > maxItems || Buffer.byteLength(`${serialized.join('\n')}\n`, 'utf8') > maxBytes) serialized.shift();
  return `${serialized.join('\n')}${serialized.length ? '\n' : ''}`;
}

function writeSamples(samples, options = {}) {
  const normalized = samples.map(normalizeSample).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const { samplesFile } = statePaths(options);
  writeTextAtomic(samplesFile, boundedJsonl(normalized, {
    maxItems: options.maxSamples || DEFAULT_MAX_SAMPLES,
    maxBytes: options.maxSampleBytes || DEFAULT_MAX_SAMPLE_BYTES
  }), options.fsImpl || fs);
  return Object.freeze(normalized);
}

function appendSample(sample, options = {}) {
  const existing = readSamples(options);
  const normalized = normalizeSample(sample);
  const samples = writeSamples([...existing, normalized], options);
  return samples[samples.length - 1];
}

function normalizeEscalation(value) {
  if (!plain(value)) fail('RESOURCE_ALERTS_ESCALATION_INVALID', 'An escalation record must be an object.');
  const keys = Object.keys(value).sort();
  const required = ['agentId', 'code', 'message', 'runId', 'status'];
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    fail('RESOURCE_ALERTS_ESCALATION_INVALID', 'An escalation record must use the agent-sweep escalation shape.');
  }
  return Object.freeze({
    agentId: boundedString(value.agentId, 'escalation.agentId', 80),
    runId: boundedString(value.runId, 'escalation.runId', 120),
    status: boundedString(value.status, 'escalation.status', 40),
    code: boundedString(value.code, 'escalation.code', 80),
    message: boundedString(value.message, 'escalation.message', 512)
  });
}

function readEscalations(options = {}) {
  const { escalationsFile } = statePaths(options);
  const text = readTextIfPresent(escalationsFile, 'Escalation state', options.fsImpl || fs);
  if (text === null || text.trim() === '') return Object.freeze([]);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > DEFAULT_MAX_ESCALATIONS * 4) {
    fail('RESOURCE_ALERTS_ESCALATION_STATE_INVALID', 'Escalation state exceeds its bounded retention limit.');
  }
  return Object.freeze(lines.map((line, index) => {
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { fail('RESOURCE_ALERTS_ESCALATION_STATE_INVALID', `Escalation line ${index + 1} is not valid JSON.`); }
    return normalizeEscalation(parsed);
  }));
}

function appendEscalations(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) return Object.freeze([]);
  const normalized = records.map(normalizeEscalation);
  const all = [...readEscalations(options), ...normalized];
  const { escalationsFile } = statePaths(options);
  writeTextAtomic(escalationsFile, boundedJsonl(all, {
    maxItems: options.maxEscalations || DEFAULT_MAX_ESCALATIONS,
    maxBytes: options.maxEscalationBytes || DEFAULT_MAX_ESCALATION_BYTES
  }), options.fsImpl || fs);
  return Object.freeze(normalized);
}

function comparison(op, actual, threshold) {
  switch (op) {
    case '>': return actual > threshold;
    case '>=': return actual >= threshold;
    case '<': return actual < threshold;
    case '<=': return actual <= threshold;
    default: fail('RESOURCE_ALERTS_RULE_INVALID', 'rule.op is unsupported.');
  }
}

function minimumSamples(rule, sampleIntervalMs) {
  // Two observations are the absolute minimum; a longer rule requires at
  // least the expected number of scheduled observation points, while the
  // coverage check below proves that the window itself has elapsed.
  return Math.max(2, Math.ceil((rule.forMinutes * 60 * 1000) / sampleIntervalMs));
}

function evaluateRule(rule, samples, now, sampleIntervalMs, samplerFailure) {
  if (!rule.enabled) return Object.freeze({ id: rule.id, state: 'DISABLED', reason: 'RULE_DISABLED' });
  if (samplerFailure) return Object.freeze({ id: rule.id, state: 'UNKNOWN', reason: 'COUNTER_READ_FAILED' });
  const durationMs = rule.forMinutes * 60 * 1000;
  const windowStart = now - durationMs;
  const window = samples.filter(sample => {
    const at = Date.parse(sample.at);
    return at >= windowStart && at <= now;
  });
  const required = minimumSamples(rule, sampleIntervalMs);
  if (window.length < required) {
    return Object.freeze({
      id: rule.id,
      state: 'UNKNOWN',
      reason: 'INSUFFICIENT_SAMPLES',
      sampleCount: window.length,
      requiredSamples: required
    });
  }
  const firstAt = Date.parse(window[0].at);
  if (firstAt > windowStart) {
    return Object.freeze({
      id: rule.id,
      state: 'UNKNOWN',
      reason: 'WINDOW_NOT_COVERED',
      sampleCount: window.length,
      requiredSamples: required,
      observedFrom: window[0].at,
      requiredFrom: new Date(windowStart).toISOString()
    });
  }
  const breaches = window.every(sample => comparison(rule.op, sample.cpu, rule.threshold));
  return Object.freeze({
    id: rule.id,
    state: breaches ? 'BREACH' : 'HEALTHY',
    sampleCount: window.length,
    requiredSamples: required,
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(now).toISOString()
  });
}

function escalationFor(rule, now, sampleCount) {
  const relation = `${rule.metric}${rule.op}${rule.threshold}`;
  return normalizeEscalation({
    // This is deliberately the exact compact escalation shape written by the
    // agent-sweep path.  runId is an immutable alert-event identity.
    agentId: 'resource-alerts',
    runId: `resource-alert-${now}-${crypto.randomBytes(6).toString('hex')}`,
    status: 'alert',
    code: 'RESOURCE_ALERT_FIRED',
    message: `Rule ${rule.id}: ${relation} held across ${sampleCount} samples for ${rule.forMinutes} minute(s).`
  });
}

function evaluateRules(options = {}) {
  const now = options.now === undefined ? Date.now() : asTimestamp(options.now, 'now');
  const sampleIntervalMs = options.sampleIntervalMs === undefined
    ? DEFAULT_SAMPLE_INTERVAL_MS
    : safeInteger(options.sampleIntervalMs, 'sampleIntervalMs', 1_000, 60 * 60 * 1000);
  const rules = readRules(options);
  const samples = readSamples(options);
  const samplerFailure = options.samplerFailure === true;
  const nextRules = [];
  const results = [];
  const escalations = [];
  let changed = false;

  for (const rule of rules) {
    const finding = evaluateRule(rule, samples, now, sampleIntervalMs, samplerFailure);
    let next = rule;
    if (finding.state === 'HEALTHY' && rule.cooldown) {
      next = normalizeRule({ ...rule, cooldown: false, cooldownClearedAt: new Date(now).toISOString() });
      changed = true;
      results.push(Object.freeze({ ...finding, state: 'CLEARED', reason: 'CONDITION_CLEARED' }));
    } else if (finding.state === 'BREACH' && !rule.cooldown) {
      const event = escalationFor(rule, now, finding.sampleCount);
      escalations.push(event);
      next = normalizeRule({ ...rule, cooldown: true, lastFiredAt: new Date(now).toISOString() });
      changed = true;
      results.push(Object.freeze({ ...finding, state: 'FIRED', escalation: event }));
    } else if (finding.state === 'BREACH') {
      results.push(Object.freeze({ ...finding, state: 'COOLDOWN', reason: 'ALREADY_FIRED_UNTIL_CLEAR' }));
    } else {
      results.push(finding);
    }
    nextRules.push(next);
  }

  // Persist the durable event before the cooldown marker.  A rare rule-write
  // failure can therefore produce an at-least-once duplicate instead of
  // silently losing an escalation.
  if (escalations.length) appendEscalations(escalations, options);
  if (changed) writeRules(nextRules, options);
  const counts = results.reduce((total, item) => {
    const key = item.state.toLowerCase();
    total[key] = (total[key] || 0) + 1;
    return total;
  }, {});
  return Object.freeze({
    at: new Date(now).toISOString(),
    sampleCount: samples.length,
    results: Object.freeze(results),
    escalations: Object.freeze(escalations),
    counts: Object.freeze(counts)
  });
}

// Win32_Processor.LoadPercentage is a single instantaneous sample and it is not
// usable as an alert input.  Measured on a machine held at a steady 44% true
// load, six consecutive reads returned 48, 31, 51, 37, 90 and 100.  Comparing
// any one of those against a threshold fires the alert on sampling noise rather
// than on load, so the escalation says nothing about the machine.  Users would
// have received the same false alarms, because this is the shipped reader.
//
// Derive utilization from the Idle process across a real window instead: busy
// cores are the logical-processor count minus the cores Idle accumulated.  The
// counter is cumulative, so the window itself does the averaging and a burst
// cannot dominate.  Idle-derived and Get-Counter agreed within a point in
// testing (44.2% vs 39-45%) while LoadPercentage was still swinging by 70.
//
// Get-Counter would work too, but its counter paths are localized on non-English
// Windows: '\Processor(_Total)\% Processor Time' does not resolve on a German or
// Japanese install.  The raw CIM class and the process name 'Idle' are not
// localized, so this keeps working on a customer machine in any locale.
const CPU_SAMPLE_WINDOW_MS = 1000;

function powerShellCounters({ execFileImpl = execFile, timeoutMs = 15_000 } = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$cores = [double](Get-CimInstance -ClassName Win32_ComputerSystem).NumberOfLogicalProcessors',
    '$a = Get-CimInstance -ClassName Win32_PerfRawData_PerfProc_Process -Filter "Name=\'Idle\'"',
    `Start-Sleep -Milliseconds ${CPU_SAMPLE_WINDOW_MS}`,
    '$b = Get-CimInstance -ClassName Win32_PerfRawData_PerfProc_Process -Filter "Name=\'Idle\'"',
    '$dt = [double]($b.Timestamp_Sys100NS - $a.Timestamp_Sys100NS)',
    '$di = [double]($b.PercentProcessorTime - $a.PercentProcessorTime)',
    // Emit no cpu value rather than a fabricated one when the window is unusable.
    // The caller's finiteNumber check then rejects the read, so a broken counter
    // surfaces as a failed sample instead of a confident wrong number.
    '$cpu = $null',
    'if ($cores -gt 0 -and $dt -gt 0) { $busy = 100 * (1 - (($di / $dt) / $cores)); $cpu = [math]::Round([math]::Max(0, [math]::Min(100, $busy)), 2) }',
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
    '[pscustomobject]@{ cpu = $cpu; freeRamMB = [math]::Round(([double]$os.FreePhysicalMemory / 1024), 2) } | ConvertTo-Json -Compress'
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFileImpl('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script
    ], {
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_COUNTER_OUTPUT_BYTES
    }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new ResourceAlertsError('RESOURCE_ALERTS_COUNTER_READ_FAILED', 'Windows resource counters could not be read.');
        wrapped.causeCode = errorCode(error, 'UNKNOWN');
        return reject(wrapped);
      }
      if (Buffer.byteLength(String(stdout || ''), 'utf8') > MAX_COUNTER_OUTPUT_BYTES) {
        return reject(new ResourceAlertsError('RESOURCE_ALERTS_COUNTER_READ_FAILED', 'Windows resource counter output exceeded its bound.'));
      }
      let parsed;
      try { parsed = JSON.parse(String(stdout || '').trim()); }
      catch {
        return reject(new ResourceAlertsError('RESOURCE_ALERTS_COUNTER_READ_FAILED', 'Windows resource counters returned invalid JSON.'));
      }
      try {
        if (!plain(parsed)) throw new Error('counter object missing');
        finiteNumber(parsed.cpu, 'counter.cpu', 0, 100);
        finiteNumber(parsed.freeRamMB, 'counter.freeRamMB', 0, Number.MAX_SAFE_INTEGER);
        resolve({ cpu: parsed.cpu, freeRamMB: parsed.freeRamMB });
      } catch (parseError) {
        reject(new ResourceAlertsError('RESOURCE_ALERTS_COUNTER_READ_FAILED', 'Windows resource counters returned invalid values.'));
      }
    });
  });
}

async function recordSample(options = {}) {
  const now = options.now === undefined ? Date.now() : asTimestamp(options.now, 'now');
  const sampler = options.sampler || powerShellCounters;
  let counters;
  try {
    counters = await sampler(options);
  } catch (error) {
    // Counter failure is an operational unknown, not a healthy result and not
    // a reason for the scheduled task to crash before it can report the state.
    return Object.freeze({
      state: 'UNKNOWN',
      reason: 'COUNTER_READ_FAILED',
      code: errorCode(error, 'RESOURCE_ALERTS_COUNTER_READ_FAILED')
    });
  }
  const sample = appendSample({ at: new Date(now).toISOString(), cpu: counters.cpu, freeRamMB: counters.freeRamMB }, options);
  return Object.freeze({ state: 'RECORDED', sample });
}

module.exports = Object.freeze({
  DEFAULT_ESCALATIONS_FILE,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_RULES_FILE,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_SAMPLES_FILE,
  DEFAULT_STATE_DIR,
  ResourceAlertsError,
  appendEscalations,
  appendSample,
  clearRule,
  createRule,
  evaluateRules,
  parseRuleExpression,
  powerShellCounters,
  readEscalations,
  readRules,
  readSamples,
  recordSample,
  setRule,
  statePaths,
  writeRules,
  writeSamples
});
