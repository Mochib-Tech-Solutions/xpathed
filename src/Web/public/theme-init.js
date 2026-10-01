// Apply the saved preference before the app paints.
(() => {
  let dark = true;
  try {
    dark = localStorage.getItem("xpathed.theme") !== "light";
  } catch {
    // Keep the dark default if storage is blocked.
  }
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
