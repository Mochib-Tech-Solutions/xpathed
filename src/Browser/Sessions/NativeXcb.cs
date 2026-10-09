using System.Runtime.InteropServices;

namespace Xpathed.Browser.Sessions;

internal static unsafe partial class NativeXcb
{
    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_connect", StringMarshalling = StringMarshalling.Utf8)]
    internal static partial nint Connect(string display, nint screen);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_disconnect")]
    internal static partial void Disconnect(nint connection);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_connection_has_error")]
    internal static partial int HasError(nint connection);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_get_setup")]
    internal static partial nint GetSetup(nint connection);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_setup_roots_iterator")]
    internal static partial XcbScreenIterator GetScreens(nint setup);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_change_window_attributes")]
    internal static partial uint ChangeWindowAttributes(nint connection, uint window, uint mask, uint* values);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_poll_for_event")]
    internal static partial nint PollForEvent(nint connection);

    [LibraryImport("libxcb.so.1", EntryPoint = "xcb_flush")]
    internal static partial int Flush(nint connection);

    [LibraryImport("libc.so.6", EntryPoint = "free")]
    internal static partial void Free(nint allocation);
}
