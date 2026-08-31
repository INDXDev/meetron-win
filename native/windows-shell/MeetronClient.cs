using System.Diagnostics;
using System.Text.Json;

namespace Meetron.WindowsShell;

internal sealed class MeetronClient
{
    private readonly string _nodePath;
    private readonly string _bridgePath;

    public MeetronClient()
    {
        RepoRoot = FindRepoRoot();
        _nodePath = Environment.GetEnvironmentVariable("MEETING_COPILOT_NODE_PATH") ?? "node.exe";
        _bridgePath = Path.Combine(RepoRoot, "src", "cli", "windows-shell-command.mjs");
        RuntimeDirectory = Environment.GetEnvironmentVariable("MEETING_COPILOT_RUNTIME_DIR") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Meetron", "Runtime");
    }

    public string RepoRoot { get; }
    public string RuntimeDirectory { get; }

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
            // Only the bridge itself is stopped. `entireProcessTree` would also reach
            // the Native Host and the detached meeting launch job below it, so a join
            // that merely outran the timeout would be killed halfway and leave
            // meeting-launch.json claiming a dead process — or audio routing restored
            // only in part. The work keeps running and the next status poll reports it.
            try { if (!process.HasExited) process.Kill(); } catch { }
            await DrainAsync(stdoutTask, stderrTask);
            throw new TimeoutException(
                $"Meetron command timed out after {timeoutSeconds} seconds. " +
                "It may still be finishing in the background — check the status before retrying.");
        }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(DescribeFailure(stdout, stderr, process.ExitCode));
        }
        return stdout.Trim();
    }

    // The readers own the redirected pipes, so they have to finish before `using var
    // process` disposes those pipes underneath them. Killing the bridge closes both
    // pipes, so the wait normally returns at once; the bound only covers a handle an
    // unexpected grandchild kept open.
    private static async Task DrainAsync(Task<string> stdoutTask, Task<string> stderrTask)
    {
        var readers = Task.WhenAll(stdoutTask, stderrTask);
        // Observed here as well so a reader that fails after the bound still cannot
        // surface as an unobserved task exception.
        _ = readers.ContinueWith(static task => { _ = task.Exception; }, TaskScheduler.Default);
        try
        {
            await readers.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // The timeout is already being reported; a broken pipe adds nothing.
        }
    }

    // The bridge reports a rejected command as exit code 1 with the protocol error on
    // stdout, so the structured message has to be preferred over the exit code.
    private static string DescribeFailure(string stdout, string stderr, int exitCode)
    {
        var payload = stdout.Trim();
        if (payload.StartsWith('{'))
        {
            try
            {
                using var document = JsonDocument.Parse(payload);
                var message = document.RootElement.GetStringOrDefault("error", "");
                if (!string.IsNullOrWhiteSpace(message)) return message;
            }
            catch (JsonException)
            {
                // Fall through to the transport level description below.
            }
        }
        return string.IsNullOrWhiteSpace(stderr)
            ? $"Meetron command stopped ({exitCode})"
            : stderr.Trim();
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
