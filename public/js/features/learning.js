import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
import { clearPrompt, saveCurrentDraft, setPromptValue } from "./composer.js";
import { renderGitPanel } from "./git.js";
import { renderMarkdownText } from "../events/markdown.js";

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

export function renderTheorySuggestions() {
  const container = $("#theory-suggestions");
  if (!container) return;
  const theoryMode = state.learningMode === "theory"
    && state.selectedSession?.purpose === "theory";
  if (!theoryMode) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const diary = state.learning?.diarySummary ?? {};
  const candidates = [
    ...(diary.focus ?? []),
    ...(diary.weakTopics ?? []).map((topic) => topic.title),
  ];
  const topics = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const topic = String(candidate ?? "").trim();
    const key = topic.toLocaleLowerCase("ru");
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length === 5) break;
  }
  if (!topics.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <span class="theory-suggestions-label">Можно разобрать</span>
    <div class="theory-topic-list">
      ${topics.map((topic) => `
        <button type="button" class="theory-topic" data-theory-topic="${escapeHtml(topic)}">
          ${escapeHtml(topic)}
        </button>
      `).join("")}
    </div>
  `;
  container.hidden = false;
  container.querySelectorAll("[data-theory-topic]").forEach((button) => {
    button.addEventListener("click", () => {
      const topic = button.dataset.theoryTopic;
      if (!topic) return;
      setPromptValue(`Разбери со мной тему «${topic}». Сначала уточни, что именно мне непонятно.`);
    });
  });
}

export function renderTheoryTabs() {
  const container = $("#theory-tabs");
  if (!container) return;
  const visible = state.learningMode === "theory"
    && ["theory", "materials"].includes(state.selectedSession?.purpose);
  container.hidden = !visible;
  if (!visible) {
    container.innerHTML = "";
    return;
  }
  const active = state.theoryTab === "materials" ? "materials" : "dialog";
  container.innerHTML = `
    <button type="button" role="tab" data-theory-tab="dialog" aria-selected="${active === "dialog"}" class="${active === "dialog" ? "active" : ""}">Диалог</button>
    <button type="button" role="tab" data-theory-tab="materials" aria-selected="${active === "materials"}" class="${active === "materials" ? "active" : ""}">Материалы</button>
  `;
  container.querySelectorAll("[data-theory-tab]").forEach((button) => {
    button.addEventListener("click", () => void selectTheoryTab(button.dataset.theoryTab));
  });
}

export async function selectTheoryTab(tab) {
  if (!["dialog", "materials"].includes(tab)) return;
  state.theoryTab = tab;
  storeString("ronix-agent-theory-tab", tab);
  const purpose = tab === "materials" ? "materials" : "theory";
  const session = state.learning?.sessions?.[purpose];
  if (!session) return;
  const { selectSession } = await import("./sessions.js");
  await selectSession(session.id);
  if (tab === "materials") await loadTheoryMaterials();
}

export async function loadTheoryMaterials(projectId = $("#project")?.value) {
  if (!projectId) return null;
  try {
    state.theoryMaterials = await api(
      `/api/projects/${encodeURIComponent(projectId)}/learning/materials`,
    );
  } catch (error) {
    state.theoryMaterials = { materials: [], errors: [], error: error.message };
  }
  const { renderEvents } = await import("../events/render.js");
  renderEvents(false);
  return state.theoryMaterials;
}

export function renderTheoryMaterialsView() {
  const library = state.theoryMaterials;
  const detail = state.theoryMaterialDetail;
  if (!library) {
    return `
      <section class="materials-view" aria-busy="true">
        <div class="materials-skeleton"><span></span><span></span><span></span></div>
      </section>
    `;
  }
  if (detail) return renderMaterialPlayer(detail);
  const materials = library.materials ?? [];
  const running = state.selectedSession?.status === "running"
    || state.materialGeneration?.status === "running";
  return `
    <section class="materials-view">
      <header class="materials-header">
        <div>
          <h3>Интерактивные материалы</h3>
          <p>Наборы остаются в проекте и открываются с любого устройства.</p>
        </div>
        ${materials.length ? `<span class="materials-count">${materials.length}</span>` : ""}
      </header>
      ${renderGenerationStatus()}
      ${renderMaterialGenerator(materials.length === 0, running)}
      ${library.error ? `<div class="materials-notice error">${escapeHtml(library.error)}</div>` : ""}
      ${(library.errors ?? []).length ? `
        <details class="materials-errors">
          <summary>Не удалось прочитать файлов: ${library.errors.length}</summary>
          <ul>${library.errors.map((error) => `<li><code>${escapeHtml(error.file)}</code> — ${escapeHtml(error.message)}</li>`).join("")}</ul>
        </details>
      ` : ""}
      ${materials.length ? `
        <div class="materials-library">
          ${materials.map(renderMaterialSummary).join("")}
        </div>
      ` : `
        <div class="materials-empty">
          <strong>Библиотека пока пуста</strong>
          <p>Создайте первый набор по текущему фокусу. Он сохранится как JSON внутри проекта.</p>
        </div>
      `}
      <div class="materials-approvals" data-materials-approvals></div>
    </section>
  `;
}

function renderMaterialGenerator(open, running) {
  const suggested = suggestedMaterialTopic();
  return `
    <details class="material-generator" ${open ? "open" : ""}>
      <summary>Создать материал</summary>
      <form data-material-generate>
        <label>
          <span>Тема</span>
          <input name="topic" maxlength="160" value="${escapeHtml(suggested)}" placeholder="Например, замыкания в JavaScript" required ${running ? "disabled" : ""}>
        </label>
        <label>
          <span>Размер</span>
          <select name="size" ${running ? "disabled" : ""}>
            <option value="short">Короткий · 6 блоков</option>
            <option value="standard" selected>Стандартный · 10 блоков</option>
            <option value="deep">Глубокий · 16 блоков</option>
          </select>
        </label>
        <label class="material-notes">
          <span>Пожелания <small>необязательно</small></span>
          <textarea name="notes" rows="2" maxlength="1000" placeholder="На что сделать акцент" ${running ? "disabled" : ""}></textarea>
        </label>
        <button type="submit" ${running ? "disabled" : ""}>${running ? "Codex создаёт…" : "Создать"}</button>
      </form>
    </details>
  `;
}

function renderGenerationStatus() {
  const generation = state.materialGeneration;
  if (!generation) return "";
  if (generation.status === "running") {
    return `<div class="materials-notice working"><span></span><div><strong>Codex собирает набор</strong><p>Можно отвечать на запросы доступа ниже. После проверки материал откроется автоматически.</p></div></div>`;
  }
  if (generation.status === "error") {
    return `<div class="materials-notice error"><div><strong>Материал не создан</strong><p>${escapeHtml(generation.message || "Ожидаемый JSON не прошёл проверку.")}</p></div><button type="button" data-retry-material>Повторить</button></div>`;
  }
  return "";
}

function renderMaterialSummary(material) {
  const attempt = material.lastAttempt;
  const score = attempt?.total ? Math.round(attempt.correct / attempt.total * 100) : null;
  return `
    <article class="material-row">
      <button type="button" class="material-open" data-open-material="${escapeHtml(material.id)}">
        <span class="material-main">
          <strong>${escapeHtml(material.title)}</strong>
          <span>${escapeHtml(material.description || material.topic)}</span>
        </span>
        <span class="material-meta">
          ${score == null ? "Не пройден" : `${score}% · ${attempt.correct}/${attempt.total}`}
          <small>${material.blockCount} блоков</small>
        </span>
      </button>
      <button type="button" class="material-delete" data-delete-material="${escapeHtml(material.id)}" aria-label="Удалить ${escapeHtml(material.title)}" title="Удалить">×</button>
    </article>
  `;
}

function suggestedMaterialTopic() {
  const diary = state.learning?.diarySummary ?? {};
  return String(diary.focus?.[0] || diary.weakTopics?.[0]?.title || "").trim();
}

export async function openTheoryMaterial(materialId) {
  const projectId = $("#project")?.value;
  if (!projectId || !materialId) return;
  try {
    const detail = await api(
      `/api/projects/${encodeURIComponent(projectId)}/learning/materials/${encodeURIComponent(materialId)}`,
    );
    state.theoryMaterialDetail = detail;
    state.theoryMaterialAnswers = structuredClone(detail.lastAttempt?.answersByBlock ?? {});
    state.theoryMaterialResult = detail.lastResult ?? null;
    state.theoryMaterialUi = { flashcards: {}, matchingSelection: {} };
  } catch (error) {
    state.materialGeneration = { status: "error", message: error.message };
  }
  const { renderEvents } = await import("../events/render.js");
  renderEvents(false);
}

function renderMaterialPlayer(detail) {
  const { material, revision } = detail;
  const result = state.theoryMaterialResult;
  const completed = Boolean(result);
  return `
    <section class="materials-view material-player">
      <header class="material-player-head">
        <button type="button" class="material-back" data-close-material>← Библиотека</button>
        <div>
          <h3>${escapeHtml(material.title)}</h3>
          <p>${escapeHtml(material.description || material.topic)}</p>
        </div>
        <span>${material.blocks.length} блоков</span>
      </header>
      ${completed ? `
        <div class="material-result ${result.percentage >= 70 ? "success" : "review"}">
          <strong>${result.percentage}%</strong>
          <span>${result.correct} из ${result.total} интерактивных заданий</span>
          <button type="button" data-retake-material>Пройти ещё раз</button>
        </div>
      ` : ""}
      <form class="material-blocks" data-material-attempt data-revision="${escapeHtml(revision)}">
        ${material.blocks.map((block, index) => renderMaterialBlock(block, index, result)).join("")}
        <footer class="material-submit-bar">
          <span>${completed ? "Сохранён последний результат этой версии" : materialProgress(material)}</span>
          ${completed
            ? `<button type="button" data-close-material>Готово</button>`
            : `<button type="submit" ${isMaterialComplete(material) ? "" : "disabled"}>Проверить набор</button>`}
        </footer>
      </form>
      <div class="materials-approvals" data-materials-approvals></div>
    </section>
  `;
}

function renderMaterialBlock(block, index, result) {
  const feedback = result?.resultsByBlock?.[block.id];
  const stateClass = feedback?.correct === true
    ? " correct"
    : feedback?.correct === false ? " incorrect" : "";
  if (block.type === "explanation") {
    return `
      <article class="material-block explanation" data-block-id="${escapeHtml(block.id)}">
        <span class="material-block-number">${index + 1}</span>
        ${block.title ? `<h4>${escapeHtml(block.title)}</h4>` : ""}
        <div class="material-prose">${renderMarkdownText(block.markdown)}</div>
      </article>
    `;
  }
  if (block.type === "choice") {
    const answer = state.theoryMaterialAnswers[block.id];
    return `
      <fieldset class="material-block choice${stateClass}" data-block-id="${escapeHtml(block.id)}">
        <legend><span>${index + 1}</span>${escapeHtml(block.prompt)}</legend>
        <div class="choice-options">
          ${block.options.map((option) => `
            <label>
              <input type="radio" name="choice-${escapeHtml(block.id)}" value="${escapeHtml(option.id)}" ${answer === option.id ? "checked" : ""} ${result ? "disabled" : ""}>
              <span>${escapeHtml(option.text)}</span>
            </label>
          `).join("")}
        </div>
        ${renderBlockFeedback(block, feedback)}
      </fieldset>
    `;
  }
  if (block.type === "flashcard") {
    const open = Boolean(state.theoryMaterialUi.flashcards[block.id] || state.theoryMaterialAnswers[block.id]);
    return `
      <article class="material-block flashcard" data-block-id="${escapeHtml(block.id)}">
        <span class="material-block-number">${index + 1}</span>
        <button type="button" class="flashcard-face" data-flashcard="${escapeHtml(block.id)}" aria-expanded="${open}">
          <span class="flashcard-label">${open ? "Ответ" : "Карточка"}</span>
          <strong>${escapeHtml(open ? block.back : block.front)}</strong>
          <small>${open ? "Нажмите, чтобы вернуться к вопросу" : "Нажмите, чтобы перевернуть"}</small>
        </button>
      </article>
    `;
  }
  if (block.type === "matching") {
    const mapping = state.theoryMaterialAnswers[block.id] ?? {};
    const selection = state.theoryMaterialUi.matchingSelection[block.id];
    return `
      <article class="material-block matching${stateClass}" data-block-id="${escapeHtml(block.id)}">
        <div class="material-question"><span>${index + 1}</span><h4>${escapeHtml(block.prompt)}</h4></div>
        <p class="matching-hint">Выберите элемент слева, затем соответствие справа.</p>
        <div class="matching-grid">
          <div>${block.left.map((item) => `
            <button type="button" data-match-side="left" data-match-block="${escapeHtml(block.id)}" data-match-id="${escapeHtml(item.id)}" class="${selection === item.id ? "selected" : ""}" ${result ? "disabled" : ""}>
              ${escapeHtml(item.text)}
              ${mapping[item.id] ? `<small>${escapeHtml(block.right.find((right) => right.id === mapping[item.id])?.text || "")}</small>` : ""}
            </button>
          `).join("")}</div>
          <div>${block.right.map((item) => `
            <button type="button" data-match-side="right" data-match-block="${escapeHtml(block.id)}" data-match-id="${escapeHtml(item.id)}" ${result || !selection ? "disabled" : ""}>
              ${escapeHtml(item.text)}
            </button>
          `).join("")}</div>
        </div>
        ${renderBlockFeedback(block, feedback)}
      </article>
    `;
  }
  const order = ensureOrderingAnswer(block);
  return `
    <article class="material-block ordering${stateClass}" data-block-id="${escapeHtml(block.id)}">
      <div class="material-question"><span>${index + 1}</span><h4>${escapeHtml(block.prompt)}</h4></div>
      <p class="ordering-hint">Используйте кнопки или клавиши ↑/↓.</p>
      <ol class="ordering-list">
        ${order.map((itemId, itemIndex) => {
          const item = block.items.find((candidate) => candidate.id === itemId);
          return `
            <li tabindex="${result ? "-1" : "0"}" data-order-item="${escapeHtml(itemId)}" data-order-block="${escapeHtml(block.id)}">
              <span>${itemIndex + 1}</span><strong>${escapeHtml(item?.text || itemId)}</strong>
              <span class="ordering-actions">
                <button type="button" data-order-move="up" aria-label="Поднять" ${result || itemIndex === 0 ? "disabled" : ""}>↑</button>
                <button type="button" data-order-move="down" aria-label="Опустить" ${result || itemIndex === order.length - 1 ? "disabled" : ""}>↓</button>
              </span>
            </li>
          `;
        }).join("")}
      </ol>
      ${renderBlockFeedback(block, feedback)}
    </article>
  `;
}

function renderBlockFeedback(block, feedback) {
  if (!feedback || block.type === "flashcard" || block.type === "explanation") return "";
  let answer = "";
  if (block.type === "choice") {
    answer = block.options.find((option) => option.id === feedback.correctAnswer)?.text ?? "";
  } else if (block.type === "matching") {
    answer = block.pairs.map((pair) => {
      const left = block.left.find((item) => item.id === pair.leftId)?.text;
      const right = block.right.find((item) => item.id === pair.rightId)?.text;
      return `${left} — ${right}`;
    }).join("; ");
  } else {
    answer = block.correctOrder.map((id) => block.items.find((item) => item.id === id)?.text).join(" → ");
  }
  return `
    <div class="material-feedback">
      <strong>${feedback.correct ? "Верно" : "Правильный ответ"}</strong>
      ${feedback.correct ? "" : `<p>${escapeHtml(answer)}</p>`}
      <p>${escapeHtml(feedback.explanation || "")}</p>
    </div>
  `;
}

function ensureOrderingAnswer(block) {
  const current = state.theoryMaterialAnswers[block.id];
  if (Array.isArray(current) && current.length === block.items.length) return current;
  const initial = block.items.map((item) => item.id);
  state.theoryMaterialAnswers[block.id] = initial;
  return initial;
}

function isMaterialComplete(material) {
  return material.blocks.every((block) => {
    if (block.type === "explanation") return true;
    const answer = state.theoryMaterialAnswers[block.id];
    if (block.type === "flashcard") return answer === true;
    if (block.type === "choice") return typeof answer === "string";
    if (block.type === "matching") return answer && Object.keys(answer).length === block.left.length;
    return Array.isArray(answer) && answer.length === block.items.length;
  });
}

function materialProgress(material) {
  const interactive = material.blocks.filter((block) => block.type !== "explanation");
  const completed = interactive.filter((block) => {
    const answer = state.theoryMaterialAnswers[block.id];
    if (block.type === "flashcard") return answer === true;
    if (block.type === "choice") return typeof answer === "string";
    if (block.type === "matching") return answer && Object.keys(answer).length === block.left.length;
    return Array.isArray(answer) && answer.length === block.items.length;
  }).length;
  return `${completed} из ${interactive.length} интерактивных блоков завершено`;
}

export function bindTheoryMaterialsView(container) {
  container.querySelectorAll("[data-open-material]").forEach((button) => {
    button.addEventListener("click", () => void openTheoryMaterial(button.dataset.openMaterial));
  });
  container.querySelectorAll("[data-close-material]").forEach((button) => {
    button.addEventListener("click", () => {
      state.theoryMaterialDetail = null;
      state.theoryMaterialResult = null;
      import("../events/render.js").then(({ renderEvents }) => renderEvents(false));
    });
  });
  container.querySelectorAll("[data-delete-material]").forEach((button) => {
    button.addEventListener("click", () => void removeTheoryMaterial(button.dataset.deleteMaterial));
  });
  container.querySelector("[data-retry-material]")?.addEventListener("click", () => {
    state.materialGeneration = null;
    const generator = container.querySelector(".material-generator");
    if (generator) generator.open = true;
    generator?.querySelector("input")?.focus();
  });
  container.querySelector("[data-material-generate]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void generateTheoryMaterial(new FormData(event.currentTarget));
  });
  container.querySelectorAll('input[type="radio"][name^="choice-"]').forEach((input) => {
    input.addEventListener("change", () => {
      const blockId = input.name.slice("choice-".length);
      state.theoryMaterialAnswers[blockId] = input.value;
      rerenderMaterials();
    });
  });
  container.querySelectorAll("[data-flashcard]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.flashcard;
      const opening = !state.theoryMaterialUi.flashcards[id];
      state.theoryMaterialUi.flashcards[id] = opening;
      if (opening) state.theoryMaterialAnswers[id] = true;
      rerenderMaterials();
    });
  });
  container.querySelectorAll("[data-match-side]").forEach((button) => {
    button.addEventListener("click", () => {
      const blockId = button.dataset.matchBlock;
      const itemId = button.dataset.matchId;
      if (button.dataset.matchSide === "left") {
        state.theoryMaterialUi.matchingSelection[blockId] = itemId;
      } else {
        const leftId = state.theoryMaterialUi.matchingSelection[blockId];
        if (!leftId) return;
        const mapping = { ...(state.theoryMaterialAnswers[blockId] ?? {}) };
        for (const [key, value] of Object.entries(mapping)) {
          if (value === itemId) delete mapping[key];
        }
        mapping[leftId] = itemId;
        state.theoryMaterialAnswers[blockId] = mapping;
        delete state.theoryMaterialUi.matchingSelection[blockId];
      }
      rerenderMaterials();
    });
  });
  container.querySelectorAll("[data-order-move]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-order-item]");
      moveOrderItem(row?.dataset.orderBlock, row?.dataset.orderItem, button.dataset.orderMove);
    });
  });
  container.querySelectorAll("[data-order-item]").forEach((row) => {
    row.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      moveOrderItem(row.dataset.orderBlock, row.dataset.orderItem, event.key === "ArrowUp" ? "up" : "down", true);
    });
  });
  container.querySelector("[data-material-attempt]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMaterialAttempt(event.currentTarget.dataset.revision);
  });
  container.querySelector("[data-retake-material]")?.addEventListener("click", () => {
    state.theoryMaterialAnswers = {};
    state.theoryMaterialResult = null;
    state.theoryMaterialUi = { flashcards: {}, matchingSelection: {} };
    rerenderMaterials();
  });
}

function rerenderMaterials() {
  import("../events/render.js").then(({ renderEvents }) => renderEvents(false));
}

async function generateTheoryMaterial(formData) {
  const projectId = $("#project")?.value;
  if (!projectId) return;
  state.materialGeneration = { status: "running" };
  rerenderMaterials();
  try {
    const result = await api(
      `/api/projects/${encodeURIComponent(projectId)}/learning/materials/generate`,
      {
        method: "POST",
        body: JSON.stringify({
          topic: formData.get("topic"),
          size: formData.get("size"),
          notes: formData.get("notes") || undefined,
        }),
      },
    );
    state.materialGeneration = { status: "running", materialId: result.materialId };
  } catch (error) {
    state.materialGeneration = { status: "error", message: error.message };
  }
  rerenderMaterials();
}

async function removeTheoryMaterial(materialId) {
  const projectId = $("#project")?.value;
  const material = state.theoryMaterials?.materials?.find((item) => item.id === materialId);
  if (!projectId || !materialId) return;
  if (!confirm(`Удалить материал «${material?.title || materialId}» и его сохранённый результат?`)) return;
  try {
    await api(
      `/api/projects/${encodeURIComponent(projectId)}/learning/materials/${encodeURIComponent(materialId)}`,
      { method: "DELETE" },
    );
    if (state.theoryMaterialDetail?.material?.id === materialId) state.theoryMaterialDetail = null;
    await loadTheoryMaterials(projectId);
  } catch (error) {
    alert(error.message);
  }
}

function moveOrderItem(blockId, itemId, direction, restoreFocus = false) {
  const order = [...(state.theoryMaterialAnswers[blockId] ?? [])];
  const index = order.indexOf(itemId);
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  state.theoryMaterialAnswers[blockId] = order;
  rerenderMaterials();
  if (restoreFocus) requestAnimationFrame(() => document.querySelector(`[data-order-item="${itemId}"]`)?.focus());
}

async function submitMaterialAttempt(revision) {
  const projectId = $("#project")?.value;
  const materialId = state.theoryMaterialDetail?.material?.id;
  if (!projectId || !materialId || !revision) return;
  try {
    state.theoryMaterialResult = await api(
      `/api/projects/${encodeURIComponent(projectId)}/learning/materials/${encodeURIComponent(materialId)}/attempt`,
      {
        method: "POST",
        body: JSON.stringify({ revision, answersByBlock: state.theoryMaterialAnswers }),
      },
    );
    await loadTheoryMaterials(projectId);
    rerenderMaterials();
  } catch (error) {
    alert(error.message);
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
  renderTheoryTabs();
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
  $("#theory-tabs").hidden = true;
  renderGitPanel();
  import("../events/render.js").then(({ renderEvents }) => renderEvents());
}

export async function selectLearningMode(mode) {
  if (!["course", "theory", "practice", "progress"].includes(mode)) return;
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
  const purpose = mode === "theory" && state.theoryTab === "materials" ? "materials" : mode;
  const session = state.learning?.sessions?.[purpose];
  if (session) await selectSession(session.id);
  if (purpose === "materials") await loadTheoryMaterials();
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
