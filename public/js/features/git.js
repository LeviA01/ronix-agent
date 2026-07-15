import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml, pluralRu, uniqueStrings } from "../core/format.js";
import { selectedProject, isLearningProject } from "./context.js";
import { setGitOpen } from "../layout/panels.js";
import { setPromptValue } from "./composer.js";

export function resetGitStatus() {
  state.gitStatus = null;
  state.gitProjectId = null;
  state.gitLoading = false;
  state.gitError = null;
  state.gitSyncRunning = null;
  state.gitSyncMessage = null;
  renderGitPanel();
}

export async function refreshGitStatus(projectId = $("#project")?.value) {
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

export function renderGitPanel() {
  const panel = $("#git-panel");
  const project = selectedProject();
  const session = state.selectedSession;
  const hideForLearningMode = isLearningProject()
    && ["theory", "progress"].includes(state.learningMode);
  if (!panel) return;
  if (!project || hideForLearningMode) {
    panel.hidden = true;
    panel.innerHTML = "";
    if ($("#toggle-git")) $("#toggle-git").hidden = true;
    setGitOpen(false);
    return;
  }

  panel.hidden = false;
  if ($("#toggle-git")) $("#toggle-git").hidden = false;
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
  return { fetch: "Fetch", pull: "Pull", push: "Push" }[action] ?? action;
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
  setPromptValue(buildGitPrompt(status, state.selectedSession));
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
