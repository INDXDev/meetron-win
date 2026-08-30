using System.Text.Json;

namespace Meetron.WindowsShell;

internal sealed record ShellSettings(bool NotificationsEnabled = true, bool HotkeyEnabled = true);

internal sealed class SettingsStore
{
    private readonly string _path = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Meetron",
        "shell-settings.json");

    public ShellSettings Load()
    {
        try
        {
            return JsonSerializer.Deserialize<ShellSettings>(File.ReadAllText(_path)) ?? new();
        }
        catch
        {
            return new();
        }
    }

    public void Save(ShellSettings settings)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = $"{_path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }) + "\n");
        File.Move(temporary, _path, true);
    }
}
