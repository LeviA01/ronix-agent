import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessStore } from "../src/access.js";
import { config } from "../src/config.js";
import { createMultiUserServer } from "../src/multi-user.js";
import { createApplication } from "../src/server.js";
import { Store } from "../src/store.js";
import { SessionManager } from "../src/session-manager.js";
import { FakeAppServer } from "./fake-app-server.js";

async function data(response: Response) {
  return await response.json() as {
    user: { id: string }; chat: { id: string }; chats: Array<{ id: string }>;
    project: { id: string }; sessions: { course: { id: string } };
  };
}

test("admin identity is explicit, new users have no modules, and the last admin is protected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronix-access-"));
  const access = new AccessStore(dir, ["owner"]);
  try {
    const first = access.identify({ subject: "stranger", username: "owner", name: "Same display name" });
    assert.equal(first.role, "user"); assert.deepEqual(first.modules, []);
    const owner = access.identify({ subject: "owner", username: "ronix", name: "Owner" });
    assert.equal(owner.role, "admin");
    assert.throws(() => access.update(owner.id, { disabled: true }), /последнего/);
    assert.throws(() => access.update(first.id, { modules: ["root"] }), /Некорректные/);
    const renamed = access.identify({ subject: "owner", username: "renamed", name: "Owner" });
    assert.equal(renamed.id, owner.id);
    assert.equal(first.chatModel, null);
    const assigned = access.update(first.id, { chatModel: "model-assigned" });
    assert.equal(assigned.chatModel, "model-assigned");
    assert.equal(assigned.revision, first.revision + 1);
    assert.equal(access.identify({ subject: "stranger", username: "renamed", name: "" }).chatModel, "model-assigned");
    assert.throws(() => access.update(first.id, { chatModel: "bad\nmodel" }), /Некорректная модель/);
    assert.equal(access.update(first.id, { chatModel: null }).chatModel, null);
  } finally { access.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("gateway isolates users, enforces module rights, and applies revocation to existing runtimes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronix-multi-"));
  const secret = "x".repeat(40);
  const workers: string[] = [];
  const clients = new Map<string, FakeAppServer>();
  const stores = new Map<string, Store>();
  const gateway = createMultiUserServer({
    accessDirectory: join(dir, "access"), proxySecret: secret, adminSubjects: ["owner"],
    trustedAddresses: ["127.0.0.1"],
    async createRuntime(user) {
      const root = join(dir, user.id); mkdirSync(root, { recursive: true });
      const store = new Store(join(root, "data"));
      class ModelsServer extends FakeAppServer {
        override async request<T>(method: string, params?: unknown): Promise<T> {
          const result = await super.request<T>(method, params);
          if (method === "model/list") {
            const list = result as { data: Array<Record<string, unknown>> };
            list.data.push({ ...list.data[0], id: "model-assigned", model: "model-assigned", isDefault: false });
          }
          return result;
        }
      }
      const client = new ModelsServer(); clients.set(user.id, client); stores.set(user.id, store);
      const sessions = new SessionManager(store, client, 100);
      const app = createApplication({ config: { ...config, authKey: "", host: "127.0.0.1", trustProxy: true,
        deploymentMode: "local", accessMode: "local", dataDir: join(root, "data"), projectRoots: [root] },
        store, sessions, access: { modules: user.modules, role: user.role, chatModel: user.chatModel } });
      // Short Unix paths also work on platforms with a small sockaddr_un limit.
      const socket = join(dir, `${workers.length}.sock`); workers.push(user.id);
      await new Promise<void>(resolve => app.server.listen(socket, resolve));
      return { socket, stop: () => app.shutdown() };
    },
  });
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (subject: string, path: string, method = "GET", body?: unknown, extraHeaders = {}) => fetch(base + path, {
    method, headers: { "x-ronix-proxy-secret": secret, "x-authentik-uid": subject,
      "x-authentik-username": subject, origin: base.replace("http:", "https:"), "content-type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await fetch(base + "/api/chats")).status, 401);
    assert.equal((await call("owner", "/api/chats", "GET", undefined, { "x-ronix-proxy-secret": "wrong" })).status, 401);
    const owner = (await data(await call("owner", "/api/me"))).user;
    const bob = (await data(await call("bob", "/api/me"))).user;
    assert.equal((await call("bob", "/api/chats")).status, 403);
    assert.equal(workers.length, 0);
    assert.equal((await call("bob", "/api/admin/users")).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { modules: ["chat"] })).status, 200);
    const aliceChat = (await data(await call("owner", "/api/chats", "POST", {}))).chat;
    const bobChat = (await data(await call("bob", "/api/chats", "POST", {}))).chat;
    // Shared styles must remain available to regular users through their runtime.
    assert.match((await call("bob", "/css/tokens.css")).headers.get("content-type") ?? "", /text\/css/);
    assert.equal((await call("bob", `/api/admin/users/${bob.id}`, "PATCH", { chatModel: "model-assigned" })).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { chatModel: "model-assigned" })).status, 200);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/settings`, "POST", { model: "gpt-5.5" })).status, 403);
    const forgedChat = await call("bob", "/api/chats", "POST", { model: "gpt-5.5" });
    assert.equal(forgedChat.status, 201);
    assert.equal((await forgedChat.json() as { chat: { model: string } }).chat.model, "model-assigned");
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/turns`, "POST", { prompt: "Hello" })).status, 202);
    const resumedClient = clients.get(bob.id)!;
    const turn = resumedClient.calls.findLast(item => item.method === "turn/start");
    assert.equal((turn?.params as { model: string }).model, "model-assigned");
    const running = stores.get(bob.id)!.getSession(bobChat.id)!;
    resumedClient.notify("turn/completed", { threadId: running.threadId, turn: { id: running.activeTurnId, status: "completed" } });
    assert.equal((await call("owner", `/api/sessions/${aliceChat.id}/settings`, "POST", { model: "model-assigned" })).status, 200);
    assert.equal((await call("owner", `/api/sessions/${aliceChat.id}/settings`, "POST", { model: "gpt-5.5" })).status, 200);
    // Changing the assignment takes effect in an already-created chat after runtime restart.
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { chatModel: "gpt-5.5" })).status, 200);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/settings`, "POST", { model: "model-assigned" })).status, 403);
    assert.notEqual(aliceChat.id, bobChat.id);
    const bobChats = (await data(await call("bob", "/api/chats"))).chats;
    assert.ok(bobChats.some(chat => chat.id === bobChat.id));
    assert.ok(bobChats.every(chat => chat.id !== aliceChat.id));
    for (const suffix of ["", "/messages", "/events", "/events/history"]) {
      assert.equal((await call("bob", `/api/sessions/${aliceChat.id}${suffix}`)).status, 404);
    }
    assert.equal((await call("bob", `/api/sessions/${aliceChat.id}`, "DELETE")).status, 404);
    assert.equal((await call("bob", "/api/memory/export")).status, 403);
    assert.equal((await call("bob", "/api/projects", "POST", { path: "course", kind: "learning", create: true })).status, 403);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/turns`, "POST", { prompt: "edit", intent: "act" })).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { modules: ["chat", "outline"] })).status, 200);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/turns`, "POST", { prompt: "Создай документ в Outline", intent: "ask" })).status, 202);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/turns`, "POST", { prompt: "Измени файл", intent: "act" })).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { modules: ["chat", "learning"] })).status, 200);
    const learningResponse = await call("bob", "/api/projects", "POST", { path: "course", kind: "learning", create: true });
    assert.equal(learningResponse.status, 201);
    const learning = (await data(learningResponse)).project;
    const state = await data(await call("bob", `/api/projects/${learning.id}/learning`));
    assert.ok(state.sessions.course.id);
    assert.equal((await call("owner", `/api/projects/${learning.id}/learning`)).status, 404);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { modules: ["chat"] })).status, 200);
    assert.equal((await call("bob", `/api/sessions/${state.sessions.course.id}`)).status, 403);
    assert.equal((await call("bob", `/api/projects/${learning.id}/learning`)).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${bob.id}`, "PATCH", { disabled: true })).status, 200);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}`)).status, 403);
    assert.equal((await call("owner", `/api/admin/users/${owner.id}`, "PATCH", { role: "user" })).status, 409);
    // An administrator can repair module assignments without starting a runtime.
    assert.equal((await call("owner", `/api/admin/users/${owner.id}`, "PATCH", { modules: [] })).status, 200);
    const workerCount = workers.length;
    for (const [path, type] of [["/admin", "text/html"], ["/admin.js", "text/javascript"],
      ["/access.css", "text/css"], ["/css/tokens.css", "text/css"], ["/css/themes/obsidian-gold.css", "text/css"]]) {
      const response = await call("owner", path!);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type")?.startsWith(type!));
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await call("owner", "/api/codex/models")).status, 403);
    assert.equal(workers.length, workerCount);
    assert.equal((await fetch(base + "/css/tokens.css")).status, 401);
  } finally { await gateway.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
