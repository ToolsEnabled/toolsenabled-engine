@echo off
setlocal
set "TOOLSENABLED_ROOT=%~dp0.."
set "TOOLSENABLED_AGENT_ACTOR=codex"
node "%TOOLSENABLED_ROOT%\tools\mcp-owner-proxy.js"
