import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { storeJson } from "../core/storage.js";

const promptInput = () => $("#prompt");

export function resizePrompt() {
  const input = promptInput();
  const form = $("#prompt-form");
  if (!input || !form) return;
  const style = getComputedStyle(input);
  const minHeight = Number.parseFloat(style.minHeight) || 44;
  const maxHeight = Number.parseFloat(style.maxHeight) || 180;
  if (form.hidden) {
    input.style.height = `${minHeight}px`;
    return;
  }
  if (!input.value) {
    input.style.height = `${minHeight}px`;
    return;
  }
  input.style.height = `${minHeight}px`;
  input.style.height = `${Math.max(
    minHeight,
    Math.min(input.scrollHeight, maxHeight),
  )}px`;
}

export function saveCurrentDraft() {
  if (!state.sessionId) return;
  const value = promptInput()?.value ?? "";
  if (value) state.drafts[state.sessionId] = value;
  else delete state.drafts[state.sessionId];
  persistDrafts();
}

export function restoreDraft(sessionId) {
  const input = promptInput();
  if (!input) return;
  input.value = state.drafts[sessionId] ?? "";
  resizePrompt();
}

export function persistDrafts() {
  storeJson("ronix-agent-drafts", state.drafts);
}

export function clearPrompt() {
  const input = promptInput();
  if (!input) return;
  input.value = "";
  resizePrompt();
}

export function setPromptValue(value) {
  const input = promptInput();
  if (!input) return;
  input.value = value;
  resizePrompt();
  saveCurrentDraft();
  input.focus();
}

export function bindComposer({ setSettingsOpen }) {
  const form = $("#prompt-form");
  const input = promptInput();
  if (!form || !input) return;

  input.addEventListener("focus", () => setSettingsOpen(false));
  input.addEventListener("input", () => {
    resizePrompt();
    saveCurrentDraft();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!$("#send")?.disabled) form.requestSubmit();
    }
  });
}
