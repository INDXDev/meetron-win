namespace Meetron.WindowsShell;

internal sealed class SessionMonitor(MeetronClient client) : IDisposable
{
    private readonly RuntimeStateReader _fallback = new(client.RuntimeDirectory);
    private readonly SemaphoreSlim _pollGate = new(1, 1);
    private Timer? _timer;
    private ShellSnapshot? _previous;
    private volatile bool _disposed;

    public event Action<ShellSnapshot>? Changed;
    public event Action<string, string>? Notification;

    // The callback must never be `async void`: an escaping exception from a timer
    // thread would terminate the shell instead of skipping one poll.
    public void Start() => _timer ??= new Timer(_ => _ = PollSafeAsync(), null, 0, 4_000);

    public Task RefreshAsync() => PollSafeAsync();

    private async Task PollSafeAsync()
    {
        try
        {
            await PollAsync();
        }
        catch
        {
            // Status polling is best effort and must not interrupt a meeting.
        }
    }

    private async Task PollAsync()
    {
        if (_disposed || !await _pollGate.WaitAsync(0)) return;
        try
        {
            ShellSnapshot current;
            try
            {
                current = ShellSnapshot.FromStatus(await client.GetStatusAsync());
            }
            catch (Exception error)
            {
                current = _fallback.ReadFallback(error);
            }

            if (_disposed) return;
            var previous = _previous;
            _previous = current;
            Changed?.Invoke(current);
            if (previous is null) return;

            foreach (var notification in ShellTransitions.Evaluate(previous, current))
                Notification?.Invoke(notification.Title, notification.Message);
        }
        finally
        {
            _pollGate.Release();
        }
    }

    public void Dispose()
    {
        // The gate is deliberately left undisposed: a poll started before Dispose can
        // still be awaiting the Native Host and has to be able to release it.
        _disposed = true;
        _timer?.Dispose();
    }
}
