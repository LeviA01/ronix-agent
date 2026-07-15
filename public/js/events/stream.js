import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api, headers } from "../core/api.js";
import { isLearningProject } from "../features/context.js";
import {
  loadLearning,
  loadTheoryMaterials,
  openTheoryMaterial,
  renderTheorySuggestions,
} from "../features/learning.js";
import {
  isLiveEvent,
  isSessionStateEvent,
} from "./classify.js";
import {
  appendVisibleEvent,
  renderEvents,
  scheduleLiveRender,
  updateLiveResponse,
} from "./render.js";
import { setConnection } from "../features/context.js";

export function updateApprovalState(event) {
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

export function scheduleSessionRefresh() {
  clearTimeout(state.sessionRefreshTimer);
  state.sessionRefreshTimer = setTimeout(() => void refreshSelectedSession(), 150);
}

async function refreshSelectedSession() {
  if (!state.sessionId) return;
  const { session } = await api(`/api/sessions/${state.sessionId}`);
  const { renderSessionMeta, loadSessions, renderSessions } = await import("../features/sessions.js");
  renderSessionMeta(session);
  if (isLearningProject()) {
    const purpose = session.purpose;
    if (["course", "theory", "practice", "materials"].includes(purpose)) {
      state.learning ??= {};
      state.learning.sessions ??= {};
      state.learning.sessions[purpose] = session;
      state.sessions = [
        state.learning.sessions.course,
        state.learning.sessions.theory,
        state.learning.sessions.practice,
      ].filter(Boolean);
      renderSessions();
      return;
    }
  }
  await loadSessions();
}

export function handleEvent(event, initial = false) {
  if (event.sequence <= state.lastSequence) return;
  state.lastSequence = event.sequence;
  if (!state.firstSequence) state.firstSequence = event.sequence;
  state.events.push(event);
  updateApprovalState(event);
  updateLiveResponse(event);
  if (
    event.type === "material.generation.completed"
    && state.materialGeneration?.status === "running"
    && (!state.materialGeneration?.materialId
      || state.materialGeneration.materialId === event.payload.materialId)
  ) {
    state.materialGeneration = null;
    void loadTheoryMaterials().then(() => openTheoryMaterial(event.payload.materialId));
  } else if (
    event.type === "material.generation.repairing"
    && state.materialGeneration?.status === "running"
    && (!state.materialGeneration?.materialId
      || state.materialGeneration.materialId === event.payload.materialId)
  ) {
    state.materialGeneration = {
      ...state.materialGeneration,
      repairing: true,
      repairAttempt: event.payload.attempt,
      maximumRepairAttempts: event.payload.maximumAttempts,
      message: event.payload.message,
    };
  } else if (
    event.type === "material.generation.failed"
    && state.materialGeneration?.status === "running"
  ) {
    state.materialGeneration = { status: "error", message: event.payload.message };
  }
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    renderEvents();
  } else if (isLiveEvent(event)) {
    scheduleLiveRender();
  } else {
    appendVisibleEvent(event);
  }
  if (isSessionStateEvent(event)) scheduleSessionRefresh();
  if (
    isLearningProject()
    && ["course", "theory", "practice"].includes(state.learningMode)
    && event.type === "codex.turn.completed"
  ) {
    void loadLearning().then(() => renderTheorySuggestions());
  }
  if (initial && state.events.length === 200) {
    state.hasMoreEvents = true;
    renderEvents();
  }
}

export function connectEvents(sessionId = state.sessionId, initial = false) {
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

export async function loadOlderEvents(button) {
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

export function bindEventActions() {
  const eventsEl = $("#events");
  if (!eventsEl) return;

  eventsEl.addEventListener("click", async (event) => {
    const { setSettingsOpen } = await import("../layout/panels.js");
    setSettingsOpen(false);
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

  eventsEl.addEventListener("submit", async (event) => {
    const form = event.target.closest(".user-input-form");
    if (!form) return;
    event.preventDefault();
    const card = form.closest("[data-approval-id]");
    if (!card || !state.sessionId) return;
    const button = form.querySelector("[data-user-input-submit]");
    if (button) button.disabled = true;
    try {
      const { collectUserInputAnswers } = await import("./format-event.js");
      await api(`/api/sessions/${state.sessionId}/approvals/${card.dataset.approvalId}`, {
        method: "POST",
        body: JSON.stringify({
          decision: "answer",
          answers: collectUserInputAnswers(form),
        }),
      });
    } catch (error) {
      if (button) button.disabled = false;
      alert(error.message);
    }
  });
}
