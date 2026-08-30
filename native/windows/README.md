# Meetron Windows native helpers

Phase 1 uses two small Rust executables. They are source-built beta components,
not a signed installer or a replacement virtual-audio driver.

- `meetron-host.exe` is Chrome's Native Messaging entry point. It reads
  `meetron-host.conf` beside the executable, starts the configured Node.js host
  with inherited stdio, and contains itself and every descendant in a Windows
  Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. If the
  recorded Node path has moved, the shim checks its bundle directory, the
  Node.js registry keys, `where.exe`, and standard per-machine/per-user paths.
- `meetron-audioctl.exe` enumerates active capture/render endpoints through
  MMDevice, returns stable endpoint IDs in the existing JSON CLI schema, and
  supports the same status/default-device commands as the macOS helper.

Build and verify on Windows 11 with the stable Rust toolchain:

```powershell
npm run build:windows
npm run test:windows
npm test
```

`node src/cli/install-control-ui.mjs` copies the release host shim and writes
its two-line config into the ACL-protected runtime directory. It then writes
the ordinary Chrome Native Messaging manifest and registers its absolute path
under the current user's Chrome registry key. No executable is committed to
the repository.

The MMDevice default-endpoint setter uses Windows' `IPolicyConfig` interface,
which Microsoft does not document as a public API. Normal Meetron routing does
not change system defaults; this command remains only for compatibility with
the established audio-controller protocol and legacy restore flow.

The Rust dependencies are `serde`/`serde_json` and Microsoft's `windows-rs`
bindings. All are used under their published MIT or Apache-2.0 terms and are
locked in `Cargo.lock`.
