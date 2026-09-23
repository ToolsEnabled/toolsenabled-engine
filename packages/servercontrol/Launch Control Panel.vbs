Option Explicit

' Primary Explorer entry point for Server Control.  WScript has no console, so
' opening the panel does not briefly flash cmd.exe or PowerShell on the desktop.
Dim shellObject, fileSystem, panelPath, command
Set shellObject = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
panelPath = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "Server-Control-Panel.ps1")
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & panelPath & """"
shellObject.Run command, 0, False
