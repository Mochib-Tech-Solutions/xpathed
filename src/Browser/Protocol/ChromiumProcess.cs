using System.Diagnostics;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Protocol;

internal sealed class ChromiumProcess : IAsyncDisposable
{
    private Process? process;
    private string? profile;
    private int disposed;
    public CdpConnection Connection { get; } = new();

    public async Task StartAsync(string executable, BrowserResolution resolution, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            throw new InvalidOperationException(
                "Set BrowserExecutablePath to an installed Chrome or Chromium executable."
            );
        }
        profile = Directory.CreateTempSubdirectory("xpathed-chromium-").FullName;
        var info = new ProcessStartInfo("/bin/sh") { RedirectStandardInput = true, RedirectStandardOutput = true };
        // Chromium reads CDP from fd 3 and writes NUL-delimited JSON to fd 4. Positional
        // arguments keep paths literal; ordinary stdin/stdout cannot contaminate the pipe.
        info.ArgumentList.Add("-c");
        // Discard stderr in the child: detached helpers can keep an inherited pipe open
        // after Chromium exits, preventing Process.WaitForExitAsync from completing.
        info.ArgumentList.Add("exec 3<&0 4>&1; exec </dev/null >/dev/null 2>/dev/null; exec \"$@\"");
        info.ArgumentList.Add("xpathed-chromium");
        info.ArgumentList.Add(executable);
        foreach (
            var argument in new[]
            {
                "--headless",
                "--remote-debugging-pipe",
                $"--user-data-dir={profile}",
                $"--window-size={resolution.Width},{resolution.Height}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-default-apps",
                "--disable-popup-blocking",
                "--disable-sync",
                "about:blank",
            }
        )
        {
            info.ArgumentList.Add(argument);
        }
        process = Process.Start(info) ?? throw new InvalidOperationException("Could not start managed Chromium.");
        Connection.Connect(process.StandardOutput.BaseStream, process.StandardInput.BaseStream);
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        startup.CancelAfter(TimeSpan.FromSeconds(20));
        await Connection.SendAsync("Browser.getVersion").WaitAsync(startup.Token);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }
        try
        {
            await Connection.DisposeAsync();
        }
        finally
        {
            try
            {
                if (process is not null)
                {
                    try
                    {
                        if (!process.HasExited)
                        {
                            process.Kill(true);
                        }
                    }
                    catch (InvalidOperationException) when (process.HasExited) { }
                    await process.WaitForExitAsync();
                    process.Dispose();
                    process = null;
                }
            }
            finally
            {
                if (profile is not null && Directory.Exists(profile))
                {
                    Directory.Delete(profile, true);
                }
                profile = null;
            }
        }
    }
}
