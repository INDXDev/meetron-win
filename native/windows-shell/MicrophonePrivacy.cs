using Microsoft.Win32;
using System.Diagnostics;

namespace Meetron.WindowsShell;

internal enum MicrophonePrivacyState { Allowed, Blocked, Unknown }

internal static class MicrophonePrivacy
{
    private const string ConsentPath = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    public static MicrophonePrivacyState Check()
    {
        var root = ReadValue(Registry.CurrentUser, ConsentPath);
        var desktop = ReadValue(Registry.CurrentUser, ConsentPath + @"\NonPackaged");
        return Evaluate(root, desktop);
    }

    internal static MicrophonePrivacyState Evaluate(string? root, string? desktop)
    {
        if (string.Equals(root, "Deny", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(desktop, "Deny", StringComparison.OrdinalIgnoreCase))
        {
            return MicrophonePrivacyState.Blocked;
        }
        if (string.Equals(root, "Allow", StringComparison.OrdinalIgnoreCase) &&
            (desktop is null || string.Equals(desktop, "Allow", StringComparison.OrdinalIgnoreCase)))
        {
            return MicrophonePrivacyState.Allowed;
        }
        return MicrophonePrivacyState.Unknown;
    }

    public static void OpenSettings() => Process.Start(new ProcessStartInfo("ms-settings:privacy-microphone")
    {
        UseShellExecute = true,
    });

    private static string? ReadValue(RegistryKey root, string path)
    {
        try { return root.OpenSubKey(path)?.GetValue("Value") as string; }
        catch { return null; }
    }
}
