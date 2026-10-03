# Manage browser tabs in the client workspace

The workspace supports several managed pages in one browser context and display, with tabs represented in the client while Chromium stays fullscreen. Keeping native popup pages preserves shared login state and opener relationships; recreating their URLs in independent sessions would lose those semantics. The browser service owns the active page and each page’s capture state, and invalidates captures on activation changes so resolution cannot silently target another tab. Native focus is read through an isolated Chromium script world because websites can override their own JavaScript APIs; focus changes also cover links that reuse an existing window.

Chat drafts and result history belong to each open tab for the workspace session. Local history never restores a browser document or asserts that a historical XPath is still valid.
