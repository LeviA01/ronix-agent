import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { sessionViewToken } from "../core/session-view.js";

let lastTop = 0;
let frame = null;

export function isChatHistory() {
  return Boolean(state.sessionId) && state.surface !== "memory"
    && !(state.surface === "learning" && (state.learningMode === "progress"
      || state.learningMode === "theory" && state.theoryTab === "materials"));
}

function atBottom(container) {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= 2;
}

export function updateScrollButton() {
  const container = $("#events");
  const button = $("#scroll-to-latest");
  if (!container || !button) return;
  button.hidden = !isChatHistory() || !state.historyReady || atBottom(container);
}

export function setHistoryScrollTop(top) {
  const container = $("#events");
  if (!container) return;
  container.scrollTop = top;
  lastTop = container.scrollTop;
  updateScrollButton();
}

export function pauseFollowing() {
  state.followLatest = false;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
}

export function followHistory() {
  if (frame !== null) cancelAnimationFrame(frame);
  const isCurrent = sessionViewToken();
  frame = requestAnimationFrame(() => {
    frame = null;
    // The user may have scrolled or switched chats since the render began.
    if (isCurrent() && state.followLatest && isChatHistory()) {
      setHistoryScrollTop($("#events").scrollHeight);
    }
  });
}

export function jumpToLatest() {
  state.followLatest = true;
  setHistoryScrollTop($("#events").scrollHeight);
  followHistory();
}

export function restoreHistoryScroll(top, follow = state.followLatest) {
  // Restore synchronously: rebuilding the DOM can clamp scrollTop to zero and
  // otherwise make a reader look as if they had returned to the latest message.
  setHistoryScrollTop(top);
  if (follow && state.followLatest) followHistory();
}

export function bindChatScroll() {
  const container = $("#events");
  const button = $("#scroll-to-latest");
  button.addEventListener("click", () => {
    jumpToLatest();
    container.focus({ preventScroll: true });
  });
  container.addEventListener("scroll", () => {
    const top = container.scrollTop;
    if (top < lastTop - 1) pauseFollowing();
    else if (top > lastTop + 1 && atBottom(container)) state.followLatest = true;
    lastTop = top;
    updateScrollButton();
  }, { passive: true });
  // Cancel queued animation frames before the browser performs the scroll.
  container.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) pauseFollowing();
  }, { passive: true });
  let touchY = null;
  container.addEventListener("touchstart", (event) => {
    touchY = event.touches[0]?.clientY ?? null;
  }, { passive: true });
  container.addEventListener("touchmove", (event) => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y > touchY + 2) pauseFollowing();
    touchY = y ?? null;
  }, { passive: true });
  container.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) pauseFollowing();
    if (event.key === "End") { event.preventDefault(); jumpToLatest(); }
  });
  new ResizeObserver(() => {
    if (state.followLatest) followHistory();
    updateScrollButton();
  }).observe(container);
  new MutationObserver(updateScrollButton).observe(container, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"],
  });
}
