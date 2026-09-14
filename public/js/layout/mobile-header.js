import { $ } from "../core/dom.js";
import { bindPopover, closePopovers } from "./popovers.js";
import { setSettingsOpen, setGitOpen } from "./panels.js";

export function bindMobileHeader() {
  const trigger = $("#mobile-context-trigger");
  const panel = $("#mobile-context-panel");
  const title = $(".chat-title");
  const media = window.matchMedia("(max-width: 760px)");
  const controls = [title, $("#toggle-settings"), $("#toggle-git")];
  // Move the actual controls so project selection, permissions and live state
  // have one source of truth at every viewport size.
  const positions = controls.map((element) => {
    const marker = document.createComment("desktop header control");
    element.before(marker);
    return { element, marker };
  });
  for (const button of [$("#project-trigger"), $("#chat-context-trigger"), ...controls.slice(1)]) {
    button.dataset.popoverItem = "";
  }
  for (const button of controls.slice(1)) {
    const label = document.createElement("span");
    label.className = "mobile-tool-label";
    label.textContent = button.getAttribute("aria-label");
    button.append(label);
  }
  const menu = bindPopover(trigger, panel, {
    onOpen: () => { setSettingsOpen(false); setGitOpen(false); },
  });

  function syncTitle() {
    const text = $("#session-title").textContent;
    const meta = $("#session-meta");
    $("#mobile-context-title").textContent = text;
    $("#mobile-context-status").className = `mobile-context-status ${meta.className}`;
    trigger.setAttribute("aria-label", `${text}. ${meta.textContent.trim()}. Открыть действия и контекст`);
  }
  new MutationObserver(syncTitle).observe(title, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["class"],
  });
  function syncLayout() {
    const focused = document.activeElement;
    const restoreFocus = panel.contains(focused) || focused === trigger;
    closePopovers();
    setSettingsOpen(false);
    setGitOpen(false);
    trigger.hidden = !media.matches;
    for (const { element, marker } of positions) {
      if (media.matches) panel.append(element);
      else marker.after(element);
    }
    if (restoreFocus) {
      const target = media.matches ? trigger
        : title.querySelector("button:not([hidden])") ?? $("#toggle-settings");
      if (target.getClientRects().length) target.focus({ preventScroll: true });
    }
    syncTitle();
  }
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("#toggle-settings, #toggle-git");
    if (!button) return;
    menu.close(true);
    const target = button.id === "toggle-settings" ? $("#session-settings") : $("#git-panel");
    target.querySelector("select:not(:disabled), button:not(:disabled), input:not(:disabled)")?.focus({ preventScroll: true });
  });
  media.addEventListener("change", syncLayout);
  syncLayout();
}
