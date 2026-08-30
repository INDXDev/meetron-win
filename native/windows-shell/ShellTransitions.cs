namespace Meetron.WindowsShell;

internal sealed record ShellNotification(string Title, string Message);

internal static class ShellTransitions
{
    public static IReadOnlyList<ShellNotification> Evaluate(ShellSnapshot previous, ShellSnapshot current)
    {
        var notifications = new List<ShellNotification>();
        if (previous.MeetingConnection != "joined" && current.MeetingConnection == "joined")
        {
            notifications.Add(new(
                "GPT-Live was admitted",
                "The participant joined the meeting successfully."));
        }
        if (previous.VoiceActive && !current.VoiceActive && current.MeetingConnection == "joined")
        {
            notifications.Add(new(
                "ChatGPT Voice stopped",
                "Voice ended unexpectedly while GPT-Live is still in the meeting."));
        }
        var endedExplicitly = previous.SessionStatus != "stopped" && current.SessionStatus == "stopped";
        var endedUnexpectedly = previous.MeetingConnection == "joined" &&
            current.MeetingConnection != "joined" && current.SessionStatus is "completed" or "failed";
        if (endedExplicitly || endedUnexpectedly)
        {
            notifications.Add(new(
                "Meetron session ended",
                endedUnexpectedly
                    ? "GPT-Live is no longer connected to the meeting."
                    : "Voice, meeting participation, and audio cleanup have finished."));
        }
        return notifications;
    }
}
