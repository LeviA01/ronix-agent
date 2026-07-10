import { state } from "./core/state.js";
import { $ } from "./core/dom.js";
import { api } from "./core/api.js";
import { storeString } from "./core/storage.js";
import { applyTheme, bindThemeControls } from "./layout/theme.js";
import { bindLayoutControls, setSettingsOpen } from "./layout/panels.js";
import { setConnection } from "./features/context.js";
import { closeLimits, bindLimits } from "./features/limits.js";
import { closeSettings, bindSettings } from "./features/settings.js";
import { closeCreateProject, bindProjects, loadProjects } from "./features/projects.js";
import { bindSessions } from "./features/sessions.js";
import { bindComposer } from "./features/composer.js";
import { loadModels, currentModel, updateSessionSettings } from "./features/models.js";
import { bindEventActions } from "./events/stream.js";
import { renderEvents } from "./events/render.js";

export async function bootstrap() {
  applyTheme(state.theme);
  bindThemeControls();
  bindLayoutControls({
    closeLimits,
    closeSettings,
    closeCreateProject,
  });
  bindLimits();
  bindSettings();
  bindProjects();
  bindSessions();
  bindComposer({ setSettingsOpen });
  bindEventActions();

  $("#show-technical").checked = state.showTechnical;
  $("#show-technical")?.addEventListener("change", (event) => {
    state.showTechnical = event.target.checked;
    storeString("ronix-agent-technical", String(state.showTechnical));
    renderEvents();
  });

  $("#sandbox-mode")?.addEventListener("change", async (event) => {
    if (!state.sessionId) return;
    const select = event.target;
    if (
      select.value === "danger-full-access"
      && !confirm("Полный доступ снимает ограничения файловой системы и отключает approvals. Продолжить?")
    ) {
      const { session } = await api(`/api/sessions/${state.sessionId}`);
      const { renderSessionMeta } = await import("./features/sessions.js");
      renderSessionMeta(session);
      return;
    }
    await updateSessionSettings({ sandboxMode: select.value });
  });

  $("#model-select")?.addEventListener("change", async (event) => {
    const model = state.models.find((item) => item.model === event.target.value);
    if (!model) return;
    await updateSessionSettings({
      model: model.model,
      reasoningEffort: model.defaultReasoningEffort,
    });
  });

  $("#reasoning-effort")?.addEventListener("change", async (event) => {
    const model = currentModel();
    if (!model) return;
    await updateSessionSettings({
      model: model.model,
      reasoningEffort: event.target.value,
    });
  });

  $("#prompt-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.sessionId) return;
    const prompt = $("#prompt").value.trim();
    if (!prompt) return;
    try {
      $("#send").disabled = true;
      await api(`/api/sessions/${state.sessionId}/turns`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      $("#prompt").value = "";
      delete state.drafts[state.sessionId];
      const { persistDrafts, resizePrompt } = await import("./features/composer.js");
      persistDrafts();
      resizePrompt();
    } catch (error) {
      alert(error.message);
      $("#send").disabled = false;
    }
  });

  fetch("/api/auth/status")
    .then((response) => response.ok ? response.json() : null)
    .then((status) => {
      if (status?.enabled) $("#logout").hidden = false;
    })
    .catch(() => {});

  $("#logout")?.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      location.replace("/login");
    }
  });

  try {
    await loadModels();
    await loadProjects();
    setConnection("ready");
  } catch (error) {
    setConnection("error");
    alert(error.message);
  }
}
