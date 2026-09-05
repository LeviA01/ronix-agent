import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml, relativeTime } from "../core/format.js";

const KIND_LABELS = {
  preference: "Предпочтение",
  fact: "Факт",
  decision: "Решение",
  task: "Задача",
  summary: "Итог",
};

let searchTimer = null;

export async function loadMemory() {
  if (state.surface !== "memory") return;
  state.memoryLoading = true;
  renderMemory();
  const params = new URLSearchParams({ limit: "100" });
  const query = $("#memory-search")?.value.trim();
  const scopeType = $("#memory-scope")?.value;
  const kind = $("#memory-kind")?.value;
  if (query) params.set("query", query);
  if (scopeType) params.set("scopeType", scopeType);
  if (kind) params.set("kind", kind);
  try {
    const [result, chatResult] = await Promise.all([
      api(`/api/memory?${params}`),
      api("/api/chats"),
    ]);
    state.chats = chatResult.chats;
    state.memoryItems = result.items;
    state.memoryTotal = result.total;
  } catch (error) {
    state.memoryItems = [];
    state.memoryTotal = 0;
    alert(error.message);
  } finally {
    state.memoryLoading = false;
    renderMemory();
  }
}

export function renderMemory() {
  const container = $("#memory-results");
  if (!container) return;
  if (state.memoryLoading) {
    container.innerHTML = '<div class="memory-empty"><strong>Ищем записи…</strong></div>';
    return;
  }
  if (!state.memoryItems.length) {
    container.innerHTML = `
      <div class="memory-empty">
        <strong>Память пока пуста</strong>
        <p>Codex сохранит устойчивые решения и факты через MCP, или добавьте запись вручную.</p>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="memory-result-count">Найдено: ${state.memoryTotal}</div>
    ${state.memoryItems.map(renderMemoryCard).join("")}
  `;
  container.querySelectorAll("[data-memory-edit]").forEach((button) => {
    button.addEventListener("click", () => toggleMemoryEditor(button.dataset.memoryEdit));
  });
  container.querySelectorAll("[data-memory-cancel]").forEach((button) => {
    button.addEventListener("click", () => toggleMemoryEditor(button.dataset.memoryCancel, false));
  });
  container.querySelectorAll("[data-memory-save]").forEach((form) => {
    form.addEventListener("submit", (event) => void saveMemory(event, form.dataset.memorySave));
  });
  container.querySelectorAll("[data-memory-delete]").forEach((button) => {
    button.addEventListener("click", () => void deleteMemory(button.dataset.memoryDelete));
  });
}

function renderMemoryCard(item) {
  return `
    <article class="memory-card" data-memory-card="${escapeHtml(item.id)}">
      <div class="memory-card-meta">
        <span class="memory-kind">${escapeHtml(KIND_LABELS[item.kind] ?? item.kind)}</span>
        <span>${escapeHtml(scopeLabel(item))}</span>
        <span>${relativeTime(item.updatedAt)}</span>
      </div>
      <p class="memory-card-content">${escapeHtml(item.content)}</p>
      <div class="memory-card-actions">
        <button type="button" data-memory-edit="${escapeHtml(item.id)}">Изменить</button>
        <button type="button" data-memory-delete="${escapeHtml(item.id)}">Забыть</button>
      </div>
      <form class="memory-edit-form" data-memory-save="${escapeHtml(item.id)}" hidden>
        <textarea name="content" rows="4">${escapeHtml(item.content)}</textarea>
        <div>
          <select name="kind">${kindOptions(item.kind)}</select>
          <label>Уверенность <input name="confidence" type="number" min="0" max="1" step="0.05" value="${item.confidence}" /></label>
          <button type="submit">Сохранить</button>
          <button type="button" data-memory-cancel="${escapeHtml(item.id)}">Отмена</button>
        </div>
      </form>
    </article>`;
}

function kindOptions(selected) {
  return Object.entries(KIND_LABELS).map(([value, label]) =>
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  ).join("");
}

function scopeLabel(item) {
  if (item.scopeType === "global") return "Общее";
  if (item.scopeType === "chat") {
    const chat = state.chats.find((entry) => entry.id === item.scopeId);
    return `Чат · ${chat?.title || item.scopeId?.slice(0, 8) || "удалён"}`;
  }
  const project = state.projects.find((entry) => entry.id === item.scopeId);
  return `${item.scopeType === "learning" ? "Учёба" : "Проект"} · ${project?.name || item.scopeId?.slice(0, 8) || "удалён"}`;
}

function toggleMemoryEditor(id, open = true) {
  const card = document.querySelector(`[data-memory-card="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelector(".memory-edit-form").hidden = !open;
  card.querySelector(".memory-card-content").hidden = open;
}

async function saveMemory(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await api(`/api/memory/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: form.elements.content.value,
        kind: form.elements.kind.value,
        confidence: Number(form.elements.confidence.value),
      }),
    });
    await loadMemory();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
}

async function deleteMemory(id) {
  if (!confirm("Забыть эту запись? Она не будет автоматически создана снова.")) return;
  try {
    await api(`/api/memory/${id}`, { method: "DELETE" });
    await loadMemory();
  } catch (error) {
    alert(error.message);
  }
}

function createScopeOptions() {
  const scope = $("#memory-create-scope").value;
  const select = $("#memory-create-scope-id");
  if (scope === "global") {
    select.innerHTML = '<option value="">Для всех проектов и чатов</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const values = scope === "chat"
    ? state.chats.map((chat) => ({ id: chat.id, name: chat.title || `Чат ${chat.id.slice(0, 8)}` }))
    : state.projects
      .filter((project) => scope !== "learning" || project.kind === "learning")
      .map((project) => ({ id: project.id, name: project.name }));
  select.innerHTML = values.length
    ? values.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")
    : '<option value="">Нет доступных областей</option>';
}

async function createMemory(event) {
  event.preventDefault();
  const scopeType = $("#memory-create-scope").value;
  try {
    await api("/api/memory", {
      method: "POST",
      body: JSON.stringify({
        scopeType,
        scopeId: scopeType === "global" ? null : $("#memory-create-scope-id").value,
        kind: $("#memory-create-kind").value,
        content: $("#memory-create-content").value,
      }),
    });
    $("#memory-create-form").reset();
    $("#memory-create-form").hidden = true;
    createScopeOptions();
    await loadMemory();
  } catch (error) {
    alert(error.message);
  }
}

async function exportMemory() {
  try {
    const snapshot = await api("/api/memory/export");
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `ronix-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  } catch (error) {
    alert(error.message);
  }
}

async function importMemoryFile(file) {
  if (!file) return;
  try {
    const snapshot = JSON.parse(await file.text());
    const { preview } = await api("/api/memory/import", {
      method: "POST",
      body: JSON.stringify({ snapshot, confirmed: false }),
    });
    const unmatched = preview.unmatchedProjects.length
      ? `\nНе найдены проекты: ${preview.unmatchedProjects.map((item) => item.name).join(", ")}. Их данные будут пропущены.`
      : "";
    if (!confirm(`Импортировать ${preview.memories} записей памяти, ${preview.chats} чатов и ${preview.messages} сообщений?${unmatched}`)) return;
    const { result } = await api("/api/memory/import", {
      method: "POST",
      body: JSON.stringify({ snapshot, confirmed: true }),
    });
    alert(`Импорт завершён: ${result.memories} записей памяти, ${result.chats} чатов, ${result.messages} сообщений.`);
    await loadMemory();
  } catch (error) {
    alert(error.message);
  } finally {
    $("#memory-import-file").value = "";
  }
}

export function bindMemory() {
  $("#memory-search")?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadMemory(), 220);
  });
  $("#memory-scope")?.addEventListener("change", () => void loadMemory());
  $("#memory-kind")?.addEventListener("change", () => void loadMemory());
  $("#memory-new")?.addEventListener("click", () => {
    $("#memory-create-form").hidden = false;
    createScopeOptions();
    $("#memory-create-content").focus();
  });
  $("#memory-create-cancel")?.addEventListener("click", () => {
    $("#memory-create-form").hidden = true;
  });
  $("#memory-create-scope")?.addEventListener("change", createScopeOptions);
  $("#memory-create-form")?.addEventListener("submit", createMemory);
  $("#memory-export")?.addEventListener("click", () => void exportMemory());
  $("#memory-import")?.addEventListener("click", () => $("#memory-import-file").click());
  $("#memory-import-file")?.addEventListener("change", (event) => void importMemoryFile(event.target.files?.[0]));
}
