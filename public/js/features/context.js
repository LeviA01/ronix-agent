import { state } from "../core/state.js";
import { $ } from "../core/dom.js";

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

export function selectedProject() {
  return state.projects.find((project) => project.id === $("#project")?.value) ?? null;
}

export function isLearningProject() {
  return selectedProject()?.kind === "learning";
}
