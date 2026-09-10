import { closePopovers } from "./popovers.js";

const returns = new WeakMap();
const bound = new WeakSet();

export function utilityReturnTarget() {
  return document.querySelector(window.matchMedia("(max-width: 760px)").matches
    ? "#open-sidebar" : "#ronix-menu-trigger");
}

function restoreFocus(modal) {
  const target = returns.get(modal);
  returns.delete(modal);
  const element = typeof target === "function" ? target() : target;
  if (element?.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden") {
    element.focus({ preventScroll: true });
  } else {
    (document.querySelector("#project-trigger:not([hidden])") ?? utilityReturnTarget())?.focus({ preventScroll: true });
  }
}

export function closeDialog(modal) {
  if (modal instanceof HTMLDialogElement) {
    if (modal.open) modal.close();
  } else if (!modal.hidden) {
    modal.hidden = true;
    restoreFocus(modal);
  }
}

export function openDialog(modal, { returnFocus = document.activeElement, initialFocus } = {}) {
  closePopovers();
  returns.set(modal, returnFocus);
  if (!bound.has(modal)) {
    bound.add(modal);
    modal.addEventListener("close", () => restoreFocus(modal));
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!(modal instanceof HTMLDialogElement)) {
          event.preventDefault();
          closeDialog(modal);
        }
      }
      if (event.key !== "Tab") return;
      const focusable = [...modal.querySelectorAll("button, a[href], input, select, textarea, [tabindex='0']")]
        .filter((element) => !element.disabled && !element.className.includes("backdrop") && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    });
  }
  if (modal instanceof HTMLDialogElement) {
    if (!modal.open) modal.showModal();
  } else modal.hidden = false;
  (initialFocus ?? [...modal.querySelectorAll("button:not([disabled]), input:not([disabled])")]
    .find((element) => !element.className.includes("backdrop") && element.getClientRects().length))?.focus({ preventScroll: true });
}
