import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config as defaultConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { FakeAppServer } from "./fake-app-server.js";

test("serves memory CRUD plus confirmed JSON export and import", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-server-memory-"));
  const projectPath = join(directory, "project");
  mkdirSync(projectPath);
  const store = new Store(join(directory, "data"));
  const sessions = new SessionManager(store, new FakeAppServer(), 100);
  const now = new Date().toISOString();
  store.createProject({ id: "p1", name: "Project", path: projectPath, kind: "dev", createdAt: now });
  const app = createApplication({
    store,
    sessions,
    config: {
      ...defaultConfig,
      dataDir: join(directory, "data"),
      projectRoots: [directory],
      authKey: "",
      trustProxy: false,
    },
  });
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Local sockets are unavailable in this sandbox");
        return;
      }
      throw error;
    }
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const changing = { "content-type": "application/json", origin: base };

    const globalMemory = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({
        scopeType: "global",
        scopeId: null,
        kind: "preference",
        content: "Отвечать кратко",
      }),
    });
    assert.equal(globalMemory.status, 201);
    const projectMemory = await fetch(`${base}/api/memory`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({
        scopeType: "project",
        scopeId: "p1",
        kind: "decision",
        content: "Использовать SQLite",
      }),
    });
    assert.equal(projectMemory.status, 201);

    const createdChat = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ title: "Архитектура", projectIds: ["p1"] }),
    });
    assert.equal(createdChat.status, 201);
    const { chat } = await createdChat.json() as { chat: { id: string } };
    store.addMessage({
      id: "m1",
      sessionId: chat.id,
      turnId: null,
      role: "user",
      text: "Что решили?",
      createdAt: now,
    });

    const exported = await fetch(`${base}/api/memory/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /ronix-memory\.json/);
    const snapshot = await exported.json() as {
      format: string;
      memories: unknown[];
      chats: Array<{ messages: unknown[] }>;
    };
    assert.equal(snapshot.format, "ronix-memory");
    assert.equal(snapshot.memories.length, 2);
    assert.equal(snapshot.chats[0]?.messages.length, 1);

    const previewResponse = await fetch(`${base}/api/memory/import`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ snapshot, confirmed: false }),
    });
    assert.equal(previewResponse.status, 200);
    const { preview } = await previewResponse.json() as { preview: { memories: number; chats: number } };
    assert.deepEqual({ memories: preview.memories, chats: preview.chats }, { memories: 2, chats: 1 });
    assert.equal(store.listChatSessions().length, 1);

    const importedResponse = await fetch(`${base}/api/memory/import`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ snapshot, confirmed: true }),
    });
    assert.equal(importedResponse.status, 200);
    assert.equal(store.listChatSessions().length, 2);
    assert.equal(store.listMemory({ limit: 100, offset: 0 }).total, 2);

    const memoryBody = await globalMemory.json() as { memory: { id: string; content: string } };
    const update = await fetch(`${base}/api/memory/${memoryBody.memory.id}`, {
      method: "PATCH",
      headers: changing,
      body: JSON.stringify({ content: "Отвечать очень кратко" }),
    });
    assert.equal(update.status, 200);
    const forget = await fetch(`${base}/api/memory/${memoryBody.memory.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.equal(forget.status, 204);
  } finally {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

