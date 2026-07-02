import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { FakeAppServer } from "./fake-app-server.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ronix-session-manager-"));
  const store = new Store(directory);
  const codex = new FakeAppServer();
  const manager = new SessionManager(store, codex, 100);
  const now = new Date().toISOString();
  store.createProject({ id: "p1", name: "Test", path: directory, createdAt: now });
  return {
    directory,
    store,
    codex,
    manager,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("starts a thread with workspace access and completes its turn", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    await testFixture.manager.startTurn(session.id, "Inspect the project");
    const running = testFixture.store.getSession(session.id);
    assert.equal(running?.threadId, "thread-1");
    assert.equal(running?.activeTurnId, "turn-1");
    assert.equal(running?.status, "running");
    assert.equal(testFixture.store.listEvents(session.id)[0]?.type, "user.message");
    assert.deepEqual(testFixture.codex.calls[0], {
      method: "thread/start",
      params: {
        cwd: testFixture.directory,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    });

    testFixture.codex.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "Hello",
    });
    testFixture.codex.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    });
    assert.equal(testFixture.store.getSession(session.id)?.status, "ready");
    assert.equal(testFixture.store.getSession(session.id)?.activeTurnId, null);
    assert.equal(
      testFixture.store.listEvents(session.id).some(
        (event) => event.type === "codex.item.agentMessage.delta",
      ),
      false,
    );
  } finally {
    testFixture.close();
  }
});

test("records the user message before reporting a start failure", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    testFixture.codex.failures.set("thread/start", new Error("Codex unavailable"));
    await assert.rejects(
      testFixture.manager.startTurn(session.id, "Please inspect this"),
      /Codex unavailable/,
    );
    assert.deepEqual(
      testFixture.store.listEvents(session.id).map((event) => event.type),
      ["user.message", "session.error"],
    );
    assert.equal(testFixture.store.getSession(session.id)?.status, "error");
  } finally {
    testFixture.close();
  }
});

test("passes the selected model and reasoning effort to Codex", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1", {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    await testFixture.manager.startTurn(session.id, "Solve a difficult problem");
    assert.deepEqual(testFixture.codex.calls[0], {
      method: "thread/start",
      params: {
        cwd: testFixture.directory,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        model: "gpt-5.5",
      },
    });
    assert.deepEqual(testFixture.codex.calls[1], {
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Solve a difficult problem" }],
        model: "gpt-5.5",
        effort: "xhigh",
      },
    });
  } finally {
    testFixture.close();
  }
});

test("routes approval requests and sends the selected decision", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    await testFixture.manager.startTurn(session.id, "Run checks");
    testFixture.codex.serverRequest(42, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm test",
    });
    assert.equal(testFixture.manager.listApprovals(session.id).length, 1);
    testFixture.manager.respondToApproval(session.id, "42", "accept");
    assert.deepEqual(testFixture.codex.responses, [{ id: 42, result: { decision: "accept" } }]);
    assert.equal(testFixture.manager.listApprovals(session.id).length, 0);
  } finally {
    testFixture.close();
  }
});

test("marks an active session failed if app-server exits", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    await testFixture.manager.startTurn(session.id, "Work");
    testFixture.codex.exit("app-server crashed");
    const failed = testFixture.store.getSession(session.id);
    assert.equal(failed?.status, "error");
    assert.equal(failed?.activeTurnId, null);
    assert.equal(failed?.lastError, "app-server crashed");
  } finally {
    testFixture.close();
  }
});

test("persists access mode and interrupts active work during shutdown", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    const updated = testFixture.manager.updateSandboxMode(session.id, "read-only");
    assert.equal(updated.sandboxMode, "read-only");
    await testFixture.manager.startTurn(session.id, "Inspect only");
    await testFixture.manager.shutdown();
    assert.ok(testFixture.codex.calls.some((call) => call.method === "turn/interrupt"));
    const stopped = testFixture.store.getSession(session.id);
    assert.equal(stopped?.status, "error");
    assert.equal(stopped?.activeTurnId, null);
  } finally {
    testFixture.close();
  }
});
