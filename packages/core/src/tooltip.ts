// tooltip.ts — one global hover/focus tooltip engine for [data-tip].
// Single fixed-position div, no dependency, realm-safe across documents.

export type Disposer = () => void;

let nextTipId = 1;

/** Realm-safe element check (works across iframes and test environments). */
function asElement(target: EventTarget | null): Element | null {
  return target !== null && (target as Node).nodeType === 1 ? (target as Element) : null;
}

export function installTooltips(scope: ParentNode = document): Disposer {
  const scopeNode = scope as Node;
  const doc: Document = scopeNode.nodeType === 9
    ? (scopeNode as Document)
    : (scopeNode.ownerDocument ?? document);
  const win: Window = doc.defaultView ?? window;

  const tip = doc.createElement('div');
  tip.id = `lw-tip-${nextTipId++}`;
  tip.className = 'lw-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);

  let current: Element | null = null;

  const attachDescribedBy = (el: Element): void => {
    const prev = el.getAttribute('aria-describedby');
    if (prev === null || prev.trim() === '') {
      el.setAttribute('aria-describedby', tip.id);
    } else if (!prev.split(/\s+/).includes(tip.id)) {
      el.setAttribute('aria-describedby', `${prev} ${tip.id}`);
    }
  };

  const detachDescribedBy = (el: Element): void => {
    const prev = el.getAttribute('aria-describedby');
    if (prev === null) return;
    const kept = prev.split(/\s+/).filter((token) => token !== '' && token !== tip.id);
    if (kept.length === 0) el.removeAttribute('aria-describedby');
    else el.setAttribute('aria-describedby', kept.join(' '));
  };

  const place = (target: Element): void => {
    const r = target.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.bottom + 6;
    left = Math.max(8, Math.min(left, win.innerWidth - tw - 8));
    if (top + th > win.innerHeight - 8) top = r.top - th - 6;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.max(8, Math.round(top))}px`;
  };

  const hide = (): void => {
    if (current !== null) {
      detachDescribedBy(current);
      current = null;
    }
    tip.hidden = true;
  };

  const show = (target: Element): void => {
    const text = target.getAttribute('data-tip');
    if (text === null || text === '') return;
    if (current !== null && current !== target) detachDescribedBy(current);
    current = target;
    attachDescribedBy(target);
    tip.textContent = text;
    tip.hidden = false;
    place(target);
  };

  const onOver = (ev: Event): void => {
    const t = asElement(ev.target);
    if (t === null) return;
    // a hovered element removed from the DOM fires no pointerout — if the
    // current target is gone (panel re-render), drop the stale tooltip
    if (current !== null && !current.isConnected) hide();
    const el = t.closest('[data-tip]');
    if (el === null) { hide(); return; }
    if (el === current) { place(el); return; }
    show(el);
  };

  const onOut = (ev: Event): void => {
    const t = asElement(ev.target);
    if (t === null) return;
    if (t.closest('[data-tip]') !== current) return;
    // Moving between child nodes inside `current` must not flicker/hide.
    const related = asElement((ev as PointerEvent).relatedTarget);
    if (related !== null && current !== null && current.contains(related)) return;
    hide();
  };

  const onFocusIn = (ev: Event): void => {
    const t = asElement(ev.target);
    if (t === null) return;
    const el = t.closest('[data-tip]');
    if (el !== null) show(el);
  };

  const onFocusOut = (ev: Event): void => {
    const t = asElement(ev.target);
    if (t === null) return;
    if (t.closest('[data-tip]') !== current) return;
    const related = asElement((ev as FocusEvent).relatedTarget);
    if (related !== null && current !== null && current.contains(related)) return;
    hide();
  };

  const onScroll = (): void => {
    if (current === null) return;
    if (!current.isConnected) { hide(); return; }
    const r = current.getBoundingClientRect();
    // Hide when a laid-out target has scrolled completely out of the viewport.
    if (
      (r.width > 0 || r.height > 0)
      && (r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth)
    ) {
      hide();
      return;
    }
    place(current);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') hide();
  };

  scope.addEventListener('pointerover', onOver);
  scope.addEventListener('pointerout', onOut);
  scope.addEventListener('focusin', onFocusIn);
  scope.addEventListener('focusout', onFocusOut);
  win.addEventListener('scroll', onScroll, { passive: true, capture: true });
  win.addEventListener('resize', onScroll);
  win.addEventListener('keydown', onKeyDown);

  return () => {
    hide();
    scope.removeEventListener('pointerover', onOver);
    scope.removeEventListener('pointerout', onOut);
    scope.removeEventListener('focusin', onFocusIn);
    scope.removeEventListener('focusout', onFocusOut);
    win.removeEventListener('scroll', onScroll, { capture: true });
    win.removeEventListener('resize', onScroll);
    win.removeEventListener('keydown', onKeyDown);
    tip.remove();
  };
}
