import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { sessionViewToken } from "../core/session-view.js";
import { escapeHtml } from "../core/format.js";
import { preferredModelSettings } from "./models.js";
import { renderSessions, selectSession } from "./sessions.js";

export async function loadChats() {
  const isCurrent = sessionViewToken();
  const { chats } = await api("/api/chats");
  if (!isCurrent() || state.surface !== "chat") return;
  state.chats = chats;
  state.sessions = chats;
  renderSessions();
  const selected = chats.find((chat) => chat.id === state.sessionId)
    ?? chats.find((chat) => chat.id === state.navigation.chatId)
    ?? chats[0];
  if (selected) {
    if (state.sessionId !== selected.id || !state.selectedSession) await selectSession(selected.id);
    else renderChatProjectEditor(selected);
  } else {
    state.sessionId = null;
    state.selectedSession = null;
    $("#session-title").textContent = "Чат";
    $("#session-meta").className = "session-meta";
    $("#session-meta").innerHTML = '<span class="session-meta-dot"></span><span>Создайте первый общий чат</span>';
    $("#prompt-form").hidden = true;
    $("#chat-composer-controls").hidden = true;
    renderChatProjectEditor(null);
  }
}

export async function createChat() {
  try {
    const { chat } = await api("/api/chats", {
      method: "POST",
      body: JSON.stringify({ projectIds: [], ...preferredModelSettings() }),
    });
    await loadChats();
    if (state.sessionId !== chat.id) await selectSession(chat.id);
  } catch (error) {
    alert(error.message);
  }
}

export function renderChatProjectEditor(chat = state.selectedSession) {
  if (state.surface !== "chat") return;
  const selected = new Set(chat?.projectIds ?? []);
  $("#chat-project-options").innerHTML = state.projects.length
    ? state.projects.map((project) => `
        <label>
          <input type="checkbox" value="${escapeHtml(project.id)}" ${selected.has(project.id) ? "checked" : ""} />
          <span>${escapeHtml(project.name)}</span>
          ${project.kind === "learning" ? "<small>учёба</small>" : ""}
        </label>
      `).join("")
    : '<p class="chat-projects-empty">Нет зарегистрированных проектов.</p>';
  $("#chat-project-options").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => void saveChatProjects());
  });
  renderChatIntentControls();
}

async function saveChatProjects() {
  if (!state.sessionId) return;
  const projectIds = [...$("#chat-project-options").querySelectorAll("input:checked")]
    .map((input) => input.value);
  try {
    const { chat } = await api(`/api/chats/${state.sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ projectIds }),
    });
    state.selectedSession = { ...state.selectedSession, ...chat };
    state.sessions = state.sessions.map((item) => item.id === chat.id ? chat : item);
    state.chats = state.sessions;
    renderChatProjectEditor(chat);
  } catch (error) {
    alert(error.message);
    renderChatProjectEditor();
  }
}

export function setChatIntent(intent) {
  state.chatIntent = intent === "act" && hasModule("development") ? "act" : "ask";
  if (state.chatIntent === "ask") state.chatActionProjectId = null;
  renderChatIntentControls();
}

export function renderChatIntentControls() {
  const chat = state.surface === "chat" ? state.selectedSession : null;
  const controls = $("#chat-composer-controls");
  controls.hidden = !chat;
  if (!chat) return;
  if (!hasModule("development")) state.chatIntent = "ask";
  controls.querySelectorAll("[data-chat-intent]").forEach((button) => {
    button.hidden = button.dataset.chatIntent === "act" && !hasModule("development");
    button.classList.toggle("active", button.dataset.chatIntent === state.chatIntent);
  });
  const attached = state.projects.filter((project) => (chat.projectIds ?? []).includes(project.id));
  const select = $("#chat-action-project");
  select.innerHTML = attached.length
    ? attached.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join("")
    : '<option value="">Сначала подключите проект</option>';
  if (!attached.some((project) => project.id === state.chatActionProjectId)) {
    state.chatActionProjectId = attached[0]?.id ?? null;
  }
  select.value = state.chatActionProjectId ?? "";
  $("#chat-action-project-label").hidden = state.chatIntent !== "act";
  $("#chat-intent-hint").textContent = state.chatIntent === "act"
    ? attached.length ? "Codex может изменить выбранный проект" : "Подключите проект в боковой панели"
    : hasModule("outline")
      ? "Можно создавать и редактировать документы Outline по вашему запросу. Файлы — только чтение."
      : "Файлы — только чтение";
}

export function bindChats() {
  $("#new-chat")?.addEventListener("click", () => void createChat());
  document.querySelectorAll("[data-chat-intent]").forEach((button) => {
    button.addEventListener("click", () => setChatIntent(button.dataset.chatIntent));
  });
  $("#chat-action-project")?.addEventListener("change", (event) => {
    state.chatActionProjectId = event.target.value || null;
  });
}
