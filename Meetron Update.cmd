@echo off
setlocal
set "MEETRON_ROOT=%~dp0"
set "MEETRON_NODE=%MEETRON_ROOT%runtime\node.exe"
rem Only the MSIX ships a bundled runtime. Run from a source checkout, this
rem must stay the documented in-place source updater rather than the packaged
rem App Installer notice.
if exist "%MEETRON_NODE%" (set "MEETRON_PACKAGED=1") else (set "MEETRON_NODE=node.exe")
"%MEETRON_NODE%" "%MEETRON_ROOT%src\cli\update-meetron.mjs" %*
exit /b %errorlevel%
