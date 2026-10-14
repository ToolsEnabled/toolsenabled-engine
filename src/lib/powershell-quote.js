'use strict';

// PowerShell recognizes straight and typographic single-quote delimiters.
function powerShellSingleQuoted(value) {
  return "'" + String(value).replace(/['\u2018-\u201b]/g, quote => quote + quote) + "'";
}
module.exports = { powerShellSingleQuoted };
