function loadDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem("ronix-agent-drafts") ?? "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const state = {
  projects: [],
  projectRoots: [],
  pendingProject: null,
  sessions: [],
  sessionId: null,
  source: null,
  reconnectTimer: null,
  lastSequence: 0,
  firstSequence: 0,
  hasMoreEvents: false,
  events: [],
  approvals: {},
  sessionRefreshTimer: null,
  liveTurnActive: false,
  liveResponse: null,
  liveRenderFrame: null,
  selectedSession: null,
  showTechnical: localStorage.getItem("ronix-agent-technical") === "true",
  drafts: loadDrafts(),
};

const $ = (selector) => document.querySelector(selector);
const appShell = $(".app-shell");

function setSidebarOpen(open) {
  appShell.classList.toggle("sidebar-open", open);
  $("#open-sidebar").setAttribute("aria-expanded", String(open));
  if (open) $("#project").focus({ preventScroll: true });
}

$("#open-sidebar").addEventListener("click", () => setSidebarOpen(true));
$("#close-sidebar").addEventListener("click", () => setSidebarOpen(false));
$("#sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSidebarOpen(false);
    closeLimits();
    closeCreateProject();
  }
});
window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
  if (event.matches) setSidebarOpen(false);
});

const limitsModal = $("#limits-modal");

function closeLimits() {
  limitsModal.hidden = true;
}

function windowLabel(minutes) {
  if (minutes === 300) return "5 часов";
  if (minutes === 10080) return "7 дней";
  if (!minutes) return "Период";
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

function resetLabel(timestamp) {
  if (!timestamp) return "Время сброса неизвестно";
  return "Сброс " + new Date(timestamp * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokens(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function renderLimitWindow(window) {
  if (!window) return "";
  const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  const remaining = 100 - used;
  const severity = used >= 90 ? "danger" : used >= 70 ? "warning" : "";
  return `
    <div class="limit-window">
      <div class="limit-numbers">
        <span>${windowLabel(window.windowDurationMins)}</span>
        <strong>${remaining}% осталось</strong>
      </div>
      <div class="limit-track"><div class="limit-fill ${severity}" style="width: ${used}%"></div></div>
      <div class="limit-reset">${escapeHtml(resetLabel(window.resetsAt))}</div>
    </div>
  `;
}

function renderLimits(data) {
  const account = data.account;
  $("#limits-account").textContent = account?.type === "chatgpt"
    ? `${account.email ?? "ChatGPT"} · ${account.planType ?? "план неизвестен"}`
    : account?.type === "apiKey" ? "OpenAI API key" : "Аккаунт Codex";

  const snapshots = data.rateLimitsByLimitId
    ? Object.values(data.rateLimitsByLimitId)
    : [data.rateLimits];
  const cards = snapshots.map((snapshot) => `
    <article class="limit-card">
      <div class="limit-card-head">
        <strong>${escapeHtml(snapshot.limitName || snapshot.limitId || "Codex")}</strong>
        <span>${escapeHtml(snapshot.planType || "")}</span>
      </div>
      ${renderLimitWindow(snapshot.primary)}
      ${renderLimitWindow(snapshot.secondary)}
    </article>
  `).join("");

  const summary = data.usage?.summary ?? {};
  const resetCredits = data.rateLimitResetCredits?.availableCount;
  $("#limits-content").innerHTML = `
    ${cards || '<div class="limits-loading">Лимиты не найдены</div>'}
    <div class="usage-summary">
      <div class="usage-stat"><span>Всего токенов</span><strong>${formatTokens(summary.lifetimeTokens)}</strong></div>
      <div class="usage-stat"><span>Пиковый день</span><strong>${formatTokens(summary.peakDailyTokens)}</strong></div>
      <div class="usage-stat"><span>Серия дней</span><strong>${summary.currentStreakDays ?? "—"}</strong></div>
    </div>
    ${resetCredits != null ? `<div class="limit-reset">Доступно сбросов лимита: ${resetCredits}</div>` : ""}
  `;

  const primary = snapshots[0]?.primary;
  $("#limits-summary").textContent = primary ? `${Math.max(0, 100 - Math.round(primary.usedPercent))}%` : "Открыть";
}

async function loadLimits(force = false) {
  $("#refresh-limits").disabled = true;
  $("#limits-content").innerHTML = '<div class="limits-loading">Получаем данные из Codex…</div>';
  try {
    renderLimits(await api(`/api/codex/usage${force ? "?refresh=1" : ""}`));
  } catch (error) {
    $("#limits-content").innerHTML = `<div class="limits-error">${escapeHtml(error.message)}</div>`;
  } finally {
    $("#refresh-limits").disabled = false;
  }
}

$("#show-limits").addEventListener("click", () => {
  setSidebarOpen(false);
  limitsModal.hidden = false;
  void loadLimits();
});
document.querySelectorAll("[data-close-limits]").forEach((button) => {
  button.addEventListener("click", closeLimits);
});
$("#refresh-limits").addEventListener("click", () => void loadLimits(true));

$("#show-technical").checked = state.showTechnical;
$("#show-technical").addEventListener("change", (event) => {
  state.showTechnical = event.target.checked;
  localStorage.setItem("ronix-agent-technical", String(state.showTechnical));
  renderEvents();
});

function headers(json = false) {
  const result = {};
  if (json) result["content-type"] = "application/json";
  return result;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...options.headers },
  });
  const body = response.status === 204 ? null : await response.json();
  if (response.status === 401) {
    location.replace("/login");
    throw new Error("Требуется вход");
  }
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`);
    if (body && typeof body === "object") Object.assign(error, body);
    throw error;
  }
  return body;
}

function setConnection(text) {
  const indicator = $("#connection");
  indicator.className = `connection-dot ${text}`;
  indicator.title = {
    connected: "Подключено",
    ready: "Готово",
    reconnecting: "Переподключение…",
    error: "Ошибка подключения",
  }[text] ?? text;
}

async function loadProjects() {
  const { projects, projectRoots = [] } = await api("/api/projects");
  state.projects = projects;
  state.projectRoots = projectRoots;
  $("#project-root-hint").textContent = projectRoots[0]
    ? `Будет найдено или создано в ${projectRoots[0]}`
    : "Корневая папка проектов не настроена";
  $("#project").innerHTML = projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join("");
  await loadSessions();
}

async function loadSessions() {
  const projectId = $("#project").value;
  if (!projectId) {
    state.sessions = [];
    renderSessions();
    return;
  }
  const { sessions } = await api(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
  state.sessions = sessions;
  renderSessions();
  if (!state.sessionId && sessions[0]) {
    await selectSession(sessions[0].id);
  }
}

function renderSessions() {
  $("#session-count").textContent = String(state.sessions.length);
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

function closeSessionMenus() {
  document.querySelectorAll(".session-menu").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll(".session-options-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", closeSessionMenus);

async function selectSession(id) {
  setSidebarOpen(false);
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
  renderEvents();
  renderSessions();
  const { session, approvals = [] } = await api(`/api/sessions/${id}`);
  for (const approval of approvals) state.approvals[approval.id] = approval;
  renderEvents();
  state.selectedSession = session;
  renderSessionMeta(session);
  restoreDraft(id);
  connectEvents(id, true);
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
      promptInput.value = "";
      resizePrompt();
      $("#session-title").textContent = "Выберите сессию";
      renderSessionMeta(null);
      $("#send").disabled = true;
      $("#interrupt").disabled = true;
      $("#sandbox-mode").disabled = true;
    }

    await loadSessions();
    renderEvents();
  } catch (error) {
    alert(error.message);
  }
}

function renderSessionMeta(session) {
  state.selectedSession = session;
  const meta = $("#session-meta");
  if (!session) {
    $("#session-title").textContent = "Выберите сессию";
    meta.className = "session-meta";
    meta.innerHTML = '<span class="session-meta-dot"></span><span>Создайте сессию, чтобы начать работу</span>';
    document.querySelector(".access-mode").hidden = true;
    $("#interrupt").hidden = true;
    return;
  }
  $("#session-title").textContent = sessionTitle(session);
  meta.className = `session-meta ${session.status}`;
  const thread = session.threadId ? ` · ${session.threadId.slice(0, 8)}` : "";
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(statusLabel(session.status) + thread)}</span>
  `;
  $("#send").disabled = session.status === "running" || session.status === "stopped";
  $("#interrupt").disabled = session.status !== "running";
  $("#interrupt").hidden = session.status !== "running";
  const sandbox = $("#sandbox-mode");
  sandbox.value = session.sandboxMode ?? "workspace-write";
  sandbox.disabled = session.status === "running";
  const accessMode = document.querySelector(".access-mode");
  accessMode.hidden = false;
  accessMode.className = `access-mode mode-${session.sandboxMode ?? "workspace-write"}`;
}

function connectEvents(sessionId = state.sessionId, initial = false) {
  if (!sessionId || sessionId !== state.sessionId) return;
  clearTimeout(state.reconnectTimer);
  const controller = new AbortController();
  state.source = { close: () => controller.abort() };
  const query = initial && state.lastSequence === 0
    ? "tail=200"
    : `after=${state.lastSequence}`;
  void streamEvents(
    `/api/sessions/${sessionId}/events?${query}`,
    controller.signal,
    sessionId,
    initial,
  );
}

async function streamEvents(path, signal, sessionId, initial) {
  try {
    const response = await fetch(path, { headers: headers(), signal });
    if (response.status === 401) {
      location.replace("/login");
      return;
    }
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    setConnection("connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data && sessionId === state.sessionId) handleEvent(JSON.parse(data), initial);
      }
    }
    if (!signal.aborted && sessionId === state.sessionId) scheduleReconnect(sessionId);
  } catch (error) {
    if (error.name !== "AbortError" && sessionId === state.sessionId) {
      setConnection("reconnecting");
      scheduleReconnect(sessionId);
    }
  }
}

function scheduleReconnect(sessionId) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => connectEvents(sessionId), 1500);
}

function handleEvent(event, initial = false) {
  if (event.sequence <= state.lastSequence) return;
  state.lastSequence = event.sequence;
  if (!state.firstSequence) state.firstSequence = event.sequence;
  state.events.push(event);
  updateApprovalState(event);
  updateLiveResponse(event);
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    renderEvents();
  } else if (isLiveEvent(event)) {
    scheduleLiveRender();
  } else {
    appendVisibleEvent(event);
  }
  if (isSessionStateEvent(event)) scheduleSessionRefresh();
  if (initial && state.events.length === 200) {
    state.hasMoreEvents = true;
    renderEvents();
  }
}

function renderEvents(scrollToBottom = true) {
  const container = $("#events");
  container.innerHTML = "";
  const events = state.showTechnical ? state.events : visibleEvents(state.events);
  const hasApprovals = Object.keys(state.approvals).length > 0;
  if (events.length === 0 && !hasApprovals) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">›_</div>
        <h3>${state.sessionId ? "Начните диалог" : "Codex готов к работе"}</h3>
        <p>${state.sessionId ? "Опишите задачу в поле ниже." : "Выберите или создайте сессию проекта."}</p>
      </div>
    `;
    return;
  }
  renderHistoryButton(container);
  renderPendingApprovals(container);
  for (const event of events) appendEvent(event, container);
  renderLiveResponse(container);
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function appendVisibleEvent(event) {
  const container = $("#events");
  container.querySelector(".empty-state")?.remove();
  const visible = state.showTechnical || visibleEvents([event]).length > 0;
  const shouldScroll = isNearBottom(container);
  if (event.type === "codex.item.completed") {
    container.querySelector(".live-response")?.remove();
  }
  if (visible) appendEvent(event, container);
  if (event.type === "codex.item.completed") {
    renderLiveResponse(container);
  }
  if (shouldScroll) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function renderHistoryButton(container) {
  if (!state.hasMoreEvents || !state.firstSequence) return;
  const button = document.createElement("button");
  button.id = "load-older";
  button.className = "load-older";
  button.type = "button";
  button.textContent = "Загрузить предыдущие сообщения";
  container.append(button);
}

function renderPendingApprovals(container) {
  for (const approval of Object.values(state.approvals)) {
    const event = {
      type: "approval.requested",
      payload: { approvalId: approval.id, method: approval.method, ...approval.payload },
    };
    appendEvent(event, container);
  }
}

function updateLiveResponse(event) {
  if (event.type === "codex.turn.started") {
    state.liveTurnActive = true;
    state.liveResponse = { mode: "thinking", itemId: null, text: "", detail: "Анализирует задачу" };
    setLocalSessionStatus("running");
    return;
  }
  if (event.type === "codex.item.agentMessage.delta") {
    const itemId = event.payload?.itemId ?? null;
    if (!state.liveResponse || state.liveResponse.itemId !== itemId) {
      state.liveResponse = { mode: "writing", itemId, text: "", detail: "Пишет ответ" };
    }
    state.liveResponse.mode = "writing";
    state.liveResponse.detail = "Пишет ответ";
    state.liveResponse.text += event.payload?.delta ?? "";
    return;
  }
  if (event.type === "codex.item.started") {
    const item = event.payload?.item;
    if (isAgentMessage(item)) {
      state.liveResponse = {
        mode: "writing",
        itemId: item.id ?? null,
        text: item.text ?? "",
        detail: "Пишет ответ",
      };
    } else if (isCommandItem(item)) {
      state.liveResponse = {
        mode: "working",
        itemId: item.id ?? null,
        text: "",
        detail: "Выполняет команду",
      };
    } else if (isFileChangeItem(item)) {
      state.liveResponse = {
        mode: "working",
        itemId: item.id ?? null,
        text: "",
        detail: "Применяет изменения",
      };
    }
    return;
  }
  if (event.type === "codex.item.completed") {
    const item = event.payload?.item;
    const matchesLiveItem = !state.liveResponse || state.liveResponse.itemId === item?.id;
    state.liveResponse = state.liveTurnActive && isToolItem(item)
      ? { mode: "thinking", itemId: null, text: "", detail: "Анализирует результат" }
      : matchesLiveItem || isAgentMessage(item) ? null : state.liveResponse;
    return;
  }
  if (
    event.type === "codex.turn.completed"
    || event.type === "turn.interrupted"
    || event.type === "session.error"
  ) {
    state.liveTurnActive = false;
    state.liveResponse = null;
    setLocalSessionStatus(event.type === "session.error" ? "error" : "ready");
  }
}

function renderLiveResponse(container = $("#events")) {
  const existing = container.querySelector(".live-response");
  if (!state.liveResponse) {
    existing?.remove();
    container.setAttribute("aria-busy", "false");
    return;
  }

  container.setAttribute("aria-busy", "true");
  const shouldScroll = isNearBottom(container);
  const element = existing ?? document.createElement("article");
  element.className = `message agent live-response ${state.liveResponse.mode}`;
  element.innerHTML = `
    <div class="avatar live-avatar">
      <span class="avatar-pulse"></span>
      <span class="avatar-text">CX</span>
    </div>
    <div class="message-content">
      <div class="message-label live-label">
        <span>Codex</span>
        <span class="live-state">${escapeHtml(state.liveResponse.detail)}</span>
      </div>
      <div class="bubble live-bubble">
        ${state.liveResponse.text
          ? renderAgentMessage(state.liveResponse.text)
          : '<span class="typing-dots"><i></i><i></i><i></i></span>'}
        <span class="stream-caret" aria-hidden="true"></span>
      </div>
    </div>
  `;
  if (!existing) container.append(element);
  if (shouldScroll) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function scheduleLiveRender() {
  if (state.liveRenderFrame) return;
  state.liveRenderFrame = requestAnimationFrame(() => {
    state.liveRenderFrame = null;
    renderLiveResponse();
  });
}

function isLiveEvent(event) {
  return [
    "codex.turn.started",
    "codex.item.started",
    "codex.item.agentMessage.delta",
    "codex.turn.completed",
    "turn.interrupted",
    "session.error",
  ].includes(event.type);
}

function isAgentMessage(item) {
  return item?.type === "agentMessage" || item?.type === "agent_message";
}

function isToolItem(item) {
  return isCommandItem(item) || isFileChangeItem(item);
}

function isCommandItem(item) {
  return [
    "commandExecution",
    "command_execution",
  ].includes(item?.type);
}

function isFileChangeItem(item) {
  return [
    "fileChange",
    "file_change",
  ].includes(item?.type);
}

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

function setLocalSessionStatus(status) {
  if (!state.selectedSession) return;
  state.selectedSession = { ...state.selectedSession, status };
  renderSessionMeta(state.selectedSession);
}

function visibleEvents(events) {
  return events.filter((event) => {
    if (event.type === "user.message") return true;
    if (event.type === "turn.error" || event.type === "session.error") return true;
    if (event.type === "turn.interrupted") return true;
    if (event.type !== "codex.item.completed") return false;

    const itemType = event.payload?.item?.type;
    return [
      "agent_message", "command_execution", "file_change", "error",
      "agentMessage", "commandExecution", "fileChange",
    ].includes(itemType);
  });
}

function appendEvent(event, container) {
  const view = state.showTechnical ? formatTechnicalEvent(event) : formatVisibleEvent(event);
  if (!view) return;

  if (view.kind === "message") {
    const element = document.createElement("article");
    element.className = `message ${view.className}`;
    const body =
      view.className === "agent"
        ? renderAgentMessage(view.body)
        : escapeHtml(view.body);
    element.innerHTML = `
      ${view.className === "agent" ? '<div class="avatar">CX</div>' : ""}
      <div class="message-content">
        <div class="message-label">${escapeHtml(view.label)}</div>
        <div class="bubble">${body}</div>
      </div>
    `;
    container.append(element);
    return;
  }

  if (view.kind === "technical") {
    const element = document.createElement("div");
    element.className = "technical-event";
    element.innerHTML = `<strong>${escapeHtml(view.label)}</strong>${escapeHtml(view.body)}`;
    container.append(element);
    return;
  }

  if (view.kind === "approval") {
    const element = document.createElement("article");
    element.className = "approval-card";
    element.dataset.approvalId = view.approvalId;
    element.innerHTML = `
      <strong>${escapeHtml(view.label)}</strong>
      ${view.body ? `<pre>${escapeHtml(view.body)}</pre>` : ""}
      <div class="approval-actions">
        <button type="button" data-approval-decision="decline">Отклонить</button>
        <button type="button" data-approval-decision="acceptForSession">Для сессии</button>
        <button type="button" data-approval-decision="accept">Разрешить</button>
      </div>
    `;
    container.append(element);
    return;
  }

  const element = document.createElement(view.collapsible ? "details" : "div");
  element.className = `activity ${view.className}`;
  element.innerHTML = view.collapsible
    ? `
        <summary class="activity-head">${escapeHtml(view.summary)}</summary>
        ${view.body ? `<pre class="activity-body">${escapeHtml(view.body)}</pre>` : ""}
      `
    : `
        <div class="activity-head">${escapeHtml(view.label)}</div>
        ${view.body ? `<pre class="activity-body">${escapeHtml(view.body)}</pre>` : ""}
      `;
  container.append(element);
}

function formatTechnicalEvent(event) {
  return {
    kind: "technical",
    label: event.type,
    body: JSON.stringify(event.payload, null, 2),
  };
}

function formatVisibleEvent(event) {
  const { type, payload } = event;
  if (type === "user.message") {
    return { kind: "message", label: "Вы", body: payload.text, className: "user" };
  }
  if (type === "turn.error" || type === "session.error") {
    return {
      kind: "activity",
      label: "Ошибка",
      body: cleanError(payload.message),
      className: "error",
    };
  }
  if (type === "turn.interrupted") {
    return {
      kind: "activity",
      label: "Выполнение прервано",
      body: "",
      className: "",
    };
  }
  if (type === "approval.requested") {
    const approvalId = payload.approvalId;
    const command = payload.command;
    const reason = payload.reason;
    return {
      kind: "approval",
      approvalId,
      label: payload.method?.includes("fileChange")
        ? "Codex запрашивает изменение файлов"
        : "Codex запрашивает выполнение команды",
      body: [command, reason].filter(Boolean).join("\n"),
      className: "approval",
    };
  }

  const item = payload?.item;
  if (item?.type === "agent_message" || item?.type === "agentMessage") {
    return { kind: "message", label: "Codex", body: item.text, className: "agent" };
  }
  if (item?.type === "command_execution" || item?.type === "commandExecution") {
    return {
      kind: "activity",
      label: item.status === "failed" ? "Команда завершилась с ошибкой" : "Команда",
      summary: `$ ${item.command}`,
      body: (item.aggregated_output ?? item.aggregatedOutput)?.trim() ?? "",
      className: item.status === "failed" ? "error" : "",
      collapsible: true,
    };
  }
  if (item?.type === "file_change" || item?.type === "fileChange") {
    return {
      kind: "activity",
      label: "Изменения файлов",
      body: item.changes.map((change) => `${changeLabel(change.kind)} ${change.path}`).join("\n"),
      className: "files",
    };
  }
  if (item?.type === "error") {
    return {
      kind: "activity",
      label: "Ошибка",
      body: cleanError(item.message),
      className: "error",
    };
  }
  return null;
}

function changeLabel(kind) {
  return { add: "+", update: "±", delete: "−" }[kind] ?? "•";
}

function cleanError(message) {
  if (!message) return "Неизвестная ошибка";
  try {
    const parsed = JSON.parse(message);
    return parsed.detail ?? parsed.message ?? message;
  } catch {
    return String(message)
      .replace(/^Codex Exec exited[^:]*:\s*/i, "")
      .replace(/^Reading prompt from stdin\.\.\.\s*/i, "")
      .trim();
  }
}

function renderAgentMessage(text) {
  const source = String(text);
  const blocks = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push(renderMarkdownText(source.slice(cursor, match.index)));
    }
    const language = match[1].trim() || "code";
    const code = match[2].replace(/\n$/, "");
    blocks.push(`
      <div class="code-block">
        <div class="code-head">
          <span>${escapeHtml(language)}</span>
          <button type="button" class="copy-code">Копировать</button>
        </div>
        <pre><code>${highlightCode(code, language)}</code></pre>
      </div>
    `);
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    blocks.push(renderMarkdownText(source.slice(cursor)));
  }

  return blocks.join("");
}

function renderMarkdownText(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function highlightCode(code, language) {
  let html = escapeHtml(code);
  const normalized = language.toLowerCase();

  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(normalized)) {
    html = html
      .replace(
        /\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|try|catch|throw|type|interface|extends|implements)\b/g,
        '<span class="syntax-keyword">$1</span>',
      )
      .replace(/\b(true|false|null|undefined)\b/g, '<span class="syntax-value">$1</span>')
      .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="syntax-string">$1</span>');
  } else if (["json", "jsonc"].includes(normalized)) {
    html = html
      .replace(/(&quot;.*?&quot;)(\s*:)/g, '<span class="syntax-key">$1</span>$2')
      .replace(/\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, '<span class="syntax-value">$1</span>');
  } else if (["sh", "bash", "shell", "zsh"].includes(normalized)) {
    html = html
      .replace(/^(\s*)(\$|#)(.*)$/gm, '$1<span class="syntax-prompt">$2</span>$3')
      .replace(/\b(cd|npm|pnpm|yarn|git|node|npx|docker|curl|export|sudo)\b/g, '<span class="syntax-keyword">$1</span>');
  }

  return html;
}

$("#events").addEventListener("click", async (event) => {
  const historyButton = event.target.closest("#load-older");
  if (historyButton) {
    await loadOlderEvents(historyButton);
    return;
  }

  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    const card = approvalButton.closest("[data-approval-id]");
    if (!card || !state.sessionId) return;
    approvalButton.disabled = true;
    try {
      await api(`/api/sessions/${state.sessionId}/approvals/${card.dataset.approvalId}`, {
        method: "POST",
        body: JSON.stringify({ decision: approvalButton.dataset.approvalDecision }),
      });
    } catch (error) {
      approvalButton.disabled = false;
      alert(error.message);
    }
    return;
  }

  const button = event.target.closest(".copy-code");
  if (!button) return;
  const code = button.closest(".code-block")?.querySelector("code")?.textContent;
  if (!code) return;

  await navigator.clipboard.writeText(code);
  button.textContent = "Скопировано";
  setTimeout(() => {
    button.textContent = "Копировать";
  }, 1200);
});

async function loadOlderEvents(button) {
  if (!state.sessionId || !state.firstSequence) return;
  button.disabled = true;
  try {
    const container = $("#events");
    const previousHeight = container.scrollHeight;
    const { events, hasMore } = await api(
      `/api/sessions/${state.sessionId}/events/history`
      + `?before=${state.firstSequence}&limit=200`,
    );
    if (events.length) {
      state.events = [...events, ...state.events];
      state.firstSequence = events[0].sequence;
    }
    state.hasMoreEvents = hasMore;
    renderEvents(false);
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight - previousHeight;
    });
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
}

async function refreshSelectedSession() {
  if (!state.sessionId) return;
  const { session } = await api(`/api/sessions/${state.sessionId}`);
  renderSessionMeta(session);
  await loadSessions();
}

function scheduleSessionRefresh() {
  clearTimeout(state.sessionRefreshTimer);
  state.sessionRefreshTimer = setTimeout(() => void refreshSelectedSession(), 150);
}

function isSessionStateEvent(event) {
  return [
    "session.ready",
    "session.error",
    "session.stopped",
    "session.resumed",
    "session.settings",
    "turn.interrupted",
    "codex.turn.started",
    "codex.turn.completed",
  ].includes(event.type);
}

function updateApprovalState(event) {
  if (event.type === "approval.requested") {
    const id = String(event.payload.approvalId);
    state.approvals[id] = {
      id,
      method: event.payload.method,
      payload: event.payload,
    };
  }
  if (event.type === "approval.resolved") {
    delete state.approvals[String(event.payload.approvalId)];
  }
}

$("#project").addEventListener("change", async () => {
  saveCurrentDraft();
  state.source?.close();
  state.sessionId = null;
  state.events = [];
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  promptInput.value = "";
  resizePrompt();
  await loadSessions();
  renderEvents();
});

$("#sandbox-mode").addEventListener("change", async (event) => {
  if (!state.sessionId) return;
  const select = event.target;
  if (
    select.value === "danger-full-access"
    && !confirm("Полный доступ снимает ограничения файловой системы и отключает approvals. Продолжить?")
  ) {
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    renderSessionMeta(session);
    return;
  }
  select.disabled = true;
  try {
    const { session } = await api(`/api/sessions/${state.sessionId}/settings`, {
      method: "POST",
      body: JSON.stringify({ sandboxMode: select.value }),
    });
    renderSessionMeta(session);
    await loadSessions();
  } catch (error) {
    alert(error.message);
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    renderSessionMeta(session);
  }
});

const createProjectModal = $("#create-project-modal");

function closeCreateProject() {
  createProjectModal.hidden = true;
  state.pendingProject = null;
}

async function addProject(folder, create = false) {
  const { project } = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: folder, create }),
  });
  $("#project-form").reset();
  await loadProjects();
  $("#project").value = project.id;
  await loadSessions();
  closeCreateProject();
}

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const folder = $("#project-folder").value.trim();
  if (!folder) return;
  try {
    await addProject(folder);
  } catch (error) {
    if (error.code === "PROJECT_NOT_FOUND") {
      state.pendingProject = folder;
      $("#create-project-path").textContent = error.path;
      createProjectModal.hidden = false;
      return;
    }
    alert(error.message);
  }
});

document.querySelectorAll("[data-cancel-project]").forEach((button) => {
  button.addEventListener("click", closeCreateProject);
});

$("#confirm-create-project").addEventListener("click", async () => {
  if (!state.pendingProject) return;
  const button = $("#confirm-create-project");
  button.disabled = true;
  try {
    await addProject(state.pendingProject, true);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#new-session").addEventListener("click", async () => {
  const projectId = $("#project").value;
  if (!projectId) return;
  try {
    const { session } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
    await loadSessions();
    await selectSession(session.id);
  } catch (error) {
    alert(error.message);
  }
});

$("#prompt-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.sessionId) return;
  const prompt = $("#prompt").value.trim();
  if (!prompt) return;
  try {
    $("#send").disabled = true;
    await api(`/api/sessions/${state.sessionId}/turns`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    $("#prompt").value = "";
    delete state.drafts[state.sessionId];
    persistDrafts();
    resizePrompt();
  } catch (error) {
    alert(error.message);
    $("#send").disabled = false;
  }
});

const promptInput = $("#prompt");
promptInput.addEventListener("input", () => {
  resizePrompt();
  saveCurrentDraft();
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!$("#send").disabled) $("#prompt-form").requestSubmit();
  }
});

function resizePrompt() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
}

function saveCurrentDraft() {
  if (!state.sessionId) return;
  const value = promptInput.value;
  if (value) state.drafts[state.sessionId] = value;
  else delete state.drafts[state.sessionId];
  persistDrafts();
}

function restoreDraft(sessionId) {
  promptInput.value = state.drafts[sessionId] ?? "";
  resizePrompt();
}

function persistDrafts() {
  localStorage.setItem("ronix-agent-drafts", JSON.stringify(state.drafts));
}

fetch("/api/auth/status")
  .then((response) => response.ok ? response.json() : null)
  .then((status) => {
    if (status?.enabled) $("#logout").hidden = false;
  })
  .catch(() => {});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    location.replace("/login");
  }
});

$("#interrupt").addEventListener("click", async () => {
  if (!state.sessionId) return;
  await api(`/api/sessions/${state.sessionId}/interrupt`, { method: "POST" });
});

function sessionTitle(session) {
  return `Сессия ${session.id.slice(0, 8)}`;
}

function statusLabel(status) {
  return {
    ready: "Готова",
    running: "Codex работает",
    stopped: "Остановлена",
    error: "Ошибка",
  }[status] ?? status;
}

function relativeTime(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "сейчас";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return new Date(date).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

loadProjects()
  .then(() => setConnection("ready"))
  .catch((error) => {
    setConnection("error");
    alert(error.message);
  });
