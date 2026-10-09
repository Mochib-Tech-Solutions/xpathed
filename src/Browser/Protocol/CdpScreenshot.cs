using System.Text.Json;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Protocol;

internal static class CdpScreenshot
{
    private const string Prepare = """
        async () => {
          const selector = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox],[data-private],[data-sensitive]';
          const roots = [], controls = [], styles = [], masks = [], previousOpacity = [];
          const collect = (root, inheritedPrivate = false) => {
            roots.push(root);
            for (const element of root.querySelectorAll('*')) {
              const privateElement = inheritedPrivate || element.matches(selector) || !!element.closest(selector);
              if (privateElement) controls.push(element);
              if (element.shadowRoot) collect(element.shadowRoot, privateElement);
            }
          };
          collect(document);
          if (controls.some(element => getComputedStyle(element).display === 'contents')) throw new Error('Private subtree cannot be safely masked');
          const boxes = controls.map(element => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          });
          const maskBoxes = controls.filter(element => {
            if (!element.matches(selector)) return false;
            for (let ancestor = element.parentElement ?? element.getRootNode().host; ancestor; ancestor = ancestor.parentElement ?? ancestor.getRootNode().host) {
              if (ancestor.matches(selector)) return false;
            }
            return true;
          }).map(element => { const rect = element.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height]; });
          for (const element of controls) {
            previousOpacity.push([element.style.getPropertyValue('opacity'), element.style.getPropertyPriority('opacity')]);
            element.style.setProperty('opacity','0','important');
          }
          for (const root of roots) {
            const style = document.createElement('style');
            style.textContent = `:is(${selector}), :is(${selector}) * { opacity: 0 !important; color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; } * { caret-color: transparent !important; }`;
            (root === document ? document.documentElement : root).append(style);
            styles.push(style);
          }
          for (const [x,y,width,height] of maskBoxes) {
            if (width <= 0 || height <= 0) continue;
            const mask = document.createElement('div');
            mask.style.cssText = `all: initial !important; position: fixed !important; left:${x}px !important; top:${y}px !important; width:${width}px !important; height:${height}px !important; background:rgb(119,119,119) !important; opacity:1 !important; z-index:2147483647 !important; pointer-events:none !important;`;
            document.documentElement.append(mask);
            masks.push(mask);
          }
          await document.fonts.ready;
          return {
            unchanged: () => {
              const fresh = [], freshRoots = [];
              const visit = (root, inheritedPrivate = false) => { freshRoots.push(root); for (const element of root.querySelectorAll('*')) { if (styles.includes(element) || masks.includes(element)) continue; const privateElement = inheritedPrivate || element.matches(selector) || !!element.closest(selector); if (privateElement) fresh.push(element); if (element.shadowRoot) visit(element.shadowRoot, privateElement); } };
              visit(document);
              return roots.length === freshRoots.length && roots.every((root,index)=>root === freshRoots[index]) && controls.length === fresh.length && controls.every((element,index) => {
                const rect = element.getBoundingClientRect();
                return element === fresh[index] && getComputedStyle(element).opacity === '0' && [rect.x,rect.y,rect.width,rect.height].every((value,part)=>value === boxes[index][part]);
              }) && styles.every(style=>style.isConnected) && masks.every(mask=>mask.isConnected);
            },
            clear: () => {
              for (let index=0; index<controls.length; index++) {
                const [value,priority]=previousOpacity[index];
                if (value) controls[index].style.setProperty('opacity',value,priority); else controls[index].style.removeProperty('opacity');
              }
              for (const element of [...styles,...masks]) element.remove();
            }
          };
        }
        """;

    public static async Task<byte[]> CaptureAsync(CdpPage page)
    {
        var frames = page.Frames;
        var prepared = new List<CdpRemoteObject>();
        try
        {
            await RejectClosedAuthorRootsAsync(page);
            foreach (var frame in frames)
            {
                prepared.Add(await frame.EvaluateHandleAsync(Prepare));
            }
            var screenshot = await page.SendAsync(
                "Page.captureScreenshot",
                new
                {
                    format = "png",
                    fromSurface = true,
                    captureBeyondViewport = false,
                }
            );
            if (!frames.ToHashSet().SetEquals(page.Frames))
            {
                throw new ApiException(409, "stale_capture", "The page frames changed during screenshot capture.");
            }
            await RejectClosedAuthorRootsAsync(page, afterCapture: true);
            foreach (var mask in prepared)
            {
                if (!await mask.EvaluateAsync<bool>("mask => mask.unchanged()"))
                {
                    throw new ApiException(409, "stale_capture", "Private controls changed during screenshot capture.");
                }
            }
            return Convert.FromBase64String(screenshot.GetProperty("data").GetString()!);
        }
        finally
        {
            foreach (var mask in prepared)
            {
                try
                {
                    await mask.EvaluateAsync("mask => mask.clear()");
                }
                catch (CdpException) { }
                finally
                {
                    await mask.DisposeAsync();
                }
            }
        }
    }

    private static async Task RejectClosedAuthorRootsAsync(CdpPage page, bool afterCapture = false)
    {
        foreach (var sessionId in page.Frames.Select(frame => frame.SessionId).Distinct(StringComparer.Ordinal))
        {
            var tree = await page.Connection.SendAsync(
                "DOMSnapshot.captureSnapshot",
                new { computedStyles = Array.Empty<string>() },
                sessionId
            );
            if (HasClosedAuthorRoot(tree))
            {
                if (afterCapture)
                {
                    throw new ApiException(
                        409,
                        "stale_capture",
                        "Private page components changed during screenshot capture."
                    );
                }
                throw new CdpException("Closed page components cannot be safely masked for image export.");
            }
        }
    }

    private static bool HasClosedAuthorRoot(JsonElement snapshot)
    {
        var strings = snapshot.GetProperty("strings");
        foreach (var document in snapshot.GetProperty("documents").EnumerateArray())
        {
            if (!document.GetProperty("nodes").TryGetProperty("shadowRootType", out var roots))
            {
                continue;
            }
            foreach (var value in roots.GetProperty("value").EnumerateArray())
            {
                if (strings[value.GetInt32()].GetString() == "closed")
                {
                    return true;
                }
            }
        }
        return false;
    }
}
