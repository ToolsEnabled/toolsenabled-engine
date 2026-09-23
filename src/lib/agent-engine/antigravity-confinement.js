'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SCOPE_ENV } = require('../../../tools/antigravity-mcp-owner-proxy');
const SERVER = 'toolsenabled-research';
const AGENT = 'toolsenabled-research-only';
function refuse(message) { throw Object.assign(new Error(message), { code: 'AGY_CLI_BOUNDARY_UNAVAILABLE' }); }
function readConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262_144) refuse('Antigravity configuration is not a regular bounded file.');
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/* Durable ownership receipt for the generated registration: proves which
 * exact content this code itself wrote, so a generation change (a new
 * absolute wrapper path) can refresh a matching registration instead of
 * refusing our own prior write as foreign. Trusted only by a recorded hash,
 * never by name or path. Bounded to two entries -- the content still
 * provably on disk, plus a newly staged one -- staged before the shared
 * config write and committed to one entry after it succeeds, so either half
 * of an interrupted write is recoverable from what is actually on disk. A
 * receipt that does not exist is safe to create; one that exists but does
 * not validate is refused, never silently replaced. writeAtomic is rename
 * atomicity (a reader never sees a torn file), not an fsync durability
 * proof against real power loss -- see tests/antigravity-confinement.test.js
 * and the commit history for the defect, the write-ordering proof and that
 * limitation. */
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_FILE = 'toolsenabled-registration-receipt.json';
const RECEIPT_MAX_BYTES = 4096;
const RECEIPT_HASH_RE = /^[0-9a-f]{64}$/;
function hashOf(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function receiptShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'owned,schemaVersion,server') return null;
  if (parsed.schemaVersion !== RECEIPT_SCHEMA_VERSION || parsed.server !== SERVER) return null;
  if (!Array.isArray(parsed.owned) || parsed.owned.length > 2) return null;
  const owned = [];
  for (const entry of parsed.owned) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (Object.keys(entry).sort().join(',') !== 'recordedAtMs,sha256,state') return null;
    if (typeof entry.sha256 !== 'string' || !RECEIPT_HASH_RE.test(entry.sha256)) return null;
    if (entry.state !== 'confirmed' && entry.state !== 'staged') return null;
    if (!Number.isSafeInteger(entry.recordedAtMs) || entry.recordedAtMs < 0) return null;
    owned.push({ sha256: entry.sha256, state: entry.state, recordedAtMs: entry.recordedAtMs });
  }
  return owned;
}
/* { present, owned }. present:false is ENOENT -- a receipt that never
   existed, safe to create. present:true with owned:null is a file that IS
   there but does not validate (symlink, not a regular file, oversized,
   unparsable, or off the exact schema) -- proves nothing, and the caller
   must refuse rather than call writeReceipt over it. */
function readReceipt(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { present: false, owned: [] }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RECEIPT_MAX_BYTES) return { present: true, owned: null };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { present: true, owned: null }; }
  return { present: true, owned: receiptShape(parsed) };
}
function writeReceipt(file, owned, writeAtomic) {
  writeAtomic(file, JSON.stringify({ schemaVersion: RECEIPT_SCHEMA_VERSION, server: SERVER, owned }, null, 2) + '\n');
}
function assertNoAmbientExtensions(accountHome) {
  const root = path.join(accountHome, '.gemini', 'config');
  for (const name of ['hooks.json', 'plugins.json', 'skills.json', 'hooks', 'plugins']) {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      if (stat.isSymbolicLink() || (stat.isDirectory() ? fs.readdirSync(path.join(root, name)).length : stat.size)) {
        refuse('Use a dedicated Antigravity profile without startup extensions.');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function prepareAntigravitySurface({ directory, configDir, entries, env, account, agentApiMode, writeAtomic }) {
  if (agentApiMode !== 'Only' || !account || !path.isAbsolute(configDir || '')) refuse('Antigravity requires a selected account and ToolsEnabled-only tools.');
  const selected = entries.find(([name]) => name === 'toolsenabled') || entries.find(([name]) => name === 'toolsenabled-readonly');
  if (!selected || entries.some(([name]) => !['toolsenabled', 'toolsenabled-readonly'].includes(name))) refuse('The Antigravity Research tool surface is unavailable.');
  const entry = selected[1];
  const script = entry.args.find(argument => path.isAbsolute(argument) && /[\\/]src[\\/]mcp-server\.js$/.test(argument));
  if (!script) refuse('The selected tool server is not the installed owner-session entry.');
  const wrapper = path.join(path.dirname(path.dirname(script)), 'tools', 'antigravity-mcp-owner-proxy.js');
  if (!fs.statSync(wrapper).isFile()) refuse('The paired Antigravity tool launcher is missing.');
  const staticEnvironment = Object.fromEntries(Object.entries(entry.env || {}).filter(([name]) => ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(name)));
  const registration = { command: entry.command, args: entry.args.map(argument => argument === script ? wrapper : argument),
    cwd: entry.cwd, env: staticEnvironment };
  const root = path.join(configDir, '.gemini', 'config');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoAmbientExtensions(configDir);
  const mcpFile = path.join(root, 'mcp_config.json');
  const mcp = readConfig(mcpFile);
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp) || (mcp.mcpServers && (typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers)))) refuse('The Antigravity MCP configuration is invalid.');
  const servers = mcp.mcpServers || {};
  if (Object.keys(servers).some(name => name !== SERVER)) refuse('This Antigravity profile has tools outside the Research boundary.');
  const receiptFile = path.join(root, RECEIPT_FILE);
  const registrationText = JSON.stringify(registration);
  const newHash = hashOf(registrationText);
  const priorText = servers[SERVER] ? JSON.stringify(servers[SERVER]) : null;
  const changed = priorText !== registrationText;
  const receiptRead = readReceipt(receiptFile);
  /* A receipt file that EXISTS but does not validate proves nothing and must
     never be written over blind -- refused here, before anything below could
     call writeReceipt on it. ENOENT (receiptRead.present === false) is the
     ordinary, safe-to-create absence and is not this. */
  if (receiptRead.present && receiptRead.owned === null) refuse('The Antigravity registration receipt is not a valid, regular bounded file.');
  const owned = receiptRead.owned;
  let priorHash = null;
  if (changed && priorText !== null) {
    priorHash = hashOf(priorText);
    /* Refused unless THIS registration's exact prior content is one a receipt
       this module itself wrote already recorded -- never because the name or
       the path merely looks like an earlier generation of ours. */
    if (!owned.some(entry => entry.sha256 === priorHash)) refuse('The Antigravity Research name is already configured differently. Use a dedicated account profile.');
  }
  const settled = !changed && owned.length === 1
    && owned[0].sha256 === newHash && owned[0].state === 'confirmed';
  if (!settled) {
    if (changed) {
      /* Carry ONLY the entry proving what is actually still on disk, never
         the receipt's whole prior history -- a stale entry from an earlier
         uncommitted attempt must not be able to evict it once bounded to
         two. See tests/antigravity-confinement.test.js for the repeated-
         interruption case this guards. */
      const priorEntry = priorHash !== null ? owned.find(entry => entry.sha256 === priorHash) : null;
      const staged = [...(priorEntry ? [priorEntry] : []), { sha256: newHash, state: 'staged', recordedAtMs: Date.now() }];
      writeReceipt(receiptFile, staged, writeAtomic);
      const expectedMcp = JSON.stringify({ ...mcp, mcpServers: { ...servers, [SERVER]: registration } }, null, 2) + '\n';
      writeAtomic(mcpFile, expectedMcp);
    }
    writeReceipt(receiptFile, [{ sha256: newHash, state: 'confirmed', recordedAtMs: Date.now() }], writeAtomic);
  }

  // Native 1.2.0 applies the selected custom agent's tools list during executor
  // construction. Its init.tools is the broad advertised catalog, not this
  // effective list. MCP is injected separately: adding call_mcp_tool here is
  // an unknown component and prevents construction of the executor.
  const agentFile = path.join(root, 'agents', AGENT + '.md');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  const agentText = '---\n' + JSON.stringify({ name: AGENT, description: 'Research using only this app session’s ToolsEnabled tools',
    tools: [], mainAgent: true, subagent: false, commandExecutionPolicy: 'off', skills: [], plugins: [] }, null, 2)
    + '\n---\nUse only the ToolsEnabled tools supplied for this Research session.\n';
  try {
    const stat = fs.lstatSync(agentFile);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.readFileSync(agentFile, 'utf8') !== agentText) refuse('The Antigravity Research agent name is already configured differently.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; writeAtomic(agentFile, agentText); }
  const settingsFile = path.join(configDir, '.gemini', 'antigravity-cli', 'settings.json');
  const settings = readConfig(settingsFile);
  const rule = `mcp(${SERVER}/*)`;
  const allow = settings.permissions?.allow || [];
  if (!Array.isArray(allow)) refuse('Antigravity permissions cannot be read.');
  if (!allow.includes(rule)) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeAtomic(settingsFile, JSON.stringify({ ...settings, permissions: { ...settings.permissions, allow: [...allow, rule] } }, null, 2) + '\n');
  }
  const boundaryFiles = [{ file: agentFile, sha256: crypto.createHash('sha256').update(agentText).digest('hex') }];
  return Object.freeze({ configDir, account, servers: Object.freeze([SERVER]),
    env: Object.freeze({ ...env, [SCOPE_ENV]: JSON.stringify({ version: 1, environment: entry.env || {} }) }),
    antigravity: Object.freeze({ contractVersion: 1, accountHome: configDir, cwd: directory, agent: AGENT,
      tools: Object.freeze(['call_mcp_tool']), servers: Object.freeze([SERVER]), boundaryFiles: Object.freeze(boundaryFiles),
      mcpFile, registration }) });
}

function assertAntigravitySurface(surface) {
  assertNoAmbientExtensions(surface.accountHome);
  for (const { file, sha256 } of surface.boundaryFiles || []) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) refuse('The generated Antigravity Research profile changed.');
  }
  const current = readConfig(surface.mcpFile).mcpServers;
  if (!current || Object.keys(current).join(',') !== SERVER || JSON.stringify(current[SERVER]) !== JSON.stringify(surface.registration)) refuse('The Antigravity tool registration changed.');
}
module.exports = { prepareAntigravitySurface, assertAntigravitySurface, SERVER, AGENT };
