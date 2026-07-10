import { state, THEMES } from "../core/state.js";
import { $$ } from "../core/dom.js";
import { storeString } from "../core/storage.js";

export function applyTheme(theme) {
  state.theme = THEMES.has(theme) ? theme : "terminal";
  document.body.dataset.theme = state.theme;
  storeString("ronix-agent-theme", state.theme);
  $$("[data-theme-option]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeOption === state.theme);
  });
}

export function bindThemeControls() {
  $$("[data-theme-option]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeOption));
  });
}
