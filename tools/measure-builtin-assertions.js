#!/usr/bin/env node
'use strict';

// Opt-in only. The parent must own the offline sandbox/process guardian and
// reconcile this trace with its independently retained child process result.
const fs = require('node:fs');
const { installMeasurement } = require('./lib/builtin-assertion-evidence');
if (process.argv.length !== 4 || process.argv[2] !== '--request') throw new Error('usage: node tools/measure-builtin-assertions.js --request ABSOLUTE_REQUEST_JSON');
const request = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
installMeasurement(request).run();
