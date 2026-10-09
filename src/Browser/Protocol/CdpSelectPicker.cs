using System.Text.Json;

namespace Xpathed.Browser.Protocol;

internal sealed class CdpSelectPicker(CdpRemoteObject retained, JsonElement options) : IAsyncDisposable
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public JsonElement Options { get; } = options;
    private const string SelectAncestor =
        "element => { for(let node=element;node;node=node.parentElement ?? node.getRootNode()?.host) { if(node instanceof HTMLSelectElement && !node.multiple && node.size<=1 && !node.matches(':disabled')) return node; } return null; }";
    private const string Unchanged =
        "picker => picker.element.isConnected && !picker.element.matches(':disabled') && !picker.element.multiple && picker.element.size<=1 && picker.options.length===picker.element.options.length && picker.options.every((item,index)=>item.node===picker.element.options[index] && item.label===item.node.label && item.disabled===item.node.matches(':disabled'))";

    public static async Task<CdpSelectPicker?> AtPointAsync(
        CdpPage page,
        double x,
        double y,
        long? expectedGeneration = null,
        CancellationToken cancellationToken = default
    )
    {
        expectedGeneration ??= page.DocumentGeneration;
        cancellationToken.ThrowIfCancellationRequested();
        page.EnsureGeneration(expectedGeneration);
        var hit = await page.SendAsync(
            "DOM.getNodeForLocation",
            new
            {
                x = (int)x,
                y = (int)y,
                includeUserAgentShadowDOM = true,
            }
        );
        if (!hit.TryGetProperty("backendNodeId", out var nodeId))
        {
            return null;
        }
        var frame = hit.TryGetProperty("frameId", out var frameId)
            ? await page.FindFrameAsync(frameId.GetString()!)
            : page.MainFrame;
        var context = frame?.Context;
        page.EnsureGeneration(expectedGeneration);
        if (frame is null || context is null)
        {
            return null;
        }
        var resolved = await page.Connection.SendAsync(
            "DOM.resolveNode",
            new { backendNodeId = nodeId.GetInt32(), executionContextId = context.Id },
            context.SessionId
        );
        await using var element = new CdpRemoteObject(
            frame,
            resolved.GetProperty("object").GetProperty("objectId").GetString()!,
            context
        );
        if (!await element.EvaluateAsync<bool>("element => !!(" + SelectAncestor + ")(element)"))
        {
            return null;
        }
        page.EnsureGeneration(expectedGeneration);
        cancellationToken.ThrowIfCancellationRequested();
        var retained = await element.EvaluateHandleAsync(
            "element => { const select=("
                + SelectAncestor
                + ")(element); select.focus(); return { element:select,options:Array.from(select.options, node=>({node,label:node.label,disabled:node.matches(':disabled')})) }; }",
            beforeSend: () =>
            {
                page.EnsureGeneration(expectedGeneration);
                cancellationToken.ThrowIfCancellationRequested();
            }
        );
        try
        {
            var options = await retained.EvaluateAsync<JsonElement>(
                "picker => picker.options.map((item,index)=>({id:'o'+index,label:item.label,disabled:item.disabled,selected:item.node.selected}))"
            );
            return new(retained, options);
        }
        catch
        {
            await retained.DisposeAsync();
            throw;
        }
    }

    public Task<bool> IsCurrentAsync() => retained.EvaluateAsync<bool>(Unchanged);

    public async Task ApplyAsync(string optionId)
    {
        if (
            !Options
                .EnumerateArray()
                .Any(option =>
                    option.GetProperty("id").GetString() == optionId && !option.GetProperty("disabled").GetBoolean()
                )
        )
        {
            throw new CdpException("The selected option is not available.");
        }
        var applied = await retained.EvaluateAsync<bool>(
            "(picker,id) => { if (!("
                + Unchanged
                + ")(picker)) return false; const index=Number(id.slice(1)), option=picker.options[index]; if(!option || option.disabled) return false; picker.element.selectedIndex=index; picker.element.dispatchEvent(new Event('input',{bubbles:true})); picker.element.dispatchEvent(new Event('change',{bubbles:true})); return true; }",
            optionId
        );
        if (!applied)
        {
            throw new CdpException("The selected control changed before confirmation.");
        }
    }

    public ValueTask DisposeAsync() => retained.DisposeAsync();
}
