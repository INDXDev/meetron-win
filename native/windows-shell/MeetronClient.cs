using System.Diagnostics;
using System.Text.Json;

namespace Meetron.WindowsShell;

internal sealed class MeetronClient
{
    private readonly string _nodePath;
    private readonly string _bridgePath;
    private readonly bool _packaged;

    public MeetronClient()
    {
        RepoRoot = FindRepoRoot();
        var bundledNode = Path.Combine(RepoRoot, "runtime", "node.exe");
        _packaged = File.Exists(bundledNode);
        _nodePath = Environment.GetEnvironmentVariable("MEETING_COPILOT_NODE_PATH") ??
            (File.Exists(bundledNode) ? bundledNode : "node.exe");
        _bridgePath = Path.Combine(RepoRoot, "src", "cli", "windows-shell-command.mjs");
        RuntimeDirectory = Environment.GetEnvironmentVariable("MEETING_COPILOT_RUNTIME_DIR") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Meetron", "Runtime");
    }

    public string RepoRoot { get; }
    public string RuntimeDirectory { get; }
    public bool IsPackaged => _packaged;

    public async Task<JsonElement> SendAsync(string type, object? payload = null, int timeoutSeconds = 45)
    {
        var request = JsonSerializer.Serialize(new { type, payload = payload ?? new { } });
        var result = await RunProcessAsync(
            _nodePath,
            [_bridgePath, "--request-stdin"],
            request,
            timeoutSeconds);
        using var document = JsonDocument.Parse(result);
        var root = document.RootElement;
        if (!root.GetBooleanOrDefault("ok"))
        {
            var error = root.GetStringOrDefault("error", "Meetron command failed");
            throw new InvalidOperationException(error);
        }
        return root.TryGetProperty("data", out var data) ? data.Clone() : default;
    }

    public Task<JsonElement> GetStatusAsync() => SendAsync("session.status.get", timeoutSeconds: 20);

    public async Task InstallIntegrationAsync()
    {
        await RunProcessAsync(
            _nodePath,
            [Path.Combine(RepoRoot, "src", "cli", "install-control-ui.mjs")],
            null,
            120);
    }

    private async Task<string> RunProcessAsync(
        string executable,
        IReadOnlyList<string> arguments,
        string? stdin,
        int timeoutSeconds)
    {
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = RepoRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = stdin is not null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment["MEETRON_PLATFORM"] = "win32";
        if (_packaged) start.Environment["MEETRON_PACKAGED"] = "1";
        using var process = Process.Start(start) ?? throw new InvalidOperationException($"Could not start {executable}");
        if (stdin is not null)
        {
            await process.StandardInput.WriteAsync(stdin);
            process.StandardInput.Close();
        }
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException($"Meetron command timed out after {timeoutSeconds} seconds");
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr)
                ? $"Meetron command stopped ({process.ExitCode})"
                : stderr.Trim());
        }
        return stdout.Trim();
    }

    private static string FindRepoRoot()
    {
        var configured = Environment.GetEnvironmentVariable("MEETRON_REPO_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(Path.Combine(configured, "package.json")))
        {
            return Path.GetFullPath(configured);
        }
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                File.Exists(Path.Combine(directory.FullName, "scripts", "native-host.mjs")))
            {
                return directory.FullName;
            }
        }
        throw new DirectoryNotFoundException("Could not locate the Meetron source directory. Set MEETRON_REPO_ROOT.");
    }
}
