@echo off
setlocal
for %%I in ("%~dp0..") do set "TOOLSENABLED_ROOT=%%~fI"
call node "%TOOLSENABLED_ROOT%\src\playwright-gateway.js" @playwright/mcp@0.0.82
