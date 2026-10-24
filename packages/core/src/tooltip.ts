// tooltip.ts — one global hover/focus tooltip engine for [data-tip].
// Single absolutely-positioned div, no dependency.

export type Disposer = () => void;

export function installTooltips(scope: ParentNode = document): Disposer {
  const tip = document.createElement('div');
  tip.className = 'lw-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: Element | null = null;

  const show = (target: Element): void => {
    const text = target.getAttribute('data-tip');
    if (text === null || text === '') return;
    current = target;
    tip.textContent = text;
    tip.hidden = false;
    place(target);
  };

  const place = (target: Element): void => {
    const r = target.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    if (top + th > window.innerHeight - 8) top = r.top - th - 6;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.max(8, Math.round(top))}px`;
  };

  const hide = (): void => {
    current = null;
    tip.hidden = true;
  };

  const onOver = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    // a hovered element removed from the DOM fires no pointerout — if the
    // current target is gone (panel re-render), drop the stale tooltip
    if (current !== null && !current.isConnected) hide();
    const el = t.closest('[data-tip]');
    if (el === null) { hide(); return; }
    if (el === current) { if (el !== null) place(el); return; }
    show(el);
  };

  const onOut = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-tip]') === current) hide();
  };

  const onFocusIn = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const el = t.closest('[data-tip]');
    if (el !== null) show(el);
  };

  const onFocusOut = (ev: Event): void => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-tip]') === current) hide();
  };

  const onScroll = (): void => {
    if (current !== null && !current.isConnected) { hide(); return; }
    if (current !== null) place(current);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') hide();
  };

  scope.addEventListener('pointerover', onOver);
  scope.addEventListener('pointerout', onOut);
  scope.addEventListener('focusin', onFocusIn);
  scope.addEventListener('focusout', onFocusOut);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    hide();
    scope.removeEventListener('pointerover', onOver);
    scope.removeEventListener('pointerout', onOut);
    scope.removeEventListener('focusin', onFocusIn);
    scope.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('keydown', onKeyDown);
    tip.remove();
  };
}
