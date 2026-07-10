import { $ } from "../core/dom.js";

const appShell = () => $(".app-shell");
const chat = () => $(".chat");

export function getChat() {
  return chat();
}

export function setSidebarOpen(open) {
  if (open) setSettingsOpen(false);
  if (open) setGitOpen(false);
  appShell().classList.toggle("sidebar-open", open);
  $("#open-sidebar")?.setAttribute("aria-expanded", String(open));
  if (open) $("#project")?.focus({ preventScroll: true });
}

export function setSettingsOpen(open) {
  if (open) setGitOpen(false);
  chat()?.classList.toggle("settings-open", open);
  $("#toggle-settings")?.setAttribute("aria-expanded", String(open));
}

export function setGitOpen(open) {
  if (open) setSettingsOpen(false);
  chat()?.classList.toggle("git-open", open);
  $("#toggle-git")?.setAttribute("aria-expanded", String(open));
}

export function isSettingsOpen() {
  return chat()?.classList.contains("settings-open") ?? false;
}

export function isGitOpen() {
  return chat()?.classList.contains("git-open") ?? false;
}

export function syncViewportHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

export function bindLayoutControls({ closeLimits, closeSettings, closeCreateProject }) {
  $("#open-sidebar")?.addEventListener("click", () => setSidebarOpen(true));
  $("#close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
  $("#sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
  $("#toggle-settings")?.addEventListener("click", () => {
    setSettingsOpen(!isSettingsOpen());
  });
  $("#toggle-git")?.addEventListener("click", () => {
    setGitOpen(!isGitOpen());
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setSidebarOpen(false);
      setSettingsOpen(false);
      setGitOpen(false);
      closeLimits?.();
      closeSettings?.();
      closeCreateProject?.();
    }
  });

  window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
    if (event.matches) {
      setSidebarOpen(false);
      setSettingsOpen(false);
      setGitOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (
      target.closest("#session-settings")
      || target.closest("#toggle-settings")
      || target.closest("#git-panel")
      || target.closest("#toggle-git")
    ) {
      return;
    }
    setSettingsOpen(false);
    setGitOpen(false);
  });

  syncViewportHeight();
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
}
