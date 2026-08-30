using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Meetron.WindowsShell;

internal sealed class NativeWindowController : IDisposable
{
    private const uint TrayMessage = 0x8001;
    private const int HotkeyId = 0x4D33;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModNoRepeat = 0x4000;
    private const uint VkM = 0x4D;
    private const uint WmHotkey = 0x0312;
    private const uint WmLButtonUp = 0x0202;
    private const uint WmContextMenu = 0x007B;
    private const uint NifMessage = 0x0001;
    private const uint NifIcon = 0x0002;
    private const uint NifTip = 0x0004;
    private const uint NimAdd = 0;
    private const uint NimModify = 1;
    private const uint NimDelete = 2;
    private const uint IdiApplication = 32512;
    private const uint IdiInformation = 32516;
    private const uint IdiWarning = 32515;
    private const uint IdiError = 32513;
    private const uint MfString = 0;
    private const uint TpmReturnCmd = 0x0100;
    private const uint TpmRightButton = 0x0002;
    private const int GwlpWndProc = -4;
    private static readonly nint HwndMessage = new(-3);

    private readonly nint _owner;
    private readonly WindowProc _windowProc;
    private readonly nint _messageWindow;
    private readonly nint _oldWindowProc;
    private bool _hotkeyRegistered;
    private bool _disposed;

    public NativeWindowController(nint owner)
    {
        _owner = owner;
        _windowProc = MessageWindowProc;
        _messageWindow = CreateWindowEx(0, "STATIC", "MeetronShellMessages", 0, 0, 0, 0, 0,
            HwndMessage, 0, 0, 0);
        if (_messageWindow == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        _oldWindowProc = SetWindowLongPtr(_messageWindow, GwlpWndProc, Marshal.GetFunctionPointerForDelegate(_windowProc));
        AddTrayIcon("Meetron — starting", IdiApplication);
    }

    public event Action? ShowRequested;
    public event Action? ToggleMuteRequested;
    public event Action? ExitRequested;
    public bool HotkeyRegistered => _hotkeyRegistered;

    public void SetHotkeyEnabled(bool enabled)
    {
        if (_hotkeyRegistered)
        {
            UnregisterHotKey(_messageWindow, HotkeyId);
            _hotkeyRegistered = false;
        }
        if (enabled)
        {
            _hotkeyRegistered = RegisterHotKey(_messageWindow, HotkeyId, ModControl | ModAlt | ModNoRepeat, VkM);
        }
    }

    public void Update(ShellSnapshot snapshot)
    {
        var icon = !snapshot.HostConnected ? IdiError
            : snapshot.VoiceActive && snapshot.MeetingConnection == "joined" ? IdiInformation
            : snapshot.SessionActive || snapshot.SessionStatus == "completed" ? IdiWarning
            : IdiApplication;
        var data = CreateData(snapshot.TrayText, icon);
        Shell_NotifyIcon(NimModify, ref data);
    }

    private void AddTrayIcon(string tooltip, uint icon)
    {
        var data = CreateData(tooltip, icon);
        if (!Shell_NotifyIcon(NimAdd, ref data)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private NotifyIconData CreateData(string tooltip, uint icon) => new()
    {
        cbSize = Marshal.SizeOf<NotifyIconData>(),
        hWnd = _messageWindow,
        uID = 1,
        uFlags = NifMessage | NifIcon | NifTip,
        uCallbackMessage = TrayMessage,
        hIcon = LoadIcon(0, new nint(icon)),
        szTip = tooltip.Length > 127 ? tooltip[..127] : tooltip,
        szInfo = "",
        szInfoTitle = "",
    };

    private nint MessageWindowProc(nint window, uint message, nint wParam, nint lParam)
    {
        if (message == WmHotkey && wParam.ToInt32() == HotkeyId)
        {
            ToggleMuteRequested?.Invoke();
            return 0;
        }
        if (message == TrayMessage)
        {
            var action = (uint)(lParam.ToInt64() & 0xFFFF);
            if (action == WmLButtonUp) ShowRequested?.Invoke();
            if (action == WmContextMenu) ShowTrayMenu();
            return 0;
        }
        return CallWindowProc(_oldWindowProc, window, message, wParam, lParam);
    }

    private void ShowTrayMenu()
    {
        var menu = CreatePopupMenu();
        if (menu == 0) return;
        try
        {
            AppendMenu(menu, MfString, 1, "Open Meetron");
            AppendMenu(menu, MfString, 2, "Mute / unmute GPT (Ctrl+Alt+M)");
            AppendMenu(menu, MfString, 3, "Exit");
            GetCursorPos(out var point);
            SetForegroundWindow(_owner);
            var command = TrackPopupMenu(menu, TpmReturnCmd | TpmRightButton, point.X, point.Y, 0, _owner, 0);
            if (command == 1) ShowRequested?.Invoke();
            if (command == 2) ToggleMuteRequested?.Invoke();
            if (command == 3) ExitRequested?.Invoke();
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        SetHotkeyEnabled(false);
        var data = CreateData("", IdiApplication);
        Shell_NotifyIcon(NimDelete, ref data);
        if (_messageWindow != 0) DestroyWindow(_messageWindow);
        GC.KeepAlive(_windowProc);
    }

    private delegate nint WindowProc(nint window, uint message, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public int cbSize;
        public nint hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public nint hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowEx(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern nint SetWindowLongPtr(nint window, int index, nint newValue);
    [DllImport("user32.dll")] private static extern nint CallWindowProc(nint previous, nint window, uint message, nint wParam, nint lParam);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIcon(uint message, ref NotifyIconData data);
    [DllImport("user32.dll")] private static extern nint LoadIcon(nint instance, nint iconName);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint window, int id);
    [DllImport("user32.dll")] private static extern nint CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool AppendMenu(nint menu, uint flags, uint id, string text);
    [DllImport("user32.dll")] private static extern uint TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint window, nint rectangle);
    [DllImport("user32.dll")] private static extern bool DestroyMenu(nint menu);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint window);
}
