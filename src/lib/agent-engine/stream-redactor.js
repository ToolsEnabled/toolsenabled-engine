'use strict';

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION/i;
const REDACTED = '[REDACTED]';

// This blanks exact values from the child's environment when their names match
// the caller's credential list (case-insensitively) or SECRET_ENV_NAME above.
// Values are read only in memory for redaction; they are never logged, persisted
// or forwarded by this helper. It does not discover credentials in files or
// recognize encoded values. Values shorter than eight characters are excluded
// so common words and small configuration flags are not blanked.
function createEnvironmentRedactor(env, credentialNames = []) {
  const environment = env === undefined || env === null ? process.env : env;
  const names = new Set(credentialNames.map(name => name.toLowerCase()));
  const values = [];
  for (const name in environment) {
    if (!names.has(name.toLowerCase()) && !SECRET_ENV_NAME.test(name)) continue;
    const value = environment[name];
    if (value !== undefined && value !== null) values.push(String(value));
  }
  return createStreamRedactor(values);
}

function createStreamRedactor(values) {
  const secrets = [...new Set(values.filter(value => typeof value === 'string' && value.length >= 8))]
    .sort((left, right) => right.length - left.length);
  const longest = secrets[0]?.length || 1;
  const pattern = secrets.length
    ? new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  let pending = '';
  let ended = false;

  function drain(final) {
    // A match may begin anywhere in the last longest-1 characters. Decide
    // only earlier starts, and consume whole matches even across that boundary
    // so neither a credential prefix nor a chopped replacement is emitted.
    const safeEnd = final ? pending.length : Math.max(0, pending.length - longest + 1);
    if (!safeEnd) return '';
    const output = [];
    let cursor = 0;
    if (pattern) {
      pattern.lastIndex = 0;
      let match;
      while (cursor < safeEnd && (match = pattern.exec(pending)) && match.index < safeEnd) {
        output.push(pending.slice(cursor, match.index), REDACTED);
        cursor = pattern.lastIndex;
      }
    }
    const consumed = Math.max(cursor, safeEnd);
    output.push(pending.slice(cursor, consumed));
    pending = pending.slice(consumed);
    // Only the bounded undecided suffix is revisited on the next write. Work
    // is linear in incoming text for a fixed secret set, never in past output.
    return output.join('');
  }

  return Object.freeze({
    write(text) {
      // An early transport failure can publish exit before its pipes close.
      // Once finalized, discard later bytes rather than start a fresh match.
      if (ended) return '';
      pending += String(text);
      return drain(false);
    },
    end() {
      if (ended) return '';
      ended = true;
      return drain(true);
    }
  });
}

module.exports = Object.freeze({ createStreamRedactor, createEnvironmentRedactor });
