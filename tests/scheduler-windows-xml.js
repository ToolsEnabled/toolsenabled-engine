'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildTaskXml, inspectXml } = require('../src/lib/scheduler-adapter');

if (process.platform !== 'win32') {
  process.stdout.write('scheduler Windows XML validation skipped (non-Windows)\n');
  process.exit(0);
}

const installationId = 'a'.repeat(32);
const jobId = 'scheduler-job-windows-xml-test';
const generation = 1;
const baseSpec = {
  version: 1,
  installationId,
  jobId,
  generation,
  taskName: `\\ToolsEnabled-v2-${installationId.slice(0, 12)}-${crypto.createHash('sha256').update(jobId, 'utf8').digest('hex').slice(0, 16)}-g${generation}`,
  ownershipMarker: 'b'.repeat(64),
  nodePath: process.execPath,
  runnerPath: require('node:path').resolve(__dirname, '..', 'src', 'job-runner.js'),
  principalId: 'S-1-5-21-111111111-222222222-333333333-1001',
  action: 'telegram.send',
  args: { chatId: 'test', text: 'test' }
};
const script = [
  "$ErrorActionPreference = 'Stop'",
  "$service = New-Object -ComObject 'Schedule.Service'",
  '$service.Connect()',
  '$definition = $service.NewTask(0)',
  '$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TOOLSENABLED_TASK_XML_B64))',
  '$definition.XmlText = $source',
  '$normalized = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($definition.XmlText))',
  '[Console]::Out.Write($normalized)'
].join('; ');
for (const schedule of [
  { schedule: 'daily', intervalMinutes: null },
  { schedule: 'hourly', intervalMinutes: null },
  { schedule: 'minutes', intervalMinutes: 7 }
]) {
  const spec = { ...baseSpec, ...schedule };
  const xml = buildTaskXml(spec);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, TOOLSENABLED_TASK_XML_B64: Buffer.from(xml, 'utf8').toString('base64') }
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, String(result.stderr || 'Task Scheduler XML validation failed.'));
  const normalized = Buffer.from(String(result.stdout).trim(), 'base64').toString('utf8');
  const observed = inspectXml(normalized, spec);
  assert.equal(observed.state, 'present', `Task Scheduler COM normalization must preserve an exact ${schedule.schedule} registration (${observed.reason}).`);
}
process.stdout.write('scheduler Windows XML validation passed for daily/hourly/minutes (no task registered)\n');
