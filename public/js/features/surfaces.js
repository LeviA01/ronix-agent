import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { storeString } from "../core/storage.js";
import { loadSessions, resetProjectSessionView } from "./sessions.js";
import { loadChats } from "./chats.js";
import { loadMemory } from "./memory.js";

const SURFACES = new Set(["projects", "chat", "memory"]);

export async function setSurface(surface) {
  const next = SURFACES.has(surface) ? surface : "projects";
  if (state.surface !== next || next === "memory") resetProjectSessionView();
  state.surface = next;
  storeString("ronix-agent-surface", next);
  document.querySelectorAll("[data-surface]").forEach((button) => {
    button.classList.toggle("active", button.dataset.surface === next);
    button.setAttribute("aria-current", button.dataset.surface === next ? "page" : "false");
  });

  $("#project-navigation").hidden = next !== "projects";
  $("#chat-projects-editor").hidden = next !== "chat";
  $("#sessions-label").parentElement.hidden = next === "memory";
  $("#sessions").hidden = next === "memory";
  $("#new-chat").hidden = next !== "chat";
  $("#events").hidden = next === "memory";
  $("#memory-view").hidden = next !== "memory";
  $("#composer-shell")?.toggleAttribute("hidden", next === "memory");
  $("#toggle-settings").hidden = true;
  $("#toggle-git").hidden = true;

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
}

export function bindSurfaces() {
  document.querySelectorAll("[data-surface]").forEach((button) => {
    button.addEventListener("click", () => void setSurface(button.dataset.surface));
  });
}

