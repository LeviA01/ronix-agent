import { $ , $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { escapeHtml, formatTokens, resetLabel, windowLabel } from "../core/format.js";
import { setSidebarOpen } from "../layout/panels.js";

const limitsModal = () => $("#limits-modal");

export function closeLimits() {
  const modal = limitsModal();
  if (modal) modal.hidden = true;
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

export function bindLimits() {
  $("#show-limits")?.addEventListener("click", () => {
    setSidebarOpen(false);
    limitsModal().hidden = false;
    void loadLimits();
  });
  $$("[data-close-limits]").forEach((button) => {
    button.addEventListener("click", closeLimits);
  });
  $("#refresh-limits")?.addEventListener("click", () => void loadLimits(true));
}
