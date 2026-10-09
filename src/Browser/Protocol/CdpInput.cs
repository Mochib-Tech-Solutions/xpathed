namespace Xpathed.Browser.Protocol;

internal static class CdpInput
{
    private static readonly string[] SelectAll = ["selectAll"];

    public static Task MouseAsync(
        CdpPage page,
        string type,
        double x,
        double y,
        string button = "none",
        int buttons = 0,
        int modifiers = 0,
        double deltaX = 0,
        double deltaY = 0,
        int clickCount = 0,
        long? expectedGeneration = null,
        Action? beforeSend = null
    ) =>
        page.SendInputAsync(
            "Input.dispatchMouseEvent",
            new
            {
                type,
                x,
                y,
                button,
                buttons,
                modifiers,
                deltaX,
                deltaY,
                clickCount,
            },
            release: type == "mouseReleased",
            expectedGeneration: expectedGeneration,
            beforeSend: beforeSend
        );

    public static Task TextAsync(
        CdpPage page,
        string text,
        long? expectedGeneration = null,
        Action? beforeSend = null
    ) =>
        page.SendInputAsync(
            "Input.insertText",
            new { text },
            expectedGeneration: expectedGeneration,
            beforeSend: beforeSend
        );

    public static Task KeyAsync(
        CdpPage page,
        string key,
        string code,
        bool down,
        int modifiers = 0,
        string? printableText = null,
        bool repeat = false,
        long? expectedGeneration = null,
        Action? beforeSend = null
    )
    {
        var virtualKey = key switch
        {
            "Backspace" => 8,
            "Tab" => 9,
            "Enter" => 13,
            "Shift" => 16,
            "Control" => 17,
            "Alt" => 18,
            "Escape" => 27,
            " " or "Space" => 32,
            "PageUp" => 33,
            "PageDown" => 34,
            "End" => 35,
            "Home" => 36,
            "ArrowLeft" => 37,
            "ArrowUp" => 38,
            "ArrowRight" => 39,
            "ArrowDown" => 40,
            "Delete" => 46,
            "Meta" => 91,
            _ => key.Length == 1 && key[0] <= 127 ? char.ToUpperInvariant(key[0]) : 0,
        };
        var text = down
            ? key switch
            {
                "Enter" => "\r",
                _ => printableText ?? "",
            }
            : "";
        return page.SendInputAsync(
            "Input.dispatchKeyEvent",
            new
            {
                type = down
                    ? text.Length > 0
                        ? "keyDown"
                        : "rawKeyDown"
                    : "keyUp",
                key = key == "Space" ? " " : key,
                code,
                windowsVirtualKeyCode = virtualKey,
                modifiers,
                autoRepeat = repeat,
                text,
                commands = down && (modifiers & 6) != 0 && key.Equals("a", StringComparison.OrdinalIgnoreCase)
                    ? SelectAll
                    : [],
            },
            release: !down,
            expectedGeneration: expectedGeneration,
            beforeSend: beforeSend
        );
    }

    public static async Task PressAsync(CdpPage page, string key, long? expectedGeneration = null)
    {
        expectedGeneration ??= page.DocumentGeneration;
        await KeyAsync(
            page,
            key,
            key,
            true,
            printableText: key is " " or "Space" ? " "
                : key.Length == 1 ? key
                : null,
            expectedGeneration: expectedGeneration
        );
        await KeyAsync(page, key, key, false, expectedGeneration: expectedGeneration);
    }
}
