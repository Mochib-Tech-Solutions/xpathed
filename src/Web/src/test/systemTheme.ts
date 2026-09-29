import { vi } from "vitest";

export function mockSystemTheme(dark = false) {
  const media = Object.assign(new EventTarget(), {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return (dark: boolean) => {
    media.matches = dark;
    media.dispatchEvent(Object.assign(new Event("change"), { matches: dark }));
  };
}
