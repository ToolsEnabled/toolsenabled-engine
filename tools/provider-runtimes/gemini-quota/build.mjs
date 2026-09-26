import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const recipe = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(recipe, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const compatibility = "import { fileURLToPath as __quotaFileURLToPath } from 'node:url'; import { dirname as __quotaDirname } from 'node:path'; const __dirname = __quotaDirname(__quotaFileURLToPath(import.meta.url));\n";

function readPlain(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(x => !x || x === '.' || x === '..') || path.isAbsolute(relative)) throw Error('invalid runtime input path');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw Error('linked runtime input root');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('linked runtime input');
  }
  if (!fs.statSync(current).isFile()) throw Error('runtime input is not a file');
  return fs.readFileSync(current);
}

// npm ci --ignore-scripts installs the two committed lockfiles first. This
// command never installs, invokes provider code, or resolves an ambient CLI.
export async function buildGeminiQuotaRuntime({ dependencies = recipe, buildTools = path.join(recipe, 'build-tools'), out = path.join(engine, 'provider-runtimes/gemini-quota') } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'config/gemini-quota-runtime.json'), 'utf8'));
  for (const [root, expected] of [[dependencies, manifest.inputLockSha256], [buildTools, manifest.buildLockSha256]]) {
    if (sha(readPlain(root, 'package-lock.json')) !== expected) throw Error('runtime lockfile differs from reviewed inputs');
  }
  if (!readPlain(dependencies, 'bundle-entry.mjs').equals(readPlain(recipe, 'bundle-entry.mjs'))) throw Error('runtime public entry changed');
  const esbuild = createRequire(pathToFileURL(path.join(buildTools, 'package.json')))('esbuild');
  if (esbuild.version !== manifest.esbuildVersion) throw Error('runtime compiler version changed');
  const target = path.resolve(out);
  // Never recursively replace an existing runtime. Publication is a separate
  // caller-owned action after every output has matched its committed hash.
  if (fs.existsSync(target)) throw Error('runtime output must be a new directory');
  fs.mkdirSync(target, { recursive: true });
  let result;
  try {
    result = await esbuild.build({ absWorkingDir: path.resolve(dependencies), entryPoints: ['bundle-entry.mjs'], bundle: true,
      platform: 'node', target: manifest.target, format: 'esm', treeShaking: true,
      outfile: path.join(target, 'sdk.mjs'), write: false, metafile: true, minify: false, legalComments: 'external', logLevel: 'silent',
      external: ['*.node', '@github/keytar', 'node-pty', '@lydell/node-pty', 'google-auth-library'], loader: { '.wasm': 'binary' },
      banner: { js: "import { createRequire as __quotaCreateRequire } from 'node:module'; const require = __quotaCreateRequire(import.meta.url);" } });
  } finally { esbuild.stop(); }
  const outputs = new Map(result.outputFiles.map(file => [path.basename(file.path), Buffer.from(file.contents)]));
  const notices = JSON.parse(readPlain(recipe, 'third-party-notices.json'));
  const noticeSources = new Map(notices.flatMap(entry => entry.noticeFiles.map(file => [file, `${entry.package}/${path.posix.basename(file)}`])));
  const lock = JSON.parse(readPlain(dependencies, 'package-lock.json'));
  for (const item of notices) {
    const pinned = lock.packages[item.package];
    const actual = JSON.parse(readPlain(dependencies, `${item.package}/package.json`));
    if (actual.version !== item.version || pinned?.version !== item.version || pinned?.integrity !== item.integrity) throw Error('runtime dependency pin differs');
  }
  let bytes = 0;
  for (const [relative, expected] of Object.entries(manifest.files)) {
    let data;
    if (relative === 'sdk.mjs') data = Buffer.concat([Buffer.from(compatibility), outputs.get(relative)]);
    else if (relative === 'sdk.mjs.LEGAL.txt') data = outputs.get(relative);
    else if (relative === 'THIRD-PARTY-NOTICES.json') data = readPlain(recipe, 'third-party-notices.json');
    else if (relative === 'policies/sandbox-default.toml') data = readPlain(dependencies, 'node_modules/@google/gemini-cli-core/dist/src/policy/policies/sandbox-default.toml');
    else data = readPlain(dependencies, noticeSources.get(relative) || relative);
    if (!data || data.length !== expected.bytes || sha(data) !== expected.sha256) throw Error(`runtime output hash differs: ${relative}`);
    const to = path.join(target, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data, { flag: 'wx' });
    bytes += data.length;
  }
  return { id: manifest.id, version: manifest.version, files: Object.keys(manifest.files).length, bytes,
    manifestSha256: sha(fs.readFileSync(path.join(engine, 'config/gemini-quota-runtime.json'))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--dependencies', '--build-tools', '--out'].includes(arg))) throw Error('invalid build arguments');
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2].slice(2).replace('build-tools', 'buildTools'), path.resolve(args[index * 2 + 1])]));
  console.log(JSON.stringify(await buildGeminiQuotaRuntime(options)));
}
