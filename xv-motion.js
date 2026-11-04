/* XVault motion system. Spring-driven, interruptible and preference-aware: Off, Reduced, the
   system reduced-motion setting and Safe Mode always win over any presentation choice.
   Public API (window.XVaultMotion): play, cancel, duration, spring, enter, stagger, flip,
   countUp, celebrate, calm, transition. One active animation per element. */
(() => {
  const active = new Map(),
    calm = () =>
      ['off', 'reduced'].includes(document.body.dataset.motion) ||
      document.body.classList.contains('reduce') ||
      document.body.classList.contains('safe-mode') ||
      matchMedia('(prefers-reduced-motion: reduce)').matches;
  const factor = () => ({ subtle: 0.7, rich: 1.2, extreme: 1.5 })[document.body.dataset.motion] || 1;
  const speed = () => {
    try {
      return Math.max(0.35, Math.min(2, Number(settings?.motionSpeed) || 1));
    } catch {
      return 1;
    }
  };
  const durationFor = milliseconds => (milliseconds * factor()) / speed();
  const supportsLinear = (() => {
    try {
      return CSS.supports('transition-timing-function', 'linear(0, 1)');
    } catch {
      return false;
    }
  })();

  // Damped harmonic oscillator sampled into a CSS linear() easing. Cached per configuration.
  const springCache = new Map();
  const SPRINGS = {
    snappy: { stiffness: 420, damping: 34 },
    gentle: { stiffness: 190, damping: 24 },
    bouncy: { stiffness: 320, damping: 17 },
    settle: { stiffness: 260, damping: 30 },
  };
  function spring(config = 'gentle') {
    const { stiffness = 260, damping = 26, mass = 1 } = typeof config === 'string' ? SPRINGS[config] || {} : config;
    const key = `${stiffness}/${damping}/${mass}`;
    if (springCache.has(key)) return springCache.get(key);
    const step = 1 / 240;
    let position = 0,
      velocity = 0,
      time = 0;
    const samples = [0];
    while (time < 2.5) {
      const force = -stiffness * (position - 1) - damping * velocity;
      velocity += (force / mass) * step;
      position += velocity * step;
      time += step;
      samples.push(position);
      if (Math.abs(position - 1) < 0.0008 && Math.abs(velocity) < 0.0008) break;
    }
    const duration = Math.round(time * 1000),
      points = [];
    const count = 40;
    for (let index = 0; index <= count; index++) {
      const value = samples[Math.round((index / count) * (samples.length - 1))];
      points.push(Number(value.toFixed(4)));
    }
    points[points.length - 1] = 1;
    const result = {
      easing: supportsLinear ? `linear(${points.join(', ')})` : 'cubic-bezier(.18,.75,.22,1)',
      duration,
    };
    springCache.set(key, result);
    return result;
  }

  function play(element, frames, duration = 180, options = {}) {
    if (!element) return null;
    active.get(element)?.cancel();
    active.delete(element);
    if (calm() || !element.animate) return null;
    const curve = options.spring ? spring(options.spring) : null;
    const animation = element.animate(frames, {
      duration: durationFor(curve && !options.fixedDuration ? Math.min(curve.duration, duration * 2.4) : duration),
      easing: curve ? curve.easing : options.easing || 'cubic-bezier(.18,.75,.22,1)',
      delay: options.delay ? durationFor(options.delay) : 0,
      fill: options.fill || (options.delay ? 'backwards' : 'none'),
      composite: options.composite || 'replace',
    });
    active.set(element, animation);
    animation.finished
      .catch(() => {})
      .finally(() => {
        if (active.get(element) === animation) active.delete(element);
      });
    return animation;
  }

  const PRESETS = {
    rise: [
      { opacity: 0, transform: 'translateY(10px)' },
      { opacity: 1, transform: 'none' },
    ],
    drop: [
      { opacity: 0, transform: 'translateY(-10px)' },
      { opacity: 1, transform: 'none' },
    ],
    scale: [
      { opacity: 0, transform: 'scale(.94)' },
      { opacity: 1, transform: 'none' },
    ],
    fade: [{ opacity: 0 }, { opacity: 1 }],
    left: [
      { opacity: 0, transform: 'translateX(-14px)' },
      { opacity: 1, transform: 'none' },
    ],
    right: [
      { opacity: 0, transform: 'translateX(14px)' },
      { opacity: 1, transform: 'none' },
    ],
    sheet: [
      { opacity: 0.4, transform: 'translateX(28px)' },
      { opacity: 1, transform: 'none' },
    ],
  };
  const enter = (element, preset = 'rise', options = {}) =>
    play(element, PRESETS[preset] || PRESETS.rise, options.duration || 260, { spring: 'gentle', ...options });

  // Reveal a set of elements in reading order. Only the first `max` move; the rest appear at once.
  function stagger(elements, preset = 'rise', { step = 22, max = 24, spring: curve = 'gentle', duration = 300 } = {}) {
    if (calm()) return;
    const list = [...elements].slice(0, max);
    list.forEach((element, index) =>
      play(element, PRESETS[preset] || PRESETS.rise, duration, {
        spring: curve,
        delay: index * step,
        fill: 'backwards',
      })
    );
  }

  // FLIP: measure, mutate, then animate every element from its old box to its new one.
  function flip(elements, mutate, { spring: curve = 'snappy', duration = 320 } = {}) {
    const list = [...(typeof elements === 'function' ? elements() : elements)];
    if (calm() || !list.length) {
      mutate?.();
      return;
    }
    const first = new Map(list.map(element => [element, element.getBoundingClientRect()]));
    mutate?.();
    const after = typeof elements === 'function' ? [...elements()] : list;
    for (const element of after) {
      const before = first.get(element);
      if (!before || !element.isConnected) continue;
      const now = element.getBoundingClientRect();
      const dx = before.left - now.left,
        dy = before.top - now.top,
        sx = now.width ? before.width / now.width : 1,
        sy = now.height ? before.height / now.height : 1;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      play(
        element,
        [
          { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'none' },
        ],
        duration,
        { spring: curve }
      );
    }
  }

  // Animated numbers. Formatting is applied every frame; calm mode writes the final value.
  const counters = new WeakMap();
  function countUp(element, to, { from, duration = 720, format = value => Math.round(value).toLocaleString() } = {}) {
    if (!element) return;
    const target = Number(to) || 0;
    const start = from ?? (Number(element.dataset.xvCount) || 0);
    element.dataset.xvCount = String(target);
    cancelAnimationFrame(counters.get(element) || 0);
    if (calm() || start === target) {
      element.textContent = format(target);
      return;
    }
    const began = performance.now(),
      total = durationFor(duration);
    const frame = now => {
      const progress = Math.min(1, (now - began) / total),
        eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = format(start + (target - start) * eased);
      if (progress < 1) counters.set(element, requestAnimationFrame(frame));
    };
    counters.set(element, requestAnimationFrame(frame));
  }

  // Success feedback: the glyph pops and a single ring expands from it. Never blocks input.
  function celebrate(element, { tone = 'accent' } = {}) {
    if (!element || calm()) return;
    play(element, [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], 360, {
      spring: 'bouncy',
      fixedDuration: true,
    });
    const box = element.getBoundingClientRect(),
      ring = document.createElement('span');
    ring.className = `xv-ring xv-ring-${tone}`;
    const size = Math.max(box.width, box.height);
    Object.assign(ring.style, {
      left: `${box.left + box.width / 2 - size / 2}px`,
      top: `${box.top + box.height / 2 - size / 2}px`,
      width: `${size}px`,
      height: `${size}px`,
    });
    document.body.append(ring);
    const animation = ring.animate(
      [
        { opacity: 0.55, transform: 'scale(.6)' },
        { opacity: 0, transform: 'scale(1.9)' },
      ],
      { duration: durationFor(520), easing: 'cubic-bezier(.2,.7,.2,1)' }
    );
    animation.finished.catch(() => {}).finally(() => ring.remove());
  }

  // Same-document view transitions for self-contained surfaces (Atlas views, reader).
  function transition(update, { direction = 0 } = {}) {
    if (calm() || typeof document.startViewTransition !== 'function') {
      update();
      return Promise.resolve();
    }
    const root = document.documentElement;
    root.dataset.vt = direction > 0 ? 'forward' : direction < 0 ? 'back' : 'fade';
    const view = document.startViewTransition(update);
    view.finished.catch(() => {}).finally(() => delete root.dataset.vt);
    return view.updateCallbackDone.catch(() => {});
  }

  const cancel = () => {
    if (!calm()) return;
    for (const animation of active.values()) animation.cancel();
    active.clear();
    document.dispatchEvent(new Event('xv:motion-disabled'));
  };
  window.XVaultMotion = {
    play,
    cancel,
    duration: durationFor,
    spring,
    enter,
    stagger,
    flip,
    countUp,
    celebrate,
    transition,
    calm,
  };

  // Rail indicator: one brass mark that travels between sections instead of reappearing.
  function navIndicator() {
    const nav = document.querySelector('.rail');
    if (!nav || nav.querySelector('.xv-nav-mark')) return;
    const mark = document.createElement('span');
    mark.className = 'xv-nav-mark';
    mark.setAttribute('aria-hidden', 'true');
    nav.append(mark);
    document.body.classList.add('xv-has-nav-mark');
    const place = () => {
      const current = nav.querySelector('.nav.active');
      if (!current || !current.offsetParent) {
        mark.style.opacity = '0';
        return;
      }
      const top = current.offsetTop + 9,
        height = Math.max(8, current.offsetHeight - 18);
      mark.style.opacity = '1';
      mark.style.transform = `translateY(${top}px)`;
      mark.style.height = `${height}px`;
    };
    const curve = spring('snappy');
    mark.style.setProperty('--xv-mark-ease', curve.easing);
    mark.style.setProperty('--xv-mark-ms', `${curve.duration}ms`);
    new MutationObserver(() => requestAnimationFrame(place)).observe(nav, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    new ResizeObserver(() => place()).observe(nav);
    place();
  }

  // Library results: stagger only when the user changed the query, sort or layout, never while
  // the virtual window recycles rows during scrolling.
  function libraryReveal() {
    const list = document.getElementById('list');
    if (!list) return;
    let intentUntil = 0,
      pending = false;
    const intent = () => (intentUntil = performance.now() + 900);
    document.getElementById('search')?.addEventListener('input', intent);
    document.getElementById('sort')?.addEventListener('change', intent);
    document.addEventListener(
      'click',
      event => {
        if (event.target.closest('#libraryLayout,#libraryDestinations,.lib-filters,#libraryChips,.xv-facets')) intent();
      },
      true
    );
    new MutationObserver(records => {
      if (pending || performance.now() > intentUntil) return;
      if (!records.some(record => record.addedNodes.length)) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        intentUntil = 0;
        const view = list.getBoundingClientRect();
        const visible = [...list.querySelectorAll('.tweet')].filter(card => {
          const box = card.getBoundingClientRect();
          return box.bottom > view.top - 40 && box.top < innerHeight + 40;
        });
        stagger(visible, 'rise', { step: 16, max: 18, duration: 260 });
      });
    }).observe(list, { childList: true });
  }

  function mount() {
    document.body.classList.add('xv-motion-ready');
    for (const [id, target, frames, curve] of [
      [
        'palette',
        '.palettebox',
        [
          { opacity: 0, transform: 'translateY(-12px) scale(.97)' },
          { opacity: 1, transform: 'none' },
        ],
        'snappy',
      ],
      [
        'detailsDrawer',
        null,
        [
          { opacity: 0, transform: 'translateX(24px)' },
          { opacity: 1, transform: 'none' },
        ],
        'gentle',
      ],
      [
        'lightbox',
        '.lbContent',
        [
          { opacity: 0, transform: 'translateY(14px) scale(.975)' },
          { opacity: 1, transform: 'none' },
        ],
        'gentle',
      ],
      [
        'notificationCenter',
        null,
        [
          { opacity: 0, transform: 'translateY(-8px)' },
          { opacity: 1, transform: 'none' },
        ],
        'snappy',
      ],
    ]) {
      const root = document.getElementById(id);
      if (!root) continue;
      let visible = !root.classList.contains('hidden');
      new MutationObserver(() => {
        const next = !root.classList.contains('hidden');
        if (next && !visible) play(target ? root.querySelector(target) : root, frames, 220, { spring: curve });
        else if (!next) {
          const element = target ? root.querySelector(target) : root;
          active.get(element)?.cancel();
          active.delete(element);
        }
        visible = next;
      }).observe(root, { attributes: true, attributeFilter: ['class'] });
    }
    // Native dialogs (shortcut sheet, switchers, confirmations) enter with the same spring.
    new MutationObserver(records => {
      for (const record of records) {
        const dialog = record.target;
        if (record.attributeName === 'open' && dialog.open && dialog.tagName === 'DIALOG' && !dialog.dataset.xvStill)
          play(dialog, PRESETS.scale, 220, { spring: 'snappy' });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    const sync = () => {
      const style = document.documentElement.style;
      for (const [key, value] of [
        ['--motion-scale', String(speed())],
        ['--motion-k', String(factor())],
        ['--xv-spring-snappy', spring('snappy').easing],
        ['--xv-spring-gentle', spring('gentle').easing],
        ['--xv-spring-bouncy', spring('bouncy').easing],
      ])
        if (style.getPropertyValue(key) !== value) style.setProperty(key, value);
      document.documentElement.classList.toggle('xv-calm', calm());
      cancel();
    };
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-motion'] });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', sync);
    sync();
    navIndicator();
    libraryReveal();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
