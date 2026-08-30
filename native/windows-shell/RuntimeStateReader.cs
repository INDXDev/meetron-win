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
