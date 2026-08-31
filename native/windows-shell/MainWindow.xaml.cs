using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using System.Diagnostics;
using System.Text.Json;
using Windows.Graphics;
using WinRT.Interop;

namespace Meetron.WindowsShell;

public sealed partial class MainWindow : Window
{
    private readonly MeetronClient _client;
    private readonly SessionMonitor _monitor;
    private readonly NotificationService _notifications;
    private readonly SettingsStore _settingsStore = new();
    // Deliberately never disposed: a toggle that started before the window closed still
    // has to be able to release it.
    private readonly SemaphoreSlim _muteGate = new(1, 1);
    private ShellSettings _settings;
    private NativeWindowController? _native;
    private AppWindow? _appWindow;
    private bool _initialized;
    private bool _exiting;
    private bool _loadingSettings;

    public MainWindow()
    {
        InitializeComponent();
        _client = new MeetronClient();
        _monitor = new SessionMonitor(_client);
        _notifications = new NotificationService();
        _settings = _settingsStore.Load();
        Activated += MainWindow_Activated;
        Closed += MainWindow_Closed;
        _monitor.Changed += snapshot => DispatcherQueue.TryEnqueue(() => ApplySnapshot(snapshot));
        _monitor.Notification += (title, message) => DispatcherQueue.TryEnqueue(() =>
        {
            if (_settings.NotificationsEnabled) _notifications.Show(title, message);
        });
        _notifications.Invoked += () => DispatcherQueue.TryEnqueue(ShowWindow);
    }

    private void MainWindow_Activated(object sender, WindowActivatedEventArgs args)
    {
        if (_initialized) return;
        _initialized = true;
        var hwnd = WindowNative.GetWindowHandle(this);
        var windowId = Win32Interop.GetWindowIdFromWindow(hwnd);
        _appWindow = AppWindow.GetFromWindowId(windowId);
        _appWindow.Resize(new SizeInt32(920, 720));
        _appWindow.Closing += (_, closing) =>
        {
            if (_exiting) return;
            closing.Cancel = true;
            HideWindow(hwnd);
        };
        _native = new NativeWindowController(hwnd);
        _native.ShowRequested += () => DispatcherQueue.TryEnqueue(ShowWindow);
        _native.ToggleMuteRequested += () => DispatcherQueue.TryEnqueue(async () => await ToggleMuteAsync(fromBackground: true));
        _native.ExitRequested += () => DispatcherQueue.TryEnqueue(ExitApplication);
        LoadSettingsControls();
        Navigation.SelectedItem = Navigation.MenuItems[0];
        _monitor.Start();
    }

    private void ApplySnapshot(ShellSnapshot snapshot)
    {
        Headline.Text = snapshot.SessionActive || snapshot.SessionStatus == "completed"
            ? snapshot.GptMuted ? "GPT-Live is muted" : snapshot.Microphone == "unmuted" ? "GPT-Live is live" : "Session state needs attention"
            : snapshot.HostConnected ? "Meetron is ready" : "Meetron host is unavailable";
        Summary.Text = snapshot.TrayText.Replace("Meetron — ", "") +
            (string.IsNullOrWhiteSpace(snapshot.ProviderId) ? "" : $" · {snapshot.ProviderId}");
        Footer.Text = string.IsNullOrEmpty(snapshot.Error)
            ? $"Audio: {(snapshot.AudioReady ? "ready" : "not ready")} · Project: {(snapshot.ProjectConfigured ? "configured" : "not configured")} · Setup: {(snapshot.SetupComplete ? "complete" : "incomplete")}"
            : $"Limited status: {snapshot.Error}";
        _native?.Update(snapshot);
    }

    private async Task ExecuteAsync(
        Func<Task> operation,
        InfoBar info,
        string success,
        string? failureNotificationTitle = null)
    {
        info.IsOpen = false;
        try
        {
            await operation();
            info.Severity = InfoBarSeverity.Success;
            info.Message = success;
            info.IsOpen = true;
            await _monitor.RefreshAsync();
        }
        catch (Exception error)
        {
            info.Severity = InfoBarSeverity.Error;
            info.Message = error.Message;
            info.IsOpen = true;
            if (failureNotificationTitle is not null && _settings.NotificationsEnabled)
            {
                _notifications.Show(failureNotificationTitle, error.Message);
            }
            // A command that timed out can still be finishing in the background, so the
            // status is re-read instead of being left on the pre-command snapshot.
            // RefreshAsync swallows its own failures, so it cannot mask the error above.
            await _monitor.RefreshAsync();
        }
    }

    // `participant.mic.toggle` is a read-modify-write on the provider's live microphone
    // state, so two overlapping toggles — the button, the tray item and Ctrl+Alt+M can
    // all fire independently — would both read the same state and leave the microphone
    // in an indeterminate one while both report success. Only one toggle is ever in
    // flight; a press that arrives while one is running is dropped rather than queued,
    // because a queued second toggle would just undo the first.
    private async Task ToggleMuteAsync(bool fromBackground = false)
    {
        if (!await _muteGate.WaitAsync(0)) return;
        try
        {
            ToggleMuteButton.IsEnabled = false;
            await ExecuteAsync(
                async () => { await _client.SendAsync("participant.mic.toggle"); },
                SessionInfo,
                "GPT participant microphone changed.",
                // A hotkey or tray toggle usually runs with the window hidden, so a failed
                // mute has to reach the user instead of only the InfoBar behind the tray.
                fromBackground ? "GPT mute did not change" : null);
        }
        finally
        {
            ToggleMuteButton.IsEnabled = true;
            _muteGate.Release();
        }
    }

    private async void StartSession_Click(object sender, RoutedEventArgs e)
    {
        if (MicrophonePrivacy.Check() == MicrophonePrivacyState.Blocked)
        {
            SessionInfo.Severity = InfoBarSeverity.Error;
            SessionInfo.Message = "Windows microphone access is off. Open Diagnostics, enable microphone access, then retry.";
            SessionInfo.IsOpen = true;
            return;
        }
        var meetingUrl = MeetingUrl.Password;
        await ExecuteAsync(
            async () =>
            {
                if (string.IsNullOrWhiteSpace(meetingUrl)) throw new InvalidOperationException("Enter a meeting URL.");
                await _client.SendAsync("session.start", new { meetingUrl });
                MeetingUrl.Password = "";
            },
            SessionInfo,
            "Meeting launch started. Meetron will notify you after admission.");
    }

    private async void ToggleMute_Click(object sender, RoutedEventArgs e) => await ToggleMuteAsync();

    private async void StopSession_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(
        async () => { await _client.SendAsync("session.stop", timeoutSeconds: 60); },
        SessionInfo,
        "Session ended and cleanup completed.");

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await _monitor.RefreshAsync();

    private async void InstallIntegration_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(
        _client.InstallIntegrationAsync,
        SetupInfo,
        "Browser integration installed for the current Windows user.");

    private async void SaveProject_Click(object sender, RoutedEventArgs e)
    {
        var projectUrl = ProjectUrl.Password;
        await ExecuteAsync(
            async () =>
            {
                await _client.SendAsync("setup.project.save", new { projectUrl });
                ProjectUrl.Password = "";
            },
            SetupInfo,
            "Project URL saved in Windows Credential Manager.");
    }

    private async void ConfigureAudio_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(
        async () => { await _client.SendAsync("setup.audio.configure", timeoutSeconds: 60); },
        SetupInfo,
        "VB-CABLE audio routing is configured.");

    private async void OpenGoogle_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(
        async () => { await _client.SendAsync("setup.open.dedicated-chrome"); },
        SetupInfo,
        "Dedicated Chrome opened. Sign in to Google, then check the confirmation.");

    private async void OpenChatGpt_Click(object sender, RoutedEventArgs e) => await ExecuteAsync(
        async () => { await _client.SendAsync("setup.open.chatgpt", timeoutSeconds: 60); },
        SetupInfo,
        "ChatGPT setup opened. Sign in, then check the confirmation.");

    private async void GoogleConfirmed_Click(object sender, RoutedEventArgs e) => await SaveConfirmationAsync(
        "googleLogin", GoogleConfirmed.IsChecked == true);

    private async void ChatGptConfirmed_Click(object sender, RoutedEventArgs e) => await SaveConfirmationAsync(
        "chatgptLogin", ChatGptConfirmed.IsChecked == true);

    private async Task SaveConfirmationAsync(string step, bool complete) => await ExecuteAsync(
        async () => { await _client.SendAsync("setup.confirm", new { step, complete }); },
        SetupInfo,
        "Setup confirmation saved.");

    private async Task LoadSetupAsync()
    {
        try
        {
            var setup = await _client.SendAsync("setup.status");
            if (setup.TryGetProperty("confirmations", out var confirmations))
            {
                GoogleConfirmed.IsChecked = confirmations.GetBooleanOrDefault("googleLoginConfirmed");
                ChatGptConfirmed.IsChecked = confirmations.GetBooleanOrDefault("chatgptLoginConfirmed");
            }
            if (setup.TryGetProperty("project", out var project) && project.GetBooleanOrDefault("configured"))
            {
                ProjectUrl.PlaceholderText = "Stored securely in Windows Credential Manager";
            }
        }
        catch (Exception error)
        {
            SetupInfo.Severity = InfoBarSeverity.Warning;
            SetupInfo.Message = error.Message;
            SetupInfo.IsOpen = true;
        }
    }

    private async void RunDiagnostics_Click(object sender, RoutedEventArgs e)
    {
        var privacy = MicrophonePrivacy.Check();
        var lines = new List<string>
        {
            $"Source: {_client.RepoRoot}",
            $"Runtime: {_client.RuntimeDirectory}",
            $"Microphone privacy: {privacy}",
            $"Tray icon: {(_native?.TrayIconVisible == true ? "registered" : "not registered — retrying")}",
            $"Credential helper: {(File.Exists(Path.Combine(_client.RepoRoot, "native", "windows", "target", "release", "meetron-credential.exe")) ? "present" : "missing")}",
            $"Native host helper: {(File.Exists(Path.Combine(_client.RepoRoot, "native", "windows", "target", "release", "meetron-host.exe")) ? "present" : "missing")}",
        };
        try
        {
            var result = await _client.SendAsync("diagnostics.run", timeoutSeconds: 45);
            lines.Add($"Environment checks: {(result.GetBooleanOrDefault("ok") ? "passed" : "failed — inspect runtime logs")}");
        }
        catch (Exception error)
        {
            lines.Add($"Environment checks: unavailable — {error.Message}");
        }
        if (privacy == MicrophonePrivacyState.Blocked)
        {
            lines.Add("Action required: enable both microphone access and desktop-app microphone access.");
        }
        DiagnosticsText.Text = string.Join(Environment.NewLine, lines);
    }

    private void OpenMicrophoneSettings_Click(object sender, RoutedEventArgs e) => MicrophonePrivacy.OpenSettings();

    private void OpenLogs_Click(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(_client.RuntimeDirectory);
        Process.Start(new ProcessStartInfo("explorer.exe", _client.RuntimeDirectory) { UseShellExecute = true });
    }

    private void Navigation_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var tag = (args.SelectedItemContainer?.Tag as string) ?? "session";
        SessionPanel.Visibility = tag == "session" ? Visibility.Visible : Visibility.Collapsed;
        SetupPanel.Visibility = tag == "setup" ? Visibility.Visible : Visibility.Collapsed;
        DiagnosticsPanel.Visibility = tag == "diagnostics" ? Visibility.Visible : Visibility.Collapsed;
        SettingsPanel.Visibility = tag == "settings" ? Visibility.Visible : Visibility.Collapsed;
        if (tag == "setup") _ = LoadSetupAsync();
    }

    private void LoadSettingsControls()
    {
        _loadingSettings = true;
        NotificationsEnabled.IsOn = _settings.NotificationsEnabled;
        HotkeyEnabled.IsOn = _settings.HotkeyEnabled;
        _native?.SetHotkeyEnabled(_settings.HotkeyEnabled);
        _loadingSettings = false;
        if (_settings.HotkeyEnabled && _native?.HotkeyRegistered == false)
        {
            Footer.Text = "Ctrl+Alt+M is already registered by another application.";
        }
    }

    private void Settings_Toggled(object sender, RoutedEventArgs e)
    {
        if (_loadingSettings) return;
        _settings = new ShellSettings(NotificationsEnabled.IsOn, HotkeyEnabled.IsOn);
        _settingsStore.Save(_settings);
        _native?.SetHotkeyEnabled(_settings.HotkeyEnabled);
        if (_settings.HotkeyEnabled && _native?.HotkeyRegistered == false)
        {
            Footer.Text = "Could not register Ctrl+Alt+M because another application owns it.";
        }
    }

    private void ShowWindow()
    {
        var hwnd = WindowNative.GetWindowHandle(this);
        ShowNativeWindow(hwnd);
        Activate();
        SetForegroundWindow(hwnd);
    }

    private void Exit_Click(object sender, RoutedEventArgs e) => ExitApplication();

    private void ExitApplication()
    {
        _exiting = true;
        Close();
    }

    private void MainWindow_Closed(object sender, WindowEventArgs args)
    {
        _monitor.Dispose();
        _notifications.Dispose();
        _native?.Dispose();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "ShowWindow")]
    private static extern bool ShowNativeWindow(nint window, int command = 5);
    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "ShowWindow")]
    private static extern bool HideNativeWindow(nint window, int command);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint window);

    private static void HideWindow(nint window) => HideNativeWindow(window, 0);
}
