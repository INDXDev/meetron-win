# Windows packaging, signing, installation, and updates

Phase 4 packages the existing Phase 1-3 Windows implementation. It does not
change the extension ID, Native Messaging host name or protocol, dedicated
Chrome profile, session contracts, preparation exit codes, or audio-backend
selection. In particular, the MSIX includes
`extension/audio-bridge-content-script.js` and the ChatGPT, Google Meet, and
Zoom Web match patterns required by the opt-in Phase 3 WebRTC loopback.

## Package contents and identity

The x64 MSIX contains the self-contained WinUI 3 shell, the three Rust helpers,
a Node 22 runtime, production `playwright-core`, the JavaScript application,
and the unpacked Chrome extension. `AppxManifest.xml` declares a packaged
classic desktop application with `runFullTrust` and the `MeetronStartup`
startup task. The startup task is disabled by default so Windows and the user
retain control of start-at-logon permission.

The package identity name is `io.github.bb8ad8.meetron`. Every update must keep
that name and use the same certificate publisher subject. Windows rejects an
update when either value changes. The release packager therefore takes the
publisher from the release certificate configuration instead of guessing it.

Meetron stores mutable Windows state outside the immutable package under
`%LOCALAPPDATA%\Meetron`. This includes runtime state, the Native Messaging
launcher/configuration, a stable copy of the unpacked extension, non-secret
local settings, and the dedicated Chrome profile. The extension copy avoids a
versioned/inaccessible WindowsApps path, so Chrome keeps the same registration
across package updates. The ChatGPT Project URL remains in Windows Credential Manager. An
MSIX update replaces package files but does not copy, reset, or delete these
paths.

These choices follow Microsoft's current guidance for
[packaged classic desktop apps](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion),
[desktop startup tasks](https://learn.microsoft.com/uwp/api/windows.applicationmodel.startuptask),
and [App Installer updates](https://learn.microsoft.com/windows/msix/app-installer/auto-update-and-repair--overview).

## Unsigned local package

Build and structurally verify a package without a certificate:

```powershell
npm ci
npm run build:windows
npm run package:windows:local -- --stage-only --stage-dir dist/windows/local-stage --skip-build
npm run package:windows:local -- --pack-stage dist/windows/local-stage --output-dir dist/windows
npm run package:windows:local -- --checksum dist/windows/Meetron-0.10.1-windows-x64-LOCAL-TEST.msix
npm run verify:windows-package -- --msix dist/windows/Meetron-0.10.1-windows-x64-LOCAL-TEST.msix --allow-unsigned
```

The filename contains `LOCAL-TEST`, and release verification rejects it. An
unsigned MSIX is useful for deterministic layout, manifest, checksum, bundled
runtime, and Phase 3 contract tests, but Windows will not install it normally.
CI additionally signs that artifact with a disposable, non-exportable
`CN=Meetron Local Test` certificate and places only its public certificate in
the ephemeral admin runner's Local Machine `TrustedPeople` store, as required
for MSIX deployment trust. Separate bounded CI
steps create the certificate, sign and verify the launch-critical inner files,
sign and checksum the outer package, install/update it, and always clean up the
exact certificate thumbprint and package. The local verifier requires intact
Authenticode content and the exact test subject, while explicitly tolerating
only the self-signed certificate's untrusted-root status; this exception cannot
select release mode. The install step refreshes Native Messaging and checks the
Chrome login-state sentinel. Never publish a local certificate or its private
key, and do not run the install test against a real user profile.

## HSM-backed release signing

`.github/workflows/windows-release.yml` is the only public release path. It is
attached to the protected `windows-release` environment and uses GitHub OIDC to
authenticate to Microsoft Artifact Signing. The signing key remains in the
managed HSM service; no PFX or long-lived Azure client secret is stored in the
repository. Configure these protected environment variables:

- `WINDOWS_SIGNING_PUBLISHER`: exact certificate subject used in the manifest;
- `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`: federated workload identity;
- `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, and
  `ARTIFACT_SIGNING_PROFILE`: Artifact Signing resources.

The workload identity needs only the Artifact Signing Certificate Profile
Signer role and should trust the protected release environment subject. The
job fails before staging when any setting is missing or the local-test
publisher is selected.

The production workflow signs every staged EXE and DLL first, verifies each trusted,
timestamped Authenticode signature, packs the MSIX, signs the MSIX, recomputes
its SHA-256 checksum, unpacks it again, and verifies its identity, contents,
inner signatures, outer signature, timestamp, checksum, and App Installer
descriptor. Microsoft documents the required SHA-256 package/signature match
and timestamping in its [SignTool guidance](https://learn.microsoft.com/windows/msix/package/sign-app-package-using-signtool),
and recommends OIDC for the
[Artifact Signing GitHub integration](https://learn.microsoft.com/azure/artifact-signing/how-to-signing-integrations).

Pull-request CI uses a disposable two-day certificate to sign the app-controlled
shell EXE/DLL and three Rust helpers plus the outer MSIX. Bundled Node keeps its
vendor signature, which CI requires to be trusted and timestamped. This keeps the
real install/update test bounded while still exercising checksum, certificate
trust, package deployment, and state preservation. Release mode never
accepts this reduced local-test scope: every staged EXE/DLL must carry the configured
HSM-backed publisher signature and a trusted timestamp.

Packing and signing are separate steps, so `--pack-stage` no longer writes a
`.sha256`. The checksum is produced afterwards with
`npm run package:windows -- --checksum PATH`, which guarantees the published
hash describes the signed bytes rather than the pre-signature package.

### Update channels

Windows polls exactly the `Uri` recorded on the `<AppInstaller>` element of the
installed descriptor, forever, so that address must stay mutable:

- stable: `Meetron.appinstaller` published at
  `https://github.com/OWNER/REPO/releases/latest/download/Meetron.appinstaller`;
- beta: `Meetron-beta.appinstaller` published at the fixed, mutable `beta`
  release tag, `https://github.com/OWNER/REPO/releases/download/beta/Meetron-beta.appinstaller`.

The `beta` release holds only that descriptor; every beta build keeps its own
version tag, and each beta run replaces the `beta` asset in place. The
`<MainPackage>` `Uri` inside either feed stays pinned to the version's own tag.
Both the generator and the verifier refuse a feed whose self-`Uri` is pinned to
the same release tag as its MSIX, refuse a non-HTTPS or non-`github.com` URI,
and refuse URIs that straddle two repositories, because such a feed can never
publish another update -- including a security fix.

Run signed betas through the same protected job. Signing a beta is necessary for
early antivirus and SmartScreen feedback, but a valid signature does not create
SmartScreen reputation by itself.

## Install and update

Install the published descriptor for the channel you want -- `Meetron.appinstaller`
for stable, `Meetron-beta.appinstaller` for beta -- with Windows App Installer. It
verifies the signed MSIX and associates the installation with its update feed.
Meetron refreshes Native Messaging registration whenever the shell launches,
which replaces versioned WindowsApps paths after an update.

For a verified offline update, keep the `.msix` and adjacent `.sha256` together
and run from an existing Meetron distribution:

```powershell
node src/cli/update-meetron.mjs --package .\Meetron-VERSION-windows-x64.msix `
  --publisher "EXACT CERTIFICATE SUBJECT"
```

The updater verifies the checksum, trusted timestamped signature, fixed package
identity, manifest publisher, bundled Phase 3 files, and every release inner
signature before calling `Add-AppxPackage` (the explicitly enabled local-test
mode checks the launch-critical inner set). It then activates the installed shell
through its app-model ID (`PackageFamilyName!Meetron`) with
`IApplicationActivationManager::ActivateApplication`, capturing the resulting
process ID. This works without an interactive Explorer shell and avoids executing
a protected `WindowsApps` path directly. The updater waits for the shell to
refresh the stable Native Messaging manifest, launcher, configuration, and
registry entry. It confirms that the dedicated Chrome profile and its `Local
State` login file were not changed. The offline install is noninteractive and
bounded to two minutes, app-model activation to 30 seconds, and Native Messaging
refresh to one minute; `--dry-run` performs all verification without installation.

Source-distributed users may continue to run `Meetron Update.cmd` from a newer
source tree. That path updates the detected live installation in place, rejects
uncommitted tracked Git changes, backs up replaced source under
`%LOCALAPPDATA%\Meetron\Backups`, and preserves `.git`, local configuration,
runtime data, the unpacked-extension path, and the external Chrome profile.

## Release evidence and external gates

Before publication, use a clean Windows 11 account or machine to record:

1. App Installer accepts the HSM-signed package and displays the expected
   publisher.
2. `MeetronStartup` can be enabled and starts the per-user shell (not a service).
3. Setup finds bundled Node and does not download dependencies.
4. The extension loads from the packaged path with its stable ID.
5. An update from the previous signed version keeps both Chrome profiles,
   Google/ChatGPT login state, Credential Manager values, and runtime settings.
6. Signature and checksum verification fail after any artifact modification.
7. Microsoft Defender and SmartScreen results are recorded without bypassing
   organization policy.

The repository cannot manufacture the legal identity, Artifact Signing account,
certificate profile, clean-machine result, Defender disposition, or SmartScreen
reputation. Until maintainers provide and record those external results, the
pipeline and local unsigned artifact are implementation evidence, not a claim
that the Phase 4 signed-installer exit criterion has passed.

Phase 5 remains excluded. The current Phase 3 evidence does not establish that
Zoom cannot carry the driverless bridge or that quality is unacceptable, so it
does not authorize an owned kernel audio driver.
