# Meetron Windows shell

Phase 2 adds an unpackaged, source-built WinUI 3 application on Windows 11. It
uses the canonical Phase 1 Native Host commands and runtime state rather than
introducing a second meeting/session implementation.

The shell provides:

- a `Shell_NotifyIcon` tray icon whose tooltip reflects connection, GPT mute,
  and ChatGPT Voice state;
- setup, diagnostics, session, and settings surfaces;
- app notifications for admission, unexpected Voice loss, and session end;
- a fail-closed `RegisterHotKey` binding at `Ctrl+Alt+M`;
- Windows Credential Manager storage for the ChatGPT Project URL; and
- microphone privacy preflight with `ms-settings:privacy-microphone` guidance.

Build and test from the repository root on Windows 11:

```powershell
npm ci
npm run build:windows
npm run test:windows
```

Launch the source build:

```powershell
native\windows-shell\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64\Meetron.WindowsShell.exe
```

The project sets `WindowsPackageType=None` and carries the Windows App SDK
runtime self-contained. MSIX identity, signing, startup registration, bundled
Node, and update delivery remain Phase 4 work. The source checkout, Node.js,
Chrome, and VB-CABLE A+B are still required. Phase 3 driverless audio and
Phase 5 owned-driver work are also outside this project.

The shell invokes `src/cli/windows-shell-command.mjs`, which frames one request
through the existing Native Messaging host. Meeting URLs and Project URLs cross
process boundaries over stdin, not command-line arguments. Runtime state remains
under `%LOCALAPPDATA%\Meetron\Runtime`; shell preferences contain no secrets and
live at `%LOCALAPPDATA%\Meetron\shell-settings.json`.
