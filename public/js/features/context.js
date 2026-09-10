import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { selectedProjectId } from "../core/navigation.js";

export function setConnection(text) {
  const indicator = $("#connection");
  if (!indicator) return;
  indicator.className = `connection-dot ${text}`;
  indicator.title = {
    connected: "Подключено",
    ready: "Готово",
    reconnecting: "Переподключение…",
    error: "Ошибка подключения",
  }[text] ?? text;
}

export function currentProjectId() {
  return selectedProjectId(state.projects, state.surface, state.navigation);
}

export function selectedProject() {
  return state.projects.find((project) => project.id === currentProjectId()) ?? null;
}

export function isLearningProject() {
  return selectedProject()?.kind === "learning";
}
