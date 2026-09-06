// Resolve identity before loading state and drafts from browser storage.
const response = await fetch("/api/auth/status");
if (!response.ok) {
  document.body.textContent = "Не удалось проверить вход. Обновите страницу или войдите через Authentik.";
} else {
  globalThis.ronixAccess = await response.json();
  const { bootstrap } = await import("./js/main.js");
  void bootstrap();
}
