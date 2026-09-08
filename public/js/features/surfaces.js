import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { $ } from "../core/dom.js";
import { storeString } from "../core/storage.js";
import { loadSessions, resetProjectSessionView, selectSession } from "./sessions.js";
import { hasSessionView } from "../core/session-view.js";
import { loadChats } from "./chats.js";
import { loadMemory } from "./memory.js";
import { setSidebarOpen } from "../layout/panels.js";
import { renderEvents } from "../events/render.js";

const SURFACES = new Set(["projects", "chat", "memory"]);
const SURFACE_LABELS = { projects: "Проекты", chat: "Чат", memory: "Память" };
const SURFACE_DETAILS = {
  projects: { description: "Сессии и работа с кодом", path: 'M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z' },
  chat: { description: "Вопросы и обсуждения", path: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6' },
  memory: { description: "Решения, факты и знания", path: 'm12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5' },
};

function surfaceIcon(value) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SURFACE_DETAILS[value].path}"/></svg>`;
}

function availableSurface(value) {
  return value === "chat" ? hasModule("chat") : value === "memory"
    ? hasModule("development") : hasModule("development") || hasModule("learning");
}

function closeSurfaceMenu(restoreFocus = false) {
  $("#surface-menu").hidden = true;
  $("#surface-trigger").setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#surface-trigger").focus();
}

function renderSurfaceMenu() {
  closeSurfaceMenu();
  const values = [...SURFACES].filter(availableSurface);
  const current = values.includes(state.surface) ? state.surface : values[0];
  $("#surface-trigger").disabled = !current;
  $("#surface-current").textContent = SURFACE_LABELS[current] ?? "Нет доступных разделов";
  $("#surface-current-icon").innerHTML = current ? surfaceIcon(current) : "";
  $("#surface-menu").innerHTML = values.map((value) => `
    <button type="button" class="surface-option" data-surface="${value}"
      role="menuitemradio" aria-checked="${value === current}" tabindex="-1">
      <span class="surface-icon">${surfaceIcon(value)}</span>
      <span class="surface-option-text"><strong>${SURFACE_LABELS[value]}</strong><small>${SURFACE_DETAILS[value].description}</small></span>
      <svg class="surface-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
    </button>
  `).join("");
}

function openSurfaceMenu(last = false) {
  const menu = $("#surface-menu");
  const items = [...menu.querySelectorAll("[data-surface]")];
  if (!items.length) return;
  menu.hidden = false;
  $("#surface-trigger").setAttribute("aria-expanded", "true");
  const selected = menu.querySelector('[aria-checked="true"]');
  (last ? items.at(-1) : selected ?? items[0]).focus();
}

export async function setSurface(surface) {
  const next = SURFACES.has(surface) && availableSurface(surface) ? surface : [...SURFACES].find(availableSurface) ?? "chat";
  if (state.surface !== next || next === "memory") resetProjectSessionView();
  state.surface = next;
  storeString("ronix-agent-surface", next);
  renderSurfaceMenu();

  $("#project-navigation").hidden = next !== "projects";
  $("#chat-projects-editor").hidden = next !== "chat";
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
    : next === "projects" ? state.navigation.sessionsByProject?.[$("#project").value] : null;
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
  const navigation = $(".surface-navigation");
  const trigger = $("#surface-trigger");
  const menu = $("#surface-menu");
  trigger.addEventListener("click", () => {
    if (menu.hidden) openSurfaceMenu();
    else closeSurfaceMenu(true);
  });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    openSurfaceMenu(event.key === "ArrowUp");
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-surface]");
    if (!option) return;
    closeSurfaceMenu(true);
    setSidebarOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches) $("#open-sidebar").focus();
    void setSurface(option.dataset.surface);
  });
  navigation.addEventListener("keydown", (event) => {
    if (menu.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSurfaceMenu(true);
      return;
    }
    const items = [...menu.querySelectorAll("[data-surface]")];
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  });
  navigation.addEventListener("focusout", (event) => {
    if (!navigation.contains(event.relatedTarget)) closeSurfaceMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!navigation.contains(event.target)) closeSurfaceMenu();
  });
}
