// Apply the saved preference before the app paints.
(() => {
  let theme = "system";
  try {
    theme = localStorage.getItem("xpathed.theme") ?? "system";
  } catch {
    // Use the system preference if storage is blocked.
  }
  const dark =
    theme === "dark" ||
    (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
