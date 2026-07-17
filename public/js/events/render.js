import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
import { isLearningProject } from "../features/context.js";
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
  import("../features/sessions.js").then(({ renderSessionMeta }) => {
    renderSessionMeta(state.selectedSession);
  });
}

export function updateLiveResponse(event) {
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

export function renderLiveResponse(container = $("#events")) {
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
      container.scrollTop = container.scrollHeight;
    });
  }
}

export function renderEvents(scrollToBottom = true) {
  const container = $("#events");
  if (!container) return;
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
  const events = state.showTechnical ? state.events : visibleEvents(state.events);
  const hasApprovals = Object.keys(state.approvals).length > 0;
  if (events.length === 0 && !hasApprovals) {
    const hasProject = Boolean($("#project").value);
    const hasSessions = state.sessions.length > 0;
    const learning = isLearningProject();
    const emptyTitle = state.sessionId
      ? learning && state.learningMode === "practice"
        ? "Начните практику"
        : learning && state.learningMode === "theory"
          ? "Закройте пробел в теории"
          : "Начните диалог"
      : !hasProject
        ? "Добавьте проект"
        : learning ? "Выберите режим" : hasSessions ? "Выберите сессию" : "В проекте пока нет сессий";
    const emptyDescription = state.sessionId
      ? learning && state.learningMode === "practice"
        ? "Отправьте код или вопрос по заданию в поле ниже."
        : learning && state.learningMode === "theory"
          ? "Выберите предложенную тему или задайте свой вопрос. Код писать не потребуется."
          : learning
            ? "Продолжите курс в поле ниже."
          : "Опишите задачу в поле ниже."
      : !hasProject
        ? "Укажите каталог проекта в боковой панели."
        : learning
          ? "Курс, теория и практика сохраняются в отдельных долгоживущих сессиях."
          : hasSessions
          ? "Выберите существующую сессию в боковой панели."
          : "Создайте первую сессию, чтобы начать работу с Codex.";
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">›_</div>
        <h3>${emptyTitle}</h3>
        <p>${emptyDescription}</p>
        ${hasProject && !hasSessions && !learning
          ? '<button class="empty-action" type="button" data-create-session>Создать сессию</button>'
          : ""}
      </div>
    `;
    container.querySelector("[data-create-session]")?.addEventListener("click", async () => {
      const { createSession } = await import("../features/sessions.js");
      void createSession();
    });
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
