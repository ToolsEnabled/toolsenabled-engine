@echo off
rem Compatibility launcher. Prefer the .vbs entry beside this file: Explorer
rem starts it without first allocating cmd.exe's transient console window.
"%SystemRoot%\System32\wscript.exe" "%~dp0Launch Control Panel.vbs"
