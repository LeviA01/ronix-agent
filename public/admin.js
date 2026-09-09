const labels = { chat: "Чат", learning: "Обучение", development: "Разработка", outline: "Outline" };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Не удалось выполнить запрос");
  return body;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
function checkbox(text, checked, value) {
  const label = element("label", "access-choice");
  const input = document.createElement("input");
  input.type = "checkbox"; input.checked = checked; input.value = value;
  label.append(input, document.createTextNode(text));
  return label;
}
export function mountAccess(root) {
  root.innerHTML = `
    <header class="access-heading"><div><h1 id="access-title">Пользователи и доступ</h1><p>Управляйте ролями и возможностями в Ronix.</p></div></header>
    <div class="access-toolbar"><label class="access-search"><span>Поиск пользователей</span><input type="search" placeholder="Имя или логин" autocomplete="off"></label><span class="access-count"></span></div>
    <p class="access-note">Новые пользователи появятся после первого входа. Изменение прав остановит их активные задачи; переписка и учебный прогресс сохранятся.</p>
    <div class="access-status" role="status" aria-live="polite"></div>
    <div class="access-users" aria-label="Пользователи" aria-busy="true"></div>`;
  const list = root.querySelector(".access-users");
  const status = root.querySelector(".access-status");
  const search = root.querySelector("input[type=search]");
  const count = root.querySelector(".access-count");
  let users = [];
  let models = [];
  function notice(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function userForm(user) {
    const form = element("form", "access-user");
    form.dataset.search = `${user.name} ${user.username}`.toLocaleLowerCase();
    const identity = element("div", "access-identity");
    const avatar = element("span", "access-avatar", (user.name || user.username || "?").slice(0, 2).toLocaleUpperCase());
    avatar.setAttribute("aria-hidden", "true");
    const name = element("div", "access-name");
    name.append(element("h2", "", user.name || user.username), element("span", "access-username", `@${user.username}`));
    const badge = element("span", "access-badge");
    function updateBadge() { badge.textContent = user.disabled ? "Отключён" : user.role === "admin" ? "Администратор" : "Пользователь"; badge.dataset.disabled = String(user.disabled); }
    updateBadge(); identity.append(avatar, name, badge);
    const controls = element("div", "access-controls");
    const roleLabel = element("label", "access-role", "Роль");
    const role = document.createElement("select");
    for (const [value, text] of [["user", "Пользователь"], ["admin", "Администратор"]]) role.add(new Option(text, value, false, user.role === value));
    roleLabel.append(role);
    const modelLabel = element("label", "access-role", "Модель чата (для пользователя)");
    const model = document.createElement("select");
    model.add(new Option("По умолчанию сервиса", "", false, !user.chatModel));
    for (const item of models) model.add(new Option(item.displayName, item.model, false, user.chatModel === item.model));
    if (user.chatModel && !models.some(item => item.model === user.chatModel)) {
      model.add(new Option(`${user.chatModel} (недоступна)`, user.chatModel, true, true));
    }
    modelLabel.append(model, element("small", "", "Администратор выбирает модель своих чатов самостоятельно."));
    const enabled = checkbox("Аккаунт включён", !user.disabled, "enabled");
    const modules = element("fieldset", "access-modules");
    modules.append(element("legend", "", "Доступные модули"));
    const choices = element("div", "access-module-options");
    for (const [id, label] of Object.entries(labels)) choices.append(checkbox(label, user.modules.includes(id), id));
    modules.append(choices);
    const footer = element("div", "access-user-footer");
    const feedback = element("span", "access-feedback"); feedback.setAttribute("role", "status");
    const save = element("button", "access-save", "Сохранить"); save.type = "submit"; save.disabled = true;
    const payload = () => ({ role: role.value, chatModel: model.value || null, disabled: !enabled.querySelector("input").checked, modules: [...modules.querySelectorAll("input:checked")].map(input => input.value) });
    let saved = JSON.stringify(payload());
    form.addEventListener("change", () => { save.disabled = saved === JSON.stringify(payload()); feedback.textContent = save.disabled ? "" : "Есть изменения"; feedback.dataset.error = "false"; });
    footer.append(feedback, save); controls.append(roleLabel, modelLabel, enabled, modules); form.append(identity, controls, footer);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const data = payload();
      const inputs = [...form.querySelectorAll("input, select, button")]; inputs.forEach(input => input.disabled = true);
      save.textContent = "Сохранение…"; feedback.textContent = "";
      try {
        const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(data) });
        Object.assign(user, result.user); updateBadge(); saved = JSON.stringify(data);
        feedback.dataset.error = "false"; feedback.textContent = "Изменения сохранены";
      } catch (error) { feedback.dataset.error = "true"; feedback.textContent = error.message; }
      finally { inputs.forEach(input => input.disabled = false); save.disabled = saved === JSON.stringify(payload()); save.textContent = "Сохранить"; }
    });
    return form;
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
    list.querySelectorAll(".access-user").forEach(form => { form.hidden = !form.dataset.search.includes(query); if (!form.hidden) visible++; });
    count.textContent = query ? `${visible} из ${users.length}` : `Всего: ${users.length}`;
    notice(!visible ? query ? "Никого не нашли. Попробуйте другое имя или логин." : "Пользователей пока нет. Список появится после первого входа в Ronix." : "");
  }
  search.addEventListener("input", filter);
  async function load() {
    notice("Загрузка пользователей…"); list.setAttribute("aria-busy", "true");
    try {
      const [userData, modelData] = await Promise.all([api("/api/admin/users"), api("/api/codex/models").catch(() => null)]);
      users = userData.users; models = modelData?.models ?? [];
      list.replaceChildren(...users.map(userForm)); filter();
      if (!modelData) notice("Список моделей недоступен. Текущие назначения сохранены; обновите страницу для выбора другой модели.", true);
    }
    catch (error) { notice(error.message, true); const retry = element("button", "access-retry", "Повторить"); retry.type = "button"; retry.onclick = () => void load(); status.append(retry); }
    finally { list.setAttribute("aria-busy", "false"); }
  }
  void load();
}
const standalone = document.querySelector("#access-page");
if (standalone) mountAccess(standalone);
