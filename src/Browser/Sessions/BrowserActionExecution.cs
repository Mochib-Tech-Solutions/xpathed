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
}
