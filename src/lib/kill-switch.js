'use strict';

const fs = require('node:fs');
const { killSwitchPath } = require('./policy');

function path() { return killSwitchPath(); }

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function statusAt(killFile) {
  try {
    fs.statSync(killFile);
    return { active: true, path: killFile };
  } catch (error) {
    if (isMissing(error)) return { active: false, path: killFile };
    throw error;
  }
}

function status() { return statusAt(path()); }
function activate() { const killFile = path(); fs.writeFileSync(killFile, `ToolsEnabled kill switch activated ${new Date().toISOString()}\n`, { encoding: 'utf8', flag: 'w' }); return statusAt(killFile); }
function deactivate() { const killFile = path(); try { fs.unlinkSync(killFile); } catch (error) { if (!isMissing(error)) throw error; } return statusAt(killFile); }

module.exports = { status, activate, deactivate };
