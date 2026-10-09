using System.Runtime.InteropServices;
using Microsoft.Playwright;

namespace Xpathed.Browser.Sessions;

// X11 focus events remain real even when Playwright emulates document focus.
internal sealed class FirefoxDisplay : IDisposable
{
    private readonly nint connection;
    private readonly Lock gate = new();
    private bool disposed;

    public FirefoxDisplay(string display)
    {
        connection = NativeXcb.Connect(display, 0);
        if (connection == 0 || NativeXcb.HasError(connection) != 0)
        {
            Dispose();
            throw new PlaywrightException("The Firefox display could not connect.");
        }
        var screen = NativeXcb.GetScreens(NativeXcb.GetSetup(connection));
        var root = unchecked((uint)Marshal.ReadInt32(screen.Data));
        SelectEvents(root, 1u << 19);
        Flush();
    }

    private void Flush()
    {
        if (NativeXcb.Flush(connection) <= 0)
        {
            throw new PlaywrightException("The Firefox display disconnected.");
        }
    }

    private unsafe void SelectEvents(uint window, uint events) =>
        _ = NativeXcb.ChangeWindowAttributes(connection, window, 1u << 11, &events);

    public bool ReadFocusChanges()
    {
        lock (gate)
        {
            if (disposed)
            {
                return false;
            }
            var changed = false;
            nint next;
            while ((next = NativeXcb.PollForEvent(connection)) != 0)
            {
                try
                {
                    var type = Marshal.ReadByte(next) & 127;
                    if (type == 16)
                    {
                        var window = unchecked((uint)Marshal.ReadInt32(next, 8));
                        SelectEvents(window, 1u << 21);
                    }
                    else if (type is 9 or 10)
                    {
                        changed = true;
                    }
                    else if (type == 0 && Marshal.ReadByte(next, 1) != 3)
                    {
                        throw new PlaywrightException("The Firefox display rejected a window operation.");
                    }
                }
                finally
                {
                    NativeXcb.Free(next);
                }
            }
            Flush();
            if (NativeXcb.HasError(connection) != 0)
            {
                throw new PlaywrightException("The Firefox display disconnected.");
            }
            return changed;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (connection != 0)
            {
                NativeXcb.Disconnect(connection);
            }
        }
    }
}
