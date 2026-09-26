using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private static readonly IntPtr ProcThreadAttributePseudoConsole = (IntPtr)0x00020016;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, IntPtr attributes, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int standardHandle, IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(Coord size, IntPtr inputRead, IntPtr outputWrite, uint flags, out IntPtr pseudoConsole);

    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr pseudoConsole, Coord size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr pseudoConsole);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    private sealed class Launch
    {
        public Launch(string logPath, string cwd, short columns, short rows, string resizePipe, string command, string[] args)
        {
            LogPath = logPath;
            Cwd = cwd;
            Columns = columns;
            Rows = rows;
            ResizePipe = resizePipe;
            Command = command;
            Args = args;
        }

        public string LogPath { get; private set; }
        public string Cwd { get; private set; }
        public short Columns { get; private set; }
        public short Rows { get; private set; }
        public string ResizePipe { get; private set; }
        public string Command { get; private set; }
        public string[] Args { get; private set; }
    }

    public static int Main(string[] args)
    {
        try
        {
            var launch = Parse(args);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(launch.LogPath)));
            return RunAsync(launch).GetAwaiter().GetResult();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("zed-conpty-relay: " + error.Message);
            return 2;
        }
    }

    private static Launch Parse(string[] args)
    {
        string logPath = null;
        string cwd = null;
        short columns = 120;
        short rows = 30;
        string resizePipe = null;
        var index = 0;
        for (; index < args.Length && args[index] != "--"; index += 1)
        {
            if (index + 1 >= args.Length) throw new ArgumentException(args[index] + " needs a value");
            var flag = args[index];
            var value = args[++index];
            switch (flag)
            {
                case "--log": logPath = value; break;
                case "--cwd": cwd = value; break;
                case "--cols": columns = ParseDimension(value, "--cols"); break;
                case "--rows": rows = ParseDimension(value, "--rows"); break;
                case "--resize-pipe": resizePipe = value; break;
                default: throw new ArgumentException("unknown option " + flag);
            }
        }
        if (index >= args.Length || index + 1 >= args.Length) throw new ArgumentException("usage: zed-conpty-relay --log <path> --cwd <path> [--resize-pipe <pipeName>] -- <command> [args...]");
        if (string.IsNullOrWhiteSpace(logPath) || string.IsNullOrWhiteSpace(cwd)) throw new ArgumentException("--log and --cwd are required");
        return new Launch(logPath, cwd, columns, rows, resizePipe, args[index + 1], args.Skip(index + 2).ToArray());
    }

    private static short ParseDimension(string value, string flag)
    {
        short dimension;
        if (!short.TryParse(value, out dimension) || dimension < 20 || dimension > 400) throw new ArgumentException(flag + " must be between 20 and 400");
        return dimension;
    }

    private sealed class ResizeListener
    {
        private const int ConnectAttemptMilliseconds = 250;
        private const int RetryDelayMilliseconds = 50;
        private const int MaximumConnectMilliseconds = 10000;
        private const int ShutdownJoinMilliseconds = 25;
        private readonly string pipeName;
        private readonly IntPtr pseudoConsole;
        private readonly object gate = new object();
        private readonly ManualResetEvent stopSignal = new ManualResetEvent(false);
        private NamedPipeClientStream client;
        private Thread thread;
        private bool stopped;

        private ResizeListener(string pipeName, IntPtr pseudoConsole)
        {
            this.pipeName = NormalizePipeName(pipeName);
            this.pseudoConsole = pseudoConsole;
        }

        public static ResizeListener Start(string pipeName, IntPtr pseudoConsole)
        {
            if (string.IsNullOrWhiteSpace(pipeName)) return null;
            try
            {
                var listener = new ResizeListener(pipeName, pseudoConsole);
                listener.thread = new Thread(listener.Listen);
                listener.thread.IsBackground = true;
                listener.thread.Name = "zed-conpty-resize";
                listener.thread.Start();
                return listener;
            }
            catch (Exception)
            {
                // Resizing is optional. A bad pipe name or an unavailable
                // named-pipe implementation must never take down the child.
                return null;
            }
        }

        public void Stop()
        {
            lock (gate)
            {
                stopped = true;
            }

            try { stopSignal.Set(); }
            catch (Exception) { }

            var activeClient = Interlocked.Exchange(ref client, null);
            if (activeClient != null)
            {
                try { activeClient.Dispose(); }
                catch (Exception) { }
            }

            var activeThread = thread;
            if (activeThread != null && activeThread != Thread.CurrentThread)
            {
                // stopped is already published under gate, so even if a
                // blocked ReadLine unwinds later it cannot race hPC closure.
                // Give disposal a brief chance to finish without delaying
                // terminal shutdown on Windows pipe cancellation quirks.
                try { activeThread.Join(ShutdownJoinMilliseconds); }
                catch (Exception) { }
            }
        }

        private void Listen()
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(MaximumConnectMilliseconds);
            while (!IsStopped() && DateTime.UtcNow < deadline)
            {
                NamedPipeClientStream localClient = null;
                try
                {
                    localClient = new NamedPipeClientStream(
                        ".",
                        pipeName,
                        PipeDirection.In,
                        PipeOptions.None);
                    Interlocked.Exchange(ref client, localClient);
                    localClient.Connect(ConnectAttemptMilliseconds);
                    if (IsStopped()) return;

                    using (var reader = new StreamReader(localClient, new UTF8Encoding(false, true), false, 256))
                    {
                        string record;
                        while (!IsStopped() && (record = reader.ReadLine()) != null)
                        {
                            ApplyRecord(record);
                        }
                    }
                }
                catch (Exception)
                {
                    // The pipe is a best-effort control channel. Missing,
                    // malformed, disconnected, or unsupported pipe state is
                    // intentionally invisible to the user-facing terminal.
                }
                finally
                {
                    if (localClient != null)
                    {
                        Interlocked.CompareExchange(ref client, null, localClient);
                        try { localClient.Dispose(); }
                        catch (Exception) { }
                    }
                }

                if (IsStopped()) return;
                try
                {
                    if (stopSignal.WaitOne(RetryDelayMilliseconds)) return;
                }
                catch (Exception) { return; }
            }
        }

        private void ApplyRecord(string record)
        {
            short columns;
            short rows;
            if (!TryParseResizeRecord(record, out columns, out rows)) return;

            // Stop takes this same lock before the owner closes hPC, so a
            // resize call can never race ClosePseudoConsole.
            lock (gate)
            {
                if (stopped) return;
                ResizePseudoConsole(pseudoConsole, new Coord { X = columns, Y = rows });
            }
        }

        private bool IsStopped()
        {
            lock (gate)
            {
                return stopped;
            }
        }

        private static string NormalizePipeName(string value)
        {
            const string prefix = @"\\.\pipe\";
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? value.Substring(prefix.Length)
                : value;
        }
    }

    private static bool TryParseResizeRecord(string record, out short columns, out short rows)
    {
        columns = 0;
        rows = 0;
        if (record == null) return false;
        var fields = record.Split(new[] { ' ' }, StringSplitOptions.None);
        return fields.Length == 2
            && TryParsePipeDimension(fields[0], out columns)
            && TryParsePipeDimension(fields[1], out rows);
    }

    private static bool TryParsePipeDimension(string value, out short dimension)
    {
        dimension = 0;
        if (string.IsNullOrEmpty(value)) return false;
        var parsed = 0;
        foreach (var character in value)
        {
            if (character < '0' || character > '9') return false;
            parsed = parsed * 10 + character - '0';
            if (parsed > 400) return false;
        }
        if (parsed < 20) return false;
        dimension = (short)parsed;
        return true;
    }

    private static async Task<int> RunAsync(Launch launch)
    {
        IntPtr ptyInputRead = IntPtr.Zero;
        IntPtr parentInputWrite = IntPtr.Zero;
        IntPtr parentOutputRead = IntPtr.Zero;
        IntPtr ptyOutputWrite = IntPtr.Zero;
        IntPtr pseudoConsole = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        var child = default(ProcessInformation);
        FileStream pseudoConsoleInput = null;
        FileStream pseudoConsoleOutput = null;
        ResizeListener resizeListener = null;
        Stream hostInput = Console.OpenStandardInput();
        Stream hostOutput = Console.OpenStandardOutput();
        var originalStdIn = GetStdHandle(StdInputHandle);
        var originalStdOut = GetStdHandle(StdOutputHandle);
        var originalStdErr = GetStdHandle(StdErrorHandle);

        try
        {
            if (!CreatePipe(out ptyInputRead, out parentInputWrite, IntPtr.Zero, 0)) throw LastError("CreatePipe(input)");
            if (!CreatePipe(out parentOutputRead, out ptyOutputWrite, IntPtr.Zero, 0)) throw LastError("CreatePipe(output)");
            var pseudoResult = CreatePseudoConsole(new Coord { X = launch.Columns, Y = launch.Rows }, ptyInputRead, ptyOutputWrite, 0, out pseudoConsole);
            if (pseudoResult != 0) throw new InvalidOperationException(string.Format("CreatePseudoConsole failed (0x{0:X8})", pseudoResult));

            CloseHandle(ptyInputRead);
            ptyInputRead = IntPtr.Zero;
            CloseHandle(ptyOutputWrite);
            ptyOutputWrite = IntPtr.Zero;

            pseudoConsoleInput = new FileStream(new SafeFileHandle(parentInputWrite, true), FileAccess.Write, 81920, false);
            parentInputWrite = IntPtr.Zero;
            pseudoConsoleOutput = new FileStream(new SafeFileHandle(parentOutputRead, true), FileAccess.Read, 81920, false);
            parentOutputRead = IntPtr.Zero;

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) throw LastError("InitializeProcThreadAttributeList");
            if (!UpdateProcThreadAttribute(attributeList, 0, ProcThreadAttributePseudoConsole, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw LastError("UpdateProcThreadAttribute");

            var startup = new StartupInfoEx
            {
                StartupInfo = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfoEx)) },
                lpAttributeList = attributeList
            };
            var commandLine = new StringBuilder(JoinCommandLine(new[] { launch.Command }.Concat(launch.Args)));
            try
            {
                if (!SetStdHandle(StdInputHandle, IntPtr.Zero)) throw LastError("SetStdHandle(stdin)");
                if (!SetStdHandle(StdOutputHandle, IntPtr.Zero)) throw LastError("SetStdHandle(stdout)");
                if (!SetStdHandle(StdErrorHandle, IntPtr.Zero)) throw LastError("SetStdHandle(stderr)");
                if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent, IntPtr.Zero, launch.Cwd, ref startup, out child)) throw LastError("CreateProcess");
            }
            finally
            {
                SetStdHandle(StdInputHandle, originalStdIn);
                SetStdHandle(StdOutputHandle, originalStdOut);
                SetStdHandle(StdErrorHandle, originalStdErr);
            }
            CloseHandle(child.hThread);
            child.hThread = IntPtr.Zero;
            resizeListener = ResizeListener.Start(launch.ResizePipe, pseudoConsole);

            var input = pseudoConsoleInput;
            Task.Run(delegate
            {
                var buffer = new byte[81920];
                try
                {
                    int count;
                    while ((count = hostInput.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        input.Write(buffer, 0, count);
                        // FileStream buffers pipe writes. Flush every keyboard
                        // chunk so an interactive child receives each key now,
                        // rather than only after the 80 KiB buffer fills.
                        input.Flush();
                    }
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            });

            var output = pseudoConsoleOutput;
            var previewOutput = hostOutput;
            var logPath = launch.LogPath;
            var outputTask = Task.Run(delegate
            {
                var buffer = new byte[81920];
                var previewAvailable = true;
                using (var rawLog = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read, 81920, false))
                {
                    int count;
                    while ((count = output.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        rawLog.Write(buffer, 0, count);
                        rawLog.Flush();
                        if (!previewAvailable) continue;
                        try
                        {
                            // The parent may show this native terminal stream
                            // transiently. The append-only raw log above remains
                            // authoritative even if that preview pipe closes.
                            previewOutput.Write(buffer, 0, count);
                            previewOutput.Flush();
                        }
                        catch (IOException) { previewAvailable = false; }
                        catch (ObjectDisposedException) { previewAvailable = false; }
                    }
                }
            });
            var wait = WaitForSingleObject(child.hProcess, 0xffffffff);
            if (wait == 0xffffffff) throw LastError("WaitForSingleObject");
            uint childExitCode;
            if (!GetExitCodeProcess(child.hProcess, out childExitCode)) throw LastError("GetExitCodeProcess");
            var exitCode = unchecked((int)childExitCode);

            if (resizeListener != null)
            {
                resizeListener.Stop();
                resizeListener = null;
            }
            pseudoConsoleInput.Dispose();
            pseudoConsoleInput = null;
            ClosePseudoConsole(pseudoConsole);
            pseudoConsole = IntPtr.Zero;
            await outputTask;
            return exitCode;
        }
        finally
        {
            if (resizeListener != null) resizeListener.Stop();
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (pseudoConsoleInput != null) pseudoConsoleInput.Dispose();
            if (pseudoConsoleOutput != null) pseudoConsoleOutput.Dispose();
            if (pseudoConsole != IntPtr.Zero) ClosePseudoConsole(pseudoConsole);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (ptyInputRead != IntPtr.Zero) CloseHandle(ptyInputRead);
            if (parentInputWrite != IntPtr.Zero) CloseHandle(parentInputWrite);
            if (parentOutputRead != IntPtr.Zero) CloseHandle(parentOutputRead);
            if (ptyOutputWrite != IntPtr.Zero) CloseHandle(ptyOutputWrite);
        }
    }

    private static Exception LastError(string operation)
    {
        var code = Marshal.GetLastWin32Error();
        return new InvalidOperationException(operation + " failed (" + code + "): " + new System.ComponentModel.Win32Exception(code).Message);
    }

    private static string JoinCommandLine(System.Collections.Generic.IEnumerable<string> args)
    {
        return string.Join(" ", args.Select(Quote));
    }

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (!value.Any(character => char.IsWhiteSpace(character) || character == '\"')) return value;
        var output = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '\"') output.Append('\\', backslashes * 2 + 1).Append(character);
            else output.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        output.Append('\\', backslashes * 2).Append('\"');
        return output.ToString();
    }
}
