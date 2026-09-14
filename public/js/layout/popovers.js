const popovers = new Set();

export function closePopovers(restoreFocus = false) {
  for (const popover of popovers) popover.close(restoreFocus);
}

export function bindPopover(trigger, panel, { placement = "bottom", onOpen } = {}) {
  // Keep menus outside clipping/transforming panels, including the mobile sidebar.
  document.body.append(panel);
  panel.classList.add("navigation-popover");
  let pointerInside = false;
  // A compact header can tuck the original trigger inside another popover.
  // Use its visible anchor when that parent closes or keyboard focus returns.
  const anchor = () => trigger.getClientRects().length ? trigger
    : document.getElementById(trigger.dataset.popoverAnchor) ?? trigger;
  const items = () => [...panel.querySelectorAll("[data-popover-item]")]
    .filter((item) => !item.disabled && item.getClientRects().length);

  function position() {
    if (panel.hidden) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const rect = anchor().getBoundingClientRect();
    panel.style.maxWidth = `${width - 24}px`;
    panel.style.maxHeight = `${height - 24}px`;
    const above = Math.max(0, rect.top - top - 20);
    const below = Math.max(0, top + height - rect.bottom - 20);
    const upwards = placement === "top" ? above >= Math.min(panel.scrollHeight, below) : below < Math.min(panel.scrollHeight, above);
    panel.style.maxHeight = `${Math.min(height - 24, Math.max(120, upwards ? above : below))}px`;
    const bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - bounds.width - 12))}px`;
    panel.style.top = `${Math.max(top + 12, Math.min(upwards ? rect.top - bounds.height - 8 : rect.bottom + 8, top + height - bounds.height - 12))}px`;
  }

  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor().getClientRects().length) anchor().focus({ preventScroll: true });
  }

  function open(last = false) {
    if (trigger.disabled || trigger.hidden) return;
    closePopovers();
    onOpen?.();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    position();
    const focus = last ? items().at(-1)
      : panel.querySelector("input[type=search]")
        ?? items().find((item) => item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-pressed") === "true")
        ?? items()[0];
    focus?.focus({ preventScroll: true });
  }

  const controller = { open, close };
  popovers.add(controller);
  trigger.addEventListener("click", () => panel.hidden ? open() : close(true));
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    open(event.key === "ArrowUp");
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const options = items();
    if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const searching = event.target.matches("input[type=search]");
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % options.length;
    if (event.key === "ArrowUp") next = index < 0 ? options.length - 1 : (index - 1 + options.length) % options.length;
    if (!searching && event.key === "Home") next = 0;
    if (!searching && event.key === "End") next = options.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    options[next].focus();
  });
  document.addEventListener("pointerdown", (event) => {
    pointerInside = panel.contains(event.target);
    if (!panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener("pointerup", () => { pointerInside = false; });
  document.addEventListener("pointercancel", () => { pointerInside = false; });
  const onFocusOut = (event) => {
    // Clicking a label or empty menu space can briefly move focus to the body.
    // Keep that click alive; Tab and focus moving outside still dismiss the menu.
    if (pointerInside && (!event.relatedTarget || event.relatedTarget === document.body)) return;
    if (!panel.contains(event.relatedTarget) && !trigger.contains(event.relatedTarget)) close();
  };
  panel.addEventListener("focusout", onFocusOut);
  trigger.addEventListener("focusout", onFocusOut);
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  return controller;
}
