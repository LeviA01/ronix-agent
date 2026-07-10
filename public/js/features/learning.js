import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
import { isLearningProject } from "./context.js";
import { clearPrompt, saveCurrentDraft } from "./composer.js";
import { renderGitPanel } from "./git.js";

export async function loadLearning(projectId = $("#project")?.value) {
  if (!projectId) {
    state.learning = null;
    return null;
  }
  try {
    state.learning = await api(`/api/projects/${encodeURIComponent(projectId)}/learning`);
    return state.learning;
  } catch (error) {
    state.learning = { available: false, error: error.message, missing: [] };
    return state.learning;
  }
}

export function renderLearningDashboard() {
  const learning = state.learning;
  if (!learning) {
    return '<div class="empty-state"><div class="empty-icon">›_</div><h3>Загрузка учёбы</h3></div>';
  }
  if (!learning.available) {
    return `
      <section class="learning-dashboard">
        <header class="learning-dashboard-head">
          <div>
            <h3>Учебные файлы не найдены</h3>
            <p>${escapeHtml(learning.error || `Не найдены: ${(learning.missing ?? []).join(", ")}`)}</p>
          </div>
          <button type="button" class="refresh-learning" data-refresh-learning>Обновить прогресс</button>
        </header>
      </section>
    `;
  }
  const diary = learning.diarySummary ?? learning.summary ?? {};
  const roadmap = learning.roadmapSummary ?? {};
  const showingRaw = state.progressTab !== "summary";
  return `
    <section class="learning-dashboard">
      <header class="learning-dashboard-head">
        <div>
          <h3>Успехи</h3>
          <p>${escapeHtml(learningSummaryLine(diary, roadmap))}</p>
        </div>
        <button type="button" class="refresh-learning" data-refresh-learning>Обновить прогресс</button>
      </header>
      <div class="learning-tabs" role="tablist">
        ${renderProgressTab("summary", "Обзор")}
        ${renderProgressTab("diary", "Дневник")}
        ${renderProgressTab("roadmap", "Roadmap")}
      </div>
      ${showingRaw
        ? `<pre class="learning-content">${escapeHtml(
            state.progressTab === "roadmap" ? learning.roadmap : learning.diary,
          )}</pre>`
        : renderLearningSummary(diary, roadmap)}
    </section>
  `;
}

function renderProgressTab(tab, label) {
  return `
    <button
      type="button"
      data-progress-tab="${escapeHtml(tab)}"
      class="${state.progressTab === tab ? "active" : ""}"
    >${escapeHtml(label)}</button>
  `;
}

export function learningSummaryLine(diary, roadmap) {
  const focus = diary.focus?.[0] ? ` · ${diary.focus[0]}` : "";
  return [
    diary.topicCount != null ? `${diary.topicCount} тем` : null,
    diary.assignmentCount != null ? `${diary.assignmentCount} заданий` : null,
    roadmap.currentStage ? `сейчас: ${roadmap.currentStage}` : null,
    diary.lastUpdated ? `обновлено ${diary.lastUpdated}` : null,
  ].filter(Boolean).join(" · ") + focus;
}

function renderLearningSummary(diary, roadmap) {
  const weakTopics = diary.weakTopics ?? [];
  const strongTopics = diary.strongTopics ?? [];
  const topics = diary.topics ?? [];
  const assignments = diary.latestGrades ?? [];
  return `
    <section class="learning-scoreboard">
      <div class="learning-stat">
        <span>Средний уровень</span>
        <strong>${diary.averageScore ?? "—"}</strong>
      </div>
      <div class="learning-stat">
        <span>Темы</span>
        <strong>${diary.topicCount ?? 0}</strong>
      </div>
      <div class="learning-stat">
        <span>Задания</span>
        <strong>${diary.assignmentCount ?? 0}</strong>
      </div>
    </section>
    ${renderRoadmapSummary(roadmap)}
    ${renderFocus(diary.focus ?? [])}
    ${renderTopicGroup("Что проседает", weakTopics, "weak")}
    ${renderTopicGroup("Сильные стороны", strongTopics, "strong")}
    ${renderAssignmentScores(assignments)}
    ${renderTopicGroup("Все темы", topics, "all")}
  `;
}

function renderRoadmapSummary(roadmap) {
  const next = [
    ...(roadmap.current ?? []).filter((item) => !item.done),
    ...(roadmap.nextSteps ?? []).filter((item) => !item.done),
  ].slice(0, 5);
  if (!roadmap.currentStage && next.length === 0) return "";
  return `
    <section class="learning-section">
      <h3>Маршрут</h3>
      ${roadmap.currentStage ? `<p class="learning-current-stage">${escapeHtml(roadmap.currentStage)}</p>` : ""}
      ${next.length ? `
        <ol class="learning-focus">
          ${next.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("")}
        </ol>
      ` : ""}
    </section>
  `;
}

function renderFocus(focus) {
  if (!focus.length) return "";
  return `
    <section class="learning-section">
      <h3>Текущий фокус</h3>
      <ol class="learning-focus">
        ${focus.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ol>
    </section>
  `;
}

function renderTopicGroup(title, topics, tone) {
  if (!topics.length) return "";
  return `
    <section class="learning-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="learning-topic-list ${tone}">
        ${topics.map(renderTopic).join("")}
      </div>
    </section>
  `;
}

function renderTopic(topic) {
  const score = Math.max(1, Math.min(10, Number(topic.score) || 1));
  return `
    <article class="learning-topic">
      <div class="learning-topic-head">
        <strong>${escapeHtml(topic.title)}</strong>
        <span>${score}/10</span>
      </div>
      <div class="learning-meter" aria-hidden="true">
        <span style="width: ${score * 10}%"></span>
      </div>
      <p>${escapeHtml(topic.rationale || topic.confidence || "")}</p>
    </article>
  `;
}

function renderAssignmentScores(assignments) {
  if (!assignments.length) return "";
  return `
    <section class="learning-section">
      <h3>Последние оценки</h3>
      <div class="learning-assignment-list">
        ${assignments.map((assignment) => `
          <div class="learning-assignment">
            <span>${escapeHtml(assignment.title)}</span>
            <strong>${assignment.score}/10</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

export function clearSelectedSessionForProgress() {
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.reconnectTimer = null;
  state.sessionRefreshTimer = null;
  state.liveRenderFrame = null;
  state.sessionId = null;
  state.events = [];
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  clearPrompt();
  renderGitPanel();
}

export function renderLearningProgressMode() {
  $("#session-title").textContent = "Успехи";
  const meta = $("#session-meta");
  meta.className = "session-meta ready";
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(learningSummaryLine(
      state.learning?.diarySummary ?? {},
      state.learning?.roadmapSummary ?? {},
    ) || "Дневник и дорожная карта")}</span>
  `;
  $("#session-settings").hidden = true;
  $("#toggle-settings").hidden = true;
  $("#interrupt").hidden = true;
  $("#prompt-form").hidden = true;
  $("#send").disabled = true;
  $("#sandbox-mode").disabled = true;
  renderGitPanel();
  import("../events/render.js").then(({ renderEvents }) => renderEvents());
}

export async function selectLearningMode(mode) {
  if (!["course", "practice", "progress"].includes(mode)) return;
  saveCurrentDraft();
  state.learningMode = mode;
  storeString("ronix-agent-learning-mode", mode);
  const { renderSessions, selectSession } = await import("./sessions.js");
  renderSessions();
  if (mode === "progress") {
    clearSelectedSessionForProgress();
    renderLearningProgressMode();
    return;
  }
  const session = state.learning?.sessions?.[mode];
  if (session) await selectSession(session.id);
}

export function renderLearningModeButton(mode, title, description) {
  const session = mode === "progress" ? null : state.learning?.sessions?.[mode];
  const status = session?.status ?? "ready";
  return `
    <button
      class="learning-mode ${state.learningMode === mode ? "active" : ""}"
      type="button"
      data-learning-mode="${escapeHtml(mode)}"
    >
      <span class="session-status ${escapeHtml(status)}"></span>
      <span>
        <span class="session-title">${escapeHtml(title)}</span>
        <small>${escapeHtml(description)}</small>
      </span>
    </button>
  `;
}
