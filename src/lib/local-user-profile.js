'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Opt-in data layout. The marker contains no paths or credentials and is never
// part of an application payload. All service state stays beside userData.
const LOCAL_PROFILE_MARKER = '.toolsenabled-local-profile.json';
function localProfileServicesRoot(stateRoot, { fileSystem = fs, assertPath = value => value } = {}) {
  const directory = path.dirname(stateRoot);
  const marker = assertPath(path.join(directory, LOCAL_PROFILE_MARKER));
  let stat;
  try { stat = fileSystem.lstatSync(marker); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const refuse = () => { throw Object.assign(new Error('The local user profile marker is invalid; existing settings were not replaced.'), { code: 'LOCAL_PROFILE_INVALID' }); };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) refuse();
  let value;
  try { value = JSON.parse(fileSystem.readFileSync(marker, 'utf8')); } catch { refuse(); }
  if (!value || value.schemaVersion !== 1 || value.services !== 'services'
      || Object.keys(value).sort().join(',') !== 'schemaVersion,services') refuse();
  const services = assertPath(path.join(directory, 'services'));
  let servicesStat;
  try { servicesStat = fileSystem.lstatSync(services); } catch { refuse(); }
  if (!servicesStat.isDirectory() || servicesStat.isSymbolicLink()) refuse();
  return services;
}

module.exports = { LOCAL_PROFILE_MARKER, localProfileServicesRoot };
