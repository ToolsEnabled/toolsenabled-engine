// EXECUTABLE CHANGE
// Assertion audit (testcanfail-tests-zed-conpty-resize-test-js):
// - FOUND shape 5: the non-Windows process.exit(0) made every product check a
//   no-op. The source contract below now executes before that platform guard.
// - Mutation: changed the ResizePseudoConsole invocation in Program.cs to a
//   ClosePseudoConsole invocation. `node tests/zed-conpty-resize.test.js` went
//   RED with `AssertionError [ERR_ASSERTION]: the resize listener must apply
//   validated dimensions to the live pseudo console`.
// - Restored Program.cs byte-for-byte (SHA-256 unchanged), after which
//   `node tests/zed-conpty-resize.test.js` was GREEN and printed
//   `Zed ConPTY resize source contract passed.` followed by the platform skip.
// - NOT-FOUND shape 1: polling loops time out by throwing; no assertion is
//   conditional on a possibly empty collection.
// - NOT-FOUND shape 2: build and relay exit assertions require exactly zero;
//   resize evidence comes from the probe's dimensions, not merely exit status.
// - NOT-FOUND shape 3: catches are confined to best-effort cleanup after the
//   assertions; none swallows a resize failure.
// - NOT-FOUND shape 4: the live test launches the real relay and observes the
//   real console probe; it does not mock the resize implementation.
// - NOT-FOUND shape 6: expected dimensions are fixed test inputs and are not
//   computed by Program.cs or by a shared implementation.
// - Unmet precondition: Windows ConPTY and the Windows C# compiler are not
//   available on this Linux audit host, so the pre-existing live branch could
//   not be executed here.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..', 'tools', 'zed-conpty-relay', 'Program.cs');
const relaySource = fs.readFileSync(source, 'utf8');
assert.match(
  relaySource,
  /ResizePseudoConsole\s*\(\s*pseudoConsole\s*,\s*new Coord\s*\{\s*X\s*=\s*columns\s*,\s*Y\s*=\s*rows\s*\}\s*\)\s*;/,
  'the resize listener must apply validated dimensions to the live pseudo console'
);
console.log('Zed ConPTY resize source contract passed.');

if (process.platform !== 'win32') {
  console.log('Zed ConPTY resize test skipped outside Windows.');
  process.exit(0);
}

const compilers = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];
const compiler = compilers.find(candidate => fs.existsSync(candidate));
assert.ok(compiler, 'Windows C# compiler is required for the ConPTY resize test');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-conpty-resize-'));
const executable = path.join(fixtureRoot, 'ZedConPtyRelay.exe');
const probeSource = path.join(fixtureRoot, 'DimensionProbe.cs');
const probeExecutable = path.join(fixtureRoot, 'DimensionProbe.exe');
const rawLog = path.join(fixtureRoot, 'raw.log');
const pipeName = `zed-conpty-resize-${process.pid}-${Date.now()}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;

fs.writeFileSync(probeSource, `using System;
using System.Runtime.InteropServices;

internal static class DimensionProbe
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SmallRect
    {
        public short Left;
        public short Top;
        public short Right;
        public short Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ConsoleScreenBufferInfo
    {
        public Coord Size;
        public Coord CursorPosition;
        public short Attributes;
        public SmallRect Window;
        public Coord MaximumWindowSize;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleScreenBufferInfo(
        IntPtr consoleOutput,
        out ConsoleScreenBufferInfo information);

    private static void PrintDimensions()
    {
        ConsoleScreenBufferInfo information;
        if (!GetConsoleScreenBufferInfo(GetStdHandle(-11), out information))
        {
            Console.WriteLine("DIM_ERROR " + Marshal.GetLastWin32Error());
            Console.Out.Flush();
            return;
        }

        var columns = information.Window.Right - information.Window.Left + 1;
        var rows = information.Window.Bottom - information.Window.Top + 1;
        Console.WriteLine("DIM " + columns + " " + rows);
        Console.Out.Flush();
    }

    public static void Main()
    {
        PrintDimensions();
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line == "exit") return;
            if (line == "probe") PrintDimensions();
        }
    }
}
`, 'utf8');

function compile(output, input, target) {
  return spawnSync(compiler, [
    '/nologo',
    `/target:${target}`,
    `/out:${output}`,
    input
  ], {
    cwd: fixtureRoot,
    windowsHide: true,
    encoding: 'utf8'
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForOutput(readOutput, text, timeoutMs, poke) {
  const deadline = Date.now() + timeoutMs;
  let nextPokeAt = 0;
  while (Date.now() < deadline) {
    if (readOutput().includes(text)) return;
    if (poke && Date.now() >= nextPokeAt) {
      poke();
      nextPokeAt = Date.now() + 100;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)} in ConPTY output`);
}

async function waitForResizeSocket(readSocket, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = readSocket();
    if (socket && !socket.destroyed) return socket;
    await delay(25);
  }
  throw new Error('the Node named-pipe server did not receive the relay client connection');
}

function waitForClose(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const relayBuild = compile(executable, source, 'winexe');
  assert.equal(relayBuild.status, 0, `${relayBuild.stdout || ''}${relayBuild.stderr || ''}`);

  const probeBuild = compile(probeExecutable, probeSource, 'exe');
  assert.equal(probeBuild.status, 0, `${probeBuild.stdout || ''}${probeBuild.stderr || ''}`);

  const resizeServer = net.createServer();
  let resizeSocket = null;
  resizeServer.on('connection', socket => {
    if (resizeSocket && !resizeSocket.destroyed) resizeSocket.destroy();
    resizeSocket = socket;
    socket.on('error', () => { /* broken control pipes are expected */ });
    socket.on('close', () => {
      if (resizeSocket === socket) resizeSocket = null;
    });
  });
  await new Promise((resolve, reject) => {
    resizeServer.once('error', reject);
    resizeServer.listen(pipePath, resolve);
  });

  const relay = spawn(executable, [
    '--log', rawLog,
    '--cwd', fixtureRoot,
    '--cols', '80',
    '--rows', '25',
    '--resize-pipe', pipeName,
    '--', probeExecutable
  ], {
    cwd: fixtureRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let preview = '';
  let stderr = '';
  let closed = false;
  relay.stdout.on('data', chunk => { preview += chunk.toString(); });
  relay.stderr.on('data', chunk => { stderr += chunk.toString(); });
  relay.stdin.on('error', () => { /* the relay may already be closing */ });
  relay.once('close', () => { closed = true; });

  try {
    const connectedSocket = await waitForResizeSocket(() => resizeSocket, 5000);
    relay.stdin.write('probe\r');
    await waitForOutput(() => preview, 'DIM 80 25', 5000);

    // Invalid records are ignored, while the valid record below must reach
    // the real ResizePseudoConsole API and become visible to the child.
    connectedSocket.write(Buffer.from('19 40\n401 40\nnot-a-dimension\n100 40\n', 'utf8'));
    await waitForOutput(() => preview, 'DIM 100 40', 5000, () => relay.stdin.write('probe\r'));

    // A broken control connection must not affect the child. Let the relay
    // reconnect, then leave that replacement socket open so Stop() is timed
    // while its reader is blocked in ReadLine.
    connectedSocket.destroy();
    await waitForResizeSocket(() => resizeSocket, 5000);
    const shutdownStartedAt = process.hrtime.bigint();
    relay.stdin.write('exit\r');
    relay.stdin.end();
    const result = await waitForClose(relay, 5000, 'ConPTY relay');
    const shutdownMilliseconds = Number(process.hrtime.bigint() - shutdownStartedAt) / 1e6;
    assert.equal(result.signal, null, `relay ended from signal ${result.signal}`);
    assert.equal(result.code, 0, stderr);
    assert.equal(stderr, '', `resize pipe failure reached the user-facing stderr: ${stderr}`);
    assert.ok(
      shutdownMilliseconds <= 1500,
      `relay shutdown took ${shutdownMilliseconds.toFixed(1)} ms; expected <= 1500 ms`
    );
    assert.match(preview, /DIM 80 25/);
    assert.match(preview, /DIM 100 40/);

    const raw = fs.readFileSync(rawLog, 'utf8');
    assert.match(raw, /DIM 80 25/);
    assert.match(raw, /DIM 100 40/);
    console.log(`Zed ConPTY live resize passed; relay shutdown ${shutdownMilliseconds.toFixed(1)} ms.`);
  } finally {
    if (!closed) {
      try {
        relay.stdin.write('exit\r');
        relay.stdin.end();
      } catch { /* relay may already be gone */ }
      await new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        relay.once('close', finish);
        setTimeout(() => {
          if (settled) return;
          relay.kill();
          setTimeout(finish, 1000);
        }, 500);
      });
    }
    if (resizeSocket && !resizeSocket.destroyed) resizeSocket.destroy();
    if (resizeServer.listening) {
      await new Promise(resolve => resizeServer.close(resolve));
    }
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  catch (error) {
    console.error(`could not remove resize fixture: ${error.message}`);
    process.exitCode = 1;
  }
});
