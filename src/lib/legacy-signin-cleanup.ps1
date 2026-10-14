param([Parameter(Mandatory=$true)][string]$ServicesRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# No sign-in contents are opened. Native directory handles prevent a rename
# race; OPEN_REPARSE_POINT exposes all tags, including non-symlink reparses.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class LegacySignInCleanup {
    [StructLayout(LayoutKind.Sequential)]
    struct AttributeTag { public uint Attributes; public uint ReparseTag; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind,
        out AttributeTag info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFileAttributesW(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool DeleteFileW(string name);
    const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400;
    static readonly Regex Agent = new Regex(@"^[a-z0-9][a-z0-9_-]{0,63}$");
    static readonly Regex Session = new Regex(@"^[a-f0-9]{64}$");
    static readonly Dictionary<string, Regex> Names = new Dictionary<string, Regex> {
        {"codex", new Regex(@"^auth\.json(?:\.[0-9]+\.[0-9]+\.refresh)?$")},
        {"claude", new Regex(@"^\.credentials\.json(?:\.[0-9]+\.[0-9]+\.refresh)?$")},
        {"gemini", new Regex(@"^(?:oauth_creds\.json(?:\.[0-9]+\.[0-9]+\.refresh)?|oauth_creds\.toolsenabled-[a-f0-9]{32}\.tmp)$")}
    };
    static string Quote(string value) {
        var text = new System.Text.StringBuilder("\"");
        foreach (char ch in value) {
            if (ch == '\\' || ch == '"') text.Append('\\').Append(ch);
            else if (ch < 32) text.Append("\\u").Append(((int)ch).ToString("x4"));
            else text.Append(ch);
        }
        return text.Append('"').ToString();
    }
    static void Emit(string kind, string name, string reason) {
        Console.WriteLine("{\"event\":" + Quote(kind) + ",\"path\":" + Quote(name)
            + (reason == null ? "" : ",\"reason\":" + Quote(reason)) + "}");
        Console.Out.Flush();
    }
    static void Error(string label, int code) {
        if (code != 2 && code != 3) Emit("refused", label, "WIN32_" + code);
    }
    static void InDirectory(string file, string label, Action action) {
        // Access 0 asks for metadata only. Share READ denies WRITE (including
        // changing reparse data) and DELETE (renaming) throughout traversal.
        using (SafeFileHandle handle = CreateFileW(file, 0, 1, IntPtr.Zero, 3,
            0x00200000 | 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) { Error(label, Marshal.GetLastWin32Error()); return; }
            AttributeTag info;
            if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) {
                Error(label, Marshal.GetLastWin32Error()); return;
            }
            if ((info.Attributes & ReparseAttribute) != 0) {
                Emit("refused", label, "directory-link"); return;
            }
            if ((info.Attributes & DirectoryAttribute) == 0) {
                Emit("refused", label, "not-directory"); return;
            }
            try { action(); }
            catch { Emit("refused", label, "directory-unavailable"); }
        }
    }
    static void Leaves(string directory, string label, string provider) {
        foreach (string file in Directory.EnumerateFileSystemEntries(directory)) {
            string name = Path.GetFileName(file);
            if (!Names[provider].IsMatch(name)) continue;
            string relative = Path.Combine(label, name);
            uint attributes = GetFileAttributesW(file);
            if (attributes == 0xffffffff) { Error(relative, Marshal.GetLastWin32Error()); continue; }
            if ((attributes & DirectoryAttribute) != 0) { Emit("refused", relative, "not-file"); continue; }
            // DeleteFile never truncates or follows a file symlink; it removes
            // that name. Hard-link peers and symlink targets survive untouched.
            if (DeleteFileW(file)) Emit("removed", relative, null);
            else Error(relative, Marshal.GetLastWin32Error());
        }
    }
    static void Walk(string directory, string label, int stage, string provider) {
        if (stage == 6) {
            Leaves(directory, label, provider);
            if (provider == "gemini") {
                string config = Path.Combine(directory, ".gemini");
                string relative = Path.Combine(label, ".gemini");
                InDirectory(config, relative, () => Leaves(config, relative, provider));
            }
            return;
        }
        foreach (string file in Directory.EnumerateFileSystemEntries(directory)) {
            string name = Path.GetFileName(file);
            bool accepted = stage == 0 ? Agent.IsMatch(name)
                : stage == 1 ? name == "@sessions"
                : stage == 2 ? Session.IsMatch(name)
                : stage == 3 ? Names.ContainsKey(name)
                : stage == 4 ? name == "guided" || name == "standard" || name == "unrestricted"
                : true;
            if (!accepted) continue;
            string relative = Path.Combine(label, name);
            InDirectory(file, relative, () => Walk(file, relative, stage + 1, stage == 3 ? name : provider));
        }
    }
    static void Ancestors(string cursor, string[] segments, int at) {
        InDirectory(cursor, "agent-home", () => {
            if (at < segments.Length) Ancestors(Path.Combine(cursor, segments[at]), segments, at + 1);
            else {
                string home = Path.Combine(cursor, "agent-home");
                InDirectory(home, "agent-home", () => {
                    string agents = Path.Combine(home, "@agents");
                    InDirectory(agents, Path.Combine("agent-home", "@agents"),
                        () => Walk(agents, Path.Combine("agent-home", "@agents"), 0, null));
                });
            }
        });
    }
    public static void Run(string root) {
        // Refuse UNC/device/relative spellings instead of contacting another
        // machine or accepting a namespace with ambiguous ancestry.
        if (!Regex.IsMatch(root, @"^[a-zA-Z]:\\")) {
            Emit("refused", "agent-home", "invalid-services-root"); return;
        }
        string full = Path.GetFullPath(root);
        string drive = Path.GetPathRoot(full);
        string[] segments = full.Substring(drive.Length).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
        Ancestors(drive, segments, 0);
        Emit("complete", "agent-home", null);
    }
}
'@
[LegacySignInCleanup]::Run($ServicesRoot)
