@echo off
setlocal
set "MEETRON_ROOT=%~dp0"
set "MEETRON_NODE=%MEETRON_ROOT%runtime\node.exe"
if not exist "%MEETRON_NODE%" set "MEETRON_NODE=node.exe"
set "MEETRON_PACKAGED=1"
"%MEETRON_NODE%" "%MEETRON_ROOT%src\cli\setup-meetron.mjs" %*
exit /b %errorlevel%
