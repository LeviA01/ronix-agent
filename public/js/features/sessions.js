import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { storeJson } from "../core/storage.js";
import { escapeHtml, relativeTime, sessionTitle, statusLabel } from "../core/format.js";
import { getChat, setGitOpen, setSettingsOpen, setSidebarOpen } from "../layout/panels.js";
import { isLearningProject } from "./context.js";
import {
  forgetSession,
  normalizeSessionModel,
  preferredModelSettings,
  rememberSession,
  renderModelControls,
} from "./models.js";
import {
  clearPrompt,
  persistDrafts,
  restoreDraft,
  saveCurrentDraft,
} from "./composer.js";
import { renderGitPanel, resetGitStatus, refreshGitStatus } from "./git.js";
import {
  clearSelectedSessionForProgress,
  loadLearning,
  loadTheoryMaterials,
  renderLearningModeButton,
  renderLearningProgressMode,
  renderTheoryTabs,
  renderTheorySuggestions,
  selectLearningMode,
} from "./learning.js";
import { connectEvents } from "../events/stream.js";
import { renderEvents } from "../events/render.js";

export function resetProjectSessionView() {
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.reconnectTimer = null;
  state.sessionRefreshTimer = null;
  state.liveRenderFrame = null;
  state.sessions = [];
  state.sessionId = null;
  state.events = [];
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  state.archivedMessages = [];
  state.gitStatus = null;
  state.gitProjectId = null;
  state.gitLoading = false;
  state.gitError = null;
  clearPrompt();
  renderSessions();
  renderSessionMeta(null);
  renderEvents();
}

export function renderSessionMeta(session) {
  state.selectedSession = session;
  renderTheoryTabs();
  renderTheorySuggestions();
  const meta = $("#session-meta");
  if (!session) {
    const project = state.surface === "projects"
      ? state.projects.find((item) => item.id === $("#project").value)
      : null;
    const hasSessions = state.sessions.length > 0;
    $("#session-title").textContent = project?.name ?? "Выберите проект";
    meta.className = "session-meta";
    meta.innerHTML = `
      <span class="session-meta-dot"></span>
      <span>${project
        ? hasSessions ? "Выберите сессию проекта" : "В проекте пока нет сессий"
        : "Добавьте проект, чтобы начать работу"}</span>
    `;
    $("#session-settings").hidden = true;
    $("#toggle-settings").hidden = true;
    $("#toggle-git").hidden = true;
    $("#interrupt").hidden = true;
    $("#prompt-form").hidden = true;
    $("#chat-composer-controls").hidden = true;
    $("#send").disabled = true;
    $("#sandbox-mode").disabled = true;
    renderModelControls(null);
    renderGitPanel();
    return;
  }
  const chatSession = session.purpose === "chat";
  $("#session-title").textContent = session.purpose === "materials" ? "Теория" : sessionTitle(session);
  meta.className = `session-meta ${session.status}`;
  const thread = session.threadId ? ` · ${session.threadId.slice(0, 8)}` : "";
  const learning = state.surface === "projects" && isLearningProject();
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(statusLabel(session.status) + (learning ? "" : thread))}</span>
  `;
  const materialMode = learning && session.purpose === "materials";
  $("#send").disabled = materialMode || session.status === "running" || session.status === "stopped";
  $("#prompt-form").hidden = materialMode;
  $("#prompt").placeholder = chatSession
    ? "Спросите Ronix или выберите Act для работы в проекте…"
    : learning
    ? session.purpose === "practice"
      ? "Отправьте код или вопрос по практике…"
      : session.purpose === "theory"
        ? "Какой пробел в теории разберём?"
      : "Спросите тему или продолжите курс…"
    : "Напишите задачу для Codex…";
  $("#interrupt").disabled = session.status !== "running";
  $("#interrupt").hidden = session.status !== "running";
  const sandbox = $("#sandbox-mode");
  sandbox.value = session.sandboxMode ?? "workspace-write";
  sandbox.disabled = session.status === "running";
  const accessMode = document.querySelector(".access-mode");
  accessMode.className =
    `setting-field access-mode mode-${session.sandboxMode ?? "workspace-write"}`;
  $("#session-settings").hidden = materialMode || chatSession;
  $("#toggle-settings").hidden = materialMode || chatSession;
  $("#toggle-git").hidden = chatSession;
  if (chatSession) {
    import("./chats.js").then(({ renderChatIntentControls, renderChatProjectEditor }) => {
      renderChatProjectEditor(session);
      renderChatIntentControls();
    });
  } else {
    $("#chat-composer-controls").hidden = true;
  }
  renderModelControls(session);
  renderGitPanel();
}

export function renderSessions() {
  const learning = state.surface === "projects" && isLearningProject();
  $("#session-search-wrap").hidden = learning || state.surface === "memory";
  $("#session-search-empty").hidden = true;
  getChat()?.classList.remove("learning-project");
  $("#sessions-label").textContent = state.surface === "chat" ? "Чаты" : learning ? "Учёба" : "Сессии";
  $("#session-count").textContent = learning ? "4" : String(state.sessions.length);
  $("#new-session").hidden = learning || state.surface !== "projects";
  if (learning) {
    $("#sessions").innerHTML = `
      ${renderLearningModeButton("course", "Курс", "Теория, объяснения и движение по ROADMAP")}
      ${renderLearningModeButton("theory", "Теория", "Разбор пробелов без написания кода")}
      ${renderLearningModeButton("practice", "Практика", "Сдача кода сообщением, ревью и дневник")}
      ${renderLearningModeButton("progress", "Успехи", "Дневник и дорожная карта только для чтения")}
    `;
    document.querySelectorAll("[data-learning-mode]").forEach((button) => {
      button.addEventListener("click", () => void selectLearningMode(button.dataset.learningMode));
    });
    return;
  }
  $("#sessions").innerHTML = state.sessions
    .map(
      (session) => `
        <div class="session-row ${session.id === state.sessionId ? "active" : ""}">
          <button class="session" data-id="${session.id}">
            <span class="session-status ${escapeHtml(session.status)}"></span>
            <span>
              <span class="session-title">${sessionTitle(session)}</span>
              <small>${statusLabel(session.status)} · ${relativeTime(session.lastActivityAt)}</small>
            </span>
          </button>
          <div class="session-options">
            <button
              class="session-options-button"
              data-options-id="${session.id}"
              title="Опции сессии"
              aria-label="Опции сессии"
              aria-expanded="false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5"></circle>
                <circle cx="12" cy="12" r="1.5"></circle>
                <circle cx="19" cy="12" r="1.5"></circle>
              </svg>
            </button>
            <div class="session-menu" data-menu-id="${session.id}" hidden>
              ${session.status === "stopped"
                ? `<button class="resume-session" data-resume-id="${session.id}">Возобновить</button>`
                : `<button class="stop-session" data-stop-id="${session.id}">Остановить</button>`}
              <button
                class="delete-session"
                data-delete-id="${session.id}"
                ${session.status === "running" ? "disabled" : ""}
              >Удалить сессию</button>
            </div>
          </div>
        </div>
      `,
    )
    .join("");
  filterSessions();
  document.querySelectorAll(".session").forEach((button) => {
    button.addEventListener("click", () => selectSession(button.dataset.id));
  });
  document.querySelectorAll(".session-options-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSessionMenu(button.dataset.optionsId);
    });
  });
  document.querySelectorAll(".delete-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(button.dataset.deleteId);
    });
  });
  document.querySelectorAll(".stop-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void changeSessionState(button.dataset.stopId, "stop");
    });
  });
  document.querySelectorAll(".resume-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void changeSessionState(button.dataset.resumeId, "resume");
    });
  });
}

function toggleSessionMenu(id) {
  const target = document.querySelector(`[data-menu-id="${id}"]`);
  const shouldOpen = target?.hidden ?? false;
  closeSessionMenus();
  if (!target || !shouldOpen) return;

  target.hidden = false;
  document.querySelector(`[data-options-id="${id}"]`)?.setAttribute("aria-expanded", "true");
}

export function closeSessionMenus() {
  document.querySelectorAll(".session-menu").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll(".session-options-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

export async function selectSession(id) {
  setSidebarOpen(false);
  setSettingsOpen(false);
  setGitOpen(false);
  closeSessionMenus();
  saveCurrentDraft();
  state.source?.close();
  clearTimeout(state.reconnectTimer);
  state.sessionId = id;
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.events = [];
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  const projectId = $("#project").value;
  if (state.surface === "projects" && projectId) rememberSession(projectId, id);
  if (state.surface === "chat") {
    state.navigation.chatId = id;
    storeJson("ronix-agent-navigation", state.navigation);
  }
  renderEvents();
  renderSessions();
  const { session, approvals = [], lastSequence = 0 } = await api(`/api/sessions/${id}`);
  const listedSession = state.sessions.find((item) => item.id === id);
  const normalizedSession = {
    ...(await normalizeSessionModel(session)),
    ...(listedSession?.projectIds ? { projectIds: listedSession.projectIds } : {}),
  };
  if (normalizedSession.purpose === "chat") {
    const archived = await api(`/api/sessions/${id}/messages?limit=500`);
    state.archivedMessages = archived.messages;
    state.lastSequence = lastSequence;
  } else {
    state.archivedMessages = [];
  }
  for (const approval of approvals) state.approvals[approval.id] = approval;
  renderEvents();
  state.selectedSession = normalizedSession;
  renderSessionMeta(normalizedSession);
  restoreDraft(id);
  connectEvents(id, normalizedSession.purpose !== "chat");
}

async function changeSessionState(id, action) {
  try {
    await api(`/api/sessions/${id}/${action}`, { method: "POST" });
    await loadSessions();
    if (state.sessionId === id) {
      const { session } = await api(`/api/sessions/${id}`);
      renderSessionMeta(session);
    }
  } catch (error) {
    alert(error.message);
  }
}

async function deleteSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (!confirm(`Удалить ${sessionTitle(session)}? История этой сессии исчезнет из Ronix.`)) {
    return;
  }

  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    delete state.drafts[id];
    persistDrafts();

    if (state.sessionId === id) {
      state.source?.close();
      state.sessionId = null;
      state.events = [];
      state.lastSequence = 0;
      state.firstSequence = 0;
      state.hasMoreEvents = false;
      state.approvals = {};
      state.liveTurnActive = false;
      state.liveResponse = null;
      state.archivedMessages = [];
      if (state.navigation.chatId === id) {
        state.navigation.chatId = null;
        storeJson("ronix-agent-navigation", state.navigation);
      }
      clearPrompt();
      $("#session-title").textContent = "Выберите сессию";
      renderSessionMeta(null);
      $("#send").disabled = true;
      $("#interrupt").disabled = true;
      $("#sandbox-mode").disabled = true;
      if (session.projectId) forgetSession(session.projectId);
    }

    if (state.surface === "chat") {
      const { loadChats } = await import("./chats.js");
      await loadChats();
    } else {
      await loadSessions();
    }
    renderEvents();
  } catch (error) {
    alert(error.message);
  }
}

export async function loadSessions() {
  if (state.surface === "chat") {
    const { loadChats } = await import("./chats.js");
    await loadChats();
    return;
  }
  if (state.surface === "memory") return;
  const projectId = $("#project").value;
  const project = state.projects.find((item) => item.id === projectId) ?? null;
  if (!projectId) {
    state.sessions = [];
    state.learning = null;
    resetGitStatus();
    renderSessions();
    renderSessionMeta(null);
    renderEvents();
    return;
  }
  if (project?.kind === "learning") {
    await loadLearning(projectId);
    state.sessions = [
      state.learning?.sessions?.course,
      state.learning?.sessions?.theory,
      state.learning?.sessions?.practice,
    ].filter(Boolean);
    renderSessions();
    if (state.gitProjectId !== projectId && !state.gitLoading) void refreshGitStatus(projectId);
    if (!["course", "theory", "practice", "progress"].includes(state.learningMode)) {
      state.learningMode = "course";
    }
    if (state.learningMode === "progress") {
      clearSelectedSessionForProgress();
      renderLearningProgressMode();
      return;
    }
    const purpose = state.learningMode === "theory" && state.theoryTab === "materials"
      ? "materials"
      : state.learningMode;
    const purposeSession = state.learning?.sessions?.[purpose];
    if (purposeSession) {
      if (state.sessionId === purposeSession.id) {
        state.selectedSession = purposeSession;
        renderSessionMeta(purposeSession);
      } else {
        await selectSession(purposeSession.id);
      }
    } else {
      renderSessionMeta(null);
      renderEvents();
    }
    if (purpose === "materials") await loadTheoryMaterials(projectId);
    return;
  }
  state.learning = null;
  const { sessions } = await api(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
  state.sessions = sessions;
  renderSessions();
  if (state.gitProjectId !== projectId && !state.gitLoading) void refreshGitStatus(projectId);
  if (!sessions.some((session) => session.id === state.sessionId)) {
    state.sessionId = null;
  }
  if (!state.sessionId) {
    const rememberedId = state.navigation.sessionsByProject?.[projectId];
    const preferred = sessions.find((session) => session.id === rememberedId) ?? sessions[0];
    if (preferred) {
      await selectSession(preferred.id);
    } else {
      forgetSession(projectId);
      renderSessionMeta(null);
      renderEvents();
    }
  }
}

export async function createSession() {
  const projectId = $("#project").value;
  if (!projectId) return;
  try {
    const { session } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, ...preferredModelSettings() }),
    });
    await loadSessions();
    if (state.sessionId !== session.id) await selectSession(session.id);
  } catch (error) {
    alert(error.message);
  }
}

export function filterSessions() {
  const query = $("#session-search").value.trim().toLocaleLowerCase("ru");
  const rows = [...document.querySelectorAll(".session-row")];
  let visible = 0;
  for (const row of rows) {
    row.hidden = !row.querySelector(".session").textContent.toLocaleLowerCase("ru").includes(query);
    if (!row.hidden) visible += 1;
  }
  $("#session-search-empty").hidden = !query || visible > 0 || state.surface === "memory" || isLearningProject();
}

export function bindSessions() {
  $("#session-search").addEventListener("input", filterSessions);
  document.addEventListener("click", closeSessionMenus);
  $("#new-session")?.addEventListener("click", () => void createSession());
  $("#interrupt")?.addEventListener("click", async () => {
    if (!state.sessionId) return;
    await api(`/api/sessions/${state.sessionId}/interrupt`, { method: "POST" });
  });
}
