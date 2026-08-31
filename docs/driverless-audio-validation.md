# Driverless audio validation

Phase 3 adds an experimental `webrtc-loopback` backend. It creates one
bidirectional `RTCPeerConnection` between the dedicated ChatGPT and meeting
tabs. Page-world `getUserMedia`, media-element `setSinkId`, and Web Audio output
hooks exchange tracks through a content-script relay; the extension service
worker carries SDP and ICE signaling only. Audio does not pass through the
Native Messaging Host and no audio is recorded or written to disk.

## Feature gate

The backend is opt-in and is deliberately not selected by `auto`:

```powershell
$env:MEETING_COPILOT_AUDIO_BACKEND = "webrtc-loopback"
```

Reload the unpacked Meetron extension in both regular and dedicated Chrome
after updating. Remove the variable to return to the existing device backend.
Device backends, provider/session contracts, exit codes, and Native Messaging
commands are unchanged.

## Phase 4 handoff

Packaging must include `audio-bridge-content-script.js` and its ChatGPT, Meet,
and Zoom match patterns without changing the extension ID. It must preserve
`MEETING_COPILOT_AUDIO_BACKEND=webrtc-loopback`, the existing Native Messaging
host/protocol, dedicated-profile path, provider preparation results, and session
exit codes. Phase 4 does not need an audio driver or a new privileged helper for
this backend; signing, installer, updater, and startup behavior remain Phase 4
work and are not implemented here.

## Reproducible checks

Run the deterministic two-tab signaling and browser integration:

```powershell
npm run measure:audio-bridge -- --mode webrtc-loopback
```

The check reports the hook-free WebRTC control as well as the Meetron path.
Some Chrome/Windows automation combinations transmit RTP comfort-noise
packets but render no nonzero audio even in the hook-free control. Such a run
validates pairing, renegotiation, track lifetimes, and packet flow, but it is
not a latency or quality measurement and must not be used to promote the
backend or trigger Phase 5.

For comparable latency, frequency, and RMS figures, repeat the same check in an
interactive browser five times:

```powershell
npm run measure:audio-bridge -- --mode webrtc-loopback --headful
```

Measure the existing cable in each direction from an interactive Chrome:

```powershell
npm run measure:audio-bridge -- --mode cable `
  --output-device "CABLE-B Input (VB-Audio Cable B)" `
  --input-device "CABLE-B Output (VB-Audio Cable B)"

npm run measure:audio-bridge -- --mode cable `
  --output-device "CABLE-A Input (VB-Audio Cable A)" `
  --input-device "CABLE-A Output (VB-Audio Cable A)"
```

The command emits JSON containing onset latency, RMS, the measured peak for a
997 Hz reference tone, and frequency error. Run each direction five times on
the same machine/Chrome build, then run the driverless check and a
non-confidential live meeting without changing hardware.

The promotion quality bar is:

- Google Meet and Zoom Web each complete join, bidirectional speech, mute,
  Voice restart, screen send, and stop independently.
- Median added driverless latency is at most 50 ms over cable and p95 added
  latency is at most 80 ms.
- Reference-tone frequency error is at most 2%, RMS differs by at most 3 dB,
  and no clipping, dropouts, echo, noise suppression, or automatic gain
  pumping is audible in a five-minute speech exchange.
- Both directions keep `echoCancellation`, `autoGainControl`, and
  `noiseSuppression` disabled and no physical microphone or speaker becomes
  active.

## Current Phase 3 evidence and limitations

- Backend/status/configuration contracts, sender authorization, service-worker
  pairing, bounded SDP/ICE relay, peer replacement, disconnect handling, and provider
  hook selection have automated coverage.
- Windows Chrome two-tab runs in headless and interactive modes establish ICE,
  mix page output onto the negotiated tracks, and carry RTP packets in both
  directions. Their hook-free controls were also silent, so those runs provide
  no valid latency or fidelity number.
- Google Meet and Zoom Web have separate preparation paths. Existing provider
  fixtures remain the regression baseline, but no live-account Zoom quality
  result is committed to the repository.
- No cable endpoint was assumed to be installed during automated validation.
  Cable numbers must come from the command above on an equipped machine.

Therefore `auto` remains unchanged. The present evidence does **not** prove
that Zoom cannot carry the driverless path and does not establish unacceptable
driverless quality. Phase 5's kernel-driver condition is not met. Missing live
or hardware validation is a reason to keep the flag experimental, not evidence
for starting kernel work.
