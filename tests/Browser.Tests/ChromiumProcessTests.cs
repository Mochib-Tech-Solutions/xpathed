using System.Diagnostics;
using System.Globalization;
using Xpathed.Browser.Protocol;

namespace Xpathed.Browser.Tests;

public sealed class ChromiumProcessTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task DisposeEndsOwnedProcessWithPendingPipeOperations(bool blockedWrite, bool inheritedError)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        var directory = Directory.CreateTempSubdirectory("xpathed-process-test-").FullName;
        var executable = Path.Combine(directory, "browser");
        await File.WriteAllTextAsync(
            executable,
            """
            #!/bin/sh
            printf '%s' "$$" > "$0.pid"
            for argument do
              case "$argument" in --user-data-dir=*) printf '%s' "${argument#*=}" > "$0.profile" ;; esac
            done
            """
                + "\n"
                + (
                    inheritedError
                        ? "/bin/sh -c 'sleep 600 3<&- 4>&- & printf \"%s\" \"$!\" > \"$1\"' fixture \"$0.helper\"\n"
                        : ""
                )
                + """
                printf '{"id":1,"result":{}}\000' >&4
                exec sleep 600
                """
        );
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var browser = new ChromiumProcess();
        Process? child = null;
        Process? helper = null;
        Task? disposal = null;
        try
        {
            await browser.StartAsync(executable, new("1024x768", 1024, 768), CancellationToken.None);
            child = Process.GetProcessById(
                int.Parse(await File.ReadAllTextAsync(executable + ".pid"), CultureInfo.InvariantCulture)
            );
            if (inheritedError)
            {
                helper = Process.GetProcessById(
                    int.Parse(await File.ReadAllTextAsync(executable + ".helper"), CultureInfo.InvariantCulture)
                );
            }
            var profile = await File.ReadAllTextAsync(executable + ".profile");
            var command = blockedWrite
                ? browser.Connection.SendAsync("Runtime.evaluate", new { expression = new string('x', 1024 * 1024) })
                : null;
            await Task.Delay(100);
            disposal = Task.Run(async () => await browser.DisposeAsync());
            await disposal.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.True(child.HasExited);
            Assert.False(Directory.Exists(profile));
            if (command is not null)
            {
                var error = await Assert.ThrowsAnyAsync<Exception>(() => command.WaitAsync(TimeSpan.FromSeconds(3)));
                Assert.IsNotType<TimeoutException>(error);
            }
            await browser.DisposeAsync();
        }
        finally
        {
            if (helper is not null && !helper.HasExited)
            {
                helper.Kill(true);
                await helper.WaitForExitAsync();
            }
            if (child is not null && !child.HasExited)
            {
                child.Kill(true);
                await child.WaitForExitAsync();
            }
            if (disposal is not null)
            {
                await disposal.WaitAsync(TimeSpan.FromSeconds(3));
            }
            await browser.DisposeAsync();
            child?.Dispose();
            helper?.Dispose();
            Directory.Delete(directory, true);
        }
    }
}
