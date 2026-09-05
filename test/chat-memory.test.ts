import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryService } from "../src/memory-service.js";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { FakeAppServer } from "./fake-app-server.js";

test("chat defaults to read-only Ask, gates Act by attached project, and archives final messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-chat-memory-"));
  const store = new Store(directory);
  const codex = new FakeAppServer();
  const memory = new MemoryService(store);
  const chatWorkspace = join(directory, "chat");
  const manager = new SessionManager(store, codex, 100, memory, chatWorkspace);
  try {
    const now = new Date().toISOString();
    const projectPath = join(directory, "project");
    store.createProject({ id: "p1", name: "Project", path: projectPath, kind: "dev", createdAt: now });
    const chat = manager.createSession(null, {}, "chat");
    memory.remember({ scopeType: "global", kind: "preference", content: "Отвечать кратко" });

    await manager.startTurn(chat.id, "Что мы решили?");
    assert.deepEqual(codex.calls[0], {
      method: "thread/start",
      params: {
        cwd: chatWorkspace,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    });
    const firstPrompt = (codex.calls[1]?.params as { input?: Array<{ text: string }> }).input?.[0]?.text ?? "";
    assert.match(firstPrompt, /Отвечать кратко/);
    assert.equal(store.getSession(chat.id)?.title, "Что мы решили?");
    codex.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-1", type: "agentMessage", phase: "commentary", text: "Проверяю варианты." },
    });
    codex.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-2", type: "agentMessage", phase: "final_answer", text: "Используем SQLite." },
    });
    codex.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    assert.deepEqual(store.listMessages(chat.id).map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Что мы решили?" },
      { role: "assistant", text: "Используем SQLite." },
    ]);

    await assert.rejects(
      manager.startTurn(chat.id, "Измени файл", { intent: "act", actionProjectId: "p1" }),
      /Attach the target project/,
    );
    store.replaceChatProjects(chat.id, ["p1"]);
    await manager.startTurn(chat.id, "Измени файл", { intent: "act", actionProjectId: "p1" });
    const resume = codex.calls.findLast((call) => call.method === "thread/resume");
    assert.deepEqual(resume, {
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        cwd: projectPath,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
