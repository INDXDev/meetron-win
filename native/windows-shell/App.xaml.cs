using Microsoft.UI.Xaml;

namespace Meetron.WindowsShell;

public partial class App : Application
{
    private MainWindow? _window;

    public App()
    {
        UnhandledException += (_, args) =>
        {
            WriteCrash(args.Exception);
            System.Diagnostics.Debug.WriteLine(args.Exception);
        };
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            _window = new MainWindow();
            _window.Activate();
            _ = RefreshPackagedIntegrationAsync();
        }
        catch (Exception error)
        {
            WriteCrash(error);
            throw;
        }
    }

    private static async Task RefreshPackagedIntegrationAsync()
    {
        try
        {
            await new MeetronClient().InstallIntegrationAsync();
        }
        catch (Exception error)
        {
            WriteCrash(error);
        }
    }

    private static void WriteCrash(Exception error)
    {
        try
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Meetron",
                "Runtime");
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "windows-shell-crash.log"), error + Environment.NewLine);
        }
        catch { }
    }
}
