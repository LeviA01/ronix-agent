export function hasModule(module) {
  const user = globalThis.ronixAccess?.user;
  return !user || user.modules.includes(module);
}
export function applyAccess() {
  const user = globalThis.ronixAccess?.user;
  if (!user) return;
  for (const module of ["chat", "learning", "development"]) {
    document.body.dataset[`allow${module[0].toUpperCase()}${module.slice(1)}`] = String(hasModule(module));
  }
  document.body.dataset.admin = String(user.role === "admin");
  const link = document.querySelector("#admin-link");
  if (link) link.hidden = user.role !== "admin";
  const learning = document.querySelector("#project-kind-learning");
  if (!hasModule("development") && learning) { learning.checked = true; learning.disabled = true; }
}

const adminLink = document.querySelector("#admin-link");
let accessDialog;
adminLink?.addEventListener("click", async event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (!accessDialog) {
    const stylesheet = document.createElement("link"); stylesheet.rel = "stylesheet"; stylesheet.href = "/access.css";
    document.head.append(stylesheet);
    accessDialog = document.createElement("dialog");
    accessDialog.className = "access-dialog";
    accessDialog.setAttribute("aria-labelledby", "access-title");
    accessDialog.innerHTML = `<button type="button" class="access-close" aria-label="Закрыть пользователей и доступ"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><section class="access-ui"><h1 id="access-title">Пользователи и доступ</h1><p role="status">Загрузка…</p></section>`;
    document.body.append(accessDialog);
    accessDialog.addEventListener("keydown", event => {
      // Keep Escape local; the native dialog still handles closing and focus.
      if (event.key === "Escape") event.stopPropagation();
    });
    accessDialog.querySelector(".access-close").addEventListener("click", () => accessDialog.close());
    accessDialog.addEventListener("click", event => {
      const rect = accessDialog.getBoundingClientRect();
      if (event.target === accessDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) accessDialog.close();
    });
  }
  if (accessDialog.open) return;
  accessDialog.showModal();
  if (!accessDialog.dataset.loaded) {
    try {
      const { mountAccess } = await import("/admin.js");
      mountAccess(accessDialog.querySelector(".access-ui"));
      accessDialog.dataset.loaded = "true";
    } catch {
      accessDialog.querySelector(".access-ui").innerHTML = '<h1 id="access-title">Пользователи и доступ</h1><p role="alert">Не удалось загрузить раздел. Закройте окно и попробуйте снова.</p>';
    }
  }
});
