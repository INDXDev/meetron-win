using System.Text.Json;

namespace Meetron.WindowsShell;

internal sealed class RuntimeStateReader(string runtimeDirectory)
{
    public ShellSnapshot ReadFallback(Exception error)
    {
        var launch = Read(Path.Combine(runtimeDirectory, "meeting-launch.json"));
        var microphone = Read(Path.Combine(runtimeDirectory, "meet-mic.json"));
        return ShellSnapshot.Empty with
        {
            SessionStatus = launch.GetStringOrDefault("status", "idle"),
            ProviderId = launch.GetStringOrDefault("providerId", ""),
            Microphone = microphone.GetStringOrDefault("state", "unavailable"),
            Error = error.Message,
            // The meeting connection and Voice flags are unknown here, so transitions
            // must not treat this snapshot as evidence that a session changed state.
            Degraded = true,
        };
    }

    private static JsonElement Read(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var document = JsonDocument.Parse(stream);
            return document.RootElement.Clone();
        }
        catch
        {
            return default;
        }
    }
}
