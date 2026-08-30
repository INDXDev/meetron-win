namespace Meetron.WindowsShell;

internal sealed class SessionMonitor(MeetronClient client) : IDisposable
{
    private readonly RuntimeStateReader _fallback = new(client.RuntimeDirectory);
    private readonly SemaphoreSlim _pollGate = new(1, 1);
    private Timer? _timer;
    private ShellSnapshot? _previous;

    public event Action<ShellSnapshot>? Changed;
    public event Action<string, string>? Notification;

    public void Start() => _timer ??= new Timer(async _ => await PollAsync(), null, 0, 4_000);

    public Task RefreshAsync() => PollAsync();

    private async Task PollAsync()
    {
        if (!await _pollGate.WaitAsync(0)) return;
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
        _timer?.Dispose();
        _pollGate.Dispose();
    }
}
