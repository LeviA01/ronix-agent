import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      status: "ready",
      lastError: null,
      createdAt: now,
      lastActivityAt: now,
    });

    const first = store.addEvent("s1", "user.message", { text: "hello" });
    const second = store.addEvent("s1", "codex.turn.started", {});
    store.updateSession("s1", { threadId: "thread-1", status: "running" });

    assert.equal(store.getProject("p1")?.name, "Test");
    assert.equal(store.getSession("s1")?.threadId, "thread-1");
    assert.deepEqual(
      store.listEvents("s1", first.sequence).map((event) => event.sequence),
      [second.sequence],
    );
    assert.equal(store.deleteSession("s1"), true);
    assert.equal(store.getSession("s1"), null);
    assert.deepEqual(store.listEvents("s1"), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
