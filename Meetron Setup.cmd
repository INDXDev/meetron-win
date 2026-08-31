@echo off
setlocal
set "MEETRON_ROOT=%~dp0"
set "MEETRON_NODE=%MEETRON_ROOT%runtime\node.exe"
rem Only the MSIX ships a bundled runtime. A source checkout must keep the
rem unpackaged setup path: install dependencies and use the repository
rem extension directory.
if exist "%MEETRON_NODE%" (set "MEETRON_PACKAGED=1") else (set "MEETRON_NODE=node.exe")
"%MEETRON_NODE%" "%MEETRON_ROOT%src\cli\setup-meetron.mjs" %*
exit /b %errorlevel%
