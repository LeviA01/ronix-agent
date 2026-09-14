// Run with: node test/sidebar-ui.browser.mjs [path/to/playwright/index.mjs]
// Uses a local static server and mocked APIs; never touches a running Ronix instance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const root = fileURLToPath(new URL("../public/", import.meta.url));
const screenshots = await mkdtemp(join(tmpdir(), "ronix-sidebar-ui-"));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(file)] ?? "text/html");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const projects = [
    { id: "dev-a", name: "Альфа", kind: "dev", path: "/projects/alpha" },
    { id: "dev-b", name: "Бета", kind: "dev", path: "/projects/beta" },
    { id: "learn-a", name: "Основы разработки", kind: "learning", path: "/projects/course" },
    { id: "learn-b", name: "Алгоритмы", kind: "learning", path: "/projects/algorithms" },
  ];
  const session = (id, projectId, purpose = "general") => ({ id, projectId, purpose, status: "ready", title: id, model: "test-model", reasoningEffort: "medium", sandboxMode: "workspace-write", lastActivityAt: new Date().toISOString(), projectIds: [] });
  const sessions = [session("alpha-session", "dev-a"), session("beta-session", "dev-b"), session("chat-a", null, "chat"), session("chat-b", null, "chat")];
  for (const project of projects.filter((item) => item.kind === "learning")) {
    for (const mode of ["course", "theory", "practice", "materials"]) sessions.push(session(`${project.id}-${mode}`, project.id, mode));
  }
  return { projects, sessions, requests: [], user: { id: "test-user", name: "Тестовый пользователь", username: "tester", role: "admin", modules: ["development", "learning", "chat"] }, auth: true, patchDelay: 0, patchError: false, delayedProject: null };
}

async function openPage(data, viewport = { width: 1280, height: 850 }) {
  const page = await browser.newPage({ viewport, isMobile: viewport.width <= 760, hasTouch: viewport.width <= 760 });
  page.setDefaultTimeout(6000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => { if (dialog.type() === "alert") errors.push(dialog.message()); await dialog.accept(); });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON();
    data.requests.push({ path, method: request.method(), body });
    const send = (value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/status") return send({ enabled: data.auth, authenticated: true, ...(data.user ? { user: data.user } : {}) });
    if (path === "/api/auth/logout") return send({});
    if (path === "/api/codex/models") return send({ models: [{ id: "test-model", model: "test-model", displayName: "Test", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] });
    if (path === "/api/codex/usage") return send({ rateLimits: { primary: { usedPercent: 25 } }, usage: {} });
    if (path === "/api/admin/users") return send({ users: [], modules: [] });
    if (path === "/api/memory") return send({ items: [], total: 0 });
    if (path === "/api/projects" && request.method() === "POST") {
      if (body.path === "missing" && !body.create) return send({ code: "PROJECT_NOT_FOUND", path: "/projects/missing", error: "Не найдена" }, 404);
      if (body.path === "forbidden") return send({ error: "Нет доступа к папке" }, 403);
      const project = { id: `new-${data.projects.length}`, name: body.path, kind: body.kind, path: `/projects/${body.path}` };
      data.projects.push(project);
      return send({ project });
    }
    if (path === "/api/projects") return send({ projects: data.projects, projectRoots: ["/projects"] });
    const projectRoute = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectRoute) {
      const project = data.projects.find((item) => item.id === projectRoute[1]);
      if (request.method() === "DELETE") { data.projects = data.projects.filter((item) => item !== project); return send({}); }
      Object.assign(project, body); return send({ project });
    }
    if (path.endsWith("/git/status")) return send({ available: false, reason: "Not a Git repository" });
    if (path.endsWith("/learning")) {
      const projectId = path.split("/")[3];
      return send({ available: false, missing: [], sessions: Object.fromEntries(data.sessions.filter((item) => item.projectId === projectId).map((item) => [item.purpose, item])), diarySummary: {} });
    }
    if (path === "/api/chats") return send({ chats: data.sessions.filter((item) => item.purpose === "chat") });
    if (path.startsWith("/api/chats/") && request.method() === "PATCH") {
      const fail = data.patchError;
      await delay(data.patchDelay);
      if (fail) return send({ error: "Тестовая ошибка" }, 500);
      const chat = data.sessions.find((item) => item.id === path.split("/")[3]);
      Object.assign(chat, body); return send({ chat });
    }
    if (path === "/api/sessions") {
      if (request.method() === "POST") {
        const session = { ...data.sessions[0], id: "new-session", projectId: body.projectId, purpose: "general", ...body };
        data.sessions.push(session); return send({ session });
      }
      const projectId = url.searchParams.get("projectId");
      if (projectId === data.delayedProject) await delay(250);
      return send({ sessions: data.sessions.filter((item) => item.projectId === projectId) });
    }
    if (path.endsWith("/events/history")) return send({ events: [], hasMore: false });
    if (path.endsWith("/messages")) return send({ messages: [], lastSequence: 0 });
    if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" });
    if (path.startsWith("/api/sessions/")) return send({ session: data.sessions.find((item) => item.id === path.split("/")[3]), approvals: [] });
    return send({});
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#connection").classList.contains("ready") || document.querySelector("#connection").classList.contains("connected"));
  return page;
}

async function textIs(page, selector, value) {
  try {
    await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent === value, { selector, value });
  } catch (error) {
    console.error({ selector, expected: value, actual: await page.locator(selector).textContent(), errors });
    await page.screenshot({ path: join(screenshots, "failure.png") });
    console.error(`Screenshot: ${screenshots}/failure.png`);
    throw error;
  }
}
async function focusIs(page, selector) {
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), selector);
}
async function surface(page, name) {
  if (await page.locator("#open-sidebar").isVisible()) await page.locator("#open-sidebar").click();
  await page.locator("#surface-trigger").click();
  await page.locator(`[data-surface="${name}"]`).click();
}
async function openProjectMenu(page) {
  if (await page.locator("#mobile-context-trigger").isVisible()) {
    await page.locator("#mobile-context-trigger").click();
    await withinViewport(page, "#mobile-context-panel");
  }
  await page.locator("#project-trigger").click();
}
async function chooseProject(page, id) {
  await openProjectMenu(page);
  await page.locator(`[data-select-project="${id}"]`).click();
}
async function withinViewport(page, selector) {
  await page.waitForFunction((selector) => {
    const bounds = document.querySelector(selector).getBoundingClientRect();
    return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
  }, selector);
  const bounds = await page.locator(selector).evaluate((element) => element.getBoundingClientRect().toJSON());
  const size = page.viewportSize();
  if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > size.width + 1 || bounds.y + bounds.height > size.height + 1) {
    console.error({ selector, bounds, size, style: await page.locator(selector).getAttribute("style") });
    await page.screenshot({ path: join(screenshots, "viewport-failure.png") });
    console.error(`Screenshot: ${screenshots}/viewport-failure.png`);
  }
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= size.width + 1 && bounds.y + bounds.height <= size.height + 1, `${selector} fits ${size.width}×${size.height}`);
}

try {
  const data = fixture();
  const page = await openPage(data);
  await textIs(page, "#project-current", "Альфа");
  assert.equal(await page.locator("#sidebar #project-trigger, #sidebar #chat-projects-editor, #sidebar .add-project").count(), 0);
  await openProjectMenu(page);
  await page.locator("#project-search").fill("бЕтА");
  assert.equal(await page.locator("[data-select-project]:visible").count(), 1);
  await page.locator("#project-search").press("ArrowDown");
  await page.keyboard.press("Enter");
  await textIs(page, "#session-title", "Сессия beta-ses");
  await page.locator("#prompt").fill("Сохранить мой черновик");
  await chooseProject(page, "dev-a");
  await textIs(page, "#session-title", "Сессия alpha-se");
  await chooseProject(page, "dev-b");
  await textIs(page, "#session-title", "Сессия beta-ses");
  assert.equal(await page.locator("#prompt").inputValue(), "Сохранить мой черновик");
  const before = data.requests.filter((r) => r.path === "/api/sessions").length;
  await chooseProject(page, "dev-b");
  assert.equal(data.requests.filter((r) => r.path === "/api/sessions").length, before);
  await surface(page, "learning");
  await textIs(page, "#project-current", "Основы разработки");
  await page.locator("[data-learning-mode]").first().waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-learning-mode]").count(), 4);
  await chooseProject(page, "learn-b");
  await textIs(page, "#project-current", "Алгоритмы");
  for (const [mode, title] of [["theory", "Теория"], ["practice", "Практика"], ["progress", "Успехи"], ["course", "Курс"]]) {
    await page.locator(`[data-learning-mode="${mode}"]`).click();
    await textIs(page, "#session-title", title);
  }
  await surface(page, "memory");
  await textIs(page, "#session-title", "Память");
  assert.equal(await page.locator("#new-session").isVisible(), false);
  assert.equal(await page.locator("#project-trigger").isVisible(), false);
  await surface(page, "development");
  await textIs(page, "#session-title", "Сессия beta-ses");
  await page.reload();
  await textIs(page, "#session-title", "Сессия beta-ses");
  assert.equal(await page.locator("#prompt").inputValue(), "Сохранить мой черновик");
  data.delayedProject = "dev-a";
  await chooseProject(page, "dev-a");
  await chooseProject(page, "dev-b");
  await delay(300);
  await textIs(page, "#session-title", "Сессия beta-ses");
  data.delayedProject = null;
  console.log("PASS project navigation, drafts, reload, learning separation, stale responses");

  await openProjectMenu(page);
  await page.locator("#project-search").fill("no such project");
  await textIs(page, "#project-search-empty", "Проекты не найдены");
  await page.keyboard.press("Escape");
  await focusIs(page, "#project-trigger");
  await openProjectMenu(page);
  await page.locator("#add-project").click();
  await page.locator("#project-folder").fill("missing");
  await page.locator("#project-submit").click();
  await page.locator("#project-create-confirmation").waitFor({ state: "visible" });
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await page.locator("#project-form-back").click();
  assert.equal(await page.locator("#project-folder").inputValue(), "missing");
  await page.locator("#project-submit").click();
  await textIs(page, "#project-submit", "Создать проект");
  await page.locator("#project-submit").click();
  await textIs(page, "#project-current", "missing");
  await page.locator("#create-project-modal").waitFor({ state: "hidden" });
  await openProjectMenu(page);
  await page.locator("#add-project").click();
  await page.locator("#project-folder").fill("forbidden");
  await page.locator("#project-submit").click();
  await textIs(page, "#project-form-error", "Нет доступа к папке");
  await page.keyboard.press("Escape");
  await focusIs(page, "#project-trigger");
  await page.locator("#new-session").click();
  await textIs(page, "#session-title", "Сессия new-sess");
  assert.equal(data.requests.findLast((r) => r.path === "/api/sessions" && r.method === "POST").body.projectId, data.projects.at(-1).id);
  console.log("PASS project creation, confirmation, back, inline errors, focus restoration");

  await surface(page, "chat");
  await textIs(page, "#session-title", "chat-a");
  await page.locator("#chat-context-trigger").click();
  data.patchDelay = 100;
  await page.locator('#chat-project-options label:has(input[value="dev-a"]) span').click();
  await page.locator('#chat-project-options input[value="dev-b"]').check();
  await page.waitForFunction(() => document.querySelector("#chat-project-options").getAttribute("aria-busy") === "false");
  assert.deepEqual(data.sessions.find((item) => item.id === "chat-a").projectIds, ["dev-a", "dev-b"]);
  await textIs(page, "#chat-context-label", "Контекст · 2");
  assert.equal(await page.locator("#chat-projects-editor").isVisible(), true);
  assert.equal(await page.locator('#chat-project-options input[value="dev-b"]').evaluate((el) => document.activeElement === el), true);
  await page.locator("#chat-project-search").fill("Алгоритмы");
  await page.locator('#chat-project-options input[value="learn-b"]').check();
  await page.locator('[data-id="chat-b"]').click();
  await textIs(page, "#session-title", "chat-b");
  await delay(180);
  await textIs(page, "#chat-context-label", "Контекст · 0");
  assert.deepEqual(data.sessions.find((item) => item.id === "chat-b").projectIds, []);
  await page.locator("#chat-context-trigger").click();
  data.patchError = true;
  await page.locator('#chat-project-options input[value="dev-a"]').check();
  await page.locator("#chat-project-status").waitFor({ state: "visible" });
  assert.equal(await page.locator('#chat-project-options input[value="dev-a"]').isChecked(), false);
  await textIs(page, "#chat-context-label", "Контекст · 0");
  data.patchError = false;
  await page.keyboard.press("Escape");
  console.log("PASS context persistence, rapid toggles, filtered selection, chat-switch race, failure rollback");

  await page.locator("#ronix-menu-trigger").click();
  assert.equal(await page.locator("#ronix-menu").isVisible(), true);
  await page.locator("#show-settings").click();
  await page.locator("#settings-modal").waitFor({ state: "visible" });
  assert.equal(await page.locator("#ronix-menu").isVisible(), false);
  await page.keyboard.press("Escape");
  await focusIs(page, "#ronix-menu-trigger");
  await page.locator("#ronix-menu-trigger").click();
  await page.locator("#show-limits").click();
  await textIs(page, "#limits-summary", "75%");
  await page.keyboard.press("Escape");
  await page.locator("#ronix-menu-trigger").click();
  await page.locator("#admin-link").click();
  await page.locator(".access-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await focusIs(page, "#ronix-menu-trigger");
  await page.screenshot({ path: join(screenshots, "desktop.png") });
  console.log("PASS utility dialogs and focus restoration");

  await surface(page, "development");
  for (const theme of ["terminal", "neon", "moon", "obsidian-gold"]) {
    await page.evaluate(async (theme) => (await import("/js/layout/theme.js")).applyTheme(theme), theme);
    for (const size of [{ width: 1280, height: 850 }, { width: 500, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (size.width <= 760) {
        assert.ok(await page.locator(".chat-head").evaluate((element) => element.offsetHeight <= 60));
        assert.equal(await page.locator("#toggle-settings").isVisible(), false);
      }
      await openProjectMenu(page);
      await withinViewport(page, "#project-menu");
      await page.keyboard.press("Escape");
      await focusIs(page, size.width <= 760 ? "#mobile-context-trigger" : "#project-trigger");
      if (size.width <= 760) await page.locator("#open-sidebar").click();
      await page.locator("#ronix-menu-trigger").click();
      await withinViewport(page, "#ronix-menu");
      await page.locator("#show-settings").click();
      await page.keyboard.press("Escape");
      const target = size.width <= 760 ? "#open-sidebar" : "#ronix-menu-trigger";
      await focusIs(page, target);
    }
  }
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".sidebar")).visibility === "hidden");
  await page.screenshot({ path: join(screenshots, "mobile.png") });
  await page.close();
  console.log("PASS all themes, desktop/mobile menus, mobile dialog return focus, reduced motion");

  const restricted = fixture();
  restricted.user.role = "user";
  restricted.user.modules = ["learning", "chat"];
  const userPage = await openPage(restricted);
  await userPage.locator("#ronix-menu-trigger").click();
  assert.equal(await userPage.locator("#show-limits").isVisible(), false);
  assert.equal(await userPage.locator("#admin-link").isVisible(), false);
  await userPage.keyboard.press("Escape");
  await userPage.locator("#surface-trigger").click();
  assert.equal(await userPage.locator('[data-surface="development"]').count(), 0);
  await userPage.close();
  const empty = fixture(); empty.user = null; empty.auth = false; empty.projects = []; empty.sessions = [];
  const emptyPage = await openPage(empty);
  await textIs(emptyPage, "#project-current", "Выбрать проект");
  await emptyPage.locator("[data-add-project]").click();
  await emptyPage.locator("#project-folder").waitFor({ state: "visible" });
  await emptyPage.keyboard.press("Escape");
  await emptyPage.locator("#ronix-menu-trigger").click();
  assert.equal(await emptyPage.locator("#logout").isVisible(), false);
  assert.equal(await emptyPage.locator("#logout-separator").isVisible(), false);
  assert.equal(await emptyPage.locator("#show-limits").isVisible(), true);
  await emptyPage.close();
  console.log("PASS module permissions, non-admin menu, unauthenticated mode, empty-project onboarding");

  const many = fixture();
  many.projects[0].name = "Очень длинное название рабочего проекта для проверки переноса текста в меню";
  for (let i = 0; i < 30; i++) many.projects.push({ id: `extra-${i}`, name: `Рабочий проект ${i}`, kind: "dev", path: `/projects/extra-${i}` });
  const mobile = await openPage(many, { width: 390, height: 844 });
  await mobile.evaluate(() => {
    document.querySelector("#session-title").textContent = "Очень длинное название текущего диалога, которое не должно увеличивать высоту шапки";
  });
  assert.ok(await mobile.locator(".chat-head").evaluate((element) => element.offsetHeight <= 60));
  await mobile.locator("#mobile-context-trigger").tap();
  assert.equal(await mobile.locator("#mobile-context-panel #session-title").isVisible(), true);
  await mobile.locator("#toggle-settings").tap();
  assert.equal(await mobile.locator(".chat").evaluate((element) => element.classList.contains("settings-open")), true);
  await withinViewport(mobile, "#session-settings");
  await mobile.keyboard.press("Escape");
  await focusIs(mobile, "#mobile-context-trigger");
  await mobile.locator("#mobile-context-trigger").tap();
  await mobile.locator("#toggle-git").tap();
  assert.equal(await mobile.locator(".chat").evaluate((element) => element.classList.contains("git-open")), true);
  await mobile.keyboard.press("Escape");
  await openProjectMenu(mobile);
  await withinViewport(mobile, "#project-menu");
  assert.equal(await mobile.locator('[data-select-project="dev-a"]').textContent().then((text) => text.trim()), many.projects[0].name);
  await mobile.locator('[data-select-project="extra-29"]').tap();
  await textIs(mobile, "#project-current", "Рабочий проект 29");
  await mobile.locator("#open-sidebar").tap();
  await mobile.locator("#ronix-menu-trigger").tap();
  await mobile.locator("#show-settings").tap();
  await mobile.locator('[data-project-remove="extra-29"]').tap();
  await textIs(mobile, "#project-current", many.projects[0].name);
  const projectForm = mobile.locator('[data-project-form="dev-a"]');
  await projectForm.locator('[name="name"]').fill("Переименованный проект");
  await projectForm.locator('[type="submit"]').tap();
  await textIs(mobile, "#project-current", "Переименованный проект");
  await mobile.locator('[data-project-learning="dev-a"]').tap();
  await textIs(mobile, "#surface-current", "Учёба");
  await textIs(mobile, "#project-current", "Переименованный проект");
  await mobile.keyboard.press("Escape");
  await focusIs(mobile, "#open-sidebar");
  await openProjectMenu(mobile);
  await mobile.screenshot({ path: join(screenshots, "mobile-projects.png") });
  await mobile.close();
  console.log("PASS touch targets, long names, scrolling, removal, renaming and conversion");
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
