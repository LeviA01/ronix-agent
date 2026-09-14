// Run: node test/access-ui.browser.mjs [path/to/playwright/index.mjs]
// Serves the real frontend with mocked APIs; no production users or rights change.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "playwright");
const root = fileURLToPath(new URL("../public/", import.meta.url));
const screenshots = await mkdtemp(join(tmpdir(), "ronix-access-ui-"));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname === "/admin" ? "/admin.html" : pathname}`);
  if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(file)] ?? "text/html");
    response.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const browser = await chromium.launch({ headless: true });
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  return {
    users: [
      { id: "owner", name: "Александр Иванов", username: "alex", role: "admin", disabled: false, modules: ["chat", "learning", "development", "outline"], chatModel: null },
      { id: "maria", name: "Мария Петрова", username: "maria", role: "user", disabled: false, modules: ["chat", "learning"], chatModel: "model-b" },
      { id: "oleg", name: "Олег Смирнов", username: "oleg", role: "user", disabled: true, modules: [], chatModel: "retired-model" },
    ],
    models: ["a", "b", "c"].map(id => ({ id: `model-${id}`, model: `model-${id}`, displayName: `Модель ${id.toUpperCase()}`, defaultReasoningEffort: "medium", supportedReasoningEfforts: [], isDefault: id === "a" })),
    requests: [], patchDelay: 0, patchError: false, modelError: false, usersError: false,
  };
}
async function openPage(data, { embedded = false, width = 1280, height = 850, theme = "obsidian-gold" } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: width <= 760, hasTouch: width <= 760 });
  page.setDefaultTimeout(7000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
  await page.addInitScript(theme => localStorage.setItem("ronix-user:owner:ronix-agent-theme", theme), theme);
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/me" || path === "/api/auth/status") return send({ user: { ...data.users[0], id: "owner", role: "admin", modules: ["chat", "learning", "development"] }, enabled: true, authenticated: true });
    if (path === "/api/admin/users") return data.usersError ? send({ error: "Не удалось загрузить пользователей" }, 500) : send({ users: data.users });
    if (path === "/api/codex/models") return data.modelError ? send({ error: "Модели недоступны" }, 503) : send({ models: data.models });
    if (path.startsWith("/api/admin/users/") && request.method() === "PATCH") {
      const id = path.split("/").at(-1), body = request.postDataJSON();
      data.requests.push({ id, body });
      const fail = data.patchError;
      await delay(data.patchDelay);
      if (fail) return send({ error: "Не удалось сохранить. Попробуйте ещё раз." }, 500);
      if (id === "owner" && (body.role !== "admin" || body.disabled)) return send({ error: "Нельзя отключить последнего администратора" }, 409);
      const user = data.users.find(user => user.id === id);
      Object.assign(user, body);
      return send({ user });
    }
    if (path === "/api/projects") return send({ projects: [], projectRoots: [] });
    if (path === "/api/chats") return send({ chats: [] });
    if (path === "/api/sessions") return send({ sessions: [] });
    if (path === "/api/memory") return send({ items: [], total: 0 });
    return send({});
  });
  await page.goto(origin + (embedded ? "/" : "/admin"));
  if (embedded) {
    await page.waitForFunction(() => document.querySelector("#connection")?.classList.contains("ready"));
    await openDialog(page);
  }
  await page.locator(".access-users[aria-busy=false]").waitFor({ state: "attached" });
  return page;
}
async function openDialog(page) {
  if (page.viewportSize().width <= 760) await page.locator("#open-sidebar").click();
  await page.locator("#ronix-menu-trigger").click();
  await page.locator("#admin-link").click();
  await page.locator(".access-dialog").waitFor();
}
async function select(page, id) { await page.locator(`[data-user-id="${id}"]`).click(); }
async function textIs(page, selector, value) {
  await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent === value, { selector, value });
}
async function focusIs(page, selector) {
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), selector);
}
async function inside(page, selector) {
  const rect = await page.locator(selector).evaluate(node => node.getBoundingClientRect().toJSON());
  const viewport = page.viewportSize();
  assert.ok(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1, `${selector} fits ${JSON.stringify(viewport)}: ${JSON.stringify(rect)}`);
}

try {
  const data = fixture();
  const page = await openPage(data, { embedded: true });
  assert.equal(await page.locator("body").getAttribute("data-theme"), "obsidian-gold");
  assert.equal(await page.locator(".access-user-row").count(), 3);
  assert.equal(await page.locator(".access-model-trigger").isDisabled(), true);
  await select(page, "maria");
  await page.locator('[name=module][value=outline]').check();
  assert.equal(await page.locator('[data-user-id=maria] .access-draft').isVisible(), true);
  await select(page, "oleg");
  await page.locator('[name=enabled]').check();
  await page.locator('.access-search input').fill("МАРИЯ");
  assert.equal(await page.locator('.access-user-row:visible').count(), 1);
  await textIs(page, ".access-name h2", "Олег Смирнов");
  await page.locator('.access-search input').fill("Никого");
  assert.equal(await page.locator('.access-user-row:visible').count(), 0);
  assert.equal(await page.locator('[name=enabled]').isChecked(), true);
  await page.locator('.access-search input').fill("");
  await select(page, "maria");
  assert.equal(await page.locator('[name=module][value=outline]').isChecked(), true);
  await page.locator('.access-reset').click();
  assert.equal(await page.locator('[name=module][value=outline]').isChecked(), false);
  assert.equal(await page.locator('[data-user-id=oleg] .access-draft').isVisible(), true);
  console.log("PASS search, independent drafts, reset and selected-user stability");

  const picker = page.locator('.access-model-trigger');
  await picker.focus(); await page.keyboard.press("ArrowDown");
  await page.locator('.access-model-menu:popover-open').waitFor();
  await inside(page, '.access-model-menu');
  await page.screenshot({path:join(screenshots,'desktop-model-menu.png')});
  await focusIs(page, '.access-model-search');
  assert.equal(await page.locator('[role=option][aria-selected=true]').textContent(), "Модель B✓");
  await page.locator('.access-model-search').fill("Модель C");
  await page.keyboard.press("Enter");
  await textIs(page, '#access-model-value', 'Модель C');
  await focusIs(page, '.access-model-trigger');
  assert.equal(await page.locator('.access-model-menu').isVisible(), false);
  await picker.click();
  await page.locator('.access-model-search').fill('nothing');
  assert.equal(await page.locator('.access-model-empty').isVisible(), true);
  await page.keyboard.press("Enter");
  assert.equal(data.requests.length, 0);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('.access-dialog').isVisible(), true);
  await focusIs(page, '.access-model-trigger');
  await picker.click();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator('.access-model-menu').isVisible(), false);
  assert.equal(await page.locator('.access-dialog').isVisible(), true);
  await picker.click();
  await page.locator('.access-name h2').click();
  assert.equal(await page.locator('.access-model-menu').isVisible(), false);
  await picker.click();
  await page.locator('[role=option]').filter({hasText:"Модель A"}).click();
  await textIs(page, '#access-model-value', 'Модель A');
  await page.keyboard.press("Escape");
  await focusIs(page, '#ronix-menu-trigger');
  await openDialog(page);
  await textIs(page, '#access-model-value', 'Модель A');
  assert.equal(await page.locator('[data-user-id=oleg] .access-draft').isVisible(), true);
  assert.equal(await page.locator('.access-model-menu').isVisible(), false);
  console.log("PASS styled model popup, keyboard, click, Escape layering and drafts after reopening");

  data.patchDelay = 300;
  await page.locator('.access-save').click();
  await page.locator('.access-user[aria-busy=true]').waitFor();
  assert.equal(await page.locator('[name=enabled]').isDisabled(), true);
  await select(page, "oleg");
  await textIs(page, '.access-name h2', 'Олег Смирнов');
  await page.waitForFunction(() => document.querySelector('[data-user-id=maria] .access-draft').hidden);
  assert.equal(await page.locator('[name=enabled]').isChecked(), true);
  assert.equal(await page.locator('.access-save').isEnabled(), true);
  assert.deepEqual(data.requests[0], {id:'maria', body:{role:'user',disabled:false,modules:['chat','learning'],chatModel:'model-a'}});
  await select(page, "maria");
  await textIs(page, '.access-feedback', 'Изменения сохранены');
  data.patchError = true;
  await page.locator('[name=module][value=development]').check();
  await page.locator('.access-save').click();
  await textIs(page, '.access-feedback', 'Не удалось сохранить. Попробуйте ещё раз.');
  assert.equal(await page.locator('[name=module][value=development]').isChecked(), true);
  assert.equal(await page.locator('.access-save').isEnabled(), true);
  data.patchError = false;
  await page.locator('.access-save').click();
  await select(page, 'oleg'); await select(page, 'maria');
  await textIs(page, '.access-feedback', 'Изменения сохранены');
  assert.equal(await page.locator('[name=module][value=development]').isChecked(), true);
  assert.equal(await page.locator('.access-save').isDisabled(), true);
  await select(page, 'owner');
  await page.locator('[name=enabled]').uncheck();
  await page.locator('.access-save').click();
  await textIs(page, '.access-feedback', 'Нельзя отключить последнего администратора');
  assert.equal(await page.locator('[name=enabled]').isChecked(), false);
  await page.locator('.access-reset').click();
  await select(page, 'oleg');
  await textIs(page, '#access-model-value', 'retired-model (недоступна)');
  await page.locator('.access-save').click();
  await textIs(page, '.access-feedback', 'Изменения сохранены');
  assert.equal(data.requests.at(-1).body.chatModel, 'retired-model');
  console.log("PASS save races, retry, preserved assignments and last-admin error");

  const failed = fixture(); failed.modelError = true;
  const failedPage = await openPage(failed);
  await select(failedPage, 'maria');
  await failedPage.locator('[name=module][value=outline]').check();
  assert.equal(await failedPage.locator('.access-model-trigger').isDisabled(), true);
  assert.equal(await failedPage.locator('.access-model-status').isVisible(), true);
  await failedPage.locator('.access-search input').fill('maria');
  assert.equal(await failedPage.locator('.access-model-status').isVisible(), true);
  failed.modelError = false;
  await failedPage.locator('.access-model-status .access-retry').click();
  await failedPage.locator('.access-model-status').waitFor({state:'hidden'});
  assert.equal(await failedPage.locator('[name=module][value=outline]').isChecked(), true);
  await textIs(failedPage, '#access-model-value', 'Модель B');
  const noUsers = fixture(); noUsers.usersError = true;
  const retryPage = await openPage(noUsers);
  await retryPage.locator('.access-search input').fill('maria');
  assert.equal(await retryPage.locator('.access-status .access-retry').isVisible(), true);
  noUsers.usersError = false;
  await retryPage.locator('.access-status .access-retry').click();
  await retryPage.locator('.access-user-row:visible').waitFor();
  assert.equal(await retryPage.locator('.access-user-row:visible').count(), 1);
  const empty = fixture(); empty.users = [];
  const emptyPage = await openPage(empty);
  await textIs(emptyPage, '.access-count', '0');
  await textIs(emptyPage, '.access-status', 'Пользователей пока нет.');
  await page.screenshot({path:join(screenshots,'desktop.png')});
  console.log("PASS model/user load failures, non-destructive retry and empty state");

  const mobile = await openPage(fixture(), {embedded:true,width:390,height:844});
  await mobile.locator('[data-user-id=maria]').tap();
  await mobile.locator('.access-model-trigger').tap();
  await inside(mobile,'.access-model-menu');
  await mobile.screenshot({path:join(screenshots,'mobile-model-menu.png')});
  await mobile.locator('[role=option]').filter({hasText:'Модель A'}).tap();
  await textIs(mobile,'#access-model-value','Модель A');
  await mobile.locator('.access-back').tap();
  await mobile.locator('[data-user-id=maria]').tap();
  await textIs(mobile,'#access-model-value','Модель A');
  await mobile.locator('.access-model-trigger').tap();
  await mobile.setViewportSize({width:390,height:520});
  await inside(mobile,'.access-model-menu');
  await mobile.keyboard.press('Escape');
  await mobile.setViewportSize({width:320,height:568});
  await inside(mobile,'.access-save');
  const editorHeight = await mobile.locator('.access-editor-scroll').evaluate(node=>node.clientHeight);
  assert.ok(editorHeight >= 200, `The small-screen editor remains usable: ${editorHeight}px`);
  await mobile.locator('.access-close').tap();
  await focusIs(mobile,'#open-sidebar');
  await mobile.close();
  console.log('PASS touch selection, mobile draft navigation, viewport resize and close focus');

  for (const embedded of [false, true]) {
    for (const theme of ['terminal','neon','moon','obsidian-gold']) {
      const sample = fixture();
      sample.users.push(...Array.from({length:24}, (_,i)=>({...sample.users[1], id:`extra-${i}`, username:`extra_${i}`,name:`Пользователь ${i+1}`})));
      sample.users[1].name = 'Мария Петрова — длинное отображаемое имя пользователя';
      sample.models.push(...Array.from({length:30},(_,i)=>({model:`extended-${i}`,displayName:`Дополнительная модель ${i+1}`})));
      const preview = await openPage(sample, {embedded,theme});
      for (const size of [{width:1280,height:850},{width:768,height:850},{width:390,height:844},{width:320,height:568}]) {
        await preview.setViewportSize(size);
        await preview.emulateMedia({reducedMotion:'reduce'});
        if (size.width <= 760 && await preview.locator('.access-back').isVisible()) await preview.locator('.access-back').click();
        await select(preview,'maria');
        await inside(preview,'.access-save');
        await inside(preview,'.access-reset');
        await preview.locator('.access-model-trigger').click();
        await inside(preview,'.access-model-menu');
        await preview.locator('.access-model-search').fill('Дополнительная модель 30');
        await preview.keyboard.press('Enter');
        await textIs(preview, '#access-model-value', 'Дополнительная модель 30');
        assert.equal(await preview.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
        assert.equal(await preview.locator('.access-editor').evaluate(node=>node.scrollWidth <= node.clientWidth),true);
        await preview.screenshot({path:join(screenshots,`${embedded?'dialog':'page'}-${theme}-${size.width}.png`)});
        if (size.width <= 760) {
          await preview.locator('.access-back').click();
          await inside(preview,'.access-directory');
          await select(preview,'maria');
          await textIs(preview, '#access-model-value', 'Дополнительная модель 30');
        }
      }
      await preview.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS all themes, standalone/dialog, 1280/768/390/320px and short screens. Screenshots: ${screenshots}`);
} catch (error) {
  for (const [index,page] of browser.contexts().flatMap(context=>context.pages()).entries()) {
    await page.screenshot({path:join(screenshots,`failure-${index}.png`)}).catch(()=>{});
  }
  console.error(`Screenshots: ${screenshots}`, errors);
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
