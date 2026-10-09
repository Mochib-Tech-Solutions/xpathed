# Select browser type per session

Status: Accepted, 2026-10-09.

The owner requested Chromium and Firefox in the test client while retaining the managed viewer and Resolver features. Browser type is a session setting, chosen at creation and returned in session records. The default is configurable; empty session POSTs remain compatible. Closing the session is required to change engines. Unknown types fail before allocating resources.

Browser keeps one shared capture, XPath and readiness implementation. `IBrowserPageDisplay` isolates the differing native window controls. Chromium retains CDP fullscreen and native-focus handling. Firefox uses a disposable profile to hide native toolbars and a per-session Matchbox window manager for the existing 1280×800 noVNC display. Native focus events invalidate captures; Firefox's isolated CSS window-activity query checks the actual foreground window because automation forces `document.hasFocus()` true on background pages. These details remain inside Browser; Resolver and ClientApi exchange serializable contracts.

The production image installs the two requested Playwright-matched engines and their dependencies on the ASP.NET runtime, excluding WebKit, the SDK and the duplicate Chromium headless shell. This intentionally costs more space than Chromium alone. Engine upgrades must pass the browser contract suite for both engines, including viewer geometry, native input, popups, focus changes, capture invalidation and teardown. Existing evaluation/release comparisons remain explicitly Chromium-based; Firefox support does not relabel historical measurements.
