// Used only by the persistent Windows vault host. Every invocation reads the
// current filesystem attributes and DACL; no permission or path verdict is cached.
using System;
using System.IO;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;

namespace ToolsEnabled {
    // Wire compatible with Windows PowerShell's DPAPI SecureString export:
    // UTF-16 code units, CurrentUser DPAPI, then hexadecimal ciphertext.
    // Mutable plaintext buffers are cleared even when DPAPI fails. Strings
    // returned to the existing caller still follow .NET's normal lifetime.
    public static class VaultDataProtectionV1 {
        public static string Protect(string value) {
            byte[] plain = new byte[checked(value.Length * 2)];
            for (int i = 0; i < value.Length; i++) {
                plain[2 * i] = (byte)value[i];
                plain[2 * i + 1] = (byte)(value[i] >> 8);
            }
            try {
                byte[] cipher = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
                return BitConverter.ToString(cipher).Replace("-", "").ToLowerInvariant();
            } finally { Array.Clear(plain, 0, plain.Length); }
        }

        public static string Unprotect(string value) {
            if (String.IsNullOrEmpty(value) || value.Length % 2 != 0)
                throw new CryptographicException("SECRET_VAULT_UNREADABLE");
            byte[] cipher = new byte[value.Length / 2];
            for (int i = 0; i < cipher.Length; i++) {
                int high = Hex(value[2 * i]), low = Hex(value[2 * i + 1]);
                if (high < 0 || low < 0) throw new CryptographicException("SECRET_VAULT_UNREADABLE");
                cipher[i] = (byte)((high << 4) | low);
            }
            byte[] plain = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser);
            try {
                if (plain.Length % 2 != 0) throw new CryptographicException("SECRET_VAULT_UNREADABLE");
                char[] characters = new char[plain.Length / 2];
                try {
                    for (int i = 0; i < characters.Length; i++) characters[i] = (char)(plain[2 * i] | (plain[2 * i + 1] << 8));
                    return new String(characters);
                } finally { Array.Clear(characters, 0, characters.Length); }
            } finally { Array.Clear(plain, 0, plain.Length); }
        }

        private static int Hex(char value) {
            if (value >= '0' && value <= '9') return value - '0';
            if (value >= 'a' && value <= 'f') return value - 'a' + 10;
            if (value >= 'A' && value <= 'F') return value - 'A' + 10;
            return -1;
        }
    }

    public static class VaultPermissionsV1 {
        private static string[] Allowed() {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
                return new [] { identity.User.Value, "S-1-5-18", "S-1-5-32-544" };
            }
        }

        private static InheritanceFlags Inheritance(bool directory) {
            return directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        }

        private static FileSystemSecurity NewAcl(bool directory) {
            FileSystemSecurity acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
            acl.SetAccessRuleProtection(true, false);
            foreach (string sid in Allowed()) {
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl,
                    Inheritance(directory), PropagationFlags.None, AccessControlType.Allow));
            }
            return acl;
        }

        public static bool IsProtected(string path, bool directory) {
            try {
                FileSystemSecurity acl = directory
                    ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Access)
                    : File.GetAccessControl(path, AccessControlSections.Access);
                if (!acl.AreAccessRulesProtected) return false;
                var required = new HashSet<string>(Allowed(), StringComparer.Ordinal);
                var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
                if (rules.Count != 3) return false;
                foreach (FileSystemAccessRule rule in rules) {
                    if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow
                        || rule.FileSystemRights != FileSystemRights.FullControl
                        || rule.InheritanceFlags != Inheritance(directory)
                        || rule.PropagationFlags != PropagationFlags.None
                        || !required.Remove(rule.IdentityReference.Value)) return false;
                }
                return required.Count == 0;
            } catch { return false; }
        }

        public static void ProtectPath(string path, bool tolerateInUse) {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            catch (IOException) {
                if (tolerateInUse) return;
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store path could not be inspected.");
            }
            if ((int)attributes == -1) {
                if (tolerateInUse) return;
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store path could not be inspected.");
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store path is a reparse point.");
            bool directory = (attributes & FileAttributes.Directory) != 0;
            if (IsProtected(path, directory)) return;
            try {
                if (directory) Directory.SetAccessControl(path, (DirectorySecurity)NewAcl(true));
                else File.SetAccessControl(path, (FileSecurity)NewAcl(false));
            } catch (IOException) {
                if (tolerateInUse) return;
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store permissions could not be restricted.");
            } catch {
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store permissions could not be restricted.");
            }
            if (!IsProtected(path, directory))
                throw new IOException("SECRET_STORE_ACL_UNSAFE: the credential store permissions remain unsafe after hardening.");
        }

        public static void InitializeStore(string path) {
            if (!Directory.Exists(path)) Directory.CreateDirectory(path, (DirectorySecurity)NewAcl(true));
            ProtectPath(path, false);
            foreach (string child in Directory.EnumerateFiles(path)) ProtectPath(child, true);
        }
    }
}
