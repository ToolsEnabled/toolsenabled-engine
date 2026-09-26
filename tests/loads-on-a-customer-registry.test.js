'use strict';

// EVERY MODULE MUST BE LOADABLE ON A CUSTOMER'S MACHINE.
//
// THE DEFECT CLASS. A module-scope line like
//
//     const DASHBOARD_PORT = loadRegistry().services.dashboard.port;
//
// reads the service registry while the file is still being LOADED. The SHIPPED
// default registry (capability-defaults/config/service-registry.json) declares
// NO services -- deliberately, because the builder's registry describes the
// builder's own machines and none of that is any business of a customer. So on
// every customer install that line threw `TypeError: Cannot read properties of
// undefined (reading 'port')` before a single line of the module ran.
//
// A module-scope throw is the worst available shape. It takes down every
// importer whether or not they were going to use the value, it does it with a
// raw TypeError rather than one of this product's named refusals, and it is
// invisible in a developer checkout -- where the registry DOES declare a
// dashboard, so everything loads and every test passes.
//
// MEASURED, NOT HYPOTHETICAL. Against the registry actually installed on this
// machine, three modules failed to load outright: coordinator/duty-registry.js,
// owner-delivery.js and service-control.js. duty-registry is required by the
// coordinator's duty host, so the entire escalation path was unloadable on a
// fresh install. The same shape in a Telegram module had already done exactly
// that once, which is how the class was noticed.
//
// WHY THE REGISTRY IS SEEDED RATHER THAN SWAPPED ON DISK. Overwriting
// config/service-registry.json would mutate a shared checkout other lanes are
// working in, and would leave the wrong file behind if this process died. So
// the resolver is seeded through require.cache before anything imports it --
// the same technique tests/link-bus-smoke-test.js already uses -- which is
// contained entirely within this process.

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* The modules a customer's machine loads. Adding one here is cheap; the cost of
   leaving one out is that it fails on their machine and nowhere else. */
const MUST_LOAD = [
  'src/lib/coordinator/duty-registry.js',
  'src/lib/coordinator/escalation-sink.js',
  'src/lib/owner-delivery.js',
  'src/lib/service-control.js',
  'src/lib/agent-digest/index.js',
];

/* A registry shaped exactly like the one every customer gets: valid, complete,
   and declaring nothing. NOT an empty object -- the point is that it PARSES and
   still has no services, which is the case a `.services.dashboard.port` reach
   walks straight off the end of. */
const CUSTOMER_REGISTRY = { services: {}, machines: {} };

/* Each module is required in its OWN child process. In-process, one module's
   successful load would poison the next one's require.cache, and the first
   throw would end the run -- so a single failure would hide every module after
   it, which is the opposite of what this file is for. */
function loadsWithNoServices(relative) {
  const script = `
    const path = require('node:path');
    const registryPath = require.resolve(${JSON.stringify(path.join(ROOT, 'src/lib/service-registry.js'))});
    const real = require(registryPath);
    /* Seed the resolver BEFORE the module under test imports it. Everything
       else about it stays real: only the answer about what this installation
       declares is replaced. */
    const seeded = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      loadRegistry: () => (${JSON.stringify(CUSTOMER_REGISTRY)}),
      resolveServiceOrThrow: (id) => {
        const error = new Error('This installation declares no service named ' + id + '.');
        error.code = 'SERVICE_UNKNOWN';
        throw error;
      },
      resolveService: (id) => ({ ok: false, code: 'SERVICE_UNKNOWN', reason: 'not declared: ' + id }),
    });
    require.cache[registryPath].exports = seeded;
    require(${JSON.stringify(path.join(ROOT, relative))});
    process.stdout.write('LOADED');
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    return { ok: String(out).includes('LOADED'), detail: '' };
  } catch (error) {
    const stderr = String((error && error.stderr) || '');
    const first = stderr.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('at '));
    return { ok: false, detail: first || (error && error.message) || 'unknown' };
  }
}

let failures = 0;

for (const relative of MUST_LOAD) {
  const result = loadsWithNoServices(relative);
  if (!result.ok) {
    failures += 1;
    process.stderr.write(`  ${relative}\n    ${result.detail}\n`);
  }
}

assert.equal(failures, 0,
  `${failures} module(s) cannot be loaded on a machine whose service registry declares nothing -- `
  + 'which is every customer machine. Resolve the service when it is needed, not while the file loads.');

/* AND THE GUARD MUST NOT BE VACUOUS. If the seed ever stops applying, every
   check above passes for the wrong reason. This proves the seeded resolver is
   really the one the child sees. */
const control = (() => {
  const script = `
    const registryPath = require.resolve(${JSON.stringify(path.join(ROOT, 'src/lib/service-registry.js'))});
    const real = require(registryPath);
    const seeded = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      loadRegistry: () => (${JSON.stringify(CUSTOMER_REGISTRY)}),
    });
    require.cache[registryPath].exports = seeded;
    const again = require(registryPath);
    process.stdout.write(String(Object.keys(again.loadRegistry().services).length));
  `;
  return execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
})();
assert.equal(String(control).trim(), '0',
  'the seeded registry did not apply, so every assertion above passed for the wrong reason');

process.stdout.write(`loads-on-a-customer-registry: ${MUST_LOAD.length} modules load with no services declared\n`);
