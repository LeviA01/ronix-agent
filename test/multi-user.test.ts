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
  } finally { access.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("gateway isolates users, enforces module rights, and applies revocation to existing runtimes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronix-multi-"));
  const secret = "x".repeat(40);
  const workers: string[] = [];
  const gateway = createMultiUserServer({
    accessDirectory: join(dir, "access"), proxySecret: secret, adminSubjects: ["owner"],
    trustedAddresses: ["127.0.0.1"],
    async createRuntime(user) {
      const root = join(dir, user.id); mkdirSync(root, { recursive: true });
      const store = new Store(join(root, "data"));
      const sessions = new SessionManager(store, new FakeAppServer(), 100);
      const app = createApplication({ config: { ...config, authKey: "", host: "127.0.0.1", trustProxy: true,
        deploymentMode: "local", accessMode: "local", dataDir: join(root, "data"), projectRoots: [root] },
        store, sessions, access: { modules: user.modules } });
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
    assert.notEqual(aliceChat.id, bobChat.id);
    const bobChats = (await data(await call("bob", "/api/chats"))).chats;
    assert.deepEqual(bobChats.map((chat: { id: string }) => chat.id), [bobChat.id]);
    for (const suffix of ["", "/messages", "/events", "/events/history"]) {
      assert.equal((await call("bob", `/api/sessions/${aliceChat.id}${suffix}`)).status, 404);
    }
    assert.equal((await call("bob", `/api/sessions/${aliceChat.id}`, "DELETE")).status, 404);
    assert.equal((await call("bob", "/api/memory/export")).status, 403);
    assert.equal((await call("bob", "/api/projects", "POST", { path: "course", kind: "learning", create: true })).status, 403);
    assert.equal((await call("bob", `/api/sessions/${bobChat.id}/turns`, "POST", { prompt: "edit", intent: "act" })).status, 403);
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
  } finally { await gateway.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
