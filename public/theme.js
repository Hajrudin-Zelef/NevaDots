// Applies the saved theme before the first paint so dark mode never flashes
// white. Kept in sync with src/client/theme.ts, which handles later changes.
// Resolves 'system' from matchMedia; 'hard_dark' is dark + data-dark='hard'.
// Poses data-theme (+ data-dark, data-palette), the page background color and
// the theme-color meta — all before the first CSS/JS.
// Also applies the interface scale (two A−/A+ buttons, `src/client/
// ui-scale.ts`) so the UI never paints at 100 % then jumps: same storage key,
// same 50–130 bounds, same `--nd-ui-scale` property.
(function () {
  var UI_SCALE_KEY = 'nevadots-ui-scale';
  var UI_SCALE_MIN = 50;
  var UI_SCALE_MAX = 130;
  var UI_SCALE_STEP = 5;
  function applyScale() {
    var percent = 100;
    try {
      var raw = localStorage.getItem(UI_SCALE_KEY);
      if (raw !== null) {
        var parsed = Number(String(raw).trim().replace(/%$/, ''));
        if (isFinite(parsed) && parsed > 0) {
          var stepped = Math.round(parsed / UI_SCALE_STEP) * UI_SCALE_STEP;
          percent = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
        }
      }
    } catch (error) {}
    var html = document.documentElement;
    html.style.setProperty('--nd-ui-scale', String(percent / 100));
    html.dataset.uiScale = String(percent);
  }
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
  applyScale();
  // Follow the OS while the choice is 'system' (theme.ts takes over once
  // the bundle loads, with the same resolution).
  try {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', apply);
  } catch (error) {}
})();
