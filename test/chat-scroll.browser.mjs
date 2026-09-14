// Run with: node test/chat-scroll.browser.mjs [path/to/playwright/index.mjs]
// Uses a local static server and mocked APIs; never touches a running Ronix instance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const root = fileURLToPath(new URL("../public/", import.meta.url));
const screenshots = await mkdtemp(join(tmpdir(), "ronix-chat-scroll-"));
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
  const page = await openPage(data, { width: 500, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(async () => {
    const { state } = await import("/js/core/state.js");
    const render = await import("/js/events/render.js");
    const { handleEvent } = await import("/js/events/stream.js");
    window.chatTest = {
      state, render,
      emit: (type, payload = {}) => handleEvent({ sequence: state.lastSequence + 1, type, payload }),
    };
    state.events = Array.from({ length: 30 }, (_, i) => ({ sequence: i + 100, type: "user.message", payload: { text: `Сообщение ${i}: ` + "История, которую можно читать во время ответа. ".repeat(5) } }));
    state.firstSequence = 100;
    state.lastSequence = 129;
    render.renderEvents();
  });
  const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scrollTop = () => page.locator("#events").evaluate(element => element.scrollTop);
  const atBottom = () => page.locator("#events").evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2);
  const emit = async (type, payload = {}) => { await page.evaluate(({ type, payload }) => chatTest.emit(type, payload), { type, payload }); await flush(); };
  const samePosition = async (top) => assert.ok(Math.abs(await scrollTop() - top) <= 2, `reader moved from ${top} to ${await scrollTop()}`);
  const running = data.sessions.find(session => session.id === "alpha-session");
  running.status = "running";
  await flush();
  assert.equal(await atBottom(), true);
  await emit("codex.turn.started");
  await emit("codex.item.agentMessage.delta", { itemId: "answer", delta: "Подробный ответ. ".repeat(250) });
  assert.equal(await atBottom(), true, "stream follows at bottom");
  assert.equal(await page.locator("#chat-activity").isVisible(), true);
  await textIs(page, "#chat-activity-label", "Codex пишет ответ");
  await page.mouse.move(250, 350);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => !chatTest.state.followLatest);
  await flush();
  let readingTop = await scrollTop();
  assert.equal(await page.locator("#scroll-to-latest").isVisible(), true);
  await withinViewport(page, "#scroll-to-latest");
  await withinViewport(page, "#chat-activity");
  await emit("codex.item.agentMessage.delta", { itemId: "answer", delta: "Ещё текст. ".repeat(150) });
  await samePosition(readingTop);
  const answer = await page.evaluate(() => chatTest.state.liveResponse.text);
  await emit("codex.item.completed", { item: { id: "answer", type: "agentMessage", text: answer } });
  await samePosition(readingTop);
  await textIs(page, "#chat-activity-label", "Codex работает над задачей…");
  await emit("codex.item.started", { item: { id: "command", type: "commandExecution", command: "pwd" } });
  await textIs(page, "#chat-activity-label", "Codex выполняет команду");
  await samePosition(readingTop);
  await emit("codex.item.completed", { item: { id: "command", type: "commandExecution", command: "pwd", aggregatedOutput: "/project", exitCode: 0 } });
  await samePosition(readingTop);
  await page.evaluate(() => chatTest.render.renderEvents());
  await flush();
  await samePosition(readingTop);
  console.log("PASS streaming, completed messages, tools and full rerenders preserve reading position");

  await page.route(/\/events\/history\?before=/, route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ hasMore: false,
      events: Array.from({ length: 3 }, (_, i) => ({ sequence: 97 + i, type: "user.message", payload: { text: "Старая история. ".repeat(50) } })),
    }),
  }));
  await page.evaluate(() => { chatTest.state.hasMoreEvents = true; chatTest.render.renderEvents(false); });
  const anchorTop = () => page.locator(".message .bubble").filter({ hasText: "Сообщение 10:" }).evaluate(element => element.getBoundingClientRect().top);
  const beforePrepend = await anchorTop();
  await page.evaluate(async () => {
    await (await import("/js/events/stream.js")).loadOlderEvents(document.querySelector("#load-older"));
  });
  await flush();
  assert.ok(Math.abs(await anchorTop() - beforePrepend) <= 2, "prepending history preserves the visible content");
  readingTop = await scrollTop();
  console.log("PASS loading older history preserves the reading anchor");

  await emit("approval.requested", { approvalId: "request", method: "item/commandExecution/requestApproval", command: "pwd" });
  await samePosition(readingTop);
  await textIs(page, "#chat-activity-label", "Codex ждёт вашего ответа");
  assert.equal(await page.locator("#chat-activity").getAttribute("data-mode"), "waiting");
  await emit("approval.resolved", { approvalId: "request" });
  await samePosition(readingTop);
  await page.screenshot({ path: join(screenshots, "reading-while-working.png") });

  await page.locator("#scroll-to-latest").tap();
  await flush();
  assert.equal(await atBottom(), true);
  assert.equal(await page.locator("#scroll-to-latest").isVisible(), false);
  await emit("codex.item.agentMessage.delta", { itemId: "next", delta: "Продолжение. ".repeat(100) });
  assert.equal(await atBottom(), true, "button resumes following");
  await page.mouse.wheel(0, -48);
  await page.waitForFunction(() => !chatTest.state.followLatest);
  await flush();
  const nearTop = await scrollTop();
  await emit("codex.item.agentMessage.delta", { itemId: "next", delta: "Новые строки. ".repeat(100) });
  await samePosition(nearTop);
  assert.equal(await page.locator("#scroll-to-latest").isVisible(), true);
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => chatTest.state.followLatest);
  await emit("codex.item.agentMessage.delta", { itemId: "next", delta: "Продолжение после возврата. ".repeat(80) });
  assert.equal(await atBottom(), true, "manual return resumes following");
  await page.evaluate(() => {
    chatTest.render.renderLiveResponse();
    document.querySelector("#events").dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true }));
    document.querySelector("#events").scrollTop -= 48;
  });
  const raceTop = await scrollTop();
  await flush();
  await samePosition(raceTop);
  console.log("PASS jump button, manual return, small upward scrolls and queued-frame cancellation");

  await page.evaluate(async () => {
    const { selectSession } = await import("/js/features/sessions.js");
    await selectSession("beta-session");
    await selectSession("alpha-session");
  });
  await flush();
  await samePosition(raceTop);
  assert.equal(await page.evaluate(() => chatTest.state.followLatest), false);
  await emit("codex.item.agentMessage.delta", { itemId: "next", delta: "Текст после возврата в чат." });
  await samePosition(raceTop);
  const finalAnswer = await page.evaluate(() => chatTest.state.liveResponse.text);
  await emit("codex.item.completed", { item: { id: "next", type: "agentMessage", text: finalAnswer } });
  running.status = "ready";
  await emit("codex.turn.completed");
  assert.equal(await page.locator("#chat-activity").isVisible(), false);
  await samePosition(raceTop);
  console.log("PASS cached chats retain reading mode; completion clears activity without jumping");

  for (const size of [{ width: 320, height: 568 }, { width: 500, height: 400 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(size);
    await page.locator("#events").evaluate(element => { element.scrollTop = 400; });
    await flush();
    running.status = "running";
    await emit("codex.turn.started");
    await withinViewport(page, "#scroll-to-latest");
    await withinViewport(page, "#chat-activity");
    await withinViewport(page, "#prompt-form");
    assert.equal(await page.locator(".chat-activity-dot").evaluate(element => getComputedStyle(element).animationName), "none");
    running.status = "error";
    await emit("session.error", { message: "Тестовая ошибка" });
    assert.equal(await page.locator("#chat-activity").isVisible(), false);
  }
  await page.locator("#scroll-to-latest").click();
  await flush();
  await page.setViewportSize({ width: 500, height: 400 });
  await flush();
  await page.setViewportSize({ width: 500, height: 900 });
  await flush();
  assert.equal(await atBottom(), true, "following survives viewport changes");
  assert.equal(await page.evaluate(() => chatTest.state.followLatest), true);
  console.log("PASS mobile, short viewports, desktop and reduced motion");
  await page.close();
  assert.deepEqual(errors, []);
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
