using Meetron.WindowsShell;
using System.Text.Json;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var idle = ShellSnapshot.Empty with { HostConnected = true };
var joined = idle with
{
    SessionStatus = "completed",
    MeetingConnection = "joined",
    Microphone = "muted",
    VoiceActive = true,
};
var admission = ShellTransitions.Evaluate(idle, joined);
Require(admission.Count == 1 && admission[0].Title.Contains("admitted"), "Admission must notify once");

var voiceStopped = ShellTransitions.Evaluate(joined, joined with { VoiceActive = false });
Require(voiceStopped.Count == 1 && voiceStopped[0].Title.Contains("Voice"), "Unexpected Voice loss must notify");

var ended = ShellTransitions.Evaluate(joined, joined with
{
    MeetingConnection = "not-running",
    VoiceActive = false,
});
Require(ended.Any(item => item.Title.Contains("ended")), "Unexpected meeting loss must notify");
Require(ShellTransitions.Evaluate(idle, idle).Count == 0, "Stable idle state must stay silent");

var unreadable = joined with
{
    HostConnected = false,
    MeetingConnection = "not-running",
    VoiceActive = false,
    Error = "Meetron command timed out",
    Degraded = true,
};
Require(ShellTransitions.Evaluate(joined, unreadable).Count == 0,
    "A failed status read must not report the session as ended");
Require(ShellTransitions.Evaluate(unreadable, joined).Count == 0,
    "Recovering from a failed status read must not report a new admission");

Require(MicrophonePrivacy.Evaluate("Allow", "Allow") == MicrophonePrivacyState.Allowed,
    "Allowed microphone settings must pass preflight");
Require(MicrophonePrivacy.Evaluate("Allow", "Deny") == MicrophonePrivacyState.Blocked,
    "Desktop microphone denial must block preflight");
Require(MicrophonePrivacy.Evaluate(null, null) == MicrophonePrivacyState.Unknown,
    "Missing consent values must remain unknown");

using var document = JsonDocument.Parse("""
{
  "host": { "connected": true },
  "meetingLaunch": { "status": "completed", "providerId": "google-meet" },
  "dedicatedMeeting": { "connection": "joined", "microphone": "muted" },
  "participantMicrophone": { "state": "muted" },
  "chatgpt": { "voiceActive": true },
  "audio": { "devicesReady": true },
  "configuration": { "projectConfigured": true, "setupComplete": true }
}
""");
var parsed = ShellSnapshot.FromStatus(document.RootElement);
Require(parsed.SessionActive && parsed.GptMuted && parsed.VoiceActive, "Live shell state must parse canonical host status");
Require(!parsed.TrayText.Contains("google"), "Tray text must not expose meeting details");
Require(parsed.Error is null && !parsed.Degraded, "A healthy status must not be reported as limited");

Console.WriteLine("WinUI shell state, notifications, and microphone privacy passed.");
