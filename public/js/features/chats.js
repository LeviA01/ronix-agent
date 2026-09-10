import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { sessionViewToken } from "../core/session-view.js";
import { escapeHtml } from "../core/format.js";
import { preferredModelSettings } from "./models.js";
import { renderSessions, selectSession } from "./sessions.js";
import { bindPopover } from "../layout/popovers.js";

const contextWrites = new Map();
let contextMenu;

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

function filterChatProjects() {
  const query = $("#chat-project-search").value.trim().toLocaleLowerCase("ru");
  let visible = 0;
  $("#chat-project-options").querySelectorAll("label").forEach((label) => {
    label.hidden = !label.textContent.toLocaleLowerCase("ru").includes(query);
    if (!label.hidden) visible++;
  });
  $("#chat-project-empty").hidden = visible > 0;
  $("#chat-project-empty").textContent = state.projects.length ? "Проекты не найдены" : "Нет зарегистрированных проектов.";
}

export function renderChatProjectEditor(chat = state.selectedSession) {
  const active = state.surface === "chat" && chat?.id === state.sessionId;
  $("#chat-context-trigger").hidden = !active;
  if (!active) { contextMenu?.close(); return; }
  const panel = $("#chat-projects-editor");
  if (panel.dataset.chatId !== chat.id) {
    contextMenu?.close();
    panel.dataset.chatId = chat.id;
    $("#chat-project-search").value = "";
    $("#chat-project-status").hidden = true;
  }
  const pending = contextWrites.get(chat.id);
  const selected = new Set(pending?.projectIds ?? chat.projectIds ?? []);
  const options = $("#chat-project-options");
  const signature = JSON.stringify(state.projects.map(({ id, name, kind }) => [id, name, kind]));
  // Keep the same checkbox nodes so saving never loses keyboard focus.
  if (options.dataset.projects !== signature) {
    options.dataset.projects = signature;
    options.innerHTML = state.projects.map((project) => `
      <label>
        <input type="checkbox" data-popover-item value="${escapeHtml(project.id)}" />
        <span>${escapeHtml(project.name)}</span>
        ${project.kind === "learning" ? "<small>учёба</small>" : ""}
      </label>
    `).join("");
  }
  options.querySelectorAll("input").forEach((input) => { input.checked = selected.has(input.value); });
  $("#chat-context-label").textContent = `Контекст · ${state.projects.filter((project) => selected.has(project.id)).length}`;
  options.setAttribute("aria-busy", String(Boolean(pending)));
  filterChatProjects();
  renderChatIntentControls();
}

async function saveChatProjects() {
  const id = state.sessionId;
  if (state.surface !== "chat" || !id || state.selectedSession?.id !== id) return;
  const projectIds = [...$("#chat-project-options").querySelectorAll("input:checked")].map((input) => input.value);
  const existing = contextWrites.get(id);
  if (existing) {
    existing.projectIds = projectIds;
    existing.version++;
    renderChatProjectEditor();
    return;
  }
  const pending = { projectIds, version: 0 };
  contextWrites.set(id, pending);
  $("#chat-project-status").hidden = true;
  renderChatProjectEditor();
  // Serialize rapid changes per chat; later choices must reach the server last.
  try {
    let savedVersion;
    do {
      savedVersion = pending.version;
      const { chat } = await api(`/api/chats/${encodeURIComponent(id)}`, {
        method: "PATCH", body: JSON.stringify({ projectIds: pending.projectIds }),
      });
      const merge = (item) => item.id === id ? { ...item, projectIds: chat.projectIds } : item;
      state.chats = state.chats.map(merge);
      if (state.surface === "chat") state.sessions = state.sessions.map(merge);
      if (state.surface === "chat" && state.sessionId === id && state.selectedSession?.id === id) {
        state.selectedSession = merge(state.selectedSession);
      }
    } while (savedVersion !== pending.version);
  } catch (error) {
    if (state.surface === "chat" && state.sessionId === id) {
      $("#chat-project-status").textContent = `Не удалось сохранить контекст: ${error.message}`;
      $("#chat-project-status").hidden = false;
    }
  } finally {
    contextWrites.delete(id);
    if (state.surface === "chat" && state.sessionId === id) renderChatProjectEditor();
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
    ? attached.length ? "Codex может изменить выбранный проект" : "Подключите проект через «Контекст» в шапке чата"
    : hasModule("outline")
      ? "Можно создавать и редактировать документы Outline по вашему запросу. Файлы — только чтение."
      : "Файлы — только чтение";
}

export function bindChats() {
  contextMenu = bindPopover($("#chat-context-trigger"), $("#chat-projects-editor"), {
    onOpen: () => { $("#chat-project-search").value = ""; renderChatProjectEditor(); },
  });
  $("#chat-project-search").addEventListener("input", filterChatProjects);
  $("#chat-project-options").addEventListener("change", () => void saveChatProjects());
  $("#new-chat")?.addEventListener("click", () => void createChat());
  document.querySelectorAll("[data-chat-intent]").forEach((button) => {
    button.addEventListener("click", () => setChatIntent(button.dataset.chatIntent));
  });
  $("#chat-action-project")?.addEventListener("change", (event) => {
    state.chatActionProjectId = event.target.value || null;
  });
}
