using System.Collections.Concurrent;
using System.Net.WebSockets;
using Xpathed.Browser.Protocol;
using Xpathed.Browser.Viewing;
using Xpathed.Common.Contracts;
using Xpathed.Common.Http;

namespace Xpathed.Browser.Sessions;

public sealed partial class BrowserSessions
{
    public async Task ConnectViewerAsync(string sessionId, WebSocket socket, CancellationToken token)
    {
        var session = FindSession(sessionId);
        using var relay = new BrowserViewerRelay();
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token, session.Stop.Token);
        try
        {
            await session.Gate.WaitAsync(lifetime.Token);
            try
            {
                if (session.Viewer is not null)
                {
                    throw new ApiException(409, "viewer_connected", "This session already has an active viewer.");
                }
                session.Viewer = relay;
                session.Interaction ??= new BrowserViewerInteraction(session, relay);
                session.Interaction.Attach(relay);
                var page = session.Pages[session.ActivePageId];
                await session.Interaction.ReplayAsync(page);
                await page.Page.StartScreencastAsync();
            }
            finally
            {
                session.Gate.Release();
            }
            await relay.RunAsync(socket, session.Interaction.HandleAsync, lifetime.Token);
        }
        finally
        {
            await session.Gate.WaitAsync(CancellationToken.None);
            try
            {
                if (session.Viewer == relay)
                {
                    session.Viewer = null;
                    foreach (var page in session.Pages.Values)
                    {
                        if (session.Interaction is { } interaction)
                        {
                            await interaction.ReleaseAsync(page, closePicker: false);
                        }
                        if (!page.Page.IsClosed)
                        {
                            try
                            {
                                await page.Page.StopScreencastAsync();
                            }
                            catch (CdpException) { }
                        }
                    }
                }
            }
            finally
            {
                session.Gate.Release();
            }
        }
    }
}
