using Microsoft.Playwright;

namespace Xpathed.Browser.Sessions;

internal interface IBrowserPageDisplay
{
    public Task InitializeAsync(IBrowserContext context, Action focused);
    public Task ShowAsync();
    public Task<bool> HasNativeFocusAsync();
}
