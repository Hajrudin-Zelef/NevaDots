// Ripple « aquatique » au clic (effet océan inspiré de cetas-lite).
// Délégation globale : aucun JSX à modifier dans les composants.
const RIPPLE_TARGETS =
  '.chat-compose-row, .send-button, .document-primary, .primary';

export function initRipple() {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest<HTMLElement>(RIPPLE_TARGETS);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty('--ripple-x', x.toFixed(2));
      el.style.setProperty('--ripple-y', y.toFixed(2));
      el.classList.remove('nd-ripple-active');
      // Force un reflow pour rejouer l'animation si déjà active.
      void el.offsetWidth;
      el.classList.add('nd-ripple-active');
      window.setTimeout(() => el.classList.remove('nd-ripple-active'), 700);
    },
    { passive: true },
  );
}
