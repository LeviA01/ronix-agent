import { changeLabel, cleanError, escapeHtml } from "../core/format.js";

export function formatTechnicalEvent(event) {
  return {
    kind: "technical",
    label: event.type,
    body: JSON.stringify(event.payload, null, 2),
  };
}

export function formatVisibleEvent(event) {
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

export function renderUserInputQuestion(question) {
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

export function collectUserInputAnswers(form) {
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
