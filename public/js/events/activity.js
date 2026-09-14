import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { isChatHistory } from "./scroll.js";

export function describeChatActivity(view) {
  if (!view.sessionId) return null;
  if (Object.keys(view.approvals).length) {
    return { mode: "waiting", text: "Codex ждёт вашего ответа" };
  }
  if (!view.liveTurnActive && view.selectedSession?.status !== "running") return null;
  const detail = view.liveResponse?.detail;
  return { mode: "working", text: detail
    ? `Codex ${detail[0].toLocaleLowerCase("ru")}${detail.slice(1)}`
    : "Codex работает над задачей…" };
}

export function renderChatActivity() {
  const indicator = $("#chat-activity");
  if (!indicator) return;
  const activity = isChatHistory() ? describeChatActivity(state) : null;
  indicator.hidden = !activity;
  indicator.dataset.mode = activity?.mode ?? "";
  const reconnecting = $("#connection")?.classList.contains("reconnecting");
  const text = activity?.mode === "working" && reconnecting
    ? "Восстанавливаем связь с Codex…" : activity?.text ?? "";
  const label = $("#chat-activity-label");
  // Deltas arrive rapidly; announce only actual changes of activity.
  if (label.textContent !== text) label.textContent = text;
  $("#events")?.setAttribute("aria-busy", String(activity?.mode === "working"));
}

export function bindChatActivity() {
  new MutationObserver(renderChatActivity).observe($("#connection"), {
    attributes: true, attributeFilter: ["class"],
  });
  renderChatActivity();
}
