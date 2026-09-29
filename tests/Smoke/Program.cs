using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.Playwright;
using static Microsoft.Playwright.Assertions;

var baseUrl = Environment.GetEnvironmentVariable("XPATHED_URL") ?? "http://localhost:8080";
using var client = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(45) };
if (args is ["--seed-restart"])
{
    var seeded = await Send("/api/sessions", HttpMethod.Post);
    Console.WriteLine(seeded.GetProperty("pageId").GetString());
    return;
}
if (args is ["--verify-restart", var oldPage])
{
    await Status($"/api/pages/{oldPage}", HttpMethod.Get, HttpStatusCode.NotFound);
    await Status($"/api/pages/{oldPage}/inspect", HttpMethod.Post, HttpStatusCode.NotFound);
    Console.WriteLine("PASS: restart invalidates the previous page in client and resolver");
    return;
}

using var playwright = await Playwright.CreateAsync();
await using var browser = await playwright.Chromium.LaunchAsync(new() { Headless = true, ChromiumSandbox = true });
var ui = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 1440, Height = 1100 } });
ui.SetDefaultTimeout(15000);
var consoleErrors = new List<string>();
ui.PageError += (_, error) => consoleErrors.Add(error);
var sessionIds = new List<string>();
var evidence = Environment.GetEnvironmentVariable("EVIDENCE_DIR") ?? "/tmp/xpathed-smoke";
Directory.CreateDirectory(evidence);
try
{
    await ui.GotoAsync(baseUrl);
    await Expect(ui.GetByRole(AriaRole.Button, new() { Name = "Open browser", Exact = true })).ToBeVisibleAsync();
    await ui.ScreenshotAsync(new() { Path = Path.Combine(evidence, "empty.png"), FullPage = true });
    var opened = await ui.RunAndWaitForResponseAsync(
        () => ui.GetByRole(AriaRole.Button, new() { Name = "Open browser", Exact = true }).ClickAsync(),
        response => response.Url.EndsWith("/api/sessions", StringComparison.Ordinal) && response.Request.Method == "POST");
    Check(opened.Ok, "Opening the browser through the UI must succeed.");
    var first = ParseJson(await opened.TextAsync());
    var firstId = first.GetProperty("pageId").GetString()!;
    sessionIds.Add(first.GetProperty("sessionId").GetString()!);
    var inspect = ui.GetByRole(AriaRole.Button, new() { Name = "Inspect page", Exact = false });
    await Expect(inspect).ToBeEnabledAsync();
    await Expect(ui.Locator(".viewer canvas")).ToBeVisibleAsync();
    var initial = (await Inspect(firstId)).GetProperty("page");
    Check(initial.GetProperty("marker").GetString() == "hello from your browser", "Welcome marker is captured.");
    var documentId = initial.GetProperty("documentId").GetString();
    Check(!string.IsNullOrEmpty(documentId), "A live document identity must be present.");

    // Input goes through the visible noVNC canvas, never a managed-page automation handle.
    await CanvasClick(200, 150);
    await ui.Keyboard.TypeAsync("changed through noVNC");
    await ui.Keyboard.PressAsync("Enter");
    await Poll(async () => (await Inspect(firstId)).GetProperty("page").GetProperty("marker").GetString() == "changed through noVNC", "noVNC typing reaches the inspected document");
    var changed = await Inspect(firstId);
    Check(changed.GetProperty("inspectedBy").GetString() == "resolver", "Inspection passes through the independent resolver.");
    Check(changed.GetProperty("page").GetProperty("documentId").GetString() == documentId, "Inspection must not recreate the page at its URL.");
    await inspect.ClickAsync();
    await Expect(ui.Locator(".marker-value")).ToHaveTextAsync("changed through noVNC");
    await ui.ScreenshotAsync(new() { Path = Path.Combine(evidence, "live.png"), FullPage = true });
    Console.WriteLine("PASS: mouse, keyboard and inspection use the same live document");

    var viewer = ui.Locator(".viewer");
    await viewer.FocusAsync();
    await ui.Keyboard.PressAsync("Enter");
    await Expect(ui.Locator(".viewer canvas")).ToBeFocusedAsync();
    await ui.Keyboard.PressAsync("F8");
    await Expect(viewer).ToBeFocusedAsync();
    await ui.Keyboard.PressAsync("Tab");
    Check(await ui.EvaluateAsync<bool>("!document.activeElement.closest('.viewer')"), "Tab after F8 leaves the managed browser.");
    Console.WriteLine("PASS: keyboard entry and escape from the viewer");

    var second = await Send("/api/sessions", HttpMethod.Post);
    var secondSessionId = second.GetProperty("sessionId").GetString()!;
    sessionIds.Add(secondSessionId);
    var secondId = second.GetProperty("pageId").GetString()!;
    var isolated = (await Inspect(secondId)).GetProperty("page");
    Check(secondId != firstId && isolated.GetProperty("documentId").GetString() != documentId, "Sessions have separate page/document identities.");
    Check(isolated.GetProperty("marker").GetString() == "hello from your browser", "A second session must not inherit the first DOM.");
    Check((await Inspect(firstId)).GetProperty("page").GetProperty("marker").GetString() == "changed through noVNC", "Another session must leave the first page unchanged.");
    Console.WriteLine("PASS: concurrent sessions are isolated");

    await CanvasClick(600, 560);
    await ui.Mouse.WheelAsync(0, 600);
    await Poll(async () => (await Inspect(firstId)).GetProperty("page").GetProperty("scrollY").GetDouble() > 100, "noVNC scrolling changes the same page");
    await ui.Mouse.WheelAsync(0, -2000);
    await Poll(async () => (await Inspect(firstId)).GetProperty("page").GetProperty("scrollY").GetDouble() == 0, "page returns to top");
    await CanvasClick(250, 250);
    await Poll(async () => (await Send($"/api/pages/{firstId}")).GetProperty("blockedPopups").GetInt32() == 1, "new windows are blocked");
    Check((await Inspect(firstId)).GetProperty("page").GetProperty("documentId").GetString() == documentId, "Popup must not replace the managed page.");
    Console.WriteLine("PASS: scrolling and popup policy");

    await Send($"/api/pages/{firstId}/navigate", HttpMethod.Post, new { url = "xpathed:welcome" });
    var navigated = (await Inspect(firstId)).GetProperty("page");
    Check(navigated.GetProperty("pageId").GetString() == firstId, "Navigation retains page identity.");
    Check(navigated.GetProperty("documentId").GetString() != documentId, "Navigation creates a fresh document in the page.");
    Check(navigated.GetProperty("marker").GetString() == "changed through noVNC", "Storage survives navigation within a session.");
    await Status($"/api/pages/{firstId}/navigate", HttpMethod.Post, HttpStatusCode.BadRequest, new { url = "file:///etc/passwd" });
    await Status($"/api/pages/{firstId}/navigate", HttpMethod.Post, HttpStatusCode.BadRequest, new { url = "https://name:secret@example.com" });
    await Status("/api/pages/unknown", HttpMethod.Get, HttpStatusCode.NotFound);
    await Status("/api/pages/unknown/inspect", HttpMethod.Post, HttpStatusCode.NotFound);
    using var foreign = new HttpRequestMessage(HttpMethod.Post, "/api/sessions");
    foreign.Headers.Add("Origin", "https://unrelated.example");
    using var rejected = await client.SendAsync(foreign);
    Check(rejected.StatusCode == HttpStatusCode.Forbidden, "Cross-origin browser control must be rejected.");
    using var rebound = new HttpRequestMessage(HttpMethod.Get, "http://client-api:8080/api/pages/unknown");
    rebound.Headers.Host = "unrelated.example:5080";
    rebound.Headers.Add("Origin", "http://unrelated.example:5080");
    using var rejectedHost = await client.SendAsync(rebound);
    Check(rejectedHost.StatusCode == HttpStatusCode.BadRequest, "A matching foreign Host and Origin must be rejected by the API itself.");
    using var foreignViewer = new HttpRequestMessage(HttpMethod.Get, first.GetProperty("viewPath").GetString());
    foreignViewer.Headers.Add("Origin", "https://unrelated.example");
    foreignViewer.Headers.Add("Connection", "Upgrade");
    foreignViewer.Headers.Add("Upgrade", "websocket");
    foreignViewer.Headers.Add("Sec-WebSocket-Version", "13");
    foreignViewer.Headers.Add("Sec-WebSocket-Key", Convert.ToBase64String(Guid.NewGuid().ToByteArray()));
    using var rejectedViewer = await client.SendAsync(foreignViewer);
    Check(rejectedViewer.StatusCode == HttpStatusCode.Forbidden, "A foreign Origin must not open the viewer WebSocket.");
    Console.WriteLine("PASS: navigation identity and invalid requests");

    var resetResponse = await ui.RunAndWaitForResponseAsync(
        () => ui.GetByRole(AriaRole.Button, new() { Name = "Reset session", Exact = true }).ClickAsync(),
        response => response.Url.EndsWith("/api/sessions", StringComparison.Ordinal) && response.Request.Method == "POST");
    Check(resetResponse.Ok, "Resetting the browser through the UI must succeed.");
    var reset = ParseJson(await resetResponse.TextAsync());
    var resetId = reset.GetProperty("pageId").GetString()!;
    sessionIds.Add(reset.GetProperty("sessionId").GetString()!);
    Check(resetId != firstId, "Reset creates a new page identity.");
    await Status($"/api/pages/{firstId}", HttpMethod.Get, HttpStatusCode.NotFound);
    await Status($"/api/pages/{firstId}/inspect", HttpMethod.Post, HttpStatusCode.NotFound);
    var resetPage = (await Inspect(resetId)).GetProperty("page");
    Check(resetPage.GetProperty("documentId").GetString() != navigated.GetProperty("documentId").GetString(), "Reset creates a new document.");
    Check(resetPage.GetProperty("marker").GetString() == "hello from your browser", "Reset clears the previous DOM and local storage.");
    await Send($"/api/pages/{resetId}/navigate", HttpMethod.Post, new { url = "xpathed:welcome" });
    Check((await Inspect(resetId)).GetProperty("page").GetProperty("marker").GetString() == "hello from your browser", "Reset storage stays empty after reloading.");
    Check((await Inspect(secondId)).GetProperty("page").GetProperty("documentId").GetString() == isolated.GetProperty("documentId").GetString(), "Reset preserves the concurrent session's document.");
    await Expect(inspect).ToBeEnabledAsync();
    Console.WriteLine("PASS: UI reset clears storage and preserves other sessions");

    await ui.SetViewportSizeAsync(390, 844);
    Check(await ui.EvaluateAsync<bool>("document.documentElement.scrollWidth <= innerWidth"), "Mobile workspace must not overflow horizontally.");
    await ui.ScreenshotAsync(new() { Path = Path.Combine(evidence, "mobile.png"), FullPage = true });
    await ui.GetByRole(AriaRole.Button, new() { Name = "Close browser session" }).ClickAsync();
    await Expect(ui.GetByRole(AriaRole.Button, new() { Name = "Open browser", Exact = true })).ToBeVisibleAsync();
    await Status($"/api/pages/{resetId}", HttpMethod.Get, HttpStatusCode.NotFound);
    await Status($"/api/pages/{resetId}/inspect", HttpMethod.Post, HttpStatusCode.NotFound);
    await Status($"/api/sessions/{sessionIds[0]}", HttpMethod.Delete, HttpStatusCode.NoContent);
    Check((await Inspect(secondId)).GetProperty("page").GetProperty("pageId").GetString() == secondId, "Closing one session preserves another.");
    Check(consoleErrors.Count == 0, "UI has no JavaScript errors: " + string.Join("; ", consoleErrors));
    Console.WriteLine("PASS: responsive layout, closure and idempotent disposal");

    await CheckCancellation(secondId);
    await Status($"/api/sessions/{secondSessionId}", HttpMethod.Delete, HttpStatusCode.NoContent);
    Console.WriteLine("PASS: queued cancellation preserves the session; active cancellation invalidates it");

    var capacitySessions = new List<string>();
    for (var i = 0; i < 4; i++)
    {
        var created = await Send("/api/sessions", HttpMethod.Post);
        var id = created.GetProperty("sessionId").GetString()!;
        capacitySessions.Add(id);
        sessionIds.Add(id);
    }
    await Status("/api/sessions", HttpMethod.Post, HttpStatusCode.Conflict);
    await Status($"/api/sessions/{capacitySessions[0]}", HttpMethod.Delete, HttpStatusCode.NoContent);
    var replacement = await Send("/api/sessions", HttpMethod.Post);
    sessionIds.Add(replacement.GetProperty("sessionId").GetString()!);
    Check((await Inspect(replacement.GetProperty("pageId").GetString()!)).GetProperty("page").GetProperty("marker").GetString() == "hello from your browser", "A freed capacity slot accepts a fresh session.");
    Console.WriteLine("PASS: session limit rejects excess work and releases capacity after closure");
}
catch
{
    await ui.ScreenshotAsync(new() { Path = Path.Combine(evidence, "failure.png"), FullPage = true });
    throw;
}
finally
{
    foreach (var id in sessionIds)
    {
        using var response = await client.DeleteAsync($"/api/sessions/{id}");
        response.EnsureSuccessStatusCode();
    }
}

async Task<JsonElement> Send(string path, HttpMethod? method = null, object? body = null, CancellationToken token = default)
{
    using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
    if (body is not null) request.Content = JsonContent.Create(body);
    using var response = await client.SendAsync(request, token);
    var text = await response.Content.ReadAsStringAsync(token);
    Check(response.IsSuccessStatusCode, $"{method} {path}: {(int)response.StatusCode} {text}");
    return ParseJson(text);
}

async Task CheckCancellation(string pageId)
{
    var address = (await Dns.GetHostAddressesAsync(Dns.GetHostName())).First(ip => ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip));
    const int fixturePort = 18081;
    using var fixture = new HttpListener();
    fixture.Prefixes.Add($"http://*:{fixturePort}/");
    fixture.Start();
    var fixtureUrl = $"http://{address}:{fixturePort}";

    var running = Send($"/api/pages/{pageId}/navigate", HttpMethod.Post, new { url = fixtureUrl + "/held" });
    var held = await NextRequest("/held");
    using var queuedCancellation = new CancellationTokenSource();
    var queued = Send($"/api/pages/{pageId}/navigate", HttpMethod.Post, new { url = fixtureUrl + "/cancelled-queue" }, queuedCancellation.Token);
    await Task.Delay(300);
    Check(!queued.IsCompleted, "The second operation waits while the first navigation holds the page.");
    await queuedCancellation.CancelAsync();
    await WasCancelled(queued);
    await Task.Delay(300);
    Check(!running.IsCompleted, "Cancelling queued work must not cancel the active navigation.");
    var html = Encoding.UTF8.GetBytes("<!doctype html><title>Held navigation completed</title>");
    held.Response.ContentType = "text/html";
    held.Response.ContentLength64 = html.Length;
    await held.Response.OutputStream.WriteAsync(html);
    held.Response.Close();
    await running;
    var preserved = (await Inspect(pageId)).GetProperty("page");
    Check(preserved.GetProperty("title").GetString() == "Held navigation completed", "Queued cancellation leaves the active document intact.");

    using var activeCancellation = new CancellationTokenSource();
    var active = Send($"/api/pages/{pageId}/navigate", HttpMethod.Post, new { url = fixtureUrl + "/active" }, activeCancellation.Token);
    var activeRequest = await NextRequest("/active");
    await activeCancellation.CancelAsync();
    await WasCancelled(active);
    await Poll(async () =>
    {
        using var response = await client.GetAsync($"/api/pages/{pageId}");
        return response.StatusCode == HttpStatusCode.NotFound;
    }, "active cancellation invalidates its page");
    await Status($"/api/pages/{pageId}/inspect", HttpMethod.Post, HttpStatusCode.NotFound);
    activeRequest.Response.Close();

    async Task<HttpListenerContext> NextRequest(string path)
    {
        while (true)
        {
            var request = await fixture.GetContextAsync().WaitAsync(TimeSpan.FromSeconds(10));
            if (request.Request.Url!.AbsolutePath == path) return request;
            Check(request.Request.Url.AbsolutePath == "/favicon.ico", "A cancelled queued navigation must never execute.");
            request.Response.StatusCode = 404;
            request.Response.Close();
        }
    }
}

static async Task WasCancelled(Task task)
{
    try { await task; }
    catch (OperationCanceledException) { return; }
    throw new InvalidOperationException("The HTTP request must observe cancellation.");
}

static JsonElement ParseJson(string text)
{
    using var document = JsonDocument.Parse(text);
    return document.RootElement.Clone();
}
Task<JsonElement> Inspect(string id) => Send($"/api/pages/{id}/inspect", HttpMethod.Post);
async Task Status(string path, HttpMethod method, HttpStatusCode expected, object? body = null)
{
    using var request = new HttpRequestMessage(method, path);
    if (body is not null) request.Content = JsonContent.Create(body);
    using var response = await client.SendAsync(request);
    Check(response.StatusCode == expected, $"{method} {path}: expected {expected}, got {response.StatusCode}");
}
async Task CanvasClick(float x, float y)
{
    var box = await ui.Locator(".viewer canvas").BoundingBoxAsync() ?? throw new InvalidOperationException("Viewer canvas missing.");
    await ui.Mouse.ClickAsync(box.X + x * box.Width / 1280, box.Y + y * box.Height / 800);
}
static async Task Poll(Func<Task<bool>> predicate, string description)
{
    for (var i = 0; i < 30; i++)
    {
        if (await predicate()) return;
        await Task.Delay(200);
    }
    throw new InvalidOperationException($"Timed out: {description}");
}
static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
