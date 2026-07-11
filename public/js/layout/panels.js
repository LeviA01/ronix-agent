import { $ } from "../core/dom.js";

const appShell = () => $(".app-shell");
const chat = () => $(".chat");

const EDGE_OPEN_WIDTH = 22;
const DRAG_THRESHOLD = 10;
const decel = 0.998;

let cancelSpring = null;
let pointerTrace = [];
let dragSession = null;
let sidebarProgress = 0;
let ignoreNextBackdropClick = false;

export function getChat() {
  return chat();
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function project(velocity, decelerationRate = decel) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

function rubberband(overshoot, dimension, constant = 0.55) {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function getSidebarEl() {
  return $(".sidebar");
}

function getBackdropEl() {
  return $("#sidebar-backdrop");
}

function sidebarWidth() {
  return getSidebarEl()?.offsetWidth || Math.min(window.innerWidth * 0.92, 340);
}

function stopSpring() {
  if (cancelSpring) {
    cancelSpring();
    cancelSpring = null;
  }
}

function applySidebarProgress(progress, { animate = false, velocity = 0 } = {}) {
  const shell = appShell();
  const sidebar = getSidebarEl();
  const backdrop = getBackdropEl();
  if (!shell || !sidebar) return;

  sidebarProgress = Math.max(0, Math.min(1, progress));
  const open = sidebarProgress > 0.5;
  shell.classList.toggle("sidebar-open", open);
  $("#open-sidebar")?.setAttribute("aria-expanded", String(open));

  const x = (sidebarProgress - 1) * sidebarWidth();
  shell.style.setProperty("--sidebar-progress", String(sidebarProgress));
  sidebar.style.setProperty("--sidebar-x", `${x}px`);
  sidebar.style.visibility = sidebarProgress > 0.001 ? "visible" : "hidden";
  if (backdrop) {
    backdrop.style.opacity = String(sidebarProgress);
    backdrop.style.pointerEvents = sidebarProgress > 0.02 ? "auto" : "none";
    if (sidebarProgress > 0.02) backdrop.style.display = "block";
  }

  if (!animate) {
    sidebar.style.transition = "none";
    if (backdrop) backdrop.style.transition = "none";
  }
}

function springSidebarTo(target, initialVelocity = 0) {
  stopSpring();
  const from = sidebarProgress;
  const sidebar = getSidebarEl();
  const backdrop = getBackdropEl();
  const shell = appShell();
  if (!sidebar || !shell) return;

  if (prefersReducedMotion()) {
    applySidebarProgress(target);
    shell.classList.remove("sidebar-dragging");
    sidebar.style.removeProperty("transition");
    if (backdrop) backdrop.style.removeProperty("transition");
    if (target <= 0) {
      sidebar.style.visibility = "hidden";
      if (backdrop) backdrop.style.display = "";
    }
    return;
  }

  // Drawer: response ~0.32, damping 1.0; slight bounce only after a flick
  const hasMomentum = Math.abs(initialVelocity) > 120;
  const response = 0.32;
  const dampingRatio = hasMomentum ? 0.82 : 1;
  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = 2 * dampingRatio * omega;

  const width = sidebarWidth();
  let x = from;
  let v = width > 0 ? initialVelocity / width : 0;
  let last = performance.now();
  let active = true;
  let raf = 0;

  shell.classList.add("sidebar-dragging");
  sidebar.style.transition = "none";
  if (backdrop) backdrop.style.transition = "none";

  const frame = (now) => {
    if (!active) return;
    const dt = Math.min(0.034, (now - last) / 1000);
    last = now;
    v += (-stiffness * (x - target) - damping * v) * dt;
    x += v * dt;

    const visual = Math.max(-0.04, Math.min(1.04, x));
    sidebarProgress = Math.max(0, Math.min(1, x));
    shell.style.setProperty("--sidebar-progress", String(sidebarProgress));
    sidebar.style.setProperty("--sidebar-x", `${(visual - 1) * width}px`);
    sidebar.style.visibility = "visible";
    if (backdrop) {
      backdrop.style.opacity = String(Math.max(0, Math.min(1, sidebarProgress)));
      backdrop.style.pointerEvents = sidebarProgress > 0.02 ? "auto" : "none";
      backdrop.style.display = "block";
    }

    if (Math.abs(v) < 0.02 && Math.abs(x - target) < 0.004) {
      active = false;
      cancelSpring = null;
      applySidebarProgress(target);
      shell.classList.remove("sidebar-dragging");
      sidebar.style.removeProperty("transition");
      if (backdrop) {
        backdrop.style.removeProperty("transition");
        if (target <= 0) backdrop.style.display = "";
      }
      if (target <= 0) sidebar.style.visibility = "hidden";
      shell.classList.toggle("sidebar-open", target > 0.5);
      $("#open-sidebar")?.setAttribute("aria-expanded", String(target > 0.5));
      return;
    }

    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
  cancelSpring = () => {
    active = false;
    cancelAnimationFrame(raf);
    cancelSpring = null;
  };
}

export function setSidebarOpen(open) {
  if (!isMobileLayout()) {
    appShell()?.classList.toggle("sidebar-open", open);
    $("#open-sidebar")?.setAttribute("aria-expanded", String(open));
    return;
  }

  if (open) {
    setSettingsOpen(false);
    setGitOpen(false);
  }

  stopSpring();
  const current = sidebarProgress;
  // Preserve continuity: open/close from live progress
  const target = open ? 1 : 0;
  if (Math.abs(current - target) < 0.001) {
    applySidebarProgress(target);
    return;
  }
  springSidebarTo(target, 0);
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

export function isSidebarOpen() {
  return appShell()?.classList.contains("sidebar-open") ?? false;
}

export function syncViewportHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

function releaseVelocity() {
  if (pointerTrace.length < 2) return 0;
  const last = pointerTrace[pointerTrace.length - 1];
  let prev = pointerTrace[0];
  for (let i = pointerTrace.length - 2; i >= 0; i -= 1) {
    if (last.t - pointerTrace[i].t <= 80) prev = pointerTrace[i];
    else break;
  }
  const dt = last.t - prev.t;
  if (dt <= 0) return 0;
  return ((last.x - prev.x) / dt) * 1000;
}

function recordPointer(x, t) {
  pointerTrace.push({ x, t });
  if (pointerTrace.length > 6) pointerTrace.shift();
}

function bindSidebarGestures() {
  const shell = appShell();
  if (!shell || shell.dataset.sidebarGestures === "1") return;
  shell.dataset.sidebarGestures = "1";

  const onPointerDown = (event) => {
    if (!isMobileLayout() || event.button !== 0) return;
    if (event.pointerType === "mouse" && event.buttons !== 1) return;

    const target = event.target;
    if (target.closest("input, textarea, select, button, a, [contenteditable='true']")) {
      // Allow drag from backdrop and chrome exclusive zones below
      if (!target.closest("#sidebar-backdrop") && !target.closest(".sidebar")) return;
    }

    const open = sidebarProgress > 0.5 || appShell()?.classList.contains("sidebar-open");
    const x = event.clientX;
    const fromEdge = !open && x <= EDGE_OPEN_WIDTH;
    const fromSidebar = open && Boolean(target.closest(".sidebar"));
    const fromBackdrop = open && Boolean(target.closest("#sidebar-backdrop"));

    if (!fromEdge && !fromSidebar && !fromBackdrop) return;

    // On sidebar content, only start drag after horizontal intent (handled in move)
    dragSession = {
      pointerId: event.pointerId,
      startX: x,
      startY: event.clientY,
      originProgress: sidebarProgress > 0.001 && sidebarProgress < 0.999
        ? sidebarProgress
        : (open ? 1 : 0),
      open,
      committed: fromBackdrop || fromEdge,
      fromSidebar,
      fromEdge,
      fromBackdrop,
    };
    pointerTrace = [];
    recordPointer(x, performance.now());

    if (fromBackdrop || fromEdge) {
      stopSpring();
      // seed from presentation
      if (open && sidebarProgress < 0.01) applySidebarProgress(1);
      if (!open && sidebarProgress > 0.99) applySidebarProgress(0);
      dragSession.originProgress = sidebarProgress;
      appShell()?.classList.add("sidebar-dragging");
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const onPointerMove = (event) => {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    const x = event.clientX;
    const y = event.clientY;
    const dx = x - dragSession.startX;
    const dy = y - dragSession.startY;
    recordPointer(x, performance.now());

    if (!dragSession.committed) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      // Direction lock: horizontal wins for drawer
      if (Math.abs(dx) < Math.abs(dy) * 1.15) {
        dragSession = null;
        return;
      }
      // When open, only drag closed if driving left
      if (dragSession.open && dx > 4) {
        dragSession = null;
        return;
      }
      // When closed (edge), only drag open if driving right
      if (!dragSession.open && dx < -4) {
        dragSession = null;
        return;
      }
      dragSession.committed = true;
      stopSpring();
      dragSession.originProgress = sidebarProgress > 0.01 && sidebarProgress < 0.99
        ? sidebarProgress
        : (dragSession.open ? 1 : 0);
      appShell()?.classList.add("sidebar-dragging");
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    }

    event.preventDefault();
    const width = sidebarWidth();
    let next = dragSession.originProgress + dx / width;

    // Rubber-band past ends: progressive resistance, no hard stop
    if (next > 1) {
      next = 1 + rubberband((next - 1) * width, width) / width;
    } else if (next < 0) {
      next = -rubberband(-next * width, width) / width;
    }

    applySidebarProgress(Math.max(0, Math.min(1, next)));
    getSidebarEl()?.style.setProperty("--sidebar-x", `${(next - 1) * width}px`);
    shell.style.setProperty("--sidebar-progress", String(Math.max(0, Math.min(1, next))));
  };

  const finishDrag = (event) => {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    const session = dragSession;
    dragSession = null;

    if (!session.committed) return;

    ignoreNextBackdropClick = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ignoreNextBackdropClick = false;
      });
    });

    const velocity = releaseVelocity();
    const width = sidebarWidth();
    const current = sidebarProgress;
    const projected = current + project(velocity) / width;
    // Projection picks landing; strong flick uses velocity sign
    let target = projected >= 0.5 ? 1 : 0;
    if (Math.abs(velocity) > 500) {
      target = velocity > 0 ? 1 : 0;
    }

    springSidebarTo(target, velocity);
  };

  shell.addEventListener("pointerdown", onPointerDown, { passive: true });
  shell.addEventListener("pointermove", onPointerMove, { passive: false });
  shell.addEventListener("pointerup", finishDrag);
  shell.addEventListener("pointercancel", finishDrag);

  // Sync starting progress with class state
  if (appShell()?.classList.contains("sidebar-open")) {
    sidebarProgress = 1;
  }
}

export function bindLayoutControls({ closeLimits, closeSettings, closeCreateProject }) {
  $("#open-sidebar")?.addEventListener("click", () => setSidebarOpen(true));
  $("#close-sidebar")?.addEventListener("click", () => setSidebarOpen(false));
  $("#sidebar-backdrop")?.addEventListener("click", () => {
    if (ignoreNextBackdropClick) return;
    setSidebarOpen(false);
  });
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
      stopSpring();
      sidebarProgress = 0;
      const shell = appShell();
      const sidebar = getSidebarEl();
      const backdrop = getBackdropEl();
      shell?.classList.remove("sidebar-open", "sidebar-dragging");
      sidebar?.style.removeProperty("--sidebar-x");
      sidebar?.style.removeProperty("visibility");
      sidebar?.style.removeProperty("transition");
      backdrop?.style.removeProperty("opacity");
      backdrop?.style.removeProperty("pointer-events");
      backdrop?.style.removeProperty("display");
      backdrop?.style.removeProperty("transition");
      setSettingsOpen(false);
      setGitOpen(false);
    } else if (appShell()?.classList.contains("sidebar-open")) {
      applySidebarProgress(1);
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

  bindSidebarGestures();
  syncViewportHeight();
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
}
