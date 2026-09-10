import { currentProjectId } from "./context.js";
import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { $ } from "../core/dom.js";
import { storeString } from "../core/storage.js";
import { loadSessions, resetProjectSessionView, selectSession } from "./sessions.js";
import { hasSessionView } from "../core/session-view.js";
import { loadChats } from "./chats.js";
import { loadMemory } from "./memory.js";
import { bindPopover, closePopovers } from "../layout/popovers.js";
import { setSidebarOpen } from "../layout/panels.js";
import { renderEvents } from "../events/render.js";
import { SURFACES, availableSurface as canAccessSurface, resolveSurface } from "../core/navigation.js";
import { renderProjectPicker } from "./projects.js";
import { saveCurrentDraft } from "./composer.js";

const SURFACE_LABELS = { learning: "Учёба", development: "Разработка", chat: "Чат", memory: "Память" };
const SURFACE_DETAILS = {
  learning: { description: "Курс, теория, практика и прогресс", path: 'M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1m0-15c3-2 7-2 9-1v15c-3-1-6-1-9 1Zm0 0v15' },
  development: { description: "Сессии и работа с кодом", path: 'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z' },
  chat: { description: "Вопросы и обсуждения", path: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6' },
  memory: { description: "Решения, факты и знания", path: 'm12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5' },
};

function surfaceIcon(value) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SURFACE_DETAILS[value].path}"/></svg>`;
}

function availableSurface(value) {
  return canAccessSurface(value, hasModule);
}

let surfaceMenu;

function renderSurfaceMenu() {
  surfaceMenu?.close();
  const values = [...SURFACES].filter(availableSurface);
  const current = values.includes(state.surface) ? state.surface : values[0];
  $("#surface-trigger").disabled = !current;
  $("#surface-current").textContent = SURFACE_LABELS[current] ?? "Нет доступных разделов";
  $("#surface-current-icon").innerHTML = current ? surfaceIcon(current) : "";
  $("#surface-menu").innerHTML = values.map((value) => `
    <button type="button" class="surface-option" data-surface="${value}"
      data-popover-item role="menuitemradio" aria-checked="${value === current}" tabindex="-1">
      <span class="surface-icon">${surfaceIcon(value)}</span>
      <span class="surface-option-text"><strong>${SURFACE_LABELS[value]}</strong><small>${SURFACE_DETAILS[value].description}</small></span>
      <svg class="surface-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
    </button>
  `).join("");
}

export async function setSurface(surface) {
  closePopovers();
  const next = resolveSurface(surface, state.projects, state.navigation, hasModule);
  if (state.surface !== next || next === "memory") {
    saveCurrentDraft();
    resetProjectSessionView();
  }
  state.surface = next;
  renderProjectPicker();
  storeString("ronix-agent-surface", next);
  renderSurfaceMenu();

  $("#chat-context-trigger").hidden = true;
  $("#new-session").hidden = next !== "development" || !currentProjectId();
  $("#sessions-label").parentElement.hidden = next === "memory";
  $("#sessions").hidden = next === "memory";
  $("#session-search").value = "";
  $("#session-search-wrap").hidden = next === "memory";
  $("#session-search-empty").hidden = true;
  $("#new-chat").hidden = next !== "chat";
  $("#events").hidden = next === "memory";
  $("#memory-view").hidden = next !== "memory";
  $("#composer-shell")?.toggleAttribute("hidden", next === "memory");
  $("#toggle-settings").hidden = true;
  $("#toggle-git").hidden = true;
  if (next !== "memory" && !state.historyReady) renderEvents();

  const cachedId = next === "chat" ? state.navigation.chatId
    : next === "development" ? state.navigation.sessionsByProject?.[currentProjectId()] : null;
  const restoring = cachedId && cachedId !== state.sessionId && hasSessionView(cachedId)
    ? selectSession(cachedId) : null;

  if (next === "chat") {
    await loadChats();
  } else if (next === "memory") {
    $("#session-title").textContent = "Память";
    $("#session-meta").className = "session-meta ready";
    $("#session-meta").innerHTML = '<span class="session-meta-dot"></span><span>Локальная база Ronix</span>';
    $("#prompt-form").hidden = true;
    $("#chat-composer-controls").hidden = true;
    await loadMemory();
  } else {
    await loadSessions();
  }
  await restoring;
  if (state.surface === next && next !== "memory" && !state.sessionId) renderEvents();
}

export function bindSurfaces() {
  renderSurfaceMenu();
  surfaceMenu = bindPopover($("#surface-trigger"), $("#surface-menu"));
  $("#surface-menu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-surface]");
    if (!option) return;
    surfaceMenu.close(true);
    setSidebarOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches) $("#open-sidebar").focus();
    void setSurface(option.dataset.surface).catch((error) => alert(error.message));
  });
}
