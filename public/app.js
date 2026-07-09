function loadStoredJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

const THEMES = new Set(["terminal", "neon", "moon"]);

function storedTheme() {
  const theme = localStorage.getItem("ronix-agent-theme") || "terminal";
  return THEMES.has(theme) ? theme : "terminal";
}

const state = {
  projects: [],
  projectRoots: [],
  models: [],
  modelError: null,
  pendingProject: null,
  sessions: [],
  sessionId: null,
  source: null,
  reconnectTimer: null,
  lastSequence: 0,
  firstSequence: 0,
  hasMoreEvents: false,
  events: [],
  approvals: {},
  sessionRefreshTimer: null,
  liveTurnActive: false,
  liveResponse: null,
  liveRenderFrame: null,
  selectedSession: null,
  theme: storedTheme(),
  showTechnical: localStorage.getItem("ronix-agent-technical") === "true",
  learningMode: localStorage.getItem("ronix-agent-learning-mode") || "course",
  progressTab: localStorage.getItem("ronix-agent-progress-tab") || "summary",
  learning: null,
  gitStatus: null,
  gitProjectId: null,
  gitLoading: false,
  gitError: null,
  gitSyncRunning: null,
  gitSyncMessage: null,
  drafts: loadStoredJson("ronix-agent-drafts", {}),
  navigation: loadStoredJson("ronix-agent-navigation", {
    projectId: null,
    sessionsByProject: {},
  }),
  modelPreference: loadStoredJson("ronix-agent-model-preference", {}),
};

const $ = (selector) => document.querySelector(selector);
const appShell = $(".app-shell");
const chat = $(".chat");

function applyTheme(theme) {
  state.theme = THEMES.has(theme) ? theme : "terminal";
  document.body.dataset.theme = state.theme;
  localStorage.setItem("ronix-agent-theme", state.theme);
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeOption === state.theme);
  });
}

applyTheme(state.theme);

if (
  !state.navigation.sessionsByProject
  || typeof state.navigation.sessionsByProject !== "object"
  || Array.isArray(state.navigation.sessionsByProject)
) {
  state.navigation.sessionsByProject = {};
}

function setSidebarOpen(open) {
  if (open) setSettingsOpen(false);
  if (open) setGitOpen(false);
  appShell.classList.toggle("sidebar-open", open);
  $("#open-sidebar").setAttribute("aria-expanded", String(open));
  if (open) $("#project").focus({ preventScroll: true });
}

function setSettingsOpen(open) {
  if (open) setGitOpen(false);
  chat.classList.toggle("settings-open", open);
  $("#toggle-settings").setAttribute("aria-expanded", String(open));
}

function setGitOpen(open) {
  if (open) setSettingsOpen(false);
  chat.classList.toggle("git-open", open);
  $("#toggle-git").setAttribute("aria-expanded", String(open));
}

$("#open-sidebar").addEventListener("click", () => setSidebarOpen(true));
$("#close-sidebar").addEventListener("click", () => setSidebarOpen(false));
$("#sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
$("#toggle-settings").addEventListener("click", () => {
  setSettingsOpen(!chat.classList.contains("settings-open"));
});
$("#toggle-git").addEventListener("click", () => {
  setGitOpen(!chat.classList.contains("git-open"));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSidebarOpen(false);
    setSettingsOpen(false);
    setGitOpen(false);
    closeLimits();
    closeCreateProject();
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

const limitsModal = $("#limits-modal");

function closeLimits() {
  limitsModal.hidden = true;
}

function windowLabel(minutes) {
  if (minutes === 300) return "5 часов";
  if (minutes === 10080) return "7 дней";
  if (!minutes) return "Период";
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

function resetLabel(timestamp) {
  if (!timestamp) return "Время сброса неизвестно";
  return "Сброс " + new Date(timestamp * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTokens(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function renderLimitWindow(window) {
  if (!window) return "";
  const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  const remaining = 100 - used;
  const severity = used >= 90 ? "danger" : used >= 70 ? "warning" : "";
  return `
    <div class="limit-window">
      <div class="limit-numbers">
        <span>${windowLabel(window.windowDurationMins)}</span>
        <strong>${remaining}% осталось</strong>
      </div>
      <div class="limit-track"><div class="limit-fill ${severity}" style="width: ${used}%"></div></div>
      <div class="limit-reset">${escapeHtml(resetLabel(window.resetsAt))}</div>
    </div>
  `;
}

function renderLimits(data) {
  const account = data.account;
  $("#limits-account").textContent = account?.type === "chatgpt"
    ? `${account.email ?? "ChatGPT"} · ${account.planType ?? "план неизвестен"}`
    : account?.type === "apiKey" ? "OpenAI API key" : "Аккаунт Codex";

  const snapshots = data.rateLimitsByLimitId
    ? Object.values(data.rateLimitsByLimitId)
    : [data.rateLimits];
  const cards = snapshots.map((snapshot) => `
    <article class="limit-card">
      <div class="limit-card-head">
        <strong>${escapeHtml(snapshot.limitName || snapshot.limitId || "Codex")}</strong>
        <span>${escapeHtml(snapshot.planType || "")}</span>
      </div>
      ${renderLimitWindow(snapshot.primary)}
      ${renderLimitWindow(snapshot.secondary)}
    </article>
  `).join("");

  const summary = data.usage?.summary ?? {};
  const resetCredits = data.rateLimitResetCredits?.availableCount;
  $("#limits-content").innerHTML = `
    ${cards || '<div class="limits-loading">Лимиты не найдены</div>'}
    <div class="usage-summary">
      <div class="usage-stat"><span>Всего токенов</span><strong>${formatTokens(summary.lifetimeTokens)}</strong></div>
      <div class="usage-stat"><span>Пиковый день</span><strong>${formatTokens(summary.peakDailyTokens)}</strong></div>
      <div class="usage-stat"><span>Серия дней</span><strong>${summary.currentStreakDays ?? "—"}</strong></div>
    </div>
    ${resetCredits != null ? `<div class="limit-reset">Доступно сбросов лимита: ${resetCredits}</div>` : ""}
  `;

  const primary = snapshots[0]?.primary;
  $("#limits-summary").textContent = primary ? `${Math.max(0, 100 - Math.round(primary.usedPercent))}%` : "Открыть";
}

async function loadLimits(force = false) {
  $("#refresh-limits").disabled = true;
  $("#limits-content").innerHTML = '<div class="limits-loading">Получаем данные из Codex…</div>';
  try {
    renderLimits(await api(`/api/codex/usage${force ? "?refresh=1" : ""}`));
  } catch (error) {
    $("#limits-content").innerHTML = `<div class="limits-error">${escapeHtml(error.message)}</div>`;
  } finally {
    $("#refresh-limits").disabled = false;
  }
}

$("#show-limits").addEventListener("click", () => {
  setSidebarOpen(false);
  limitsModal.hidden = false;
  void loadLimits();
});
document.querySelectorAll("[data-close-limits]").forEach((button) => {
  button.addEventListener("click", closeLimits);
});
$("#refresh-limits").addEventListener("click", () => void loadLimits(true));

document.querySelectorAll("[data-theme-option]").forEach((button) => {
  button.addEventListener("click", () => applyTheme(button.dataset.themeOption));
});

$("#show-technical").checked = state.showTechnical;
$("#show-technical").addEventListener("change", (event) => {
  state.showTechnical = event.target.checked;
  localStorage.setItem("ronix-agent-technical", String(state.showTechnical));
  renderEvents();
});

function headers(json = false) {
  const result = {};
  if (json) result["content-type"] = "application/json";
  return result;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...options.headers },
  });
  const body = response.status === 204 ? null : await response.json();
  if (response.status === 401) {
    location.replace("/login");
    throw new Error("Требуется вход");
  }
  if (!response.ok) {
    const error = new Error(body.error ?? `HTTP ${response.status}`);
    if (body && typeof body === "object") Object.assign(error, body);
    throw error;
  }
  return body;
}

function setConnection(text) {
  const indicator = $("#connection");
  indicator.className = `connection-dot ${text}`;
  indicator.title = {
    connected: "Подключено",
    ready: "Готово",
    reconnecting: "Переподключение…",
    error: "Ошибка подключения",
  }[text] ?? text;
}

async function loadProjects() {
  const { projects, projectRoots = [] } = await api("/api/projects");
  state.projects = projects;
  state.projectRoots = projectRoots;
  $("#project-root-hint").textContent = projectRoots[0]
    ? `Будет найдено или создано в ${projectRoots[0]}`
    : "Корневая папка проектов не настроена";
  $("#project").innerHTML = projects
    .map((project) => `
      <option value="${project.id}">${escapeHtml(
        project.kind === "learning" ? `${project.name} · учёба` : project.name,
      )}</option>
    `)
    .join("");
  const rememberedProject = projects.find(
    (project) => project.id === state.navigation.projectId,
  );
  if (rememberedProject) $("#project").value = rememberedProject.id;
  rememberProject($("#project").value || null);
  await loadSessions();
}

async function loadModels() {
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

async function loadSessions() {
  const projectId = $("#project").value;
  const project = selectedProject();
  if (!projectId) {
    state.sessions = [];
    state.learning = null;
    resetGitStatus();
    renderSessions();
    renderSessionMeta(null);
    renderEvents();
    return;
  }
  if (project?.kind === "learning") {
    await loadLearning(projectId);
    state.sessions = [
      state.learning?.sessions?.course,
      state.learning?.sessions?.practice,
    ].filter(Boolean);
    renderSessions();
    if (state.gitProjectId !== projectId && !state.gitLoading) void refreshGitStatus(projectId);
    if (!["course", "practice", "progress"].includes(state.learningMode)) {
      state.learningMode = "course";
    }
    if (state.learningMode === "progress") {
      clearSelectedSessionForProgress();
      renderLearningProgressMode();
      return;
    }
    const purposeSession = state.learning?.sessions?.[state.learningMode];
    if (purposeSession) {
      if (state.sessionId === purposeSession.id) {
        state.selectedSession = purposeSession;
        renderSessionMeta(purposeSession);
      } else {
        await selectSession(purposeSession.id);
      }
    } else {
      renderSessionMeta(null);
      renderEvents();
    }
    return;
  }
  state.learning = null;
  const { sessions } = await api(`/api/sessions?projectId=${encodeURIComponent(projectId)}`);
  state.sessions = sessions;
  renderSessions();
  if (state.gitProjectId !== projectId && !state.gitLoading) void refreshGitStatus(projectId);
  if (!sessions.some((session) => session.id === state.sessionId)) {
    state.sessionId = null;
  }
  if (!state.sessionId) {
    const rememberedId = state.navigation.sessionsByProject?.[projectId];
    const preferred = sessions.find((session) => session.id === rememberedId) ?? sessions[0];
    if (preferred) {
      await selectSession(preferred.id);
    } else {
      forgetSession(projectId);
      renderSessionMeta(null);
      renderEvents();
    }
  }
}

async function loadLearning(projectId = $("#project").value) {
  if (!projectId) {
    state.learning = null;
    return null;
  }
  try {
    state.learning = await api(`/api/projects/${encodeURIComponent(projectId)}/learning`);
    return state.learning;
  } catch (error) {
    state.learning = { available: false, error: error.message, missing: [] };
    return state.learning;
  }
}

function selectedProject() {
  return state.projects.find((project) => project.id === $("#project").value) ?? null;
}

function isLearningProject() {
  return selectedProject()?.kind === "learning";
}

async function refreshGitStatus(projectId = $("#project").value) {
  if (!projectId) return null;
  state.gitProjectId = projectId;
  state.gitLoading = true;
  state.gitError = null;
  renderGitPanel();
  try {
    const status = await api(`/api/projects/${encodeURIComponent(projectId)}/git/status`);
    if (state.gitProjectId === projectId) {
      state.gitStatus = status;
      state.gitError = null;
    }
    return status;
  } catch (error) {
    if (state.gitProjectId === projectId) {
      state.gitStatus = null;
      state.gitError = error.message;
    }
    return null;
  } finally {
    if (state.gitProjectId === projectId) {
      state.gitLoading = false;
      renderGitPanel();
    }
  }
}

function resetGitStatus() {
  state.gitStatus = null;
  state.gitProjectId = null;
  state.gitLoading = false;
  state.gitError = null;
  state.gitSyncRunning = null;
  state.gitSyncMessage = null;
  renderGitPanel();
}

function renderGitPanel() {
  const panel = $("#git-panel");
  const project = selectedProject();
  const session = state.selectedSession;
  const progressMode = isLearningProject() && state.learningMode === "progress";
  if (!project || progressMode) {
    panel.hidden = true;
    panel.innerHTML = "";
    $("#toggle-git").hidden = true;
    setGitOpen(false);
    return;
  }

  panel.hidden = false;
  $("#toggle-git").hidden = false;
  const status = state.gitProjectId === project.id ? state.gitStatus : null;
  const loading = state.gitProjectId === project.id && state.gitLoading;
  const practice = isLearningProject() && session?.purpose === "practice";
  const actionText = practice ? "Сдать изменения" : "Проверить изменения";
  const disabledReason = gitActionDisabledReason(status, session, loading);
  const summary = gitSummaryText(status, loading, state.gitError);
  panel.innerHTML = `
    <div class="git-panel-head">
      <div>
        <h3>Git</h3>
        <p>${escapeHtml(summary)}</p>
      </div>
      <button
        id="git-action"
        class="git-action ${practice ? "primary" : ""}"
        type="button"
        ${disabledReason ? "disabled" : ""}
        title="${escapeHtml(disabledReason || actionText)}"
      >${escapeHtml(actionText)}</button>
    </div>
    ${renderGitSyncSection(status, loading)}
    ${renderGitFileLists(status)}
  `;
  panel.querySelector("#git-action")?.addEventListener("click", () => {
    void prepareGitPrompt();
  });
  panel.querySelectorAll("[data-git-sync]").forEach((button) => {
    button.addEventListener("click", () => {
      void runGitSync(button.dataset.gitSync);
    });
  });
}

function gitActionDisabledReason(status, session, loading) {
  if (loading) return "Git-статус обновляется";
  if (!session) return "Выберите сессию";
  if (session.status === "running") return "Дождитесь завершения текущего ответа";
  if (session.status === "stopped") return "Возобновите сессию";
  if (!status) return state.gitError || "Git-статус еще не загружен";
  if (!status.repoFound) return status.error || "Git-репозиторий не найден";
  if (status.clean) return "В проекте нет изменённых файлов";
  return "";
}

function gitSummaryText(status, loading, error) {
  if (loading) return "Обновляем список изменённых файлов";
  if (error) return error;
  if (!status) return "Статус ещё не загружен";
  if (!status.repoFound) return status.error || "В папке проекта не найден Git-репозиторий";
  const branch = gitBranchText(status);
  if (status.clean) return `${branch} · рабочее дерево чистое`;
  return `${branch} · ${status.changedCount} ${pluralRu(status.changedCount, "файл", "файла", "файлов")} изменено`;
}

function gitBranchText(status) {
  const branch = status.branch || "ветка неизвестна";
  const upstream = status.upstream ? ` → ${status.upstream}` : "";
  const divergence = [
    status.ahead > 0 ? `↑${status.ahead}` : "",
    status.behind > 0 ? `↓${status.behind}` : "",
  ].filter(Boolean).join(" ");
  return `${branch}${upstream}${divergence ? ` · ${divergence}` : ""}`;
}

function renderGitSyncSection(status, loading) {
  if (!status?.repoFound) return "";
  const buttons = ["fetch", "pull", "push"].map((action) => {
    const disabledReason = gitSyncDisabledReason(action, status, loading);
    const running = state.gitSyncRunning === action;
    const label = running ? `${gitSyncLabel(action)}...` : gitSyncLabel(action);
    return `
      <button
        type="button"
        class="git-sync-button ${action === "push" ? "accent" : ""}"
        data-git-sync="${escapeHtml(action)}"
        ${disabledReason || running ? "disabled" : ""}
        title="${escapeHtml(disabledReason || gitSyncTitle(action))}"
      >${escapeHtml(label)}</button>
    `;
  }).join("");
  const message = state.gitSyncMessage ? `
    <div class="git-sync-message ${state.gitSyncMessage.kind}">
      <span>${escapeHtml(state.gitSyncMessage.text)}</span>
      ${state.gitSyncMessage.output ? `<pre>${escapeHtml(state.gitSyncMessage.output)}</pre>` : ""}
    </div>
  ` : "";
  return `
    <div class="git-sync">
      <div class="git-remote-state">${escapeHtml(gitRemoteStateText(status))}</div>
      <div class="git-sync-actions">${buttons}</div>
      ${message}
    </div>
  `;
}

function gitSyncDisabledReason(action, status, loading) {
  if (loading) return "Git-статус обновляется";
  if (state.gitSyncRunning) return "Git-команда уже выполняется";
  if (!status?.repoFound) return status?.error || "Git-репозиторий не найден";
  if (action === "fetch") return "";
  if (action === "pull") {
    if (!status.upstream) return "У ветки не настроен upstream";
    if (status.behind <= 0) return "Нет входящих коммитов";
  }
  if (action === "push") {
    if (status.ahead <= 0 && !status.clean) return "Push отправляет только коммиты: сначала нужен commit";
    if (!status.upstream) return "У ветки не настроен upstream";
    if (status.ahead <= 0) return "Нет исходящих коммитов";
  }
  return "";
}

function gitSyncLabel(action) {
  return {
    fetch: "Fetch",
    pull: "Pull",
    push: "Push",
  }[action] ?? action;
}

function gitSyncTitle(action) {
  return {
    fetch: "Обновить состояние remote",
    pull: "Подтянуть входящие коммиты через fast-forward",
    push: "Отправить локальные коммиты в upstream",
  }[action] ?? action;
}

function gitRemoteStateText(status) {
  if (!status.upstream) return "Remote не привязан к текущей ветке";
  const parts = [];
  if (status.behind > 0) parts.push(`${status.behind} входящих`);
  if (status.ahead > 0) parts.push(`${status.ahead} исходящих`);
  if (!status.clean && status.ahead <= 0) parts.push("локальные правки ещё не в commit");
  return parts.length ? parts.join(" · ") : "Синхронизировано с upstream";
}

async function runGitSync(action) {
  if (!["fetch", "pull", "push"].includes(action)) return;
  const project = selectedProject();
  if (!project) return;
  state.gitSyncRunning = action;
  state.gitSyncMessage = null;
  renderGitPanel();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(project.id)}/git/${action}`, {
      method: "POST",
    });
    if (state.gitProjectId === project.id || !state.gitProjectId) {
      state.gitProjectId = project.id;
      state.gitStatus = result.status;
      state.gitError = null;
    }
    state.gitSyncMessage = {
      kind: "success",
      text: `${gitSyncLabel(action)} выполнен`,
      output: result.output || "",
    };
  } catch (error) {
    state.gitSyncMessage = {
      kind: "error",
      text: error.message || `${gitSyncLabel(action)} завершился с ошибкой`,
      output: error.output || "",
    };
    await refreshGitStatus(project.id);
  } finally {
    if (state.gitSyncRunning === action) state.gitSyncRunning = null;
    renderGitPanel();
  }
}

function renderGitFileLists(status) {
  if (!status?.repoFound || status.clean) return "";
  const groups = [
    ["conflicted", "Конфликты"],
    ["staged", "Staged"],
    ["unstaged", "Changed"],
    ["untracked", "Untracked"],
  ];
  return `
    <div class="git-file-groups">
      ${groups.map(([key, title]) => renderGitFileGroup(title, status.files?.[key] ?? [])).join("")}
    </div>
  `;
}

function renderGitFileGroup(title, files) {
  if (!files.length) return "";
  const visible = files.slice(0, 8);
  const remaining = files.length - visible.length;
  return `
    <div class="git-file-group">
      <span>${escapeHtml(title)}</span>
      <ul>
        ${visible.map((file) => `
          <li>
            <code>${escapeHtml(file.path)}</code>
            <small>${escapeHtml(gitStateLabel(file))}</small>
          </li>
        `).join("")}
        ${remaining > 0 ? `<li class="git-more">ещё ${remaining}</li>` : ""}
      </ul>
    </div>
  `;
}

function gitStateLabel(file) {
  const labels = {
    added: "added",
    copied: "copied",
    deleted: "deleted",
    modified: "modified",
    renamed: "renamed",
    unmerged: "conflict",
    untracked: "new",
    unknown: `${file.index}${file.worktree}`.trim() || "changed",
  };
  return labels[file.state] ?? file.state ?? "changed";
}

async function prepareGitPrompt() {
  const project = selectedProject();
  if (!project || !state.selectedSession) return;
  const status = await refreshGitStatus(project.id);
  if (!status || gitActionDisabledReason(status, state.selectedSession, false)) return;
  promptInput.value = buildGitPrompt(status, state.selectedSession);
  resizePrompt();
  saveCurrentDraft();
  promptInput.focus();
}

function buildGitPrompt(status, session) {
  const untracked = gitFilePaths(status.files?.untracked ?? []);
  const changed = [
    ...gitFilePaths(status.files?.staged ?? []),
    ...gitFilePaths(status.files?.unstaged ?? []),
    ...gitFilePaths(status.files?.conflicted ?? []),
  ];
  const untrackedBlock = untracked.length
    ? untracked.map((path) => `- ${path}`).join("\n")
    : "- нет";
  const changedBlock = uniqueStrings(changed).length
    ? uniqueStrings(changed).map((path) => `- ${path}`).join("\n")
    : "- нет tracked-изменений";

  if (isLearningProject() && session.purpose === "practice") {
    return [
      "Проверь сдачу практики по текущим Git-изменениям проекта.",
      "",
      "Сначала посмотри `git status --short`, `git diff --stat` и `git diff`.",
      "Отдельно прочитай untracked-файлы из списка ниже, потому что они не попадают в `git diff`.",
      "",
      "Tracked-изменения:",
      changedBlock,
      "",
      "Untracked-файлы:",
      untrackedBlock,
      "",
      "Проведи ревью как наставник: проверь корректность, выполнение задания, ошибки, читаемость и понимание решения. Если неясно, задай вопросы. Обновляй `learning/LEARNING_DIARY.md` и `learning/ROADMAP.md` только если практика действительно завершена.",
    ].join("\n");
  }

  return [
    "Проведи ревью текущих Git-изменений проекта. Ничего не меняй в файлах без отдельной просьбы.",
    "",
    "Сначала посмотри `git status --short`, `git diff --stat` и `git diff`.",
    "Отдельно прочитай untracked-файлы из списка ниже, потому что они не попадают в `git diff`.",
    "",
    "Tracked-изменения:",
    changedBlock,
    "",
    "Untracked-файлы:",
    untrackedBlock,
    "",
    "Дай ревью по рискам, багам, недостающим тестам и следующим проверкам.",
  ].join("\n");
}

function gitFilePaths(files) {
  return uniqueStrings(files.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]));
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function pluralRu(value, one, few, many) {
  const abs = Math.abs(value);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function renderLearningDashboard() {
  const learning = state.learning;
  if (!learning) {
    return '<div class="empty-state"><div class="empty-icon">›_</div><h3>Загрузка учёбы</h3></div>';
  }
  if (!learning.available) {
    return `
      <section class="learning-dashboard">
        <header class="learning-dashboard-head">
          <div>
            <h3>Учебные файлы не найдены</h3>
            <p>${escapeHtml(learning.error || `Не найдены: ${(learning.missing ?? []).join(", ")}`)}</p>
          </div>
          <button type="button" class="refresh-learning" data-refresh-learning>Обновить прогресс</button>
        </header>
      </section>
    `;
  }
  const diary = learning.diarySummary ?? learning.summary ?? {};
  const roadmap = learning.roadmapSummary ?? {};
  const showingRaw = state.progressTab !== "summary";
  return `
    <section class="learning-dashboard">
      <header class="learning-dashboard-head">
        <div>
          <h3>Успехи</h3>
          <p>${escapeHtml(learningSummaryLine(diary, roadmap))}</p>
        </div>
        <button type="button" class="refresh-learning" data-refresh-learning>Обновить прогресс</button>
      </header>
      <div class="learning-tabs" role="tablist">
        ${renderProgressTab("summary", "Обзор")}
        ${renderProgressTab("diary", "Дневник")}
        ${renderProgressTab("roadmap", "Roadmap")}
      </div>
      ${showingRaw
        ? `<pre class="learning-content">${escapeHtml(
            state.progressTab === "roadmap" ? learning.roadmap : learning.diary,
          )}</pre>`
        : renderLearningSummary(diary, roadmap)}
    </section>
  `;
}

function renderProgressTab(tab, label) {
  return `
    <button
      type="button"
      data-progress-tab="${escapeHtml(tab)}"
      class="${state.progressTab === tab ? "active" : ""}"
    >${escapeHtml(label)}</button>
  `;
}

function learningSummaryLine(diary, roadmap) {
  const focus = diary.focus?.[0] ? ` · ${diary.focus[0]}` : "";
  return [
    diary.topicCount != null ? `${diary.topicCount} тем` : null,
    diary.assignmentCount != null ? `${diary.assignmentCount} заданий` : null,
    roadmap.currentStage ? `сейчас: ${roadmap.currentStage}` : null,
    diary.lastUpdated ? `обновлено ${diary.lastUpdated}` : null,
  ].filter(Boolean).join(" · ") + focus;
}

function renderLearningSummary(diary, roadmap) {
  const weakTopics = diary.weakTopics ?? [];
  const strongTopics = diary.strongTopics ?? [];
  const topics = diary.topics ?? [];
  const assignments = diary.latestGrades ?? [];
  return `
    <section class="learning-scoreboard">
      <div class="learning-stat">
        <span>Средний уровень</span>
        <strong>${diary.averageScore ?? "—"}</strong>
      </div>
      <div class="learning-stat">
        <span>Темы</span>
        <strong>${diary.topicCount ?? 0}</strong>
      </div>
      <div class="learning-stat">
        <span>Задания</span>
        <strong>${diary.assignmentCount ?? 0}</strong>
      </div>
    </section>
    ${renderRoadmapSummary(roadmap)}
    ${renderFocus(diary.focus ?? [])}
    ${renderTopicGroup("Что проседает", weakTopics, "weak")}
    ${renderTopicGroup("Сильные стороны", strongTopics, "strong")}
    ${renderAssignmentScores(assignments)}
    ${renderTopicGroup("Все темы", topics, "all")}
  `;
}

function renderRoadmapSummary(roadmap) {
  const next = [
    ...(roadmap.current ?? []).filter((item) => !item.done),
    ...(roadmap.nextSteps ?? []).filter((item) => !item.done),
  ].slice(0, 5);
  if (!roadmap.currentStage && next.length === 0) return "";
  return `
    <section class="learning-section">
      <h3>Маршрут</h3>
      ${roadmap.currentStage ? `<p class="learning-current-stage">${escapeHtml(roadmap.currentStage)}</p>` : ""}
      ${next.length ? `
        <ol class="learning-focus">
          ${next.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("")}
        </ol>
      ` : ""}
    </section>
  `;
}

function renderFocus(focus) {
  if (!focus.length) return "";
  return `
    <section class="learning-section">
      <h3>Текущий фокус</h3>
      <ol class="learning-focus">
        ${focus.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ol>
    </section>
  `;
}

function renderTopicGroup(title, topics, tone) {
  if (!topics.length) return "";
  return `
    <section class="learning-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="learning-topic-list ${tone}">
        ${topics.map(renderTopic).join("")}
      </div>
    </section>
  `;
}

function renderTopic(topic) {
  const score = Math.max(1, Math.min(10, Number(topic.score) || 1));
  return `
    <article class="learning-topic">
      <div class="learning-topic-head">
        <strong>${escapeHtml(topic.title)}</strong>
        <span>${score}/10</span>
      </div>
      <div class="learning-meter" aria-hidden="true">
        <span style="width: ${score * 10}%"></span>
      </div>
      <p>${escapeHtml(topic.rationale || topic.confidence || "")}</p>
    </article>
  `;
}

function renderAssignmentScores(assignments) {
  if (!assignments.length) return "";
  return `
    <section class="learning-section">
      <h3>Последние оценки</h3>
      <div class="learning-assignment-list">
        ${assignments.map((assignment) => `
          <div class="learning-assignment">
            <span>${escapeHtml(assignment.title)}</span>
            <strong>${assignment.score}/10</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function rememberProject(projectId) {
  state.navigation.projectId = projectId;
  state.navigation.sessionsByProject ??= {};
  localStorage.setItem("ronix-agent-navigation", JSON.stringify(state.navigation));
}

function rememberSession(projectId, sessionId) {
  state.navigation.projectId = projectId;
  state.navigation.sessionsByProject ??= {};
  state.navigation.sessionsByProject[projectId] = sessionId;
  localStorage.setItem("ronix-agent-navigation", JSON.stringify(state.navigation));
}

function forgetSession(projectId) {
  state.navigation.sessionsByProject ??= {};
  delete state.navigation.sessionsByProject[projectId];
  localStorage.setItem("ronix-agent-navigation", JSON.stringify(state.navigation));
}

function renderSessions() {
  const learning = isLearningProject();
  chat.classList.remove("learning-project");
  $("#sessions-label").textContent = learning ? "Учёба" : "Сессии";
  $("#session-count").textContent = learning ? "3" : String(state.sessions.length);
  $("#new-session").hidden = learning;
  $("#enable-learning").hidden = !selectedProject() || learning;
  if (learning) {
    $("#sessions").innerHTML = `
      ${renderLearningModeButton("course", "Курс", "Теория, объяснения и движение по ROADMAP")}
      ${renderLearningModeButton("practice", "Практика", "Сдача кода сообщением, ревью и дневник")}
      ${renderLearningModeButton("progress", "Успехи", "Дневник и дорожная карта только для чтения")}
    `;
    document.querySelectorAll("[data-learning-mode]").forEach((button) => {
      button.addEventListener("click", () => void selectLearningMode(button.dataset.learningMode));
    });
    return;
  }
  $("#sessions").innerHTML = state.sessions
    .map(
      (session) => `
        <div class="session-row ${session.id === state.sessionId ? "active" : ""}">
          <button class="session" data-id="${session.id}">
            <span class="session-status ${escapeHtml(session.status)}"></span>
            <span>
              <span class="session-title">${sessionTitle(session)}</span>
              <small>${statusLabel(session.status)} · ${relativeTime(session.lastActivityAt)}</small>
            </span>
          </button>
          <div class="session-options">
            <button
              class="session-options-button"
              data-options-id="${session.id}"
              title="Опции сессии"
              aria-label="Опции сессии"
              aria-expanded="false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="1.5"></circle>
                <circle cx="12" cy="12" r="1.5"></circle>
                <circle cx="19" cy="12" r="1.5"></circle>
              </svg>
            </button>
            <div class="session-menu" data-menu-id="${session.id}" hidden>
              ${session.status === "stopped"
                ? `<button class="resume-session" data-resume-id="${session.id}">Возобновить</button>`
                : `<button class="stop-session" data-stop-id="${session.id}">Остановить</button>`}
              <button
                class="delete-session"
                data-delete-id="${session.id}"
                ${session.status === "running" ? "disabled" : ""}
              >Удалить сессию</button>
            </div>
          </div>
        </div>
      `,
    )
    .join("");
  document.querySelectorAll(".session").forEach((button) => {
    button.addEventListener("click", () => selectSession(button.dataset.id));
  });
  document.querySelectorAll(".session-options-button").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSessionMenu(button.dataset.optionsId);
    });
  });
  document.querySelectorAll(".delete-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(button.dataset.deleteId);
    });
  });
  document.querySelectorAll(".stop-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void changeSessionState(button.dataset.stopId, "stop");
    });
  });
  document.querySelectorAll(".resume-session").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void changeSessionState(button.dataset.resumeId, "resume");
    });
  });
}

function renderLearningModeButton(mode, title, description) {
  const session = mode === "progress" ? null : state.learning?.sessions?.[mode];
  const status = session?.status ?? "ready";
  return `
    <button
      class="learning-mode ${state.learningMode === mode ? "active" : ""}"
      type="button"
      data-learning-mode="${escapeHtml(mode)}"
    >
      <span class="session-status ${escapeHtml(status)}"></span>
      <span>
        <span class="session-title">${escapeHtml(title)}</span>
        <small>${escapeHtml(description)}</small>
      </span>
    </button>
  `;
}

async function selectLearningMode(mode) {
  if (!["course", "practice", "progress"].includes(mode)) return;
  saveCurrentDraft();
  state.learningMode = mode;
  localStorage.setItem("ronix-agent-learning-mode", mode);
  renderSessions();
  if (mode === "progress") {
    clearSelectedSessionForProgress();
    renderLearningProgressMode();
    return;
  }
  const session = state.learning?.sessions?.[mode];
  if (session) await selectSession(session.id);
}

function toggleSessionMenu(id) {
  const target = document.querySelector(`[data-menu-id="${id}"]`);
  const shouldOpen = target?.hidden ?? false;
  closeSessionMenus();
  if (!target || !shouldOpen) return;

  target.hidden = false;
  document.querySelector(`[data-options-id="${id}"]`)?.setAttribute("aria-expanded", "true");
}

function closeSessionMenus() {
  document.querySelectorAll(".session-menu").forEach((menu) => {
    menu.hidden = true;
  });
  document.querySelectorAll(".session-options-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", closeSessionMenus);

async function selectSession(id) {
  setSidebarOpen(false);
  setSettingsOpen(false);
  setGitOpen(false);
  closeSessionMenus();
  saveCurrentDraft();
  state.source?.close();
  clearTimeout(state.reconnectTimer);
  state.sessionId = id;
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.events = [];
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  const projectId = $("#project").value;
  if (projectId) rememberSession(projectId, id);
  renderEvents();
  renderSessions();
  const { session, approvals = [] } = await api(`/api/sessions/${id}`);
  const normalizedSession = await normalizeSessionModel(session);
  for (const approval of approvals) state.approvals[approval.id] = approval;
  renderEvents();
  state.selectedSession = normalizedSession;
  renderSessionMeta(normalizedSession);
  restoreDraft(id);
  connectEvents(id, true);
}

async function changeSessionState(id, action) {
  try {
    await api(`/api/sessions/${id}/${action}`, { method: "POST" });
    await loadSessions();
    if (state.sessionId === id) {
      const { session } = await api(`/api/sessions/${id}`);
      renderSessionMeta(session);
    }
  } catch (error) {
    alert(error.message);
  }
}

async function deleteSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  if (!confirm(`Удалить ${sessionTitle(session)}? История этой сессии исчезнет из Ronix.`)) {
    return;
  }

  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    delete state.drafts[id];
    persistDrafts();

    if (state.sessionId === id) {
      state.source?.close();
      state.sessionId = null;
      state.events = [];
      state.lastSequence = 0;
      state.firstSequence = 0;
      state.hasMoreEvents = false;
      state.approvals = {};
      state.liveTurnActive = false;
      state.liveResponse = null;
      promptInput.value = "";
      resizePrompt();
      $("#session-title").textContent = "Выберите сессию";
      renderSessionMeta(null);
      $("#send").disabled = true;
      $("#interrupt").disabled = true;
      $("#sandbox-mode").disabled = true;
      forgetSession(session.projectId);
    }

    await loadSessions();
    renderEvents();
  } catch (error) {
    alert(error.message);
  }
}

function renderSessionMeta(session) {
  state.selectedSession = session;
  const meta = $("#session-meta");
  if (!session) {
    const project = state.projects.find((item) => item.id === $("#project").value);
    const hasSessions = state.sessions.length > 0;
    $("#session-title").textContent = project?.name ?? "Выберите проект";
    meta.className = "session-meta";
    meta.innerHTML = `
      <span class="session-meta-dot"></span>
      <span>${project
        ? hasSessions ? "Выберите сессию проекта" : "В проекте пока нет сессий"
        : "Добавьте проект, чтобы начать работу"}</span>
    `;
    $("#session-settings").hidden = true;
    $("#toggle-settings").hidden = true;
    $("#toggle-git").hidden = true;
    $("#interrupt").hidden = true;
    $("#prompt-form").hidden = true;
    $("#send").disabled = true;
    $("#sandbox-mode").disabled = true;
    renderModelControls(null);
    renderGitPanel();
    return;
  }
  $("#session-title").textContent = sessionTitle(session);
  meta.className = `session-meta ${session.status}`;
  const thread = session.threadId ? ` · ${session.threadId.slice(0, 8)}` : "";
  const learning = isLearningProject();
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(statusLabel(session.status) + (learning ? "" : thread))}</span>
  `;
  $("#send").disabled = session.status === "running" || session.status === "stopped";
  $("#prompt-form").hidden = false;
  $("#prompt").placeholder = learning
    ? session.purpose === "practice"
      ? "Отправьте код или вопрос по практике…"
      : "Спросите тему или продолжите курс…"
    : "Напишите задачу для Codex…";
  $("#interrupt").disabled = session.status !== "running";
  $("#interrupt").hidden = session.status !== "running";
  const sandbox = $("#sandbox-mode");
  sandbox.value = session.sandboxMode ?? "workspace-write";
  sandbox.disabled = session.status === "running";
  const accessMode = document.querySelector(".access-mode");
  accessMode.className =
    `setting-field access-mode mode-${session.sandboxMode ?? "workspace-write"}`;
  $("#session-settings").hidden = false;
  $("#toggle-settings").hidden = false;
  renderModelControls(session);
  renderGitPanel();
}

function currentModel(session = state.selectedSession) {
  return state.models.find((model) => model.model === session?.model)
    ?? state.models.find((model) => model.isDefault)
    ?? state.models[0]
    ?? null;
}

async function normalizeSessionModel(session) {
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

function renderModelControls(session) {
  const modelSelect = $("#model-select");
  const effortSelect = $("#reasoning-effort");
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

function effortLabel(effort) {
  return {
    none: "Без reasoning",
    minimal: "Минимальный",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    ultra: "Ultra",
  }[effort] ?? effort;
}

function preferredModelSettings() {
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

function rememberModelSettings(session) {
  if (!session?.model || !session?.reasoningEffort) return;
  state.modelPreference = {
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  };
  localStorage.setItem(
    "ronix-agent-model-preference",
    JSON.stringify(state.modelPreference),
  );
}

async function updateSessionSettings(update) {
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
    renderSessionMeta(session);
    await loadSessions();
  } catch (error) {
    alert(error.message);
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    renderSessionMeta(session);
  }
}

function connectEvents(sessionId = state.sessionId, initial = false) {
  if (!sessionId || sessionId !== state.sessionId) return;
  clearTimeout(state.reconnectTimer);
  const controller = new AbortController();
  state.source = { close: () => controller.abort() };
  const query = initial && state.lastSequence === 0
    ? "tail=200"
    : `after=${state.lastSequence}`;
  void streamEvents(
    `/api/sessions/${sessionId}/events?${query}`,
    controller.signal,
    sessionId,
    initial,
  );
}

async function streamEvents(path, signal, sessionId, initial) {
  try {
    const response = await fetch(path, { headers: headers(), signal });
    if (response.status === 401) {
      location.replace("/login");
      return;
    }
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    setConnection("connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data && sessionId === state.sessionId) handleEvent(JSON.parse(data), initial);
      }
    }
    if (!signal.aborted && sessionId === state.sessionId) scheduleReconnect(sessionId);
  } catch (error) {
    if (error.name !== "AbortError" && sessionId === state.sessionId) {
      setConnection("reconnecting");
      scheduleReconnect(sessionId);
    }
  }
}

function scheduleReconnect(sessionId) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => connectEvents(sessionId), 1500);
}

function handleEvent(event, initial = false) {
  if (event.sequence <= state.lastSequence) return;
  state.lastSequence = event.sequence;
  if (!state.firstSequence) state.firstSequence = event.sequence;
  state.events.push(event);
  updateApprovalState(event);
  updateLiveResponse(event);
  if (event.type === "approval.requested" || event.type === "approval.resolved") {
    renderEvents();
  } else if (isLiveEvent(event)) {
    scheduleLiveRender();
  } else {
    appendVisibleEvent(event);
  }
  if (isSessionStateEvent(event)) scheduleSessionRefresh();
  if (
    isLearningProject()
    && ["course", "practice"].includes(state.learningMode)
    && event.type === "codex.turn.completed"
  ) {
    void loadLearning();
  }
  if (initial && state.events.length === 200) {
    state.hasMoreEvents = true;
    renderEvents();
  }
}

function renderEvents(scrollToBottom = true) {
  const container = $("#events");
  container.innerHTML = "";
  if (isLearningProject() && state.learningMode === "progress") {
    container.innerHTML = renderLearningDashboard();
    container.querySelector("[data-refresh-learning]")?.addEventListener("click", async () => {
      await loadLearning();
      renderLearningProgressMode();
    });
    container.querySelectorAll("[data-progress-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.progressTab = button.dataset.progressTab;
        localStorage.setItem("ronix-agent-progress-tab", state.progressTab);
        renderEvents(false);
      });
    });
    return;
  }
  const events = state.showTechnical ? state.events : visibleEvents(state.events);
  const hasApprovals = Object.keys(state.approvals).length > 0;
  if (events.length === 0 && !hasApprovals) {
    const hasProject = Boolean($("#project").value);
    const hasSessions = state.sessions.length > 0;
    const learning = isLearningProject();
    const emptyTitle = state.sessionId
      ? learning && state.learningMode === "practice" ? "Начните практику" : "Начните диалог"
      : !hasProject
        ? "Добавьте проект"
        : learning ? "Выберите режим" : hasSessions ? "Выберите сессию" : "В проекте пока нет сессий";
    const emptyDescription = state.sessionId
      ? learning && state.learningMode === "practice"
        ? "Отправьте код или вопрос по заданию в поле ниже."
        : learning
          ? "Продолжите курс в поле ниже."
          : "Опишите задачу в поле ниже."
      : !hasProject
        ? "Укажите каталог проекта в боковой панели."
        : learning
          ? "Курс и практика сохраняются в отдельных долгоживущих сессиях."
          : hasSessions
          ? "Выберите существующую сессию в боковой панели."
          : "Создайте первую сессию, чтобы начать работу с Codex.";
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">›_</div>
        <h3>${emptyTitle}</h3>
        <p>${emptyDescription}</p>
        ${hasProject && !hasSessions && !learning
          ? '<button class="empty-action" type="button" data-create-session>Создать сессию</button>'
          : ""}
      </div>
    `;
    container.querySelector("[data-create-session]")?.addEventListener("click", () => {
      void createSession();
    });
    return;
  }
  renderHistoryButton(container);
  renderPendingApprovals(container);
  for (const event of events) appendEvent(event, container);
  renderLiveResponse(container);
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function appendVisibleEvent(event) {
  const container = $("#events");
  container.querySelector(".empty-state")?.remove();
  const visible = state.showTechnical || visibleEvents([event]).length > 0;
  const shouldScroll = isNearBottom(container);
  if (event.type === "codex.item.completed") {
    container.querySelector(".live-response")?.remove();
  }
  if (visible) appendEvent(event, container);
  if (event.type === "codex.item.completed") {
    renderLiveResponse(container);
  }
  if (shouldScroll) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function renderHistoryButton(container) {
  if (!state.hasMoreEvents || !state.firstSequence) return;
  const button = document.createElement("button");
  button.id = "load-older";
  button.className = "load-older";
  button.type = "button";
  button.textContent = "Загрузить предыдущие сообщения";
  container.append(button);
}

function renderPendingApprovals(container) {
  for (const approval of Object.values(state.approvals)) {
    const event = {
      type: "approval.requested",
      payload: { approvalId: approval.id, method: approval.method, ...approval.payload },
    };
    appendEvent(event, container);
  }
}

function updateLiveResponse(event) {
  if (event.type === "codex.turn.started") {
    state.liveTurnActive = true;
    state.liveResponse = { mode: "thinking", itemId: null, text: "", detail: "Анализирует задачу" };
    setLocalSessionStatus("running");
    return;
  }
  if (event.type === "codex.item.agentMessage.delta") {
    const itemId = event.payload?.itemId ?? null;
    if (!state.liveResponse || state.liveResponse.itemId !== itemId) {
      state.liveResponse = { mode: "writing", itemId, text: "", detail: "Пишет ответ" };
    }
    state.liveResponse.mode = "writing";
    state.liveResponse.detail = "Пишет ответ";
    state.liveResponse.text += event.payload?.delta ?? "";
    return;
  }
  if (event.type === "codex.item.started") {
    const item = event.payload?.item;
    if (isAgentMessage(item)) {
      state.liveResponse = {
        mode: "writing",
        itemId: item.id ?? null,
        text: item.text ?? "",
        detail: "Пишет ответ",
      };
    } else if (isCommandItem(item)) {
      state.liveResponse = {
        mode: "working",
        itemId: item.id ?? null,
        text: "",
        detail: "Выполняет команду",
      };
    } else if (isFileChangeItem(item)) {
      state.liveResponse = {
        mode: "working",
        itemId: item.id ?? null,
        text: "",
        detail: "Применяет изменения",
      };
    }
    return;
  }
  if (event.type === "codex.item.completed") {
    const item = event.payload?.item;
    const matchesLiveItem = !state.liveResponse || state.liveResponse.itemId === item?.id;
    state.liveResponse = state.liveTurnActive && isToolItem(item)
      ? { mode: "thinking", itemId: null, text: "", detail: "Анализирует результат" }
      : matchesLiveItem || isAgentMessage(item) ? null : state.liveResponse;
    return;
  }
  if (
    event.type === "codex.turn.completed"
    || event.type === "turn.interrupted"
    || event.type === "session.error"
  ) {
    state.liveTurnActive = false;
    state.liveResponse = null;
    setLocalSessionStatus(event.type === "session.error" ? "error" : "ready");
  }
}

function renderLiveResponse(container = $("#events")) {
  const existing = container.querySelector(".live-response");
  if (!state.liveResponse) {
    existing?.remove();
    container.setAttribute("aria-busy", "false");
    return;
  }

  container.setAttribute("aria-busy", "true");
  const shouldScroll = isNearBottom(container);
  const element = existing ?? document.createElement("article");
  element.className = `message agent live-response ${state.liveResponse.mode}`;
  element.innerHTML = `
    <div class="avatar live-avatar">
      <span class="avatar-pulse"></span>
      <span class="avatar-text">CX</span>
    </div>
    <div class="message-content">
      <div class="message-label live-label">
        <span>Codex</span>
        <span class="live-state">${escapeHtml(state.liveResponse.detail)}</span>
      </div>
      <div class="bubble live-bubble">
        ${state.liveResponse.text
          ? renderAgentMessage(state.liveResponse.text)
          : '<span class="typing-dots"><i></i><i></i><i></i></span>'}
        <span class="stream-caret" aria-hidden="true"></span>
      </div>
    </div>
  `;
  if (!existing) container.append(element);
  if (shouldScroll) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function scheduleLiveRender() {
  if (state.liveRenderFrame) return;
  state.liveRenderFrame = requestAnimationFrame(() => {
    state.liveRenderFrame = null;
    renderLiveResponse();
  });
}

function isLiveEvent(event) {
  return [
    "codex.turn.started",
    "codex.item.started",
    "codex.item.agentMessage.delta",
    "codex.turn.completed",
    "turn.interrupted",
    "session.error",
  ].includes(event.type);
}

function isAgentMessage(item) {
  return item?.type === "agentMessage" || item?.type === "agent_message";
}

function isToolItem(item) {
  return isCommandItem(item) || isFileChangeItem(item);
}

function isCommandItem(item) {
  return [
    "commandExecution",
    "command_execution",
  ].includes(item?.type);
}

function isFileChangeItem(item) {
  return [
    "fileChange",
    "file_change",
  ].includes(item?.type);
}

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

function setLocalSessionStatus(status) {
  if (!state.selectedSession) return;
  state.selectedSession = { ...state.selectedSession, status };
  renderSessionMeta(state.selectedSession);
}

function visibleEvents(events) {
  return events.filter((event) => {
    if (event.type === "user.message") return true;
    if (event.type === "turn.error" || event.type === "session.error") return true;
    if (event.type === "turn.interrupted") return true;
    if (event.type !== "codex.item.completed") return false;

    const itemType = event.payload?.item?.type;
    return [
      "agent_message", "command_execution", "file_change", "error",
      "agentMessage", "commandExecution", "fileChange",
    ].includes(itemType);
  });
}

function appendEvent(event, container) {
  const view = state.showTechnical ? formatTechnicalEvent(event) : formatVisibleEvent(event);
  if (!view) return;

  if (view.kind === "message") {
    const element = document.createElement("article");
    element.className = `message ${view.className}`;
    const body =
      view.className === "agent"
        ? renderAgentMessage(view.body)
        : escapeHtml(view.body);
    element.innerHTML = `
      ${view.className === "agent" ? '<div class="avatar">CX</div>' : ""}
      <div class="message-content">
        <div class="message-label">${escapeHtml(view.label)}</div>
        <div class="bubble">${body}</div>
      </div>
    `;
    container.append(element);
    return;
  }

  if (view.kind === "technical") {
    const element = document.createElement("div");
    element.className = "technical-event";
    element.innerHTML = `<strong>${escapeHtml(view.label)}</strong>${escapeHtml(view.body)}`;
    container.append(element);
    return;
  }

  if (view.kind === "approval") {
    const element = document.createElement("article");
    element.className = "approval-card";
    element.dataset.approvalId = view.approvalId;
    element.innerHTML = `
      <strong>${escapeHtml(view.label)}</strong>
      ${view.body ? `<pre>${escapeHtml(view.body)}</pre>` : ""}
      <div class="approval-actions">
        <button type="button" data-approval-decision="decline">Отклонить</button>
        <button type="button" data-approval-decision="acceptForSession">Для сессии</button>
        <button type="button" data-approval-decision="accept">Разрешить</button>
      </div>
    `;
    container.append(element);
    return;
  }

  if (view.kind === "userInput") {
    const element = document.createElement("article");
    element.className = "approval-card user-input-card";
    element.dataset.approvalId = view.approvalId;
    element.innerHTML = `
      <strong>${escapeHtml(view.label)}</strong>
      ${view.body ? `<pre>${escapeHtml(view.body)}</pre>` : ""}
      <form class="user-input-form">
        ${view.questions.map(renderUserInputQuestion).join("")}
        <div class="approval-actions">
          <button type="button" data-approval-decision="cancel">Отмена</button>
          <button type="submit" data-user-input-submit>Отправить</button>
        </div>
      </form>
    `;
    container.append(element);
    return;
  }

  const element = document.createElement(view.collapsible ? "details" : "div");
  element.className = `activity ${view.className}`;
  element.innerHTML = view.collapsible
    ? `
        <summary class="activity-head">${escapeHtml(view.summary)}</summary>
        ${view.body ? `<pre class="activity-body">${escapeHtml(view.body)}</pre>` : ""}
      `
    : `
        <div class="activity-head">${escapeHtml(view.label)}</div>
        ${view.body ? `<pre class="activity-body">${escapeHtml(view.body)}</pre>` : ""}
      `;
  container.append(element);
}

function renderUserInputQuestion(question) {
  const options = Array.isArray(question.options) ? question.options : [];
  const name = `question-${question.id}`;
  const inputType = question.isSecret ? "password" : "text";
  return `
    <fieldset class="user-input-question" data-question-id="${escapeHtml(question.id)}">
      <legend>
        <span>${escapeHtml(question.header || "Вопрос")}</span>
        <strong>${escapeHtml(question.question || "")}</strong>
      </legend>
      ${options.length
        ? `
          <div class="user-input-options">
            ${options.map((option, index) => `
              <label>
                <input
                  type="radio"
                  name="${escapeHtml(name)}"
                  value="${escapeHtml(option.label)}"
                  ${index === 0 ? "checked" : ""}
                />
                <span>
                  <strong>${escapeHtml(option.label)}</strong>
                  ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
                </span>
              </label>
            `).join("")}
            ${question.isOther ? `
              <label>
                <input type="radio" name="${escapeHtml(name)}" value="__other__" />
                <span>
                  <strong>Другой ответ</strong>
                  <input class="user-input-other" type="${inputType}" autocomplete="off" />
                </span>
              </label>
            ` : ""}
          </div>
        `
        : `<input class="user-input-text" type="${inputType}" autocomplete="off" />`}
    </fieldset>
  `;
}

function formatTechnicalEvent(event) {
  return {
    kind: "technical",
    label: event.type,
    body: JSON.stringify(event.payload, null, 2),
  };
}

function formatVisibleEvent(event) {
  const { type, payload } = event;
  if (type === "user.message") {
    return { kind: "message", label: "Вы", body: payload.text, className: "user" };
  }
  if (type === "turn.error" || type === "session.error") {
    return {
      kind: "activity",
      label: "Ошибка",
      body: cleanError(payload.message),
      className: "error",
    };
  }
  if (type === "turn.interrupted") {
    return {
      kind: "activity",
      label: "Выполнение прервано",
      body: "",
      className: "",
    };
  }
  if (type === "approval.requested") {
    const approvalId = payload.approvalId;
    if (payload.method === "item/tool/requestUserInput") {
      return {
        kind: "userInput",
        approvalId,
        label: "Codex просит уточнение",
        body: payload.autoResolutionMs
          ? `Если не ответить, Codex продолжит примерно через ${Math.round(payload.autoResolutionMs / 1000)} сек.`
          : "",
        questions: Array.isArray(payload.questions) ? payload.questions : [],
        className: "approval",
      };
    }
    const command = payload.command;
    const reason = payload.reason;
    const permissions = payload.permissions
      ? JSON.stringify(payload.permissions, null, 2)
      : "";
    const cwd = payload.cwd ? `cwd: ${payload.cwd}` : "";
    const grantRoot = payload.grantRoot ? `root: ${payload.grantRoot}` : "";
    return {
      kind: "approval",
      approvalId,
      label: payload.method?.includes("permissions")
        ? "Codex запрашивает расширенные права"
        : payload.method?.includes("fileChange") || payload.method === "applyPatchApproval"
        ? "Codex запрашивает изменение файлов"
        : "Codex запрашивает выполнение команды",
      body: [command, cwd, grantRoot, reason, permissions].filter(Boolean).join("\n"),
      className: "approval",
    };
  }

  const item = payload?.item;
  if (item?.type === "agent_message" || item?.type === "agentMessage") {
    return { kind: "message", label: "Codex", body: item.text, className: "agent" };
  }
  if (item?.type === "command_execution" || item?.type === "commandExecution") {
    return {
      kind: "activity",
      label: item.status === "failed" ? "Команда завершилась с ошибкой" : "Команда",
      summary: `$ ${item.command}`,
      body: (item.aggregated_output ?? item.aggregatedOutput)?.trim() ?? "",
      className: item.status === "failed" ? "error" : "",
      collapsible: true,
    };
  }
  if (item?.type === "file_change" || item?.type === "fileChange") {
    return {
      kind: "activity",
      label: "Изменения файлов",
      body: item.changes.map((change) => `${changeLabel(change.kind)} ${change.path}`).join("\n"),
      className: "files",
    };
  }
  if (item?.type === "error") {
    return {
      kind: "activity",
      label: "Ошибка",
      body: cleanError(item.message),
      className: "error",
    };
  }
  return null;
}

function changeLabel(kind) {
  return { add: "+", update: "±", delete: "−" }[kind] ?? "•";
}

function cleanError(message) {
  if (!message) return "Неизвестная ошибка";
  try {
    const parsed = JSON.parse(message);
    return parsed.detail ?? parsed.message ?? message;
  } catch {
    return String(message)
      .replace(/^Codex Exec exited[^:]*:\s*/i, "")
      .replace(/^Reading prompt from stdin\.\.\.\s*/i, "")
      .trim();
  }
}

function renderAgentMessage(text) {
  const source = String(text);
  const blocks = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push(renderMarkdownText(source.slice(cursor, match.index)));
    }
    const language = match[1].trim() || "code";
    const code = match[2].replace(/\n$/, "");
    blocks.push(`
      <div class="code-block">
        <div class="code-head">
          <span>${escapeHtml(language)}</span>
          <button type="button" class="copy-code">Копировать</button>
        </div>
        <pre><code>${highlightCode(code, language)}</code></pre>
      </div>
    `);
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    blocks.push(renderMarkdownText(source.slice(cursor)));
  }

  return blocks.join("");
}

function renderMarkdownText(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function highlightCode(code, language) {
  let html = escapeHtml(code);
  const normalized = language.toLowerCase();

  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(normalized)) {
    html = html
      .replace(
        /\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|try|catch|throw|type|interface|extends|implements)\b/g,
        '<span class="syntax-keyword">$1</span>',
      )
      .replace(/\b(true|false|null|undefined)\b/g, '<span class="syntax-value">$1</span>')
      .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="syntax-string">$1</span>');
  } else if (["json", "jsonc"].includes(normalized)) {
    html = html
      .replace(/(&quot;.*?&quot;)(\s*:)/g, '<span class="syntax-key">$1</span>$2')
      .replace(/\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, '<span class="syntax-value">$1</span>');
  } else if (["sh", "bash", "shell", "zsh"].includes(normalized)) {
    html = html
      .replace(/^(\s*)(\$|#)(.*)$/gm, '$1<span class="syntax-prompt">$2</span>$3')
      .replace(/\b(cd|npm|pnpm|yarn|git|node|npx|docker|curl|export|sudo)\b/g, '<span class="syntax-keyword">$1</span>');
  }

  return html;
}

$("#events").addEventListener("click", async (event) => {
  setSettingsOpen(false);
  const historyButton = event.target.closest("#load-older");
  if (historyButton) {
    await loadOlderEvents(historyButton);
    return;
  }

  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    const card = approvalButton.closest("[data-approval-id]");
    if (!card || !state.sessionId) return;
    approvalButton.disabled = true;
    try {
      await api(`/api/sessions/${state.sessionId}/approvals/${card.dataset.approvalId}`, {
        method: "POST",
        body: JSON.stringify({ decision: approvalButton.dataset.approvalDecision }),
      });
    } catch (error) {
      approvalButton.disabled = false;
      alert(error.message);
    }
    return;
  }

  const button = event.target.closest(".copy-code");
  if (!button) return;
  const code = button.closest(".code-block")?.querySelector("code")?.textContent;
  if (!code) return;

  await navigator.clipboard.writeText(code);
  button.textContent = "Скопировано";
  setTimeout(() => {
    button.textContent = "Копировать";
  }, 1200);
});

$("#events").addEventListener("submit", async (event) => {
  const form = event.target.closest(".user-input-form");
  if (!form) return;
  event.preventDefault();
  const card = form.closest("[data-approval-id]");
  if (!card || !state.sessionId) return;
  const button = form.querySelector("[data-user-input-submit]");
  if (button) button.disabled = true;
  try {
    await api(`/api/sessions/${state.sessionId}/approvals/${card.dataset.approvalId}`, {
      method: "POST",
      body: JSON.stringify({
        decision: "answer",
        answers: collectUserInputAnswers(form),
      }),
    });
  } catch (error) {
    if (button) button.disabled = false;
    alert(error.message);
  }
});

function collectUserInputAnswers(form) {
  const answers = {};
  form.querySelectorAll("[data-question-id]").forEach((fieldset) => {
    const id = fieldset.dataset.questionId;
    if (!id) return;
    const checked = fieldset.querySelector("input[type='radio']:checked");
    const text = fieldset.querySelector(".user-input-text");
    const other = fieldset.querySelector(".user-input-other");
    let values = [];
    if (checked) {
      values = checked.value === "__other__"
        ? [other?.value?.trim() ?? ""]
        : [checked.value];
    } else if (text) {
      values = [text.value.trim()];
    }
    answers[id] = { answers: values.filter(Boolean) };
  });
  return answers;
}

async function loadOlderEvents(button) {
  if (!state.sessionId || !state.firstSequence) return;
  button.disabled = true;
  try {
    const container = $("#events");
    const previousHeight = container.scrollHeight;
    const { events, hasMore } = await api(
      `/api/sessions/${state.sessionId}/events/history`
      + `?before=${state.firstSequence}&limit=200`,
    );
    if (events.length) {
      state.events = [...events, ...state.events];
      state.firstSequence = events[0].sequence;
    }
    state.hasMoreEvents = hasMore;
    renderEvents(false);
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight - previousHeight;
    });
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
}

async function refreshSelectedSession() {
  if (!state.sessionId) return;
  const { session } = await api(`/api/sessions/${state.sessionId}`);
  renderSessionMeta(session);
  if (isLearningProject()) {
    const purpose = session.purpose;
    if (purpose === "course" || purpose === "practice") {
      state.learning ??= {};
      state.learning.sessions ??= {};
      state.learning.sessions[purpose] = session;
      state.sessions = [
        state.learning.sessions.course,
        state.learning.sessions.practice,
      ].filter(Boolean);
      renderSessions();
      return;
    }
  }
  await loadSessions();
}

function scheduleSessionRefresh() {
  clearTimeout(state.sessionRefreshTimer);
  state.sessionRefreshTimer = setTimeout(() => void refreshSelectedSession(), 150);
}

function isSessionStateEvent(event) {
  return [
    "session.ready",
    "session.error",
    "session.stopped",
    "session.resumed",
    "session.settings",
    "turn.interrupted",
    "codex.turn.started",
    "codex.turn.completed",
  ].includes(event.type);
}

function updateApprovalState(event) {
  if (event.type === "approval.requested") {
    const id = String(event.payload.approvalId);
    state.approvals[id] = {
      id,
      method: event.payload.method,
      payload: event.payload,
    };
  }
  if (event.type === "approval.resolved") {
    delete state.approvals[String(event.payload.approvalId)];
  }
}

function resetProjectSessionView() {
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.reconnectTimer = null;
  state.sessionRefreshTimer = null;
  state.liveRenderFrame = null;
  state.sessions = [];
  state.sessionId = null;
  state.events = [];
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  state.gitStatus = null;
  state.gitProjectId = null;
  state.gitLoading = false;
  state.gitError = null;
  promptInput.value = "";
  resizePrompt();
  renderSessions();
  renderSessionMeta(null);
  renderEvents();
}

function clearSelectedSessionForProgress() {
  state.source?.close();
  state.source = null;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.sessionRefreshTimer);
  if (state.liveRenderFrame) cancelAnimationFrame(state.liveRenderFrame);
  state.reconnectTimer = null;
  state.sessionRefreshTimer = null;
  state.liveRenderFrame = null;
  state.sessionId = null;
  state.events = [];
  state.lastSequence = 0;
  state.firstSequence = 0;
  state.hasMoreEvents = false;
  state.approvals = {};
  state.liveTurnActive = false;
  state.liveResponse = null;
  state.selectedSession = null;
  promptInput.value = "";
  resizePrompt();
  renderGitPanel();
}

function renderLearningProgressMode() {
  $("#session-title").textContent = "Успехи";
  const meta = $("#session-meta");
  meta.className = "session-meta ready";
  meta.innerHTML = `
    <span class="session-meta-dot"></span>
    <span>${escapeHtml(learningSummaryLine(
      state.learning?.diarySummary ?? {},
      state.learning?.roadmapSummary ?? {},
    ) || "Дневник и дорожная карта")}</span>
  `;
  $("#session-settings").hidden = true;
  $("#toggle-settings").hidden = true;
  $("#interrupt").hidden = true;
  $("#prompt-form").hidden = true;
  $("#send").disabled = true;
  $("#sandbox-mode").disabled = true;
  renderGitPanel();
  renderEvents();
}

$("#project").addEventListener("change", async () => {
  saveCurrentDraft();
  resetProjectSessionView();
  rememberProject($("#project").value || null);
  await loadSessions();
  renderEvents();
});

$("#sandbox-mode").addEventListener("change", async (event) => {
  if (!state.sessionId) return;
  const select = event.target;
  if (
    select.value === "danger-full-access"
    && !confirm("Полный доступ снимает ограничения файловой системы и отключает approvals. Продолжить?")
  ) {
    const { session } = await api(`/api/sessions/${state.sessionId}`);
    renderSessionMeta(session);
    return;
  }
  await updateSessionSettings({ sandboxMode: select.value });
});

$("#model-select").addEventListener("change", async (event) => {
  const model = state.models.find((item) => item.model === event.target.value);
  if (!model) return;
  await updateSessionSettings({
    model: model.model,
    reasoningEffort: model.defaultReasoningEffort,
  });
});

$("#reasoning-effort").addEventListener("change", async (event) => {
  const model = currentModel();
  if (!model) return;
  await updateSessionSettings({
    model: model.model,
    reasoningEffort: event.target.value,
  });
});

const createProjectModal = $("#create-project-modal");

function closeCreateProject() {
  createProjectModal.hidden = true;
  state.pendingProject = null;
}

async function addProject(folder, create = false, kind = "dev") {
  const { project } = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: folder, create, kind }),
  });
  $("#project-form").reset();
  saveCurrentDraft();
  state.projects = [
    ...state.projects.filter((item) => item.id !== project.id),
    project,
  ];
  const option = document.createElement("option");
  option.value = project.id;
  option.textContent = project.name;
  $("#project").append(option);
  $("#project").value = project.id;
  resetProjectSessionView();
  rememberProject(project.id);
  await loadProjects();
  closeCreateProject();
  $(".add-project").open = false;
  setSidebarOpen(false);
}

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const folder = $("#project-folder").value.trim();
  const kind = $("#project-kind-learning").checked ? "learning" : "dev";
  if (!folder) return;
  try {
    await addProject(folder, false, kind);
  } catch (error) {
    if (error.code === "PROJECT_NOT_FOUND") {
      state.pendingProject = { folder, kind };
      $("#create-project-path").textContent = error.path;
      createProjectModal.hidden = false;
      return;
    }
    alert(error.message);
  }
});

document.querySelectorAll("[data-cancel-project]").forEach((button) => {
  button.addEventListener("click", closeCreateProject);
});

$("#confirm-create-project").addEventListener("click", async () => {
  if (!state.pendingProject) return;
  const button = $("#confirm-create-project");
  button.disabled = true;
  try {
    await addProject(state.pendingProject.folder, true, state.pendingProject.kind);
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#enable-learning").addEventListener("click", async () => {
  const project = selectedProject();
  if (!project || project.kind === "learning") return;
  try {
    const { project: updated, learning } = await api(
      `/api/projects/${encodeURIComponent(project.id)}/learning/enable`,
      { method: "POST" },
    );
    state.projects = state.projects.map((item) => item.id === updated.id ? updated : item);
    state.learning = learning;
    state.learningMode = "course";
    localStorage.setItem("ronix-agent-learning-mode", state.learningMode);
    await loadProjects();
  } catch (error) {
    alert(error.message);
  }
});

async function createSession() {
  const projectId = $("#project").value;
  if (!projectId) return;
  try {
    const { session } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, ...preferredModelSettings() }),
    });
    await loadSessions();
    if (state.sessionId !== session.id) await selectSession(session.id);
  } catch (error) {
    alert(error.message);
  }
}

$("#new-session").addEventListener("click", () => void createSession());

$("#prompt-form").addEventListener("submit", async (event) => {
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
    persistDrafts();
    resizePrompt();
  } catch (error) {
    alert(error.message);
    $("#send").disabled = false;
  }
});

const promptInput = $("#prompt");
promptInput.addEventListener("focus", () => setSettingsOpen(false));
promptInput.addEventListener("input", () => {
  resizePrompt();
  saveCurrentDraft();
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!$("#send").disabled) $("#prompt-form").requestSubmit();
  }
});

function resizePrompt() {
  const form = $("#prompt-form");
  const style = getComputedStyle(promptInput);
  const minHeight = Number.parseFloat(style.minHeight) || 44;
  const maxHeight = Number.parseFloat(style.maxHeight) || 180;
  if (form.hidden) {
    promptInput.style.height = `${minHeight}px`;
    return;
  }
  if (!promptInput.value) {
    promptInput.style.height = `${minHeight}px`;
    return;
  }
  promptInput.style.height = `${minHeight}px`;
  promptInput.style.height = `${Math.max(
    minHeight,
    Math.min(promptInput.scrollHeight, maxHeight),
  )}px`;
}

function saveCurrentDraft() {
  if (!state.sessionId) return;
  const value = promptInput.value;
  if (value) state.drafts[state.sessionId] = value;
  else delete state.drafts[state.sessionId];
  persistDrafts();
}

function restoreDraft(sessionId) {
  promptInput.value = state.drafts[sessionId] ?? "";
  resizePrompt();
}

function persistDrafts() {
  localStorage.setItem("ronix-agent-drafts", JSON.stringify(state.drafts));
}

fetch("/api/auth/status")
  .then((response) => response.ok ? response.json() : null)
  .then((status) => {
    if (status?.enabled) $("#logout").hidden = false;
  })
  .catch(() => {});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    location.replace("/login");
  }
});

$("#interrupt").addEventListener("click", async () => {
  if (!state.sessionId) return;
  await api(`/api/sessions/${state.sessionId}/interrupt`, { method: "POST" });
});

function sessionTitle(session) {
  if (session.purpose === "course") return "Курс";
  if (session.purpose === "practice") return "Практика";
  return `Сессия ${session.id.slice(0, 8)}`;
}

function statusLabel(status) {
  return {
    ready: "Готова",
    running: "Codex работает",
    stopped: "Остановлена",
    error: "Ошибка",
  }[status] ?? status;
}

function relativeTime(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "сейчас";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return new Date(date).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function syncViewportHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

syncViewportHeight();
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);

loadModels()
  .then(loadProjects)
  .then(() => setConnection("ready"))
  .catch((error) => {
    setConnection("error");
    alert(error.message);
  });
