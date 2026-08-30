# Privacy

Meetron runs locally, but the audio bridge sends meeting audio to ChatGPT Web Voice and sends ChatGPT Voice output into the selected meeting. When the user presses the screenshot button in Google Meet or Zoom, the currently visible dedicated meeting viewport is also sent to the active ChatGPT conversation. Those services process audio and images under the user's account settings, terms, and privacy policies.

## Local data

The project may store the following data on the Mac:

- `.meeting-copilot.env`: ChatGPT Project URL and local automation ports
- `.meeting-copilot-runtime/`: launch status, recent microphone state, setup confirmations, saved audio-device names and Core Audio UIDs, and bounded diagnostic logs
- Shared dedicated Chrome profile at `~/Library/Application Support/MeetingCopilot/GPTParticipantChrome/`: ChatGPT and Google sessions, cookies, permissions, and extension state
- Chrome extension local storage: the last entered Meet URL and panel layout preferences

These paths are excluded from Git. Meetron does not intentionally record or transcribe meeting audio, and it does not send local runtime files to this repository's maintainers.

Meeting screenshots are encoded as JPEG in memory and are not intentionally written to Meetron's local runtime directory. Screenshot delivery writes bounded diagnostics to `.meeting-copilot-runtime/visual-context.log`; these records contain the provider ID, processing stage, duration, and error code, but not the image, meeting URL, prompt, attachment filename, or ChatGPT conversation URL. The submitted image and prompt become part of the ChatGPT conversation and may remain server-side until the user deletes them according to their ChatGPT settings.

## User responsibilities

Before connecting Meetron:

1. Notify participants that an AI participant is present and audio is being processed.
2. Obtain consent where law, policy, or contract requires it.
3. Review ChatGPT Data Controls and the Google account settings used by the dedicated profiles.
4. Avoid confidential meetings until the setup has been tested with non-sensitive audio.
5. Before sending a screenshot, check the full visible meeting viewport for confidential content, participant names, notifications, or chat messages and obtain any required consent.

## Deletion

Remove the extension from both Chrome profiles, then run:

```bash
node src/cli/uninstall.mjs --remove-data --yes
```

This deletes the Native Messaging registration, local configuration and runtime files, the shared dedicated Chrome profile, and the legacy pre-0.6 ChatGPT profile if present. Add `--remove-audio-driver` to remove the system-level Meetron virtual audio plug-ins as well. It does not delete server-side ChatGPT chats or submitted screenshots, Google account data, legacy BlackHole packages, or the repository checkout.
