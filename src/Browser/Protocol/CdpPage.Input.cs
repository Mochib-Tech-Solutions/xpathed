using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Scripts;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed partial class CdpPage
{
    public async Task AnswerDialogAsync(string dialogId, bool accept, string? promptText)
    {
        var dialog = CurrentDialog;
        if (dialog is null || dialog.Id != dialogId)
        {
            throw new CdpException("The dialog is no longer current.");
        }
        await Connection.SendAsync("Page.handleJavaScriptDialog", new { accept, promptText }, dialog.SessionId);
    }

    public async Task SendInputAsync(
        string method,
        object parameters,
        bool release = false,
        long? expectedGeneration = null,
        Action? beforeSend = null
    )
    {
        EnsureGeneration(expectedGeneration);
        if (CurrentDialog is not null && !release)
        {
            throw new CdpDialogPendingException();
        }
        var interrupted = dialogOpened.Task;
        var command = Connection.SendAsync(
            method,
            parameters,
            SessionId,
            () =>
            {
                EnsureGeneration(expectedGeneration);
                if (CurrentDialog is not null && !release)
                {
                    throw new CdpDialogPendingException();
                }
                beforeSend?.Invoke();
            }
        );
        if (await Task.WhenAny(command, interrupted) == command)
        {
            await command;
        }
        else
        {
            _ = ObserveInputCompletionAsync(command);
        }
    }

    public void EnsureGeneration(long? expected)
    {
        if (IsClosed || (expected is not null && expected != DocumentGeneration))
        {
            throw new CdpException("The displayed document changed before input dispatch.");
        }
    }

    public async Task<JsonElement> DocumentCommandAsync(Func<Task<JsonElement>> send)
    {
        var interrupted = dialogOpened.Task;
        if (CurrentDialog is not null)
        {
            throw new CdpDialogPendingException();
        }
        var command = send();
        if (await Task.WhenAny(command, interrupted) == command)
        {
            return await command;
        }
        _ = ObserveInputCompletionAsync(command);
        throw new CdpDialogPendingException();
    }

    private static async Task ObserveInputCompletionAsync(Task command)
    {
        try
        {
            await command;
        }
        catch (CdpException) { }
        catch (OperationCanceledException) { }
    }
}
