using Microsoft.Playwright;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

internal static class BrowserActionExecution
{
    public static void Validate(string action, string? value)
    {
        if (
            action
            is not (
                "click"
                or "double_click"
                or "right_click"
                or "hover"
                or "fill"
                or "type"
                or "clear"
                or "select"
                or "check"
                or "uncheck"
                or "press"
                or "focus"
                or "blur"
            )
        )
        {
            throw new ApiException(400, "execution_unsupported", "This action cannot be executed in the workspace.");
        }
        if (action is "fill" or "type" or "select" or "press")
        {
            if (value is null || value.Length > 10000 || (action is "type" or "press" && value.Length == 0))
            {
                throw new ApiException(400, "invalid_action_value", "Enter the value for this action.");
            }
        }
        else if (value is not null)
        {
            throw new ApiException(400, "invalid_action_value", "This action does not accept a value.");
        }
        if (
            action == "press"
            && value
                is not (
                    "Enter"
                    or "Tab"
                    or "Escape"
                    or "ArrowUp"
                    or "ArrowDown"
                    or "ArrowLeft"
                    or "ArrowRight"
                    or "Home"
                    or "End"
                    or "PageUp"
                    or "PageDown"
                    or "Backspace"
                    or "Delete"
                    or "Space"
                )
        )
        {
            throw new ApiException(400, "invalid_action_value", "Choose a supported keyboard key.");
        }
    }

    public static async Task ExecuteAsync(IElementHandle element, string action, string? value)
    {
        const float timeout = 3000;
        switch (action)
        {
            case "click":
                await element.ClickAsync(new() { Timeout = timeout });
                break;
            case "double_click":
                await element.DblClickAsync(new() { Timeout = timeout });
                break;
            case "right_click":
                await element.ClickAsync(new() { Button = MouseButton.Right, Timeout = timeout });
                break;
            case "hover":
                await element.HoverAsync(new() { Timeout = timeout });
                break;
            case "fill":
                await element.FillAsync(value!, new() { Timeout = timeout });
                break;
            case "type":
                // A locator can retarget a replacement node; typing must use the retained capture handle.
#pragma warning disable CS0612
                await element.TypeAsync(value!, new() { Timeout = timeout });
#pragma warning restore CS0612
                break;
            case "clear":
                await element.FillAsync(string.Empty, new() { Timeout = timeout });
                break;
            case "check":
                await element.CheckAsync(new() { Timeout = timeout });
                break;
            case "uncheck":
                await element.UncheckAsync(new() { Timeout = timeout });
                break;
            case "focus":
                await element.FocusAsync();
                break;
            case "blur":
                await element.EvaluateAsync("element => element.blur()");
                break;
            case "press":
                await element.PressAsync(value == "Space" ? " " : value!, new() { Timeout = timeout });
                break;
            case "select":
                var optionIndex = await element.EvaluateAsync<int>(
                    "(element, value) => { const options = [...element.options].filter(option => option.value === value && !option.matches(':disabled')); return options.length === 1 ? options[0].index : -1; }",
                    value
                );
                if (optionIndex < 0)
                {
                    throw new ApiException(409, "invalid_action_value", "The value must match one enabled option.");
                }
                await element.SelectOptionAsync(
                    new SelectOptionValue { Index = optionIndex, Value = value },
                    new() { Timeout = timeout }
                );
                break;
        }
    }
}
