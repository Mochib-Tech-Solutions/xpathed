using System.Runtime.InteropServices;

namespace Xpathed.Browser.Sessions;

[StructLayout(LayoutKind.Sequential)]
internal readonly struct XcbScreenIterator
{
    public readonly nint Data;
    public readonly int Remaining;
    public readonly int Index;
}
