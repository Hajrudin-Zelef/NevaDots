// Applies the saved theme before the first paint so dark mode never flashes
// white. Kept in sync with src/client/theme.ts, which handles later changes.
// Resolves 'system' from matchMedia; 'hard_dark' is dark + data-dark='hard'.
// Poses data-theme (+ data-dark, data-palette), the page background color and
// the theme-color meta — all before the first CSS/JS.
(function () {
  function themeColor(dark, hard) {
    return hard ? '#0d0d0d' : dark ? '#161616' : '#ffffff';
  }
  function apply() {
    var preference = 'system';
    var palette = null;
    try {
      preference = localStorage.getItem('opendots-theme') || 'system';
      palette = localStorage.getItem('opendots-palette');
    } catch (error) {}
    var hard = preference === 'hard_dark';
    var dark =
      hard ||
      preference === 'dark' ||
      (preference !== 'light' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (hard) root.setAttribute('data-dark', 'hard');
    else root.removeAttribute('data-dark');
    if (palette) root.setAttribute('data-palette', palette);
    root.style.backgroundColor = themeColor(dark, hard);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColor(dark, hard));
  }
  apply();
  // Follow the OS while the choice is 'system' (theme.ts takes over once
  // the bundle loads, with the same resolution).
  try {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', apply);
  } catch (error) {}
})();
