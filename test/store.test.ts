import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/store.js";

test("persists projects, sessions, and ordered events", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-"));
  const store = new Store(directory);

  try {
    const now = new Date().toISOString();
    store.createProject({ id: "p1", name: "Test", path: "/tmp/test", createdAt: now });
    store.createSession({
      id: "s1",
      projectId: "p1",
      threadId: null,
      activeTurnId: null,
      status: "ready",
      sandboxMode: "workspace-write",
      model: null,
      reasoningEffort: null,
      lastError: null,
      createdAt: now,
      lastActivityAt: now,
    });

    const first = store.addEvent("s1", "user.message", { text: "hello" });
    const second = store.addEvent("s1", "codex.turn.started", {});
    store.updateSession("s1", { threadId: "thread-1", status: "running" });
    store.updateSession("s1", {
      model: "gpt-5.5",
      reasoningEffort: "high",
    });

    assert.equal(store.getProject("p1")?.name, "Test");
    assert.equal(store.getSession("s1")?.threadId, "thread-1");
    assert.equal(store.getSession("s1")?.model, "gpt-5.5");
    assert.equal(store.getSession("s1")?.reasoningEffort, "high");
    assert.deepEqual(
      store.listEvents("s1", first.sequence).map((event) => event.sequence),
      [second.sequence],
    );
    assert.deepEqual(store.listRecentEvents("s1", 1).map((event) => event.sequence), [
      second.sequence,
    ]);
    assert.deepEqual(
      store.listEventsBefore("s1", second.sequence, 10).map((event) => event.sequence),
      [first.sequence],
    );
    store.addEvent("s1", "codex.item.agentMessage.delta", { delta: "x" });
    assert.equal(
      store.deleteEventsByTypes("s1", ["codex.item.agentMessage.delta"]),
      1,
    );
    assert.equal(store.deleteSession("s1"), true);
    assert.equal(store.getSession("s1"), null);
    assert.deepEqual(store.listEvents("s1"), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovers sessions left running after a process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-recovery-"));
  const store = new Store(directory);
  try {
    const now = new Date().toISOString();
    store.createProject({ id: "p1", name: "Test", path: "/tmp/test", createdAt: now });
    store.createSession({
      id: "s1",
      projectId: "p1",
      threadId: "thread-1",
      activeTurnId: "turn-1",
      status: "running",
      sandboxMode: "workspace-write",
      model: null,
      reasoningEffort: null,
      lastError: null,
      createdAt: now,
      lastActivityAt: now,
    });
    const [recovered] = store.recoverRunningSessions();
    assert.equal(recovered?.status, "error");
    assert.equal(recovered?.activeTurnId, null);
    assert.match(recovered?.lastError ?? "", /restarted/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates sessions created by version 0.1", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-migration-"));
  const databasePath = join(directory, "ronix-agent.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      thread_id TEXT,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('p1', 'Legacy', '/tmp/legacy', '2026-01-01T00:00:00Z');
    INSERT INTO sessions VALUES (
      's1', 'p1', 'thread-1', 'ready', NULL,
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
  `);
  legacy.close();

  const store = new Store(directory);
  try {
    const session = store.getSession("s1");
    assert.equal(session?.activeTurnId, null);
    assert.equal(session?.sandboxMode, "workspace-write");
    assert.equal(session?.model, null);
    assert.equal(session?.reasoningEffort, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
