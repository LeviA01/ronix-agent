import { state } from "../core/state.js";
import { isProjectSurface } from "../core/navigation.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { storeJson } from "../core/storage.js";
import { rememberSessionView, restoreSessionView, invalidateSessionView, sessionViewToken, forgetSessionView } from "../core/session-view.js";
import { escapeHtml, relativeTime, sessionTitle, statusLabel } from "../core/format.js";
import { getChat, setGitOpen, setSettingsOpen, setSidebarOpen } from "../layout/panels.js";
import { currentProjectId, isLearningProject } from "./context.js";
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
import { renderEvents, renderLiveResponse, updateLiveResponse } from "../events/render.js";
import { setHistoryScrollTop } from "../events/scroll.js";
import { renderChatActivity } from "../events/activity.js";

export function resetProjectSessionView() {
  rememberSessionView($("#events")?.scrollTop);
  invalidateSessionView();
  state.historyReady = false;
  state.historyError = null;
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.reconnectTimer = null;
  state.sessionRefreshTimer = null;
  state.liveRenderFrame = null;
  state.sessions = [];
  state.learning = null;
  state.theoryMaterials = null;
  state.theoryMaterialDetail = null;
  state.theoryMaterialAnswers = {};
  state.theoryMaterialResult = null;
  state.materialGeneration = null;
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
  renderChatActivity();
  renderTheoryTabs();
  renderTheorySuggestions();
  const meta = $("#session-meta");
  if (!session) {
    $("#chat-context-trigger").hidden = true;
    const project = isProjectSurface(state.surface)
      ? state.projects.find((item) => item.id === currentProjectId())
      : null;
    const hasSessions = state.sessions.length > 0;
    $("#session-title").textContent = !project ? "Начало работы"
      : state.surface === "learning" ? "Выберите режим"
      : hasSessions ? "Выберите сессию" : "Новая сессия";
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
  const learning = isProjectSurface(state.surface) && isLearningProject();
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(statusLabel(session.status) + (learning ? "" : thread))}</span>
  `;
  const materialMode = learning && session.purpose === "materials";
  $("#send").disabled = materialMode || session.status === "running" || session.status === "stopped";
  $("#prompt-form").hidden = materialMode;
  $("#prompt").placeholder = chatSession
    ? "Напишите вопрос или задачу…"
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
  const learning = isProjectSurface(state.surface) && isLearningProject();
  $("#session-search-wrap").hidden = state.surface === "learning" || state.surface === "memory";
  $("#session-search-empty").hidden = true;
  getChat()?.classList.remove("learning-project");
  $("#sessions-label").textContent = state.surface === "chat" ? "Чаты" : state.surface === "learning" ? "Учёба" : "Сессии";
  $("#session-count").textContent = learning ? "4" : String(state.sessions.length);
  $("#new-session").hidden = state.surface !== "development" || !currentProjectId();
  if (learning) {
    $("#sessions").innerHTML = `
      ${renderLearningModeButton("course", "Курс", "Теория, объяснения и движение по ROADMAP")}
      ${renderLearningModeButton("theory", "Теория", "Разбор пробелов без написания кода")}
      ${renderLearningModeButton("practice", "Практика", "Сдача кода сообщением, ревью и дневник")}
      ${renderLearningModeButton("progress", "Прогресс", "Дневник и дорожная карта только для чтения")}
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
  rememberSessionView($("#events")?.scrollTop);
  invalidateSessionView();
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.liveRenderFrame = null;
  state.sessionId = id;
  const isCurrent = sessionViewToken();
  state.historyReady = false;
  state.historyError = null;
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.events = [];
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  state.archivedMessages = [];
  const projectId = currentProjectId();
  if (isProjectSurface(state.surface) && projectId) rememberSession(projectId, id);
  if (state.surface === "chat") {
    state.navigation.chatId = id;
    storeJson("ronix-agent-navigation", state.navigation);
  }
  const cached = restoreSessionView(id);
  const listedSession = state.sessions.find((item) => item.id === id);
  renderSessionMeta(cached?.selectedSession ?? listedSession ?? null);
  if (!cached) $("#send").disabled = true;
  restoreDraft(id);
  renderEvents(!cached);
  if (cached) setHistoryScrollTop(cached.scrollTop);
  renderSessions();

  try {
    const chat = state.surface === "chat";
    const [detail, history] = await Promise.all([
      api(`/api/sessions/${id}`),
      cached ? null : api(chat
        ? `/api/sessions/${id}/messages?limit=500`
        : `/api/sessions/${id}/events/history?limit=200`),
    ]);
    if (!isCurrent()) return;
    const normalizedSession = {
      ...(await normalizeSessionModel(detail.session)),
      ...(listedSession?.projectIds ? { projectIds: listedSession.projectIds } : {}),
    };
    if (!isCurrent()) return;
    if (!cached) {
      if (chat) {
        state.archivedMessages = history.messages;
        state.lastSequence = history.lastSequence ?? detail.lastSequence ?? 0;
      } else {
        state.events = history.events;
        state.firstSequence = history.events[0]?.sequence ?? 0;
        state.lastSequence = history.events.at(-1)?.sequence ?? 0;
        state.hasMoreEvents = history.hasMore;
        for (const event of history.events) updateLiveResponse(event, false);
      }
    }
    state.approvals = Object.fromEntries((detail.approvals ?? []).map((approval) => [approval.id, approval]));
    if (normalizedSession.status !== "running") {
      state.liveTurnActive = false;
      state.liveResponse = null;
    }
    state.historyReady = true;
    renderSessionMeta(normalizedSession);
    if (!cached) renderEvents();
    else renderLiveResponse($("#events"), false);
    connectEvents(id);
  } catch (error) {
    if (!isCurrent()) return;
    state.historyError = error.message;
    if (cached) connectEvents(id);
    else renderEvents(false);
  }
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
    forgetSessionView(id);
    delete state.drafts[id];
    persistDrafts();

    if (state.sessionId === id) {
      state.source?.close();
      state.sessionId = null;
      invalidateSessionView();
      state.historyReady = false;
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
  const isCurrent = sessionViewToken();
  if (state.surface === "chat") {
    const { loadChats } = await import("./chats.js");
    await loadChats();
    return;
  }
  if (state.surface === "memory") return;
  const projectId = currentProjectId();
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
    if (!isCurrent() || !isProjectSurface(state.surface) || currentProjectId() !== projectId) return;
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
  if (!isCurrent() || !isProjectSurface(state.surface) || currentProjectId() !== projectId) return;
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
  const projectId = currentProjectId();
  if (state.surface !== "development" || !projectId) return;
  const isCurrent = sessionViewToken();
  try {
    const { session } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, ...preferredModelSettings() }),
    });
    if (!isCurrent()) return;
    await loadSessions();
    if (state.surface === "development" && currentProjectId() === projectId
      && state.sessionId !== session.id) await selectSession(session.id);
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
