using System.Text.Json;

namespace Meetron.WindowsShell;

internal sealed record ShellSnapshot(
    bool HostConnected,
    string SessionStatus,
    string MeetingConnection,
    string Microphone,
    bool VoiceActive,
    bool AudioReady,
    bool ProjectConfigured,
    bool SetupComplete,
    string ProviderId,
    string? Error)
{
    public static ShellSnapshot Empty { get; } = new(
        false, "idle", "not-running", "unavailable", false, false, false, false, "", null);

    public bool SessionActive =>
        MeetingConnection == "joined" || SessionStatus is "starting" or "running";

    public bool GptMuted => Microphone == "muted";

    public string TrayText
    {
        get
        {
            if (!HostConnected) return "Meetron — host unavailable";
            if (!SessionActive && SessionStatus != "completed") return "Meetron — no active session";
            var voice = VoiceActive ? "Voice active" : "Voice inactive";
            var microphone = GptMuted ? "GPT muted" : Microphone == "unmuted" ? "GPT live" : "GPT mic unknown";
            return $"Meetron — {microphone} — {voice}";
        }
    }

    public static ShellSnapshot FromStatus(JsonElement data)
    {
        var launch = Child(data, "meetingLaunch");
        var meeting = Child(data, "dedicatedMeeting");
        var microphone = Child(data, "participantMicrophone");
        var chatgpt = Child(data, "chatgpt");
        var audio = Child(data, "audio");
        var configuration = Child(data, "configuration");
        return new ShellSnapshot(
            Child(data, "host").GetBooleanOrDefault("connected"),
            launch.GetStringOrDefault("status", "idle"),
            meeting.GetStringOrDefault("connection", "not-running"),
            microphone.GetStringOrDefault("state", meeting.GetStringOrDefault("microphone", "unavailable")),
            chatgpt.GetBooleanOrDefault("voiceActive"),
            audio.GetBooleanOrDefault("devicesReady"),
            configuration.GetBooleanOrDefault("projectConfigured"),
            configuration.GetBooleanOrDefault("setupComplete"),
            launch.GetStringOrDefault("providerId", meeting.GetStringOrDefault("providerId", "")),
            launch.GetStringOrDefault("error", null));
    }

    private static JsonElement Child(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var child)
            ? child
            : default;
}

internal static class JsonElementExtensions
{
    public static string GetStringOrDefault(this JsonElement element, string name, string? fallback)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? fallback ?? "";
        }
        return fallback ?? "";
    }

    public static bool GetBooleanOrDefault(this JsonElement element, string name)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
    }
}
