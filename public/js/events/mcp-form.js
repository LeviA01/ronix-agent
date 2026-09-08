import { escapeHtml } from "../core/format.js";

export function renderMcpForm(payload) {
  if (payload.mode === "url") {
    let url;
    try { url = new URL(payload.url); } catch { return null; }
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return `<p><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Открыть ${escapeHtml(url.hostname)}</a></p>
      <p>Завершите действие на сайте, затем нажмите «Подтвердить».</p>`;
  }
  if (payload.mode !== "form" || payload.requestedSchema?.type !== "object") return null;
  const required = payload.requestedSchema.required ?? [];
  const fields = [];
  for (const [name, schema] of Object.entries(payload.requestedSchema.properties ?? {})) {
    const attributes = `data-mcp-field="${escapeHtml(name)}" data-value-type="${escapeHtml(schema.type)}" ${required.includes(name) ? "required" : ""}`;
    const choices = schema.enum?.map((value, index) => ({ value, title: schema.enumNames?.[index] ?? value }))
      ?? schema.oneOf?.map(option => ({ value: option.const, title: option.title ?? option.const }));
    let input;
    if (schema.type === "boolean" || choices) {
      const options = choices ?? [{ value: true, title: "Да" }, { value: false, title: "Нет" }];
      input = `<select ${attributes}><option value="">Выберите ответ</option>${options.map(option =>
        `<option value="${escapeHtml(String(option.value))}" ${option.value === schema.default ? "selected" : ""}>${escapeHtml(String(option.title))}</option>`
      ).join("")}</select>`;
    } else if (["string", "number", "integer"].includes(schema.type)) {
      const numeric = schema.type !== "string";
      input = `<input ${attributes} type="${numeric ? "number" : schema.format === "email" ? "email" : "text"}"
        ${numeric ? `step="${schema.type === "integer" ? "1" : "any"}"` : ""}
        value="${escapeHtml(String(schema.default ?? ""))}" autocomplete="off" />`;
    } else if (schema.type === "array" && schema.items?.enum) {
      input = `<select ${attributes} multiple>${schema.items.enum.map(value =>
        `<option value="${escapeHtml(value)}" ${schema.default?.includes(value) ? "selected" : ""}>${escapeHtml(value)}</option>`
      ).join("")}</select>`;
    } else {
      return null;
    }
    fields.push(`<label class="user-input-question"><strong>${escapeHtml(schema.title ?? name)}</strong>
      ${schema.description ? `<small>${escapeHtml(schema.description)}</small>` : ""}${input}</label>`);
  }
  return fields.join("");
}

export function collectMcpAnswers(form) {
  return Object.fromEntries([...form.querySelectorAll("[data-mcp-field]")].flatMap(input => {
    const type = input.dataset.valueType;
    if (input.value === "" && !input.required) return [];
    const value = type === "boolean" ? input.value === "true"
      : type === "number" || type === "integer" ? Number(input.value)
      : type === "array" ? [...input.selectedOptions].map(option => option.value)
      : input.value;
    return [[input.dataset.mcpField, value]];
  }));
}
