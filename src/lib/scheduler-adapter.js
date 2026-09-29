'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run: defaultRun } = require('./runtime');
const { SCHEDULER_TASK_EXECUTION_LIMIT } = require('./scheduler-constants');

const TASK_NOT_FOUND_HRESULT = 0x80070002;
const MAX_TASK_NAME = 238;

// A SYSTEM BINARY NAMED WITHOUT A PATH IS WHOEVER PATH SAYS IT IS.
//
// This adapter used to hand run() the bare names 'whoami.exe' and
// 'schtasks.exe'. MEASURED 2026-08-19 in a shell carrying Git for Windows:
// `whoami.exe /user /fo csv /nh` runs <git>/usr/bin/whoami.exe, GNU coreutils'
// whoami, which answers "extra operand '/user'" and exits non-zero -- which
// resolveCurrentPrincipalIdentity() below turns into
// SCHEDULER_IDENTITY_UNAVAILABLE, "The current Windows user SID could not be
// resolved." Git for Windows, MSYS2, Cygwin and WSL interop all ship shadowing
// coreutils builds, so this is a defect that reaches other people's machines
// rather than ours. It is a PATH-hijack vector besides.
//
// The rule is already this repo's, stated in uac-delegation.js and followed by
// service-control.js, uac-delegation-client.js, supervision/observer.js,
// codex-native-pair.js and fra-root-access.js: name the absolute path under
// %SystemRoot%\System32. SystemRoot is READ rather than assumed, because
// Windows is not always at C:\Windows.
function systemRoot() {
  const configured = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir;
  return configured && configured.trim() ? configured : 'C:\\Windows';
}
function whoamiPath() { return path.join(systemRoot(), 'System32', 'whoami.exe'); }
function schtasksPath() { return path.join(systemRoot(), 'System32', 'schtasks.exe'); }

class SchedulerAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SchedulerAdapterError';
    this.code = code;
    this.retryable = options.retryable !== false;
    this.uncertain = options.uncertain === true;
    this.observation = options.observation || null;
  }
}

function assertSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Scheduler task spec must be an object.');
  for (const field of ['installationId', 'jobId', 'taskName', 'ownershipMarker', 'nodePath', 'runnerPath']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new TypeError(`Scheduler task spec is missing ${field}.`);
    if (/["\0\r\n]/.test(value[field])) throw new TypeError(`Scheduler task spec ${field} contains an unsupported character.`);
  }
  if (typeof value.principalId !== 'string' || !value.principalId) throw new TypeError('Scheduler task spec is missing principalId.');
  if (/["\0\r\n]/.test(value.principalId)) throw new TypeError('Scheduler task spec principalId contains an unsupported character.');
  if (!/^[a-f0-9]{32}$/.test(value.installationId)) throw new TypeError('Scheduler installationId is invalid.');
  if (!/^scheduler-job-[A-Za-z0-9-]{1,180}$/.test(value.jobId)) throw new TypeError('Scheduler jobId is invalid.');
  if (!/^[a-f0-9]{64}$/.test(value.ownershipMarker)) throw new TypeError('Scheduler ownershipMarker is invalid.');
  if (!/^S-\d-(?:\d+-){1,14}\d+$/i.test(value.principalId)) throw new TypeError('Scheduler principalId must be a Windows SID.');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new TypeError('Scheduler generation is invalid.');
  if (!['daily', 'hourly', 'minutes'].includes(value.schedule)) throw new TypeError('Scheduler schedule is invalid.');
  if (value.schedule === 'minutes' && (!Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 1439)) {
    throw new TypeError('Scheduler intervalMinutes must be from 1 through 1439.');
  }
  if (value.schedule !== 'minutes' && value.intervalMinutes !== null && value.intervalMinutes !== undefined) {
    throw new TypeError('Scheduler intervalMinutes is valid only for a minutes schedule.');
  }
  if (!path.isAbsolute(value.nodePath) || !path.isAbsolute(value.runnerPath)) throw new TypeError('Scheduler runtime paths must be absolute.');
  if (!value.taskName.startsWith('\\') || value.taskName.length > MAX_TASK_NAME) throw new TypeError(`Scheduler taskName must be an absolute name no longer than ${MAX_TASK_NAME} characters.`);
  const expectedTaskName = `\\ToolsEnabled-v2-${value.installationId.slice(0, 12)}-${crypto.createHash('sha256').update(value.jobId, 'utf8').digest('hex').slice(0, 16)}-g${value.generation}`;
  if (value.taskName !== expectedTaskName) throw new TypeError('Scheduler taskName is not the deterministic name for this registration.');
  return value;
}

function assertLegacySpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Legacy scheduler task spec must be an object.');
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.name)) throw new TypeError('Legacy scheduler task name is invalid.');
  for (const field of ['taskName', 'nodePath', 'runnerPath']) {
    if (typeof value[field] !== 'string' || !value[field] || /["\0\r\n]/.test(value[field])) {
      throw new TypeError(`Legacy scheduler task spec ${field} is invalid.`);
    }
  }
  if (value.taskName !== `\\ToolsEnabled-${value.name}` || value.taskName.length > MAX_TASK_NAME) {
    throw new TypeError('Legacy scheduler taskName is not deterministic for this job.');
  }
  if (!path.win32.isAbsolute(value.nodePath) || !path.win32.isAbsolute(value.runnerPath)) {
    throw new TypeError('Legacy scheduler executable paths must be absolute Windows paths.');
  }
  if (typeof value.principalId !== 'string' || !/^S-\d-(?:\d+-){1,14}\d+$/i.test(value.principalId)) {
    throw new TypeError('Legacy scheduler principalId must be a Windows SID.');
  }
  if (typeof value.principalName !== 'string' || value.principalName.length < 1 || value.principalName.length > 256
    || /["\0\r\n]/.test(value.principalName)) {
    throw new TypeError('Legacy scheduler principalName is invalid.');
  }
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) throw new TypeError('Legacy scheduler createdAtMs is required.');
  if (!['daily', 'hourly'].includes(value.schedule)) throw new TypeError('Legacy scheduler schedule must be daily or hourly.');
  return value;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlDecode(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, raw) => String.fromCodePoint(Number.parseInt(raw, 16)))
    .replace(/&#([0-9]+);/g, (_, raw) => String.fromCodePoint(Number.parseInt(raw, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'i').exec(xml);
  return match ? xmlDecode(match[1].trim()) : null;
}

function tagValues(xml, name) {
  const values = [];
  const expression = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'gi');
  let match;
  while ((match = expression.exec(String(xml))) !== null) values.push(xmlDecode(match[1].trim()));
  return values;
}

function section(xml, name) {
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'i').exec(String(xml));
  return match ? match[1] : null;
}

function directChildNames(fragment) {
  if (fragment === null) return [];
  const names = [];
  const tokens = /<([^>]+)>/g;
  let depth = 0;
  let match;
  while ((match = tokens.exec(fragment)) !== null) {
    const token = match[1].trim();
    if (!token || token.startsWith('?') || token.startsWith('!')) continue;
    if (token.startsWith('/')) {
      if (depth > 0) depth -= 1;
      continue;
    }
    const rawName = token.split(/[\s/>]/, 1)[0];
    const localName = rawName.includes(':') ? rawName.slice(rawName.lastIndexOf(':') + 1) : rawName;
    if (depth === 0) names.push(localName);
    if (!token.endsWith('/')) depth += 1;
  }
  return names;
}

function sameChildren(fragment, expected) {
  const actual = directChildNames(fragment).map(value => value.toLowerCase()).sort();
  const wanted = expected.map(value => value.toLowerCase()).sort();
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function onlyChildren(fragment, allowed, required = []) {
  const actual = directChildNames(fragment).map(value => value.toLowerCase());
  const allowedSet = new Set(allowed.map(value => value.toLowerCase()));
  if (actual.some(value => !allowedSet.has(value)) || new Set(actual).size !== actual.length) return false;
  return required.every(value => actual.includes(value.toLowerCase()));
}

function oneTagEquals(fragment, name, expected, caseInsensitive = true) {
  const values = tagValues(fragment, name);
  if (values.length !== 1) return false;
  return caseInsensitive
    ? values[0].toLowerCase() === String(expected).toLowerCase()
    : values[0] === String(expected);
}

function tagEqualsOrDefault(fragment, name, expected, defaultValue, caseInsensitive = true) {
  const values = tagValues(fragment, name);
  if (values.length > 1) return false;
  const actual = values.length === 0 ? String(defaultValue) : values[0];
  return caseInsensitive
    ? actual.toLowerCase() === String(expected).toLowerCase()
    : actual === String(expected);
}

function oneOpeningTagHasAttribute(xml, name, attribute, expected) {
  const matches = [...String(xml).matchAll(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b([^>]*)>`, 'gi'))];
  if (matches.length !== 1) return false;
  const attributeMatch = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(matches[0][1]);
  return Boolean(attributeMatch) && xmlDecode(attributeMatch[2]).toLowerCase() === String(expected).toLowerCase();
}

function normalizedWindowsPath(value) {
  return path.win32.normalize(String(value)).toLowerCase();
}

function resolveCurrentPrincipalIdentity(dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const result = run(whoamiPath(), ['/user', '/fo', 'csv', '/nh'], { timeout: 30_000 });
  if (unsignedStatus(result.status) !== 0) throw new SchedulerAdapterError('SCHEDULER_IDENTITY_UNAVAILABLE', 'The current Windows user SID could not be resolved.', { retryable: true });
  const match = /^\s*"([^"\r\n]+)"\s*,\s*"?(S-\d-(?:\d+-){1,14}\d+)"?\s*$/i.exec(String(result.stdout || '').trim());
  if (!match) throw new SchedulerAdapterError('SCHEDULER_IDENTITY_UNAVAILABLE', 'whoami returned no valid Windows user SID.', { retryable: true });
  return { principalName: match[1], principalId: match[2] };
}

function resolveCurrentPrincipalId(dependencies = {}) {
  return resolveCurrentPrincipalIdentity(dependencies).principalId;
}

function resolveCurrentPrincipalName(dependencies = {}) {
  return resolveCurrentPrincipalIdentity(dependencies).principalName;
}

function runnerArguments(spec) {
  assertSpec(spec);
  return `"${spec.runnerPath}" --installation-id ${spec.installationId} --job-id ${spec.jobId} --generation ${spec.generation} --ownership-marker ${spec.ownershipMarker}`;
}

function ownershipDescription(spec) {
  return `ToolsEnabled scheduler v2; installation=${spec.installationId}; job=${spec.jobId}; generation=${spec.generation}; ownership=${spec.ownershipMarker}`;
}

function legacyRunnerArguments(input) {
  const spec = assertLegacySpec(input);
  return `/s /c ""${spec.nodePath}" "${spec.runnerPath}" "${spec.name}""`;
}

function repetitionMinutes(spec) {
  if (spec.schedule === 'hourly') return 60;
  if (spec.schedule === 'minutes') return spec.intervalMinutes;
  return null;
}

function buildTaskXml(input) {
  const spec = assertSpec(input);
  const repeat = repetitionMinutes(spec);
  const trigger = repeat === null
    ? `<CalendarTrigger>
      <StartBoundary>2000-01-01T00:05:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>`
    : `<TimeTrigger>
      <StartBoundary>2000-01-01T00:05:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${repeat}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(ownershipDescription(spec))}</Description>
    <URI>${xmlEscape(spec.taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    ${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(spec.principalId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>${SCHEDULER_TASK_EXECUTION_LIMIT}</ExecutionTimeLimit>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(spec.nodePath)}</Command>
      <Arguments>${xmlEscape(runnerArguments(spec))}</Arguments>
      <WorkingDirectory>${xmlEscape(path.dirname(spec.runnerPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function parseIntervalMinutes(xml) {
  const raw = tag(xml, 'Interval');
  if (raw === null) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(raw);
  if (!match) return Number.NaN;
  return (Number(match[1] || 0) * 60) + Number(match[2] || 0);
}

function validLegacyBoundary(value, schedule) {
  if (typeof value !== 'string') return false;
  const pattern = schedule === 'daily'
    ? /^\d{4}-\d{2}-\d{2}T00:05:00$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/;
  return pattern.test(value) && Number.isFinite(Date.parse(value));
}

function inspectLegacyXml(xml, input) {
  const spec = assertLegacySpec(input);
  if (typeof xml !== 'string' || !xml.trim()) return { state: 'unknown', exact: false, owned: false, reason: 'empty-xml' };
  const task = section(xml, 'Task');
  const registration = section(task, 'RegistrationInfo');
  const triggers = section(xml, 'Triggers');
  const calendar = section(triggers, 'CalendarTrigger');
  const timeTrigger = section(triggers, 'TimeTrigger');
  const repetition = section(timeTrigger, 'Repetition');
  const scheduleByDay = section(calendar, 'ScheduleByDay');
  const principals = section(xml, 'Principals');
  const principal = section(principals, 'Principal');
  const settings = section(xml, 'Settings');
  const idleSettings = section(settings, 'IdleSettings');
  const actions = section(xml, 'Actions');
  const exec = section(actions, 'Exec');

  const registrationDate = tag(registration, 'Date');
  const registrationDateMs = registrationDate === null ? Number.NaN : Date.parse(registrationDate);
  const taskExact = sameChildren(task, ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions']);
  const registrationExact = sameChildren(registration, ['Date', 'Author', 'URI'])
    && oneTagEquals(registration, 'URI', spec.taskName, false)
    && oneTagEquals(registration, 'Author', spec.principalName)
    && Number.isFinite(registrationDateMs)
    && registrationDateMs >= spec.createdAtMs - 2_000
    && registrationDateMs <= spec.createdAtMs + 10 * 60_000;
  const actionExact = sameChildren(actions, ['Exec'])
    && sameChildren(exec, ['Command', 'Arguments'])
    && oneOpeningTagHasAttribute(xml, 'Actions', 'Context', 'Author')
    && oneTagEquals(exec, 'Command', '/d', false)
    && oneTagEquals(exec, 'Arguments', legacyRunnerArguments(spec), false);
  const principalExact = sameChildren(principals, ['Principal'])
    && onlyChildren(principal, ['UserId', 'LogonType', 'RunLevel'], ['UserId', 'LogonType'])
    && oneOpeningTagHasAttribute(principals, 'Principal', 'id', 'Author')
    && oneTagEquals(principal, 'UserId', spec.principalId)
    && oneTagEquals(principal, 'LogonType', 'InteractiveToken')
    && tagEqualsOrDefault(principal, 'RunLevel', 'LeastPrivilege', 'LeastPrivilege');
  const start = tag(spec.schedule === 'daily' ? calendar : timeTrigger, 'StartBoundary');
  const startMs = start === null ? Number.NaN : Date.parse(start);
  const scheduleExact = spec.schedule === 'daily'
    ? sameChildren(triggers, ['CalendarTrigger'])
      && onlyChildren(calendar, ['StartBoundary', 'Enabled', 'ScheduleByDay'], ['StartBoundary', 'ScheduleByDay'])
      && validLegacyBoundary(start, 'daily')
      && typeof registrationDate === 'string' && start.slice(0, 10) === registrationDate.slice(0, 10)
      && tagEqualsOrDefault(calendar, 'Enabled', 'true', 'true')
      && sameChildren(scheduleByDay, ['DaysInterval'])
      && oneTagEquals(scheduleByDay, 'DaysInterval', '1', false)
    : sameChildren(triggers, ['TimeTrigger'])
      && onlyChildren(timeTrigger, ['StartBoundary', 'Enabled', 'Repetition'], ['StartBoundary', 'Repetition'])
      && validLegacyBoundary(start, 'hourly')
      && Number.isFinite(startMs) && startMs >= registrationDateMs - 2 * 60_000 && startMs <= registrationDateMs + 2_000
      && tagEqualsOrDefault(timeTrigger, 'Enabled', 'true', 'true')
      && onlyChildren(repetition, ['Interval', 'StopAtDurationEnd'], ['Interval'])
      && parseIntervalMinutes(repetition) === 60
      && tagEqualsOrDefault(repetition, 'StopAtDurationEnd', 'false', 'false');
  const legacySettings = {
    MultipleInstancesPolicy: 'IgnoreNew', DisallowStartIfOnBatteries: 'true', StopIfGoingOnBatteries: 'true',
    AllowHardTerminate: 'true', StartWhenAvailable: 'false', RunOnlyIfNetworkAvailable: 'false',
    AllowStartOnDemand: 'true', Enabled: 'true', Hidden: 'false', RunOnlyIfIdle: 'false', WakeToRun: 'false',
    ExecutionTimeLimit: 'PT72H', DisallowStartOnRemoteAppSession: 'false', UseUnifiedSchedulingEngine: 'false', Priority: '7'
  };
  const legacyDefaults = { ...legacySettings };
  const settingsExact = onlyChildren(settings, [...Object.keys(legacySettings), 'IdleSettings'], ['IdleSettings'])
    && Object.entries(legacySettings).every(([name, expected]) => tagEqualsOrDefault(settings, name, expected, legacyDefaults[name]))
    && sameChildren(idleSettings, ['Duration', 'WaitTimeout', 'StopOnIdleEnd', 'RestartOnIdle'])
    && oneTagEquals(idleSettings, 'Duration', 'PT10M', false)
    && oneTagEquals(idleSettings, 'WaitTimeout', 'PT1H', false)
    && oneTagEquals(idleSettings, 'StopOnIdleEnd', 'true')
    && oneTagEquals(idleSettings, 'RestartOnIdle', 'false');

  const evidenceHash = crypto.createHash('sha256').update(xml, 'utf8').digest('hex');
  if (!taskExact || !registrationExact || !actionExact || !principalExact || !scheduleExact || !settingsExact) {
    let reason = 'legacy-settings-mismatch';
    if (!taskExact || !registrationExact || !actionExact) reason = 'legacy-identity-mismatch';
    else if (!principalExact) reason = 'legacy-principal-mismatch';
    else if (!scheduleExact) reason = 'legacy-schedule-mismatch';
    return { state: 'foreign', exact: false, owned: false, reason, evidenceHash };
  }
  return { state: 'present', exact: true, owned: true, reason: 'legacy-exact', evidenceHash };
}

function inspectXml(xml, input) {
  const spec = assertSpec(input);
  if (typeof xml !== 'string' || !xml.trim()) {
    return { state: 'unknown', exact: false, owned: false, reason: 'empty-xml' };
  }
  const registration = section(xml, 'RegistrationInfo');
  const triggers = section(xml, 'Triggers');
  const calendar = section(triggers, 'CalendarTrigger');
  const timeTrigger = section(triggers, 'TimeTrigger');
  const scheduleByDay = section(calendar, 'ScheduleByDay');
  const principals = section(xml, 'Principals');
  const principal = section(principals, 'Principal');
  const settings = section(xml, 'Settings');
  const idleSettings = section(settings, 'IdleSettings');
  const actions = section(xml, 'Actions');
  const exec = section(actions, 'Exec');
  const uri = tag(registration, 'URI');
  const command = tag(exec, 'Command');
  const args = tag(exec, 'Arguments');
  const description = tag(registration, 'Description');
  const workingDirectory = tag(exec, 'WorkingDirectory');
  const identityExact = uri === spec.taskName
    && command !== null && normalizedWindowsPath(command) === normalizedWindowsPath(spec.nodePath)
    && args === runnerArguments(spec)
    && description === ownershipDescription(spec)
    && workingDirectory !== null && normalizedWindowsPath(workingDirectory) === normalizedWindowsPath(path.dirname(spec.runnerPath));
  if (!identityExact) return { state: 'foreign', exact: false, owned: false, reason: 'ownership-mismatch' };

  const expectedInterval = repetitionMinutes(spec);
  const repetition = section(expectedInterval === null ? calendar : timeTrigger, 'Repetition');
  const interval = parseIntervalMinutes(repetition);
  const scheduleExact = expectedInterval === null
    ? sameChildren(triggers, ['CalendarTrigger'])
      && onlyChildren(calendar, ['StartBoundary', 'Enabled', 'ScheduleByDay'], ['StartBoundary', 'ScheduleByDay'])
      && oneTagEquals(calendar, 'StartBoundary', '2000-01-01T00:05:00', false)
      && tagEqualsOrDefault(calendar, 'Enabled', 'true', 'true')
      && sameChildren(scheduleByDay, ['DaysInterval'])
      && oneTagEquals(scheduleByDay, 'DaysInterval', '1', false)
      && sameChildren(repetition, [])
    : sameChildren(triggers, ['TimeTrigger'])
      && onlyChildren(timeTrigger, ['StartBoundary', 'Enabled', 'Repetition'], ['StartBoundary', 'Repetition'])
      && oneTagEquals(timeTrigger, 'StartBoundary', '2000-01-01T00:05:00', false)
      && tagEqualsOrDefault(timeTrigger, 'Enabled', 'true', 'true')
      && onlyChildren(repetition, ['Interval', 'StopAtDurationEnd'], ['Interval'])
      && interval === expectedInterval
      && tagEqualsOrDefault(repetition, 'StopAtDurationEnd', 'false', 'false');
  const principalExact = sameChildren(principals, ['Principal'])
    && onlyChildren(principal, ['UserId', 'LogonType', 'RunLevel'], ['UserId', 'LogonType'])
    && oneOpeningTagHasAttribute(principals, 'Principal', 'id', 'Author')
    && oneTagEquals(principal, 'UserId', spec.principalId)
    && oneTagEquals(principal, 'LogonType', 'InteractiveToken')
    && tagEqualsOrDefault(principal, 'RunLevel', 'LeastPrivilege', 'LeastPrivilege');
  const expectedSettings = {
    MultipleInstancesPolicy: 'IgnoreNew',
    DisallowStartIfOnBatteries: 'false',
    StopIfGoingOnBatteries: 'false',
    AllowHardTerminate: 'true',
    StartWhenAvailable: 'true',
    RunOnlyIfNetworkAvailable: 'false',
    AllowStartOnDemand: 'true',
    Enabled: 'true',
    Hidden: 'false',
    RunOnlyIfIdle: 'false',
    WakeToRun: 'false',
    ExecutionTimeLimit: SCHEDULER_TASK_EXECUTION_LIMIT,
    DisallowStartOnRemoteAppSession: 'false',
    UseUnifiedSchedulingEngine: 'true',
    Priority: '7'
  };
  const settingDefaults = {
    MultipleInstancesPolicy: 'IgnoreNew',
    DisallowStartIfOnBatteries: 'true',
    StopIfGoingOnBatteries: 'true',
    AllowHardTerminate: 'true',
    StartWhenAvailable: 'false',
    RunOnlyIfNetworkAvailable: 'false',
    AllowStartOnDemand: 'true',
    Enabled: 'true',
    Hidden: 'false',
    RunOnlyIfIdle: 'false',
    WakeToRun: 'false',
    ExecutionTimeLimit: 'PT72H',
    DisallowStartOnRemoteAppSession: 'false',
    UseUnifiedSchedulingEngine: 'false',
    Priority: '7'
  };
  const settingsExact = onlyChildren(settings, [...Object.keys(expectedSettings), 'IdleSettings'], [
    'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries', 'StartWhenAvailable', 'IdleSettings',
    'ExecutionTimeLimit', 'UseUnifiedSchedulingEngine'
  ])
    && Object.entries(expectedSettings).every(([name, expected]) => tagEqualsOrDefault(settings, name, expected, settingDefaults[name]))
    && sameChildren(idleSettings, ['StopOnIdleEnd', 'RestartOnIdle'])
    && oneTagEquals(idleSettings, 'StopOnIdleEnd', 'false')
    && oneTagEquals(idleSettings, 'RestartOnIdle', 'false');
  const actionsExact = sameChildren(actions, ['Exec'])
    && sameChildren(exec, ['Command', 'Arguments', 'WorkingDirectory'])
    && oneOpeningTagHasAttribute(xml, 'Actions', 'Context', 'Author')
    && tagValues(exec, 'Command').length === 1
    && tagValues(exec, 'Arguments').length === 1
    && tagValues(exec, 'WorkingDirectory').length === 1;
  const registrationExact = sameChildren(registration, ['Description', 'URI'])
    && tagValues(registration, 'Description').length === 1
    && tagValues(registration, 'URI').length === 1;
  if (!registrationExact || !scheduleExact || !principalExact || !settingsExact || !actionsExact) {
    let reason = 'settings-drift';
    if (!registrationExact) reason = 'registration-drift';
    else if (!scheduleExact) reason = 'schedule-drift';
    else if (!principalExact) reason = 'principal-drift';
    else if (!actionsExact) reason = 'action-drift';
    return { state: 'owned-drift', exact: false, owned: true, reason };
  }
  return { state: 'present', exact: true, owned: true, reason: 'exact' };
}

function unsignedStatus(status) {
  if (!Number.isInteger(status)) return null;
  return status >>> 0;
}

function publicCommandObservation(result) {
  return {
    commandStatus: Number.isInteger(result && result.status) ? unsignedStatus(result.status) : null,
    commandErrorCode: result && result.errorCode ? String(result.errorCode).slice(0, 100) : undefined,
    stdoutPresent: Boolean(result && result.stdout),
    stderrPresent: Boolean(result && result.stderr)
  };
}

function createWindowsSchedulerAdapter(dependencies = {}) {
  const run = dependencies.run || defaultRun;
  const tempRoot = dependencies.tempRoot || os.tmpdir();

  function inspect(input) {
    const spec = assertSpec(input);
    let result;
    try {
      result = run(schtasksPath(), ['/query', '/tn', spec.taskName, '/xml', '/hresult'], { timeout: 30_000 });
    } catch (error) {
      return {
        state: 'unknown', exact: false, owned: false, reason: 'query-threw',
        commandStatus: null, commandErrorCode: String(error && error.code || 'QUERY_FAILED').slice(0, 100)
      };
    }
    const status = unsignedStatus(result.status);
    if (status === 0) return { ...inspectXml(result.stdout, spec), commandStatus: status };
    if (status === TASK_NOT_FOUND_HRESULT) return { state: 'absent', exact: true, owned: false, reason: 'not-found', commandStatus: status };
    return { state: 'unknown', exact: false, owned: false, reason: 'query-failed', ...publicCommandObservation(result) };
  }

  function inspectLegacy(input) {
    const spec = assertLegacySpec(input);
    let result;
    try {
      result = run(schtasksPath(), ['/query', '/tn', spec.taskName, '/xml', '/hresult'], { timeout: 30_000 });
    } catch (error) {
      return {
        state: 'unknown', exact: false, owned: false, reason: 'query-threw',
        commandStatus: null, commandErrorCode: String(error && error.code || 'QUERY_FAILED').slice(0, 100)
      };
    }
    const status = unsignedStatus(result.status);
    if (status === 0) return { ...inspectLegacyXml(result.stdout, spec), commandStatus: status };
    if (status === TASK_NOT_FOUND_HRESULT) return { state: 'absent', exact: true, owned: false, reason: 'not-found', commandStatus: status };
    return { state: 'unknown', exact: false, owned: false, reason: 'query-failed', ...publicCommandObservation(result) };
  }

  function mutate(operation, spec, beforeMutation) {
    if (typeof beforeMutation === 'function') {
      try { beforeMutation({ operation, spec }); }
      catch (error) {
        // Callers must distinguish a fail-closed audit/policy rejection (where
        // no command ran) from an ambiguous command exception that requires
        // post-effect inspection.
        Object.defineProperty(error, 'schedulerMutationNotStarted', { value: true, configurable: true });
        throw error;
      }
    }
    if (operation === 'delete') {
      return run(schtasksPath(), ['/delete', '/tn', spec.taskName, '/f', '/hresult'], { timeout: 30_000 });
    }
    const directory = fs.mkdtempSync(path.join(tempRoot, 'toolsenabled-scheduler-'));
    const file = path.join(directory, 'task.xml');
    try {
      // A BOM keeps Task Scheduler's XML decoder unambiguous; the declaration
      // and byte encoding are both UTF-16LE.
      fs.writeFileSync(file, `\ufeff${buildTaskXml(spec)}`, { encoding: 'utf16le', flag: 'wx', mode: 0o600 });
      return run(schtasksPath(), ['/create', '/tn', spec.taskName, '/xml', file, '/hresult'], { timeout: 30_000 });
    } finally {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort removal of non-secret task XML. */ }
    }
  }

  function attemptedMutation(operation, spec, beforeMutation) {
    try { return { result: mutate(operation, spec, beforeMutation), error: null }; }
    catch (error) {
      if (error && error.schedulerMutationNotStarted === true) throw error;
      return { result: { errorCode: error && error.code || 'COMMAND_FAILED' }, error };
    }
  }

  function ensure(input, options = {}) {
    const spec = assertSpec(input);
    let before = inspect(spec);
    if (before.state === 'present') return { changed: false, observation: before };
    if (before.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_FOREIGN_TASK', 'A foreign task occupies the immutable ToolsEnabled task name.', { retryable: false, observation: before });
    }
    if (before.state === 'unknown') {
      throw new SchedulerAdapterError('SCHEDULER_INSPECTION_UNKNOWN', 'Task Scheduler could not prove whether the task exists.', { retryable: true, uncertain: true, observation: before });
    }
    let changed = false;
    if (before.state === 'owned-drift') {
      const deletion = attemptedMutation('delete', spec, options.beforeMutation);
      changed = true;
      const afterDelete = inspect(spec);
      if (afterDelete.state !== 'absent') {
        if (afterDelete.state === 'foreign') {
          throw new SchedulerAdapterError('SCHEDULER_OWNERSHIP_CHANGED', 'Task ownership changed while repairing scheduler drift.', { retryable: false, observation: afterDelete });
        }
        const uncertain = afterDelete.state === 'unknown';
        throw new SchedulerAdapterError(uncertain ? 'SCHEDULER_DELETE_UNCERTAIN' : 'SCHEDULER_DELETE_FAILED',
          uncertain ? 'Task Scheduler did not prove the owned drifted task was removed.' : 'Task Scheduler definitively left the drifted task present.', {
            retryable: true, uncertain, observation: { ...afterDelete, command: publicCommandObservation(deletion.result) }
          });
      }
      before = afterDelete;
    }
    const command = attemptedMutation('create', spec, options.beforeMutation);
    changed = true;
    const after = inspect(spec);
    if (after.state === 'present') return { changed, observation: after, command: publicCommandObservation(command.result) };
    if (after.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_CREATE_COLLISION', 'A non-matching task appeared at the immutable task name.', { retryable: false, observation: after });
    }
    const uncertain = after.state === 'unknown';
    throw new SchedulerAdapterError(
      uncertain ? 'SCHEDULER_CREATE_UNCERTAIN' : 'SCHEDULER_CREATE_FAILED',
      uncertain ? 'Task creation outcome is unknown after inspection.' : 'Task Scheduler did not create the expected task.',
      { retryable: true, uncertain, observation: { ...after, command: publicCommandObservation(command.result) } }
    );
  }

  function remove(input, options = {}) {
    const spec = assertSpec(input);
    const before = inspect(spec);
    if (before.state === 'absent') return { changed: false, observation: before };
    if (before.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_FOREIGN_TASK', 'Refusing to delete a task whose exact ToolsEnabled ownership cannot be proven.', { retryable: false, observation: before });
    }
    if (before.state === 'unknown') {
      throw new SchedulerAdapterError('SCHEDULER_INSPECTION_UNKNOWN', 'Task Scheduler could not prove whether the task is safe to delete.', { retryable: true, uncertain: true, observation: before });
    }
    const command = attemptedMutation('delete', spec, options.beforeMutation);
    const after = inspect(spec);
    if (after.state === 'absent') return { changed: true, observation: after, command: publicCommandObservation(command.result) };
    if (after.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_DELETE_OWNERSHIP_CHANGED', 'Task ownership changed during deletion; the task was left untouched after inspection.', { retryable: false, observation: after });
    }
    throw new SchedulerAdapterError('SCHEDULER_DELETE_UNCERTAIN', 'Task deletion outcome is unknown after inspection.', {
      retryable: true, uncertain: after.state === 'unknown', observation: { ...after, command: publicCommandObservation(command.result) }
    });
  }

  function removeLegacy(input, options = {}) {
    const spec = assertLegacySpec(input);
    const before = inspectLegacy(spec);
    if (before.state === 'absent') return { changed: false, observation: before };
    if (before.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_LEGACY_TASK_CONFLICT',
        'Refusing to delete a legacy-named task whose complete pre-saga definition does not match.', {
          retryable: false, observation: before
        });
    }
    if (before.state === 'unknown') {
      throw new SchedulerAdapterError('SCHEDULER_LEGACY_INSPECTION_UNKNOWN',
        'Task Scheduler could not prove whether the legacy task is safe to delete.', {
          retryable: true, uncertain: true, observation: before
        });
    }
    const command = attemptedMutation('delete', spec, event => {
      if (typeof options.beforeMutation === 'function') options.beforeMutation({ ...event, observation: before });
    });
    const after = inspectLegacy(spec);
    if (after.state === 'absent') return { changed: true, observation: after, command: publicCommandObservation(command.result) };
    if (after.state === 'foreign') {
      throw new SchedulerAdapterError('SCHEDULER_LEGACY_OWNERSHIP_CHANGED',
        'Legacy task ownership changed during deletion; no further mutation was attempted.', {
          retryable: false, observation: after
        });
    }
    throw new SchedulerAdapterError('SCHEDULER_LEGACY_DELETE_UNCERTAIN',
      'Task Scheduler did not prove the exact legacy task was removed.', {
        retryable: true, uncertain: after.state === 'unknown', observation: { ...after, command: publicCommandObservation(command.result) }
      });
  }

  return { inspect, inspectLegacy, ensure, remove, removeLegacy };
}

module.exports = {
  MAX_TASK_NAME,
  SchedulerAdapterError,
  TASK_NOT_FOUND_HRESULT,
  buildTaskXml,
  createWindowsSchedulerAdapter,
  inspectLegacyXml,
  inspectXml,
  legacyRunnerArguments,
  ownershipDescription,
  resolveCurrentPrincipalIdentity,
  resolveCurrentPrincipalId,
  resolveCurrentPrincipalName,
  runnerArguments,
  unsignedStatus
};
