using System.Text;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Protocol;

internal static class CdpActions
{
    public static async Task ExecuteAsync(CdpRemoteObject element, string action, string? value, double x, double y)
    {
        var page = element.Frame.Page;
        var generation = page.DocumentGeneration;
        if (!await element.EvaluateAsync<bool>("element => element.isConnected"))
        {
            throw new CdpException("The retained action target was detached.");
        }
        switch (action)
        {
            case "click":
            case "double_click":
            case "right_click":
                await ClickAsync(page, x, y, action == "right_click" ? "right" : "left", 1, generation);
                if (action == "double_click")
                {
                    await ClickAsync(page, x, y, "left", 2, generation);
                }
                break;
            case "hover":
                await CdpInput.MouseAsync(page, "mouseMoved", x, y, expectedGeneration: generation);
                break;
            case "check":
            case "uncheck":
                var expected = action == "check";
                if (await element.EvaluateAsync<bool>("element => element.checked") != expected)
                {
                    await ClickAsync(page, x, y, "left", 1, generation);
                    if (await element.EvaluateAsync<bool>("element => element.checked") != expected)
                    {
                        throw new CdpException("The control did not confirm the requested state.");
                    }
                }
                break;
            case "blur":
                await element.EvaluateAsync("element => element.blur()");
                break;
            case "focus":
                await FocusAsync(element);
                break;
            case "press":
                await FocusAsync(element);
                await CdpInput.PressAsync(page, value!, generation);
                break;
            case "type":
                await FocusAsync(element);
                foreach (var character in value!.EnumerateRunes())
                {
                    var text = character.ToString();
                    await page.SendInputAsync(
                        "Input.dispatchKeyEvent",
                        new
                        {
                            type = "keyDown",
                            key = text,
                            text,
                        },
                        expectedGeneration: generation
                    );
                    await page.SendInputAsync(
                        "Input.dispatchKeyEvent",
                        new { type = "keyUp", key = text },
                        release: true,
                        expectedGeneration: generation
                    );
                }
                break;
            case "fill":
            case "clear":
                var entered = action == "clear" ? "" : value!;
                var specialized = await element.EvaluateAsync<bool>(
                    "element => element.localName === 'input' && ['date','month','week','time','datetime-local'].includes(element.type)"
                );
                await FocusAsync(element);
                if (specialized)
                {
                    var accepted = await element.EvaluateAsync<bool>(
                        "(element,value) => { element.value=value; if(element.value!==value)return false; element.dispatchEvent(new Event('input',{bubbles:true,composed:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
                        entered
                    );
                    if (!accepted)
                    {
                        throw new ApiException(409, "invalid_action_value", "Enter a value supported by this control.");
                    }
                }
                else
                {
                    await element.EvaluateAsync(
                        "element => { if (element.isContentEditable) { const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection.removeAllRanges();selection.addRange(range); } else element.select(); }"
                    );
                    if (entered.Length == 0)
                    {
                        await CdpInput.PressAsync(page, "Backspace", generation);
                    }
                    else
                    {
                        await CdpInput.TextAsync(page, entered, generation);
                    }
                }
                break;
            case "select":
                var selected = await element.EvaluateAsync<bool>(
                    "(element,value) => { const options=[...element.options].filter(option=>option.value===value&&!option.matches(':disabled')); if(options.length!==1)return false; for(const option of element.options)option.selected=option===options[0];element.dispatchEvent(new Event('input',{bubbles:true,composed:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true; }",
                    value
                );
                if (!selected)
                {
                    throw new ApiException(409, "invalid_action_value", "The value must match one enabled option.");
                }
                break;
            default:
                throw new ApiException(
                    400,
                    "execution_unsupported",
                    "This action cannot be executed in the workspace."
                );
        }
    }

    private static Task FocusAsync(CdpRemoteObject element) =>
        element.EvaluateAsync("element => element.focus({preventScroll:true})");

    private static async Task ClickAsync(CdpPage page, double x, double y, string button, int count, long generation)
    {
        await CdpInput.MouseAsync(page, "mouseMoved", x, y, expectedGeneration: generation);
        await CdpInput.MouseAsync(
            page,
            "mousePressed",
            x,
            y,
            button,
            button == "right" ? 2 : 1,
            clickCount: count,
            expectedGeneration: generation
        );
        await CdpInput.MouseAsync(
            page,
            "mouseReleased",
            x,
            y,
            button,
            clickCount: count,
            expectedGeneration: generation
        );
    }
}
