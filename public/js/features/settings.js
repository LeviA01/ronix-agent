import { state } from "../core/state.js";
import { $, $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { storeString } from "../core/storage.js";
import { setSidebarOpen } from "../layout/panels.js";
import { rememberProject } from "./models.js";
import { saveCurrentDraft } from "./composer.js";

const settingsModal = () => $("#settings-modal");

export function closeSettings() {
  const modal = settingsModal();
  if (modal) modal.hidden = true;
}

export function selectSettingsTab(tab) {
  state.settingsTab = tab === "appearance" ? "appearance" : "projects";
  $$("[data-settings-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === state.settingsTab);
  });
  $$("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== state.settingsTab;
  });
}

export function openSettings() {
  setSidebarOpen(false);
  renderSettingsProjects();
  selectSettingsTab(state.settingsTab);
  settingsModal().hidden = false;
}

export function renderSettingsProjects() {
  const container = $("#settings-project-list");
  if (!container) return;
  if (!state.projects.length) {
    container.innerHTML = `<div class="settings-empty">Проекты ещё не добавлены.</div>`;
    return;
  }
  container.innerHTML = state.projects.map((project) => `
    <form class="settings-project" data-project-form="${escapeHtml(project.id)}">
      <div class="settings-project-main">
        <label>
          <span>Название</span>
          <input
            name="name"
            value="${escapeHtml(project.name)}"
            autocomplete="off"
            required
          />
        </label>
        <label>
          <span>Путь</span>
          <input
            name="path"
            value="${escapeHtml(project.path)}"
            autocomplete="off"
            required
          />
        </label>
      </div>
      <div class="settings-project-meta">
        <span>${escapeHtml(project.kind === "learning" ? "Учебный" : "Dev")}</span>
        <code>${escapeHtml(project.id.slice(0, 8))}</code>
      </div>
      <div class="settings-project-actions">
        <button type="submit">Сохранить</button>
        ${project.kind === "learning"
          ? ""
          : `<button type="button" data-project-learning="${escapeHtml(project.id)}">Сделать учебным</button>`}
        <button type="button" class="danger" data-project-remove="${escapeHtml(project.id)}">
          Убрать из Ronix
        </button>
      </div>
    </form>
  `).join("");
  container.querySelectorAll("[data-project-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveProjectSettings(form);
    });
  });
  container.querySelectorAll("[data-project-learning]").forEach((button) => {
    button.addEventListener("click", () => void makeProjectLearning(button.dataset.projectLearning));
  });
  container.querySelectorAll("[data-project-remove]").forEach((button) => {
    button.addEventListener("click", () => void removeProjectFromRonix(button.dataset.projectRemove));
  });
}

async function saveProjectSettings(form) {
  const projectId = form.dataset.projectForm;
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const name = form.elements.name.value.trim();
  const path = form.elements.path.value.trim();
  if (!name || !path) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const { project: updated } = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name, path }),
    });
    state.projects = state.projects.map((item) => item.id === updated.id ? updated : item);
    rememberProject($("#project").value || updated.id);
    const { loadProjects } = await import("./projects.js");
    await loadProjects();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function makeProjectLearning(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || project.kind === "learning") return;
  try {
    const { project: updated } = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ kind: "learning" }),
    });
    state.projects = state.projects.map((item) => item.id === updated.id ? updated : item);
    if ($("#project").value === updated.id) {
      state.learningMode = "course";
      storeString("ronix-agent-learning-mode", state.learningMode);
    }
    rememberProject($("#project").value || updated.id);
    const { loadProjects } = await import("./projects.js");
    await loadProjects();
  } catch (error) {
    alert(error.message);
  }
}

async function removeProjectFromRonix(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (
    !confirm(
      `Убрать ${project.name} из Ronix? Сессии и история Ronix будут удалены, папка проекта останется на диске.`,
    )
  ) {
    return;
  }
  try {
    const wasSelected = $("#project").value === project.id;
    if (wasSelected) {
      saveCurrentDraft();
      const { resetProjectSessionView } = await import("./sessions.js");
      resetProjectSessionView();
      rememberProject(null);
    }
    await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    state.projects = state.projects.filter((item) => item.id !== project.id);
    const { loadProjects } = await import("./projects.js");
    await loadProjects();
  } catch (error) {
    alert(error.message);
  }
}

export function bindSettings() {
  $("#show-settings")?.addEventListener("click", openSettings);
  $$("[data-close-settings]").forEach((button) => {
    button.addEventListener("click", closeSettings);
  });
  $$("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
  });
}
