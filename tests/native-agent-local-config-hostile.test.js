'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const launcherFile = path.join(ROOT, 'sidecars', 'native-agent', 'src', 'native-agent-launcher.js');
const generatorFile = path.join(ROOT, 'tools', 'generate-mirrors.js');
const retiredDescriptor = path.join(ROOT, 'sidecars', 'native-agent', 'native-agent-mcp.json');
const launcher = require(launcherFile);
const generator = require(generatorFile);
const hostileProfile = path.win32.join('C:\\', 'Users', 'foreign-user', 'stale');

function makeRuntimeFixture(parent, name, interpreterName) {
  const root = path.join(parent, name);
  const source = path.join(root, 'src');
  fs.mkdirSync(source, { recursive: true });
  const serverFile = path.join(source, 'mcp-server.js');
  const interpreter = path.join(root, interpreterName);
  fs.writeFileSync(serverFile, "'use strict';\n", 'utf8');
  fs.writeFileSync(interpreter, 'fixture runtime\n', 'utf8');
  return { root, serverFile, interpreter };
}

function refusal(action, code) {
  assert.throws(action, error => {
    assert(error instanceof launcher.NativeAgentLaunchError);
    assert.equal(error.code, code);
    return true;
  });
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-agent-local-config-'));
const priorEnvironment = new Map();
const hostileEnvironment = {
  NATIVE_AGENT_MCP_CONFIG_FILE: path.win32.join(hostileProfile, 'native-agent-mcp.json'),
  NATIVE_AGENT_NODE: path.win32.join(hostileProfile, 'node.exe'),
  TOOLSENABLED_INSTALL_ROOT: path.win32.join(hostileProfile, 'engine'),
  TOOLSENABLED_MCP_SERVER: path.win32.join(hostileProfile, 'mcp-server.js'),
  TOOLSENABLED_TOOL_ALLOWLIST: 'host.read_file'
};

try {
  for (const [name, value] of Object.entries(hostileEnvironment)) {
    priorEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }

  const checkout = makeRuntimeFixture(fixtureRoot, 'source-checkout', process.platform === 'win32' ? 'node.exe' : 'node');
  const checkoutConfig = launcher.buildLocalMcpDocument({
    root: checkout.root,
    interpreter: checkout.interpreter
  });
  assert.equal(checkoutConfig.command, checkout.interpreter);
  assert.equal(checkoutConfig.serverFile, checkout.serverFile);
  assert.deepEqual(checkoutConfig.document.mcpServers.toolsenabled, {
    command: checkout.interpreter,
    args: [checkout.serverFile],
    cwd: checkout.root,
    env: {
      TOOLSENABLED_CLIENT_SUITE: 'claude',
      TOOLSENABLED_AGENT_ACTOR: 'claude'
    }
  });

  const packaged = makeRuntimeFixture(fixtureRoot, 'packaged-payload', 'ToolsEnabled.exe');
  fs.writeFileSync(path.join(packaged.root, 'PAYLOAD.json'), '{}\n', 'utf8');
  const packagedConfig = launcher.buildLocalMcpDocument({
    root: packaged.root,
    interpreter: packaged.interpreter
  });
  assert.equal(packagedConfig.document.mcpServers.toolsenabled.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(packagedConfig.document.mcpServers.toolsenabled.command, packaged.interpreter);
  assert.deepEqual(packagedConfig.document.mcpServers.toolsenabled.args, [packaged.serverFile]);

  const serialized = JSON.stringify(packagedConfig.document);
  for (const hostile of Object.values(hostileEnvironment)) {
    assert.equal(serialized.includes(hostile), false, `ambient override entered runtime MCP config: ${hostile}`);
  }
  assert.doesNotMatch(serialized, /machine-[ab]|Machine [AB]|undefined[\\/]src/i);
  assert.equal(Object.hasOwn(packagedConfig.document.mcpServers.toolsenabled.env, 'TOOLSENABLED_TOOL_ALLOWLIST'), false);

  const runtimeDirectory = path.join(fixtureRoot, 'runtime-state');
  const runtimeConfig = launcher.createRuntimeMcpConfig({
    root: packaged.root,
    interpreter: packaged.interpreter,
    runtimeDirectory,
    randomBytes: () => Buffer.alloc(12, 0xab),
    pid: 4321
  });
  assert.equal(path.dirname(runtimeConfig.configFile), runtimeDirectory);
  assert.equal(fs.existsSync(runtimeConfig.configFile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtimeConfig.configFile, 'utf8')), packagedConfig.document);
  assert.equal(launcher.assertRegistryUsable(runtimeConfig.configFile).command, packaged.interpreter);
  assert.equal(runtimeConfig.cleanup(), true);
  assert.equal(runtimeConfig.cleanup(), true);
  assert.equal(fs.existsSync(runtimeConfig.configFile), false);

  // Exclusive create is an integrity boundary. A hostile pre-existing name
  // must be refused and must never be overwritten or removed by cleanup for a
  // file this process did not create.
  const collision = path.join(runtimeDirectory, `${launcher.RUNTIME_CONFIG_PREFIX}4321.${'ab'.repeat(12)}.json`);
  fs.writeFileSync(collision, 'attacker-owned\n', 'utf8');
  refusal(() => launcher.createRuntimeMcpConfig({
    root: packaged.root,
    interpreter: packaged.interpreter,
    runtimeDirectory,
    randomBytes: () => Buffer.alloc(12, 0xab),
    pid: 4321
  }), 'NATIVE_AGENT_MCP_CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(collision, 'utf8'), 'attacker-owned\n');

  refusal(() => launcher.buildLocalMcpDocument({
    root: path.join(fixtureRoot, 'absent-root'),
    interpreter: packaged.interpreter
  }), 'NATIVE_AGENT_LOCAL_ROOT_INVALID');
  refusal(() => launcher.buildLocalMcpDocument({
    root: packaged.root,
    interpreter: path.join(fixtureRoot, 'absent-runtime.exe')
  }), 'NATIVE_AGENT_LOCAL_INTERPRETER_INVALID');
  fs.unlinkSync(packaged.serverFile);
  refusal(() => launcher.buildLocalMcpDocument({
    root: packaged.root,
    interpreter: packaged.interpreter
  }), 'NATIVE_AGENT_LOCAL_SERVER_INVALID');

  assert.equal(fs.existsSync(retiredDescriptor), false, 'no tracked machine-specific native-agent descriptor may ship');
  const shippedSource = `${fs.readFileSync(launcherFile, 'utf8')}\n${fs.readFileSync(generatorFile, 'utf8')}`;
  assert.doesNotMatch(shippedSource, /machine-[ab]|Machine [AB]|undefined[\\/]src|foreign-user/i);
  assert.deepEqual(
    generator.machineRoots().map(entry => entry.file),
    ['adapters/claude/mcp.json.example', 'adapters/gemini/settings.json.example']
  );
  assert.equal(generator.run({ check: true }).every(result => result.changed === false), true,
    'customer-neutral generated mirrors must verify on a fresh default topology');
} finally {
  for (const [name, value] of priorEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('native agent local config hostile: source and packaged runtime derivation passed');
