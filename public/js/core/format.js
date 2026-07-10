export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;");
}

export function pluralRu(value, one, few, many) {
  const abs = Math.abs(value);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function relativeTime(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "сейчас";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return new Date(date).toLocaleDateString();
}

export function sessionTitle(session) {
  if (session.purpose === "course") return "Курс";
  if (session.purpose === "practice") return "Практика";
  return `Сессия ${session.id.slice(0, 8)}`;
}

export function statusLabel(status) {
  return {
    ready: "Готова",
    running: "Codex работает",
    stopped: "Остановлена",
    error: "Ошибка",
  }[status] ?? status;
}

export function effortLabel(effort) {
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

export function cleanError(message) {
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

export function changeLabel(kind) {
  return { add: "+", update: "±", delete: "−" }[kind] ?? "•";
}

export function formatTokens(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function windowLabel(minutes) {
  if (minutes === 300) return "5 часов";
  if (minutes === 10080) return "7 дней";
  if (!minutes) return "Период";
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч.`;
  return `${minutes} мин.`;
}

export function resetLabel(timestamp) {
  if (!timestamp) return "Время сброса неизвестно";
  return "Сброс " + new Date(timestamp * 1000).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
