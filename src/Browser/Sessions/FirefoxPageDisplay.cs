using Microsoft.Playwright;

namespace Xpathed.Browser.Sessions;

internal sealed class FirefoxPageDisplay(IPage page) : IBrowserPageDisplay
{
    public Task InitializeAsync(IBrowserContext context, Action focused) => Task.CompletedTask;

    public async Task ShowAsync()
    {
        await page.BringToFrontAsync();
        await page.WaitForFunctionAsync("innerWidth === 1280 && innerHeight === 800", null, new() { Timeout = 5000 });
        if (!await HasNativeFocusAsync())
        {
            throw new PlaywrightException("The Firefox page lost focus.");
        }
    }

    // Playwright queries selectors in its isolated utility world, away from page overrides.
    public async Task<bool> HasNativeFocusAsync() =>
        await page.Locator(":root:not(:-moz-window-inactive)").CountAsync() == 1;
}
