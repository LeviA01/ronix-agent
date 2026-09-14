const modules = {
  chat: ["Чат", "Диалоги с Ronix"],
  learning: ["Обучение", "Курсы и практика"],
  development: ["Разработка", "Проекты и код"],
  outline: ["Outline", "База знаний"],
};
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
function button(className, text) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}
function values(user) {
  return { role: user.role, disabled: user.disabled, modules: Object.keys(modules).filter(id => user.modules.includes(id)), chatModel: user.chatModel ?? null };
}
function dirty(entry) { return JSON.stringify(values(entry.user)) !== JSON.stringify(entry.draft); }
function avatar(user) {
  const initials = (user.name || user.username || "?").trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase();
  const node = element("span", "access-avatar", initials);
  node.setAttribute("aria-hidden", "true");
  return node;
}

// The popup stays inside the dialog's DOM/focus boundary, while the top layer
// lets it escape the editor's scroll container. No body-level menu portal.
function modelPicker(container, onChange) {
  const trigger = button("access-model-trigger");
  trigger.id = "access-model-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "access-model-menu");
  trigger.setAttribute("aria-labelledby", "access-model-label access-model-value");
  trigger.setAttribute("aria-describedby", "access-model-help");
  trigger.innerHTML = '<span id="access-model-value"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
  const menu = element("div", "access-model-menu");
  menu.id = "access-model-menu";
  menu.setAttribute("popover", "manual");
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Выбор модели чата");
  menu.innerHTML = `<input class="access-model-search" type="search" placeholder="Найти модель…" aria-label="Поиск моделей" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="access-model-options" autocomplete="off">
    <div id="access-model-options" class="access-model-options" role="listbox" aria-label="Модели чата"></div>
    <p class="access-model-empty" role="status" hidden>Модель не найдена</p>`;
  container.append(trigger, menu);
  const search = menu.querySelector("input");
  const list = menu.querySelector("[role=listbox]");
  const empty = menu.querySelector(".access-model-empty");
  const events = new AbortController();
  let options = [], visible = [], selected = null, active = -1;
  const isOpen = () => menu.matches(":popover-open");
  const listen = (target, name, handler, extra = {}) => target?.addEventListener(name, handler, { ...extra, signal: events.signal });

  function close(restoreFocus = false) {
    if (!isOpen()) return;
    menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (restoreFocus && !trigger.disabled && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
  }
  function position() {
    if (!isOpen()) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    if (!trigger.getClientRects().length) { close(); return; }
    // A software keyboard can move the trigger outside the visual viewport.
    // Keep the focused search open and anchor its popup to the visible edge.
    const anchorTop = Math.max(top + 12, Math.min(rect.top, top + height - 12));
    const anchorBottom = Math.max(top + 12, Math.min(rect.bottom, top + height - 12));
    const above = Math.max(0, anchorTop - top - 20), below = Math.max(0, top + height - anchorBottom - 20);
    const upwards = below < 340 && above > below;
    menu.style.width = `${Math.min(Math.max(rect.width, 280), width - 24)}px`;
    menu.style.maxHeight = `${Math.min(360, upwards ? above : below)}px`;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - bounds.width - 12))}px`;
    menu.style.top = `${Math.max(top + 12, Math.min(upwards ? anchorTop - bounds.height - 8 : anchorBottom + 8, top + height - bounds.height - 12))}px`;
  }
  function highlight(index, scroll = true) {
    active = index;
    [...list.children].forEach((option, i) => { option.dataset.active = String(i === active); });
    const option = list.children[active];
    if (option) {
      search.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    } else search.removeAttribute("aria-activedescendant");
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    visible = options.filter(option => `${option.label} ${option.value ?? ""}`.toLocaleLowerCase().includes(query));
    list.replaceChildren(...visible.map((option, index) => {
      const node = element("div", "access-model-option");
      node.id = `access-model-option-${index}`;
      node.setAttribute("role", "option");
      node.setAttribute("aria-selected", String(option.value === selected));
      node.dataset.index = String(index);
      node.append(element("span", "", option.label), element("span", "access-model-check", option.value === selected ? "✓" : ""));
      node.lastChild.setAttribute("aria-hidden", "true");
      return node;
    }));
    empty.hidden = visible.length > 0;
    highlight(visible.length ? Math.max(0, visible.findIndex(option => option.value === selected)) : -1, false);
    position();
  }
  function open() {
    if (trigger.disabled) return;
    search.value = "";
    menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-expanded", "true");
    filter();
    search.focus({ preventScroll: true });
    highlight(active);
  }
  function choose(index) {
    if (!visible[index]) return;
    onChange(visible[index].value);
    close(true);
  }
  listen(trigger, "click", () => isOpen() ? close(true) : open());
  listen(trigger, "keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); open();
  });
  listen(search, "input", filter);
  listen(menu, "keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (event.key === "Tab") close(true);
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); choose(active); }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (visible.length) highlight((active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
    }
  });
  listen(list, "pointerdown", event => { if (event.target.closest("[role=option]")) event.preventDefault(); });
  listen(list, "click", event => { const option = event.target.closest("[role=option]"); if (option) choose(Number(option.dataset.index)); });
  listen(document, "pointerdown", event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(); });
  listen(document, "focusin", event => { if (!menu.contains(event.target) && event.target !== trigger) close(); });
  listen(document, "scroll", event => { if (!menu.contains(event.target)) position(); }, { capture: true });
  listen(window, "resize", position);
  listen(window.visualViewport, "resize", position);
  listen(window.visualViewport, "scroll", position);
  listen(container.closest("dialog"), "close", () => close());
  return {
    update(items, value, disabled, loaded) {
      selected = value;
      options = [{ label: "По умолчанию сервиса", value: null }, ...items.map(item => ({ label: item.displayName || item.model, value: item.model }))];
      if (value && !items.some(item => item.model === value)) options.push({ label: `${value}${loaded ? " (недоступна)" : ""}`, value });
      trigger.querySelector("span").textContent = options.find(option => option.value === value)?.label;
      trigger.disabled = disabled;
      if (disabled) close();
    },
    destroy() { close(); events.abort(); },
  };
}

export function mountAccess(root) {
  root.dataset.view = "list";
  root.innerHTML = `
    <header class="access-heading"><h1 id="access-title">Пользователи и доступ</h1><p>Роли, модули и настройки чата</p></header>
    <div class="access-workspace">
      <aside class="access-directory" aria-label="Список пользователей">
        <div class="access-toolbar"><div class="access-list-heading"><h2>Пользователи</h2><span class="access-count" aria-live="polite"></span></div>
          <label class="access-search"><span class="access-sr-only">Поиск пользователей</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" placeholder="Имя или логин" autocomplete="off"></label></div>
        <div class="access-directory-scroll"><div class="access-status" role="status"></div><div class="access-users" aria-busy="true"></div></div>
        <p class="access-directory-note">Новые пользователи появляются здесь после первого входа.</p>
      </aside>
      <section class="access-editor" aria-label="Настройки пользователя"><p class="access-editor-empty">Выберите пользователя, чтобы настроить доступ.</p></section>
    </div>`;
  const list = root.querySelector(".access-users"), status = root.querySelector(".access-status");
  const search = root.querySelector(".access-search input"), count = root.querySelector(".access-count");
  const editor = root.querySelector(".access-editor");
  const entries = new Map(), rows = new Map();
  let selectedId = null, picker, refreshEditor;
  let models = [], modelState = "loading", listState = "loading";

  function updateRow(entry) {
    const row = rows.get(entry.user.id);
    row.querySelector(".access-row-role").textContent = entry.user.role === "admin" ? "Администратор" : "Пользователь";
    row.querySelector(".access-row-disabled").hidden = !entry.user.disabled;
    row.querySelector(".access-draft").hidden = !dirty(entry);
    row.setAttribute("aria-current", String(entry.user.id === selectedId));
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const [id, entry] of entries) {
      const row = rows.get(id);
      row.hidden = !`${entry.user.name} ${entry.user.username}`.toLocaleLowerCase().includes(query);
      if (!row.hidden) visible++;
    }
    count.textContent = query ? `${visible} / ${entries.size}` : String(entries.size);
    if (listState === "ready") status.textContent = visible ? "" : query ? "Никого не нашли. Попробуйте другое имя или логин." : "Пользователей пока нет.";
  }
  function changed(entry) {
    entry.message = ""; entry.error = false;
    updateRow(entry); refreshEditor?.();
  }
  function selectUser(id, focus = true) {
    selectedId = id;
    if (focus) root.dataset.view = "editor";
    entries.forEach(updateRow);
    renderEditor(entries.get(id));
    if (focus) editor.querySelector("h2").focus({ preventScroll: true });
  }
  function renderEditor(entry) {
    picker?.destroy();
    const user = entry.user;
    editor.innerHTML = `
      <form class="access-user">
        <header class="access-editor-heading"><button class="access-back" type="button">← К пользователям</button><div class="access-identity"><div class="access-name"><h2 tabindex="-1"></h2><div class="access-identity-meta"><span class="access-username"></span><span class="access-badge"></span></div></div></div></header>
        <div class="access-editor-scroll">
          <fieldset class="access-fields"><legend class="access-sr-only">Настройки доступа</legend>
            <section class="access-section"><h3>Аккаунт</h3>
              <fieldset class="access-role"><legend class="access-sr-only">Роль</legend><div class="access-role-options">
                <label><input type="radio" name="role" value="user"><span>Пользователь</span></label>
                <label><input type="radio" name="role" value="admin"><span>Администратор</span></label>
              </div></fieldset>
              <label class="access-enabled"><span><strong>Аккаунт включён</strong><small>Пользователь может входить в Ronix</small></span><input type="checkbox" role="switch" name="enabled" aria-label="Аккаунт включён"></label>
            </section>
            <fieldset class="access-section access-modules"><legend>Доступные модули</legend><div class="access-module-options"></div></fieldset>
            <section class="access-section access-model"><h3 id="access-model-label">Модель чата</h3><div class="access-model-control"></div><p id="access-model-help" class="access-help"></p>
              <div class="access-model-status" role="status"><span></span><button type="button" class="access-retry">Повторить загрузку</button></div>
            </section>
          </fieldset>
        </div>
        <footer class="access-user-footer"><p class="access-save-note">Сохранение остановит активные задачи. Переписка и прогресс сохранятся.</p>
          <div class="access-save-actions"><span class="access-feedback" role="status"></span><div class="access-buttons"><button type="button" class="access-reset" aria-label="Отменить изменения">Отменить<span class="access-reset-detail"> изменения</span></button><button type="submit" class="access-save">Сохранить</button></div></div>
        </footer>
      </form>`;
    const identity = editor.querySelector(".access-identity");
    identity.prepend(avatar(user));
    editor.querySelector("h2").textContent = user.name || user.username;
    editor.querySelector("h2").title = user.name || user.username;
    editor.querySelector(".access-username").textContent = `@${user.username}`;
    const form = editor.querySelector("form"), fields = editor.querySelector(".access-fields");
    const roleInputs = [...editor.querySelectorAll("[name=role]")];
    const enabled = editor.querySelector("[name=enabled]");
    const choices = editor.querySelector(".access-module-options");
    for (const [id, [name, description]] of Object.entries(modules)) {
      const choice = element("label", "access-choice");
      const input = document.createElement("input");
      input.type = "checkbox"; input.name = "module"; input.value = id;
      input.checked = entry.draft.modules.includes(id);
      const text = element("span", ""); text.append(element("strong", "", name), element("small", "", description));
      choice.append(input, text); choices.append(choice);
    }
    roleInputs.forEach(input => { input.checked = input.value === entry.draft.role; });
    enabled.checked = !entry.draft.disabled;
    const save = editor.querySelector(".access-save"), reset = editor.querySelector(".access-reset");
    const feedback = editor.querySelector(".access-feedback"), badge = editor.querySelector(".access-badge");
    const retry = editor.querySelector(".access-retry"), modelStatus = editor.querySelector(".access-model-status");
    picker = modelPicker(editor.querySelector(".access-model-control"), value => { entry.draft.chatModel = value; changed(entry); });
    refreshEditor = () => {
      const modified = dirty(entry);
      roleInputs.forEach(input => { input.checked = input.value === entry.draft.role; });
      enabled.checked = !entry.draft.disabled;
      choices.querySelectorAll("input").forEach(input => { input.checked = entry.draft.modules.includes(input.value); });
      fields.disabled = entry.busy;
      save.disabled = reset.disabled = !modified || entry.busy;
      save.textContent = entry.busy ? "Сохранение…" : "Сохранить";
      form.setAttribute("aria-busy", String(entry.busy));
      feedback.textContent = entry.busy ? "Сохраняем изменения…" : entry.message || (modified ? "Есть изменения" : "");
      feedback.dataset.error = String(entry.error);
      badge.textContent = user.disabled ? "Отключён" : "Активен";
      badge.dataset.disabled = String(user.disabled);
      picker.update(models, entry.draft.chatModel, entry.busy || entry.draft.role === "admin" || modelState !== "ready", modelState === "ready");
      editor.querySelector(".access-help").textContent = entry.draft.role === "admin"
        ? "Администратор выбирает модель своих чатов самостоятельно."
        : "Используется в новых и существующих чатах. Пользователь не сможет изменить её самостоятельно.";
      modelStatus.hidden = modelState === "ready";
      modelStatus.dataset.error = String(modelState === "error");
      modelStatus.querySelector("span").textContent = modelState === "loading" ? "Загрузка моделей…" : "Не удалось загрузить модели. Текущее назначение сохранено.";
      retry.hidden = modelState !== "error";
    };
    refreshEditor();
    form.addEventListener("change", () => {
      entry.draft.role = roleInputs.find(input => input.checked).value;
      entry.draft.disabled = !enabled.checked;
      entry.draft.modules = [...choices.querySelectorAll("input:checked")].map(input => input.value);
      changed(entry);
    });
    editor.querySelector(".access-back").addEventListener("click", () => {
      root.dataset.view = "list";
      const row = rows.get(selectedId);
      (row && !row.hidden ? row : search).focus({ preventScroll: true });
    });
    reset.addEventListener("click", () => {
      entry.draft = values(entry.user); entry.message = ""; entry.error = false;
      updateRow(entry); renderEditor(entry); editor.querySelector("[name=role]:checked").focus({ preventScroll: true });
    });
    retry.addEventListener("click", () => void loadModels());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (entry.busy || !dirty(entry)) return;
      const data = structuredClone(entry.draft);
      entry.busy = true; entry.message = ""; entry.error = false; refreshEditor();
      try {
        const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify(data) });
        Object.assign(user, result.user);
        entry.draft = values(user);
        entry.message = "Изменения сохранены";
      } catch (error) { entry.error = true; entry.message = error.message; }
      finally {
        entry.busy = false;
        updateRow(entry);
        // A response belongs to its user, even if another editor is now open.
        if (selectedId === user.id) refreshEditor();
      }
    });
  }
  async function loadModels() {
    modelState = "loading"; refreshEditor?.();
    try { models = (await api("/api/codex/models")).models; modelState = "ready"; }
    catch { modelState = "error"; }
    refreshEditor?.();
  }
  async function loadUsers() {
    listState = "loading"; status.textContent = "Загрузка пользователей…"; status.dataset.error = "false";
    list.setAttribute("aria-busy", "true");
    try {
      const { users } = await api("/api/admin/users");
      for (const user of users) {
        const entry = { user, draft: values(user), busy: false, message: "", error: false };
        entries.set(user.id, entry);
        const row = button("access-user-row"); row.dataset.userId = user.id;
        const text = element("span", "access-row-text");
        text.append(element("strong", "access-row-name", user.name || user.username), element("span", "access-row-username", `@${user.username}`));
        text.firstChild.title = user.name || user.username;
        const meta = element("span", "access-row-meta");
        meta.append(element("span", "access-row-role"), element("span", "access-row-disabled", "Отключён"));
        text.append(meta);
        const draft = element("span", "access-draft", "•");
        draft.setAttribute("aria-label", "Есть несохранённые изменения"); draft.title = "Есть несохранённые изменения";
        row.append(avatar(user), text, draft);
        row.addEventListener("click", () => selectUser(user.id));
        rows.set(user.id, row); list.append(row); updateRow(entry);
      }
      listState = "ready"; filter();
      if (users.length) selectUser(users[0].id, false);
    } catch (error) {
      listState = "error"; status.dataset.error = "true"; status.textContent = error.message;
      const retry = button("access-retry", "Повторить загрузку");
      retry.addEventListener("click", () => void loadUsers()); status.append(retry);
    } finally { list.setAttribute("aria-busy", "false"); }
  }
  search.addEventListener("input", filter);
  void loadUsers(); void loadModels();
}

const standalone = document.querySelector("#access-page");
if (standalone) {
  // Match the application's per-user theme without booting its chat/session state.
  try {
    const { user } = await api("/api/me");
    const key = user ? `ronix-user:${user.id}:ronix-agent-theme` : "ronix-agent-theme";
    const theme = localStorage.getItem(key);
    document.body.dataset.theme = ["terminal", "neon", "moon", "obsidian-gold"].includes(theme) ? theme : "terminal";
  } catch { document.body.dataset.theme = "terminal"; }
  mountAccess(standalone);
}
