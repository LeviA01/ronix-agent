import { state } from "../core/state.js";
import { hasModule } from "../core/access.js";
import { isProjectSurface, migrateProjectNavigation, projectSurface, projectsForSurface, resolveSurface } from "../core/navigation.js";
import { $, $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml } from "../core/format.js";
import { setSidebarOpen } from "../layout/panels.js";
import { bindPopover } from "../layout/popovers.js";
import { openDialog, closeDialog } from "../layout/dialogs.js";
import { currentProjectId, selectedProject } from "./context.js";
import { rememberProject } from "./models.js";
import { renderSettingsProjects } from "./settings.js";
import { loadSessions, resetProjectSessionView } from "./sessions.js";
import { saveCurrentDraft } from "./composer.js";
import { renderEvents } from "../events/render.js";

let projectMenu;
let submitting = false;
const createProjectModal = () => $("#create-project-modal");

export function closeCreateProject() {
  if (!submitting) closeDialog(createProjectModal());
}

export function openCreateProject() {
  if (!isProjectSurface(state.surface) || submitting) return;
  const kind = state.surface === "learning" ? "learning" : "dev";
  state.pendingProject = { folder: "", kind, create: false };
  $("#project-form").reset();
  $("#project-folder-fields").hidden = false;
  $("#project-create-confirmation").hidden = true;
  $("#project-form-back").hidden = true;
  $("#project-form-error").hidden = true;
  $("#project-submit").textContent = "Добавить";
  $("#create-project-title").textContent = kind === "learning" ? "Добавить учебный проект" : "Добавить проект разработки";
  $("#project-root-hint").textContent = state.projectRoots[0]
    ? `Будет найдено или создано в ${state.projectRoots[0]}`
    : "Корневая папка проектов не настроена";
  setSidebarOpen(false);
  openDialog(createProjectModal(), {
    returnFocus: () => $("#project-trigger"), initialFocus: $("#project-folder"),
  });
}

function filterProjects() {
  const query = $("#project-search").value.trim().toLocaleLowerCase("ru");
  let visible = 0;
  $$("[data-select-project]").forEach((button) => {
    button.hidden = !button.textContent.toLocaleLowerCase("ru").includes(query);
    if (!button.hidden) visible++;
  });
  const empty = $("#project-search-empty");
  empty.hidden = visible > 0;
  empty.textContent = projectsForSurface(state.projects, state.surface).length
    ? "Проекты не найдены" : "Здесь пока нет проектов. Добавьте первый, чтобы начать работу.";
}

export function renderProjectPicker() {
  const projects = projectsForSurface(state.projects, state.surface);
  const selected = selectedProject();
  rememberProject(selected?.id ?? null);
  $("#project-trigger").hidden = !isProjectSurface(state.surface);
  $("#project-current").textContent = selected?.name ?? "Выбрать проект";
  $("#project-trigger").title = selected?.name ?? "Выбрать проект";
  $("#project-trigger").setAttribute("aria-label", selected ? `Выбрать проект: ${selected.name}` : "Выбрать проект");
  $("#project-menu-title").textContent = state.surface === "learning" ? "Учебные проекты" : "Проекты разработки";
  $("#project-options").innerHTML = projects.map((project) => `
    <button type="button" class="popover-option project-option" data-select-project="${escapeHtml(project.id)}"
      data-popover-item aria-pressed="${project.id === selected?.id}">
      <span>${escapeHtml(project.name)}</span>
      <svg class="project-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
    </button>
  `).join("");
  filterProjects();
}

export async function selectProject(projectId) {
  if (!projectsForSurface(state.projects, state.surface).some((project) => project.id === projectId)) return;
  projectMenu.close(true);
  if (currentProjectId() === projectId) return;
  saveCurrentDraft();
  rememberProject(projectId);
  $("#session-search").value = "";
  resetProjectSessionView();
  renderProjectPicker();
  try {
    await loadSessions();
    if (currentProjectId() === projectId) renderEvents();
  } catch (error) {
    if (currentProjectId() === projectId) alert(error.message);
  }
}

export async function loadProjects({ refreshSessions = true } = {}) {
  const { projects, projectRoots = [] } = await api("/api/projects");
  const previousId = currentProjectId();
  state.projects = projects;
  state.projectRoots = projectRoots;
  migrateProjectNavigation(state.navigation, projects);
  state.surface = resolveSurface(state.surface, projects, state.navigation, hasModule);
  if (isProjectSurface(state.surface) && previousId !== currentProjectId()) {
    saveCurrentDraft();
    resetProjectSessionView();
  }
  renderProjectPicker();
  renderSettingsProjects();
  if (refreshSessions) await loadSessions();
}

async function addProject(folder, create, kind) {
  const { project } = await api("/api/projects", {
    method: "POST", body: JSON.stringify({ path: folder, create, kind }),
  });
  saveCurrentDraft();
  state.projects = [...state.projects.filter((item) => item.id !== project.id), project];
  resetProjectSessionView();
  state.navigation.projectsBySurface ??= {};
  state.navigation.projectsBySurface[projectSurface(project)] = project.id;
  const { setSurface } = await import("./surfaces.js");
  await setSurface(projectSurface(project));
  renderSettingsProjects();
}

function setSubmitting(value) {
  submitting = value;
  $("#project-form").setAttribute("aria-busy", String(value));
  createProjectModal().querySelectorAll("button, input").forEach((element) => { element.disabled = value; });
}

export function bindProjects() {
  projectMenu = bindPopover($("#project-trigger"), $("#project-menu"), {
    onOpen: () => { $("#project-search").value = ""; renderProjectPicker(); },
  });
  $("#project-search").addEventListener("input", filterProjects);
  $("#project-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-project]");
    if (button) void selectProject(button.dataset.selectProject);
  });
  $("#add-project").addEventListener("click", openCreateProject);
  $("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !state.pendingProject) return;
    const pending = state.pendingProject;
    const folder = $("#project-folder").value.trim();
    if (!folder) return;
    setSubmitting(true);
    $("#project-form-error").hidden = true;
    try {
      await addProject(folder, pending.create, pending.kind);
      setSubmitting(false);
      closeCreateProject();
    } catch (error) {
      if (error.code === "PROJECT_NOT_FOUND" && !pending.create) {
        pending.create = true;
        $("#create-project-path").textContent = error.path;
        $("#project-folder-fields").hidden = true;
        $("#project-create-confirmation").hidden = false;
        $("#project-form-back").hidden = false;
        $("#project-submit").textContent = "Создать проект";
      } else {
        $("#project-form-error").textContent = error.message;
        $("#project-form-error").hidden = false;
      }
    } finally {
      setSubmitting(false);
      if (createProjectModal().open) $("#project-submit").focus();
    }
  });
  $("#project-form-back").addEventListener("click", () => {
    state.pendingProject.create = false;
    $("#project-folder-fields").hidden = false;
    $("#project-create-confirmation").hidden = true;
    $("#project-form-back").hidden = true;
    $("#project-form-error").hidden = true;
    $("#project-submit").textContent = "Добавить";
    $("#project-folder").focus();
  });
  $$("[data-cancel-project]").forEach((button) => button.addEventListener("click", closeCreateProject));
  createProjectModal().addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  createProjectModal().addEventListener("close", () => { state.pendingProject = null; });
  createProjectModal().addEventListener("click", (event) => {
    const rect = createProjectModal().getBoundingClientRect();
    if (event.target === createProjectModal() && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeCreateProject();
  });
}
