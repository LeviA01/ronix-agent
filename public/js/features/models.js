import { state } from "../core/state.js";
import { storeJson } from "../core/storage.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml, effortLabel } from "../core/format.js";

export function rememberProject(projectId) {
  state.navigation.projectId = projectId;
  state.navigation.sessionsByProject ??= {};
  storeJson("ronix-agent-navigation", state.navigation);
}

export function rememberSession(projectId, sessionId) {
  state.navigation.projectId = projectId;
  state.navigation.sessionsByProject ??= {};
  state.navigation.sessionsByProject[projectId] = sessionId;
  storeJson("ronix-agent-navigation", state.navigation);
}

export function forgetSession(projectId) {
  state.navigation.sessionsByProject ??= {};
  delete state.navigation.sessionsByProject[projectId];
  storeJson("ronix-agent-navigation", state.navigation);
}

export function rememberModelSettings(session) {
  if (!session?.model || !session?.reasoningEffort) return;
  state.modelPreference = {
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  };
  storeJson("ronix-agent-model-preference", state.modelPreference);
}

export function preferredModelSettings() {
  if (state.models.length === 0) return {};
  const model = state.models.find(
    (item) => item.model === state.modelPreference.model,
  ) ?? state.models.find((item) => item.isDefault) ?? state.models[0];
  const reasoningEffort = model.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === state.modelPreference.reasoningEffort,
  )
    ? state.modelPreference.reasoningEffort
    : model.defaultReasoningEffort;
  return { model: model.model, reasoningEffort };
}

export function currentModel(session = state.selectedSession) {
  return state.models.find((model) => model.model === session?.model)
    ?? state.models.find((model) => model.isDefault)
    ?? state.models[0]
    ?? null;
}

export async function loadModels() {
  try {
    const { models } = await api("/api/codex/models");
    state.models = models;
    state.modelError = null;
  } catch (error) {
    state.models = [];
    state.modelError = error.message;
  }
  renderModelControls(state.selectedSession);
}

export function renderModelControls(session) {
  const modelSelect = $("#model-select");
  const effortSelect = $("#reasoning-effort");
  if (!modelSelect || !effortSelect) return;

  const selectedModel = currentModel(session);
  if (!selectedModel) {
    modelSelect.innerHTML = `<option>${escapeHtml(
      state.modelError ? "Модели недоступны" : "Загрузка…",
    )}</option>`;
    effortSelect.innerHTML = "<option>—</option>";
    modelSelect.disabled = true;
    effortSelect.disabled = true;
    return;
  }

  modelSelect.innerHTML = state.models
    .map((model) => `
      <option value="${escapeHtml(model.model)}">${escapeHtml(model.displayName)}</option>
    `)
    .join("");
  modelSelect.value = selectedModel.model;
  effortSelect.innerHTML = selectedModel.supportedReasoningEfforts
    .map((option) => `
      <option
        value="${escapeHtml(option.reasoningEffort)}"
        title="${escapeHtml(option.description)}"
      >${escapeHtml(effortLabel(option.reasoningEffort))}</option>
    `)
    .join("");
  const selectedEffort = selectedModel.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === session?.reasoningEffort,
  )
    ? session.reasoningEffort
    : selectedModel.defaultReasoningEffort;
  effortSelect.value = selectedEffort;
  const disabled = !session || session.status === "running";
  modelSelect.disabled = disabled;
  effortSelect.disabled = disabled;
}

export async function normalizeSessionModel(session) {
  if (!session.model || state.models.length === 0 || session.status === "running") {
    return session;
  }
  const model = state.models.find((item) => item.model === session.model);
  const fallback = model
    ?? state.models.find((item) => item.isDefault)
    ?? state.models[0];
  const hasValidEffort = fallback.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === session.reasoningEffort,
  );
  if (model && hasValidEffort) return session;
  const { session: normalized } = await api(`/api/sessions/${session.id}/settings`, {
    method: "POST",
    body: JSON.stringify({
      model: fallback.model,
      reasoningEffort: hasValidEffort
        ? session.reasoningEffort
        : fallback.defaultReasoningEffort,
    }),
  });
  rememberModelSettings(normalized);
  return normalized;
}

export async function updateSessionSettings(update) {
  if (!state.sessionId) return;
  const modelSelect = $("#model-select");
  const effortSelect = $("#reasoning-effort");
  const sandboxSelect = $("#sandbox-mode");
  modelSelect.disabled = true;
  effortSelect.disabled = true;
  sandboxSelect.disabled = true;
  try {
    const { session } = await api(`/api/sessions/${state.sessionId}/settings`, {
      method: "POST",
      body: JSON.stringify(update),
    });
    rememberModelSettings(session);
    const { renderSessionMeta } = await import("./sessions.js");
    renderSessionMeta(session);
    const { loadSessions } = await import("./sessions.js");
    await loadSessions();
  } catch (error) {
    alert(error.message);
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    const { renderSessionMeta } = await import("./sessions.js");
    renderSessionMeta(session);
  }
}
