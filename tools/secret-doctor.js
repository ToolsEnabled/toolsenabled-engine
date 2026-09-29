#!/usr/bin/env node
'use strict';

const { doctor } = require('../src/lib/secret-store/doctor');

function parse(argv) {
  const options = {};
  let compact = false;
  function valueAfter(index) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw Object.assign(new Error('Unknown secret doctor argument.'), { code: 'SECRET_DOCTOR_ARGUMENT_INVALID' });
    }
    return value;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--compact') compact = true;
    else if (flag === '--as-of') options.asOf = valueAfter(index++);
    else if (flag === '--expiring-within-days') options.expiringWithinDays = Number(valueAfter(index++));
    else throw Object.assign(new Error('Unknown secret doctor argument.'), { code: 'SECRET_DOCTOR_ARGUMENT_INVALID' });
  }
  return { compact, options };
}

try {
  const { compact, options } = parse(process.argv.slice(2));
  const result = doctor(options);
  process.stdout.write(`${JSON.stringify(result, null, compact ? 0 : 2)}\n`);
  process.exitCode = result.ok ? 0 : 2;
} catch (error) {
  const code = typeof error.code === 'string' && /^SECRET_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'SECRET_DOCTOR_FAILED';
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message: 'Secret doctor could not complete.' } })}\n`);
  process.exitCode = 1;
}
