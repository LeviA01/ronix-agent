import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { $ } from "../core/dom.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
import { sessionViewToken } from "../core/session-view.js";
import { isLearningProject } from "../features/context.js";
import { setPromptValue } from "../features/composer.js";
import { setSidebarOpen } from "../layout/panels.js";
import {
  bindTheoryMaterialsView,
  loadLearning,
  renderLearningDashboard,
  renderTheoryMaterialsView,
} from "../features/learning.js";
import {
  formatTechnicalEvent,
  formatVisibleEvent,
  renderUserInputQuestion,
} from "./format-event.js";
import { renderAgentMessage } from "./markdown.js";
import { renderMcpForm } from "./mcp-form.js";
import {
  isAgentMessage,
  isCommandItem,
  isFileChangeItem,
  isNearBottom,
  isToolItem,
  visibleEvents,
} from "./classify.js";

export function setLocalSessionStatus(status) {
  if (!state.selectedSession) return;
  state.selectedSession = { ...state.selectedSession, status };
  const isCurrent = sessionViewToken();
  import("../features/sessions.js").then(({ renderSessionMeta }) => {
    if (isCurrent()) renderSessionMeta(state.selectedSession);
  });
}

export function updateLiveResponse(event, updateStatus = true) {
  if (event.type === "codex.turn.started") {
    state.liveTurnActive = true;
    state.liveResponse = { mode: "thinking", itemId: null, text: "", detail: "Анализирует задачу" };
    if (updateStatus) setLocalSessionStatus("running");
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
    if (updateStatus) setLocalSessionStatus(event.type === "session.error" ? "error" : "ready");
  }
}

export function renderLiveResponse(container = $("#events"), allowScroll = true) {
  if (!container) return;
  const existing = container.querySelector(".live-response");
  if (isLearningProject() && state.learningMode === "theory" && state.theoryTab === "materials") {
    existing?.remove();
    container.setAttribute("aria-busy", "false");
    return;
  }
  if (!state.liveResponse) {
    existing?.remove();
    container.setAttribute("aria-busy", "false");
    return;
  }

  container.setAttribute("aria-busy", "true");
  const shouldScroll = allowScroll && isNearBottom(container);
  const isCurrent = sessionViewToken();
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
      if (isCurrent()) container.scrollTop = container.scrollHeight;
    });
  }
}

export function scheduleLiveRender() {
  if (state.liveRenderFrame) return;
  state.liveRenderFrame = requestAnimationFrame(() => {
    state.liveRenderFrame = null;
    renderLiveResponse();
  });
}

export function appendEvent(event, container) {
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

  if (view.kind === "mcpInput") {
    const element = document.createElement("article");
    element.className = "approval-card user-input-card";
    element.dataset.approvalId = view.approvalId;
    const fields = renderMcpForm(view.payload);
    element.innerHTML = `<strong>${escapeHtml(view.label)}</strong>
      <p>${escapeHtml(view.body)}</p>
      <form class="user-input-form" data-mcp-form>
        ${fields ?? "<p>Эта форма пока не поддерживается в Ronix. Отмените запрос и уточните действие в чате.</p>"}
        <div class="approval-actions">
          <button type="button" data-approval-decision="decline">Отклонить</button>
          <button type="button" data-approval-decision="cancel">Отмена</button>
          ${fields !== null ? '<button type="submit" data-user-input-submit>Подтвердить</button>' : ""}
        </div>
      </form>`;
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

  if (view.kind === "userInput") {
    const element = document.createElement("article");
    element.className = "approval-card user-input-card";
    element.dataset.approvalId = view.approvalId;
    element.innerHTML = `
      <strong>${escapeHtml(view.label)}</strong>
      ${view.body ? `<pre>${escapeHtml(view.body)}</pre>` : ""}
      <form class="user-input-form">
        ${view.questions.map(renderUserInputQuestion).join("")}
        <div class="approval-actions">
          <button type="button" data-approval-decision="cancel">Отмена</button>
          <button type="submit" data-user-input-submit>Отправить</button>
        </div>
      </form>
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

export function appendVisibleEvent(event) {
  const container = $("#events");
  const isCurrent = sessionViewToken();
  if (isLearningProject() && state.learningMode === "theory" && state.theoryTab === "materials") {
    renderEvents(false);
    return;
  }
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
      if (isCurrent()) container.scrollTop = container.scrollHeight;
    });
  }
}

export function renderEvents(scrollToBottom = true) {
  const container = $("#events");
  if (!container) return;
  const isCurrent = sessionViewToken();
  container.innerHTML = "";
  if (isLearningProject() && state.learningMode === "progress") {
    container.innerHTML = renderLearningDashboard();
    container.querySelector("[data-refresh-learning]")?.addEventListener("click", async () => {
      await loadLearning();
      const { renderLearningProgressMode } = await import("../features/learning.js");
      renderLearningProgressMode();
    });
    container.querySelectorAll("[data-progress-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.progressTab = button.dataset.progressTab;
        storeString("ronix-agent-progress-tab", state.progressTab);
        renderEvents(false);
      });
    });
    return;
  }
  if (isLearningProject() && state.learningMode === "theory" && state.theoryTab === "materials") {
    container.innerHTML = renderTheoryMaterialsView();
    bindTheoryMaterialsView(container);
    const approvalsHost = container.querySelector("[data-materials-approvals]");
    if (approvalsHost) renderPendingApprovals(approvalsHost);
    return;
  }
  if (state.sessionId && !state.historyReady) {
    container.innerHTML = `<div class="history-status" role="status">
      ${state.historyError
        ? `<p>Не удалось загрузить историю: ${escapeHtml(state.historyError)}</p><button type="button" data-retry-history>Повторить</button>`
        : '<p>Загружаем историю сообщений…</p>'}
    </div>`;
    container.querySelector("[data-retry-history]")?.addEventListener("click", async () => {
      const { selectSession } = await import("../features/sessions.js");
      if (isCurrent()) void selectSession(state.sessionId);
    });
    return;
  }
  if (state.surface === "chat" && state.archivedMessages.length) {
    for (const message of state.archivedMessages) {
      appendEvent(message.role === "user"
        ? { type: "user.message", payload: { text: message.text } }
        : {
            type: "codex.item.completed",
            payload: { item: { type: "agentMessage", phase: "final_answer", text: message.text } },
          }, container);
    }
  }
  const events = state.showTechnical ? state.events : visibleEvents(state.events);
  const hasApprovals = Object.keys(state.approvals).length > 0;
  const hasArchivedMessages = state.surface === "chat" && state.archivedMessages.length > 0;
  if (events.length === 0 && !hasApprovals && !hasArchivedMessages && !state.hasMoreEvents && !state.liveResponse) {
    const chatSurface = state.surface === "chat";
    const hasProject = chatSurface || Boolean($("#project").value);
    const hasSessions = state.sessions.length > 0;
    const learning = isLearningProject();
    const emptyTitle = state.sessionId
      ? chatSurface
        ? "Начните общий диалог"
        : learning && state.learningMode === "practice"
        ? "Начните практику"
        : learning && state.learningMode === "theory"
          ? "Закройте пробел в теории"
          : "Что сделаем сегодня?"
      : chatSurface
        ? "Создайте первый чат"
      : !hasProject
        ? "Добавьте проект"
        : learning ? "Выберите режим" : hasSessions ? "Выберите сессию" : "В проекте пока нет сессий";
    const emptyDescription = state.sessionId
      ? chatSurface
        ? (hasModule("development") ? "Ask отвечает без изменений, Act работает в явно выбранном проекте." : "Задайте вопрос в поле ниже.")
        : learning && state.learningMode === "practice"
        ? "Отправьте код или вопрос по заданию в поле ниже."
        : learning && state.learningMode === "theory"
          ? "Выберите предложенную тему или задайте свой вопрос. Код писать не потребуется."
          : learning
            ? "Продолжите курс в поле ниже."
          : "Разберёмся в коде, исправим ошибку или создадим что-то новое. Начните с задачи."
      : chatSurface
        ? "Чаты объединяют контекст проектов, учёбы и общей памяти."
      : !hasProject
        ? "Укажите каталог проекта в боковой панели."
        : learning
          ? "Курс, теория и практика сохраняются в отдельных долгоживущих сессиях."
          : hasSessions
          ? "Выберите существующую сессию в боковой панели."
          : "Создайте первую сессию, чтобы начать работу с Codex.";
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">R<span>↗</span></div>
        <span class="empty-eyebrow">${chatSurface ? "Ваш собеседник" : "Пространство для идей и кода"}</span>
        <h3>${emptyTitle}</h3>
        <p>${emptyDescription}</p>
        ${state.sessionId && !learning && !chatSurface ? `
          <div class="starter-actions" aria-label="Примеры задач">
            <button type="button" data-starter="Объясни, как устроен этот проект: основные модули, связи между ними и с чего начать изучение."><span class="starter-symbol" aria-hidden="true">⌘</span><strong>Разобраться в проекте</strong><span>Архитектура и ключевые файлы</span><span class="starter-arrow" aria-hidden="true">↗</span></button>
            <button type="button" data-starter="Помоги найти и исправить ошибку. Вот что происходит: "><span class="starter-symbol" aria-hidden="true">↗</span><strong>Решить задачу</strong><span>От проблемы к работающему коду</span><span class="starter-arrow" aria-hidden="true">↗</span></button>
          </div>` : ""}
        ${!hasProject ? '<button class="empty-action" type="button" data-add-project>Добавить проект <span aria-hidden="true">↗</span></button>' : ""}
        ${hasProject && !hasSessions && !learning
          ? `<button class="empty-action" type="button" data-create-session>${chatSurface ? "Создать чат" : "Создать сессию"}</button>`
          : ""}
      </div>
    `;
    container.querySelectorAll("[data-starter]").forEach((button) => {
      button.addEventListener("click", () => setPromptValue(button.dataset.starter));
    });
    container.querySelector("[data-add-project]")?.addEventListener("click", () => {
      setSidebarOpen(true);
      document.querySelector(".add-project").open = true;
      $("#project-folder").focus();
    });
    container.querySelector("[data-create-session]")?.addEventListener("click", async () => {
      if (chatSurface) {
        const { createChat } = await import("../features/chats.js");
        void createChat();
      } else {
        const { createSession } = await import("../features/sessions.js");
        void createSession();
      }
    });
    return;
  }
  renderHistoryButton(container);
  renderPendingApprovals(container);
  for (const event of events) appendEvent(event, container);
  // Reopened history is already complete; do not replay entry animations.
  for (const element of container.children) element.classList.add("history-item");
  renderLiveResponse(container, false);
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      if (isCurrent()) container.scrollTop = container.scrollHeight;
    });
  }
}
