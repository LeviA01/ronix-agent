import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
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
    return `
      <div class="empty-state">
        <div class="empty-icon">›_</div>
        <h3>Загрузка прогресса</h3>
        <p>Собираем дневник и roadmap…</p>
      </div>
    `;
  }
  if (!learning.available) {
    return `
      <section class="learning-dashboard">
        <header class="learning-dashboard-head">
          <div class="learning-hero">
            <p class="learning-kicker">Прогресс</p>
            <h3>Файлы учёбы не найдены</h3>
            <p class="learning-sub">${escapeHtml(
              learning.error || `Не найдены: ${(learning.missing ?? []).join(", ")}`,
            )}</p>
          </div>
          <button type="button" class="refresh-learning" data-refresh-learning>Обновить</button>
        </header>
      </section>
    `;
  }

  const diary = learning.diarySummary ?? learning.summary ?? {};
  const roadmap = learning.roadmapSummary ?? {};
  const tab = ["summary", "diary", "roadmap"].includes(state.progressTab)
    ? state.progressTab
    : "summary";

  return `
    <section class="learning-dashboard">
      <header class="learning-dashboard-head">
        <div class="learning-hero">
          <p class="learning-kicker">Прогресс</p>
          <h3>Успехи</h3>
          <p class="learning-sub">${escapeHtml(learningSummaryLine(diary, roadmap) || "Дневник и дорожная карта")}</p>
        </div>
        <button type="button" class="refresh-learning" data-refresh-learning title="Обновить прогресс">
          Обновить
        </button>
      </header>

      <div class="learning-tabs" role="tablist" aria-label="Разделы прогресса">
        ${renderProgressTab("summary", "Обзор", tab)}
        ${renderProgressTab("diary", "Дневник", tab)}
        ${renderProgressTab("roadmap", "Roadmap", tab)}
      </div>

      <div class="learning-body">
        ${tab === "summary"
          ? renderLearningSummary(diary, roadmap)
          : renderLearningSource(
              tab === "roadmap" ? "Roadmap" : "Дневник",
              tab === "roadmap" ? learning.roadmap : learning.diary,
            )}
      </div>
    </section>
  `;
}

function renderProgressTab(id, label, active) {
  const isActive = active === id;
  return `
    <button
      type="button"
      role="tab"
      data-progress-tab="${escapeHtml(id)}"
      class="${isActive ? "active" : ""}"
      aria-selected="${isActive}"
    >${escapeHtml(label)}</button>
  `;
}

export function learningSummaryLine(diary, roadmap) {
  return [
    diary.topicCount != null ? `${diary.topicCount} тем` : null,
    diary.assignmentCount != null ? `${diary.assignmentCount} заданий` : null,
    roadmap.currentStage ? roadmap.currentStage : null,
    diary.lastUpdated ? `обн. ${diary.lastUpdated}` : null,
  ].filter(Boolean).join(" · ");
}

function renderLearningSource(title, content) {
  const text = String(content ?? "").trim();
  if (!text) {
    return `
      <div class="learning-empty">
        <strong>${escapeHtml(title)} пуст</strong>
        <p>Пока нет содержимого. Продолжи курс или практику — файлы обновятся сами.</p>
      </div>
    `;
  }
  return `
    <article class="learning-source-card">
      <header class="learning-source-head">
        <h4>${escapeHtml(title)}</h4>
        <span>только чтение</span>
      </header>
      <pre class="learning-content">${escapeHtml(text)}</pre>
    </article>
  `;
}

function renderLearningSummary(diary, roadmap) {
  const weakTopics = (diary.weakTopics ?? []).slice(0, 4);
  const strongTopics = (diary.strongTopics ?? []).slice(0, 4);
  const topics = diary.topics ?? [];
  const assignments = (diary.latestGrades ?? []).slice(0, 6);
  const focus = diary.focus ?? [];
  const next = [
    ...(roadmap.current ?? []).filter((item) => !item.done),
    ...(roadmap.nextSteps ?? []).filter((item) => !item.done),
  ].slice(0, 5);

  return `
    <div class="learning-scoreboard" aria-label="Ключевые цифры">
      ${renderStat("Уровень", diary.averageScore ?? "—", "среднее")}
      ${renderStat("Темы", diary.topicCount ?? 0, "в дневнике")}
      ${renderStat("Задания", diary.assignmentCount ?? 0, "оценено")}
    </div>

    <div class="learning-grid">
      <section class="learning-card learning-card-primary">
        <header class="learning-card-head">
          <h4>Сейчас</h4>
          ${diary.lastUpdated ? `<span>${escapeHtml(diary.lastUpdated)}</span>` : ""}
        </header>
        ${roadmap.currentStage
          ? `<p class="learning-current-stage">${escapeHtml(roadmap.currentStage)}</p>`
          : `<p class="learning-muted">Этап roadmap ещё не указан</p>`}
        ${focus.length ? `
          <div class="learning-focus-block">
            <span class="learning-label">Фокус</span>
            <ol class="learning-focus">
              ${focus.slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ol>
          </div>
        ` : ""}
        ${next.length ? `
          <div class="learning-focus-block">
            <span class="learning-label">Дальше</span>
            <ol class="learning-focus">
              ${next.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("")}
            </ol>
          </div>
        ` : ""}
      </section>

      <section class="learning-card">
        <header class="learning-card-head">
          <h4>Последние оценки</h4>
          <span>${assignments.length || "—"}</span>
        </header>
        ${assignments.length
          ? `<div class="learning-assignment-list">
              ${assignments.map((item) => renderAssignment(item)).join("")}
            </div>`
          : `<p class="learning-muted">Оценок пока нет — сдай практику.</p>`}
      </section>
    </div>

    <div class="learning-grid learning-grid-skills">
      ${renderSkillColumn("Проседает", weakTopics, "weak", "Темы с низким уровнем")}
      ${renderSkillColumn("Сильные", strongTopics, "strong", "Что уже стабильно")}
    </div>

    <details class="learning-details" ${topics.length <= 6 ? "open" : ""}>
      <summary>
        <span>Все темы</span>
        <span class="learning-details-count">${topics.length}</span>
      </summary>
      <div class="learning-topic-list all">
        ${topics.length
          ? topics.map(renderTopic).join("")
          : `<p class="learning-muted">Темы появятся после обновления дневника.</p>`}
      </div>
    </details>
  `;
}

function renderStat(label, value, hint) {
  return `
    <article class="learning-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `;
}

function renderSkillColumn(title, topics, tone, hint) {
  return `
    <section class="learning-card learning-card-${tone}">
      <header class="learning-card-head">
        <h4>${escapeHtml(title)}</h4>
        <span>${topics.length || "—"}</span>
      </header>
      <p class="learning-card-hint">${escapeHtml(hint)}</p>
      ${topics.length
        ? `<div class="learning-topic-list ${tone}">
            ${topics.map(renderTopic).join("")}
          </div>`
        : `<p class="learning-muted">Пока пусто</p>`}
    </section>
  `;
}

function renderTopic(topic) {
  const score = Math.max(0, Math.min(10, Number(topic.score) || 0));
  const note = topic.rationale || topic.confidence || "";
  return `
    <article class="learning-topic">
      <div class="learning-topic-head">
        <strong title="${escapeHtml(topic.title)}">${escapeHtml(topic.title)}</strong>
        <span>${score}/10</span>
      </div>
      <div class="learning-meter" aria-hidden="true">
        <span style="width: ${score * 10}%"></span>
      </div>
      ${note ? `<p>${escapeHtml(note)}</p>` : ""}
    </article>
  `;
}

function renderAssignment(assignment) {
  const score = assignment.score ?? "—";
  return `
    <div class="learning-assignment">
      <span title="${escapeHtml(assignment.title)}">${escapeHtml(assignment.title)}</span>
      <strong>${escapeHtml(String(score))}<small>/10</small></strong>
    </div>
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
  const diary = state.learning?.diarySummary ?? {};
  const roadmap = state.learning?.roadmapSummary ?? {};
  $("#session-title").textContent = "Успехи";
  const meta = $("#session-meta");
  meta.className = "session-meta ready";
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(learningSummaryLine(diary, roadmap) || "Дневник и roadmap")}</span>
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
