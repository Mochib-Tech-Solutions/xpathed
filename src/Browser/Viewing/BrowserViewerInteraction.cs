using System.Collections.Concurrent;
using System.Text.Json;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Sessions;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Viewing;

internal sealed class BrowserViewerInteraction(BrowserSessionRuntime session, BrowserViewerRelay initialRelay)
{
    private BrowserViewerRelay relay = initialRelay;
    private readonly ConcurrentDictionary<
        string,
        (BrowserPageRuntime Page, string DocumentId, long Generation, string Key, string Code)
    > keys = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<
        string,
        (BrowserPageRuntime Page, string DocumentId, long Generation, double X, double Y)
    > buttons = new(StringComparer.Ordinal);
    private CdpSelectPicker? picker;
    private BrowserPageRuntime? pickerPage;
    private string? pickerDocument;
    private string? lastDialogId;

    public void Attach(BrowserViewerRelay nextRelay) => relay = nextRelay;

    public async Task HandleAsync(JsonElement input, CancellationToken viewerToken = default)
    {
        using var admission = CancellationTokenSource.CreateLinkedTokenSource(viewerToken, session.Stop.Token);
        var admissionToken = admission.Token;
        await session.Gate.WaitAsync(admissionToken);
        try
        {
            admissionToken.ThrowIfCancellationRequested();
            var pageId = Text(input, "pageId");
            var documentId = Text(input, "documentId");
            if (
                !session.Pages.TryGetValue(pageId, out var page)
                || page.Page.IsClosed
                || session.ActivePageId != pageId
                || page.DocumentId != documentId
            )
            {
                throw new ApiException(409, "stale_view", "The displayed page changed. Wait for its current image.");
            }
            session.LastSeen = DateTimeOffset.UtcNow;
            var generation = page.Page.DocumentGeneration;
            var type = Text(input, "type");
            if (type == "dialog")
            {
                var accept = input.GetProperty("accept").GetBoolean();
                await page.Page.AnswerDialogAsync(
                    Text(input, "dialogId"),
                    accept,
                    OptionalText(input, "promptText") ?? ""
                );
                return;
            }
            if (type == "select")
            {
                if (
                    picker is null
                    || pickerPage != page
                    || pickerDocument != documentId
                    || picker.Id != Text(input, "pickerId")
                )
                {
                    throw new ApiException(409, "stale_picker", "The selected control changed. Open it again.");
                }
                var option = OptionalText(input, "optionId");
                if (option is not null)
                {
                    try
                    {
                        await picker.ApplyAsync(option);
                    }
                    catch (CdpDialogPendingException) { }
                    await page.ClearCaptureAsync();
                }
                await ClosePickerAsync();
                return;
            }
            if (page.Page.CurrentDialog is not null)
            {
                throw new ApiException(409, "dialog_pending", "Answer the browser dialog first.");
            }
            if (
                picker is not null
                && (
                    (type == "mouse" && Text(input, "event") is "up" or "move")
                    || (type == "key" && Text(input, "event") == "up")
                )
            )
            {
                return;
            }
            await ClosePickerAsync();
            var modifiers = Number(input, "modifiers", 0, 15);
            switch (type)
            {
                case "mouse":
                    var x = Coordinate(input, "x", session.Resolution.Width);
                    var y = Coordinate(input, "y", session.Resolution.Height);
                    var action = Text(input, "event");
                    var button = Text(input, "button");
                    if (button is not ("none" or "left" or "middle" or "right"))
                    {
                        throw Invalid();
                    }
                    if (action == "down" && button == "left")
                    {
                        var selected = await CdpSelectPicker.AtPointAsync(page.Page, x, y, generation, admissionToken);
                        if (selected is not null)
                        {
                            try
                            {
                                await ReleaseAsync(page);
                                await page.ClearCaptureAsync();
                                EnsureCurrent();
                                picker = selected;
                                pickerPage = page;
                                pickerDocument = documentId;
                                await ReplayAsync(page);
                            }
                            catch
                            {
                                if (!ReferenceEquals(picker, selected))
                                {
                                    await selected.DisposeAsync();
                                }
                                throw;
                            }
                            return;
                        }
                    }
                    var nativeType = action switch
                    {
                        "move" => "mouseMoved",
                        "down" => "mousePressed",
                        "up" => "mouseReleased",
                        "wheel" => "mouseWheel",
                        _ => throw Invalid(),
                    };
                    if (action == "down")
                    {
                        buttons[button] = (page, documentId, generation, x, y);
                        await page.ClearCaptureAsync();
                    }
                    if (action == "up")
                    {
                        buttons.TryRemove(button, out _);
                    }
                    EnsureCurrent();
                    await CdpInput.MouseAsync(
                        page.Page,
                        nativeType,
                        x,
                        y,
                        button,
                        Number(input, "buttons", 0, 7),
                        modifiers,
                        Finite(input, "deltaX"),
                        Finite(input, "deltaY"),
                        Number(input, "clickCount", action == "down" ? 1 : 0, 3),
                        generation,
                        EnsureCurrent
                    );
                    break;
                case "key":
                    var key = Text(input, "key");
                    var code = Text(input, "code");
                    var keyEvent = Text(input, "event");
                    if (keyEvent is not ("down" or "up") || key == "F8")
                    {
                        throw Invalid();
                    }
                    var down = keyEvent == "down";
                    if (down)
                    {
                        keys[code] = (page, documentId, generation, key, code);
                        await page.ClearCaptureAsync();
                    }
                    else
                    {
                        keys.TryRemove(code, out _);
                    }
                    EnsureCurrent();
                    await CdpInput.KeyAsync(
                        page.Page,
                        key,
                        code,
                        down,
                        modifiers,
                        OptionalText(input, "text"),
                        input.TryGetProperty("repeat", out var repeat) && repeat.GetBoolean(),
                        generation,
                        EnsureCurrent
                    );
                    break;
                case "text":
                    await page.ClearCaptureAsync();
                    EnsureCurrent();
                    await CdpInput.TextAsync(page.Page, Text(input, "text"), generation, EnsureCurrent);
                    break;
                default:
                    throw Invalid();
            }
            void EnsureCurrent()
            {
                admissionToken.ThrowIfCancellationRequested();
                if (
                    session.ActivePageId != pageId
                    || page.DocumentId != documentId
                    || page.Page.DocumentGeneration != generation
                    || page.Page.IsClosed
                )
                {
                    throw new ApiException(
                        409,
                        "stale_view",
                        "The displayed page changed. Wait for its current image."
                    );
                }
            }
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public void Invalidated(BrowserPageRuntime page)
    {
        if (pickerPage == page)
        {
            _ = ClosePickerAsync();
        }
        // A new document has no pressed input state to release into.
        foreach (
            var key in keys.Where(item => item.Value.Page == page && item.Value.DocumentId != page.DocumentId)
                .Select(item => item.Key)
                .ToArray()
        )
        {
            keys.TryRemove(key, out _);
        }
        foreach (
            var button in buttons
                .Where(item => item.Value.Page == page && item.Value.DocumentId != page.DocumentId)
                .Select(item => item.Key)
                .ToArray()
        )
        {
            buttons.TryRemove(button, out _);
        }
    }

    public void DialogChanged(BrowserPageRuntime page, CdpDialog? dialog)
    {
        if (session.ActivePageId != page.Id)
        {
            return;
        }
        if (dialog is null)
        {
            _ = ReleaseAsync(page);
            relay.PublishControl(
                new
                {
                    type = "dialogClosed",
                    pageId = page.Id,
                    documentId = page.DocumentId,
                    dialogId = lastDialogId,
                }
            );
            lastDialogId = null;
        }
        else
        {
            _ = ReleaseAsync(page);
            lastDialogId = dialog.Id;
            relay.PublishControl(
                new
                {
                    type = "dialog",
                    pageId = page.Id,
                    documentId = page.DocumentId,
                    dialogId = dialog.Id,
                    dialogType = dialog.Type,
                    dialog.Message,
                    dialog.DefaultPrompt,
                }
            );
        }
    }

    public async Task ReplayAsync(BrowserPageRuntime page)
    {
        if (page.Page.CurrentDialog is { } dialog)
        {
            DialogChanged(page, dialog);
        }
        else if (picker is not null && pickerPage == page && pickerDocument == page.DocumentId)
        {
            try
            {
                if (await picker.IsCurrentAsync())
                {
                    relay.PublishControl(
                        new
                        {
                            type = "select",
                            pageId = page.Id,
                            documentId = page.DocumentId,
                            pickerId = picker.Id,
                            options = picker.Options,
                        }
                    );
                }
                else
                {
                    await ClosePickerAsync();
                }
            }
            catch (CdpException)
            {
                await ClosePickerAsync();
            }
        }
    }

    public async Task ReleaseAsync(BrowserPageRuntime page, bool closePicker = true)
    {
        if (closePicker)
        {
            await ClosePickerAsync();
        }
        foreach (var entry in keys.Where(item => item.Value.Page == page).ToArray())
        {
            keys.TryRemove(entry.Key, out _);
            if (!page.Page.IsClosed && entry.Value.DocumentId == page.DocumentId)
            {
                try
                {
                    await CdpInput.KeyAsync(
                        page.Page,
                        entry.Value.Key,
                        entry.Value.Code,
                        false,
                        expectedGeneration: entry.Value.Generation
                    );
                }
                catch (CdpException) { }
            }
        }
        foreach (var entry in buttons.Where(item => item.Value.Page == page).ToArray())
        {
            buttons.TryRemove(entry.Key, out _);
            if (!page.Page.IsClosed && entry.Value.DocumentId == page.DocumentId)
            {
                try
                {
                    await CdpInput.MouseAsync(
                        page.Page,
                        "mouseReleased",
                        entry.Value.X,
                        entry.Value.Y,
                        entry.Key,
                        clickCount: 0,
                        expectedGeneration: entry.Value.Generation
                    );
                }
                catch (CdpException) { }
            }
        }
    }

    private async Task ClosePickerAsync()
    {
        var previous = Interlocked.Exchange(ref picker, null);
        var page = pickerPage;
        var document = pickerDocument;
        pickerPage = null;
        pickerDocument = null;
        if (previous is null)
        {
            return;
        }
        relay.PublishControl(
            new
            {
                type = "selectClosed",
                pageId = page?.Id,
                documentId = document,
                pickerId = previous.Id,
            }
        );
        await previous.DisposeAsync();
    }

    private static ApiException Invalid() => new(400, "invalid_viewer_input", "The viewer input is not supported.");

    private static string Text(JsonElement data, string name) => OptionalText(data, name) ?? throw Invalid();

    private static string? OptionalText(JsonElement data, string name) =>
        data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int Number(JsonElement data, string name, int minimum, int maximum)
    {
        var value = data.TryGetProperty(name, out var item) ? item.GetInt32() : minimum;
        if (value < minimum || value > maximum)
        {
            throw Invalid();
        }
        return value;
    }

    private static double Finite(JsonElement data, string name)
    {
        var value = data.TryGetProperty(name, out var item) ? item.GetDouble() : 0;
        if (!double.IsFinite(value))
        {
            throw Invalid();
        }
        return value;
    }

    private static double Coordinate(JsonElement data, string name, int maximum)
    {
        var value = Finite(data, name);
        if (value < 0 || value > maximum)
        {
            throw Invalid();
        }
        return value;
    }
}
