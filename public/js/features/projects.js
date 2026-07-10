import { state } from "../core/state.js";
import { $, $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { setSidebarOpen } from "../layout/panels.js";
import { rememberProject } from "./models.js";
import { renderSettingsProjects } from "./settings.js";
import { loadSessions, resetProjectSessionView } from "./sessions.js";
import { saveCurrentDraft } from "./composer.js";
import { renderEvents } from "../events/render.js";

const createProjectModal = () => $("#create-project-modal");

export function closeCreateProject() {
  const modal = createProjectModal();
  if (modal) modal.hidden = true;
  state.pendingProject = null;
}

export async function loadProjects() {
  const { projects, projectRoots = [] } = await api("/api/projects");
  state.projects = projects;
  state.projectRoots = projectRoots;
  $("#project-root-hint").textContent = projectRoots[0]
    ? `Будет найдено или создано в ${projectRoots[0]}`
    : "Корневая папка проектов не настроена";
  $("#project").innerHTML = projects
    .map((project) => `
      <option value="${project.id}">${escapeHtml(
        project.kind === "learning" ? `${project.name} · учёба` : project.name,
      )}</option>
    `)
    .join("");
  const rememberedProject = projects.find(
    (project) => project.id === state.navigation.projectId,
  );
  if (rememberedProject) $("#project").value = rememberedProject.id;
  rememberProject($("#project").value || null);
  renderSettingsProjects();
  await loadSessions();
}

async function addProject(folder, create = false, kind = "dev") {
  const { project } = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: folder, create, kind }),
  });
  $("#project-form").reset();
  saveCurrentDraft();
  state.projects = [
    ...state.projects.filter((item) => item.id !== project.id),
    project,
  ];
  const option = document.createElement("option");
  option.value = project.id;
  option.textContent = project.name;
  $("#project").append(option);
  $("#project").value = project.id;
  resetProjectSessionView();
  rememberProject(project.id);
  await loadProjects();
  closeCreateProject();
  $(".add-project").open = false;
  setSidebarOpen(false);
}

export function bindProjects() {
  $("#project")?.addEventListener("change", async () => {
    saveCurrentDraft();
    resetProjectSessionView();
    rememberProject($("#project").value || null);
    await loadSessions();
    renderEvents();
  });

  $("#project-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const folder = $("#project-folder").value.trim();
    const kind = $("#project-kind-learning").checked ? "learning" : "dev";
    if (!folder) return;
    try {
      await addProject(folder, false, kind);
    } catch (error) {
      if (error.code === "PROJECT_NOT_FOUND") {
        state.pendingProject = { folder, kind };
        $("#create-project-path").textContent = error.path;
        createProjectModal().hidden = false;
        return;
      }
      alert(error.message);
    }
  });

  $$("[data-cancel-project]").forEach((button) => {
    button.addEventListener("click", closeCreateProject);
  });

  $("#confirm-create-project")?.addEventListener("click", async () => {
    if (!state.pendingProject) return;
    const button = $("#confirm-create-project");
    button.disabled = true;
    try {
      await addProject(state.pendingProject.folder, true, state.pendingProject.kind);
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
}
