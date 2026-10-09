using Microsoft.Playwright;
using Xpathed.Common.Contracts;

namespace Xpathed.Browser.Sessions;

internal sealed class FirefoxPageDisplay(IPage page, BrowserResolution resolution) : IBrowserPageDisplay
{
    public Task InitializeAsync(IBrowserContext context, Action focused) => Task.CompletedTask;

    public async Task ShowAsync()
    {
        await page.BringToFrontAsync();
        await page.WaitForFunctionAsync(
            "size => innerWidth === size.width && innerHeight === size.height",
            new { width = resolution.Width, height = resolution.Height },
            new() { Timeout = 5000 }
        );
        if (!await HasNativeFocusAsync())
        {
            throw new PlaywrightException("The Firefox page lost focus.");
        }
    }

    // Playwright queries selectors in its isolated utility world, away from page overrides.
    public async Task<bool> HasNativeFocusAsync() =>
        await page.Locator(":root:not(:-moz-window-inactive)").CountAsync() == 1;
}
