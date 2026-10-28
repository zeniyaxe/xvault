/* One interruptible animation per surface. Motion preferences can cancel in-flight work. */
(() => {
  const active = new Map(),
    calm = () =>
      ['off', 'reduced'].includes(document.body.dataset.motion) ||
      document.body.classList.contains('reduce') ||
      matchMedia('(prefers-reduced-motion: reduce)').matches;
  const factor = () => ({ subtle: 0.7, rich: 1.2, extreme: 1.5 })[document.body.dataset.motion] || 1;
  const durationFor = milliseconds =>
    (milliseconds * factor()) / Math.max(0.35, Math.min(2, Number(settings.motionSpeed) || 1));
  function play(element, frames, duration = 180) {
    if (!element) return;
    active.get(element)?.cancel();
    active.delete(element);
    if (calm() || !element.animate) return;
    const animation = element.animate(frames, {
      duration: durationFor(duration),
      easing: 'cubic-bezier(.18,.75,.22,1)',
      fill: 'none',
    });
    active.set(element, animation);
    animation.finished
      .catch(() => {})
      .finally(() => {
        if (active.get(element) === animation) active.delete(element);
      });
  }
  const cancel = () => {
    if (!calm()) return;
    for (const animation of active.values()) animation.cancel();
    active.clear();
    document.dispatchEvent(new Event('xv:motion-disabled'));
  };
  window.XVaultMotion = { play, cancel, duration: durationFor };
  function mount() {
    document.body.classList.add('xv-motion-ready');
    for (const [id, target, frames] of [
      [
        'palette',
        '.palettebox',
        [
          { opacity: 0, transform: 'translateY(-12px) scale(.98)' },
          { opacity: 1, transform: 'none' },
        ],
      ],
      [
        'detailsDrawer',
        null,
        [
          { opacity: 0, transform: 'translateX(20px)' },
          { opacity: 1, transform: 'none' },
        ],
      ],
      [
        'lightbox',
        '.lbContent',
        [
          { opacity: 0, transform: 'translateY(12px) scale(.985)' },
          { opacity: 1, transform: 'none' },
        ],
      ],
    ]) {
      const root = document.getElementById(id);
      if (!root) continue;
      let visible = !root.classList.contains('hidden');
      new MutationObserver(() => {
        const next = !root.classList.contains('hidden');
        if (next && !visible) play(target ? root.querySelector(target) : root, frames);
        else if (!next) {
          const element = target ? root.querySelector(target) : root;
          active.get(element)?.cancel();
          active.delete(element);
        }
        visible = next;
      }).observe(root, { attributes: true, attributeFilter: ['class'] });
    }
    const sync = () => {
      const style = document.documentElement.style;
      for (const [key, value] of [
        ['--motion-scale', String(Math.max(0.35, Math.min(2, Number(settings.motionSpeed) || 1)))],
        ['--motion-k', String(factor())],
      ])
        if (style.getPropertyValue(key) !== value) style.setProperty(key, value);
      cancel();
    };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-motion'] });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', sync);
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
