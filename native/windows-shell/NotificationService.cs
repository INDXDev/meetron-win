using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Meetron.WindowsShell;

internal sealed class NotificationService : IDisposable
{
    private bool _registered;

    public NotificationService()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += OnInvoked;
            AppNotificationManager.Default.Register();
            _registered = true;
        }
        catch
        {
            _registered = false;
        }
    }

    public event Action? Invoked;
    public bool Available => _registered;

    public void Show(string title, string message)
    {
        if (!_registered) return;
        try
        {
            var notification = new AppNotificationBuilder()
                .AddText(title)
                .AddText(message)
                .BuildNotification();
            AppNotificationManager.Default.Show(notification);
        }
        catch
        {
            // Notification failure must never interrupt a meeting operation.
        }
    }

    private void OnInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args) => Invoked?.Invoke();

    public void Dispose()
    {
        if (!_registered) return;
        try
        {
            AppNotificationManager.Default.NotificationInvoked -= OnInvoked;
            AppNotificationManager.Default.Unregister();
        }
        catch { }
    }
}
