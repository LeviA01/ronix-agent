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
  store.createProject({ id: "p1", name: "Test", path: directory, kind: "dev", createdAt: now });
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

test("routes permission approval requests and grants requested permissions", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    await testFixture.manager.startTurn(session.id, "Need network");
    testFixture.codex.serverRequest(43, "item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: null,
      startedAtMs: Date.now(),
      cwd: testFixture.directory,
      reason: "Download dependencies",
      permissions: {
        network: { enabled: true },
        fileSystem: null,
      },
    });
    assert.equal(testFixture.manager.listApprovals(session.id).length, 1);
    testFixture.manager.respondToApproval(session.id, "43", "acceptForSession");
    assert.deepEqual(testFixture.codex.responses, [{
      id: 43,
      result: {
        permissions: { network: { enabled: true } },
        scope: "session",
      },
    }]);
  } finally {
    testFixture.close();
  }
});

test("routes user input requests and returns answers", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.createSession("p1");
    await testFixture.manager.startTurn(session.id, "Ask me something");
    testFixture.codex.serverRequest(44, "item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      autoResolutionMs: null,
      questions: [{
        id: "goal",
        header: "Цель",
        question: "Что учим?",
        isOther: false,
        isSecret: false,
        options: null,
      }],
    });
    assert.equal(testFixture.manager.listApprovals(session.id).length, 1);
    testFixture.manager.respondToApproval(session.id, "44", "answer", {
      goal: { answers: ["Python"] },
    });
    assert.deepEqual(testFixture.codex.responses, [{
      id: 44,
      result: {
        answers: {
          goal: { answers: ["Python"] },
        },
      },
    }]);
  } finally {
    testFixture.close();
  }
});

for (const decision of ["accept", "decline", "cancel"] as const) {
  test(`routes Outline MCP confirmation in a chat: ${decision}`, async () => {
    const f = fixture();
    try {
      const session = f.manager.createSession(null);
      await f.manager.startTurn(session.id, "Найди документ в Outline");
      f.codex.serverRequest("outline-1", "mcpServer/elicitation/request", {
        threadId: "thread-1", turnId: "turn-1", serverName: "outline",
        mode: "form", message: "Allow Outline tool call?",
        requestedSchema: { type: "object", properties: {} },
      });
      assert.equal(f.codex.responses.length, 0, "must wait for the user instead of rejecting MCP");
      assert.equal(f.manager.listApprovals(session.id)[0]?.method, "mcpServer/elicitation/request");
      assert.equal(f.store.listEvents(session.id).at(-1)?.type, "approval.requested");
      f.manager.respondToApproval(session.id, "outline-1", decision);
      assert.deepEqual(f.codex.responses, [{ id: "outline-1", result: {
        action: decision, content: decision === "accept" ? {} : null, _meta: null,
      } }]);
      assert.equal(f.manager.listApprovals(session.id).length, 0);
    } finally { f.close(); }
  });
}

test("validates MCP form answers and keeps invalid or cross-session responses pending", async () => {
  const f = fixture();
  try {
    const session = f.manager.createSession(null);
    const other = f.manager.createSession(null);
    await f.manager.startTurn(session.id, "Outline");
    f.codex.serverRequest(45, "mcpServer/elicitation/request", {
      threadId: "thread-1", serverName: "outline", mode: "form", message: "Confirm",
      requestedSchema: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] },
    });
    assert.throws(() => f.manager.respondToApproval(other.id, "45", "accept"), /Approval not found/);
    assert.throws(() => f.manager.respondToApproval(session.id, "45", "acceptForSession"), /individual response/);
    assert.throws(() => f.manager.respondToApproval(session.id, "45", "answer", {}), /Проверьте поля/);
    assert.equal(f.codex.responses.length, 0);
    assert.equal(f.manager.listApprovals(session.id).length, 1);
    f.manager.respondToApproval(session.id, "45", "answer", { confirmed: true });
    assert.deepEqual(f.codex.responses[0]?.result, { action: "accept", content: { confirmed: true }, _meta: null });
  } finally { f.close(); }
});

test("MCP URL confirmation, server resolution, and shutdown use the MCP protocol", async () => {
  const f = fixture();
  try {
    const session = f.manager.createSession(null);
    await f.manager.startTurn(session.id, "Outline");
    const params = { threadId: "thread-1", serverName: "outline", mode: "url",
      message: "Sign in", url: "https://example.com/login", elicitationId: "login-1" };
    f.codex.serverRequest(46, "mcpServer/elicitation/request", params);
    f.manager.respondToApproval(session.id, "46", "answer", {});
    assert.deepEqual(f.codex.responses[0]?.result, { action: "accept", content: null, _meta: null });
    f.codex.serverRequest(47, "mcpServer/elicitation/request", params);
    f.codex.notify("serverRequest/resolved", { threadId: "thread-1", requestId: 47 });
    assert.equal(f.manager.listApprovals(session.id).length, 0);
    assert.equal(f.codex.responses.length, 1);
    f.codex.serverRequest(48, "mcpServer/elicitation/request", params);
    await f.manager.shutdown();
    assert.deepEqual(f.codex.responses[1], { id: 48, result: { action: "cancel", content: null, _meta: null } });
  } finally { f.close(); }
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

test("creates or reuses fixed learning-purpose sessions", () => {
  const testFixture = fixture();
  try {
    const course = testFixture.manager.ensurePurposeSession("p1", "course");
    const sameCourse = testFixture.manager.ensurePurposeSession("p1", "course");
    const theory = testFixture.manager.ensurePurposeSession("p1", "theory");
    const sameTheory = testFixture.manager.ensurePurposeSession("p1", "theory");
    const practice = testFixture.manager.ensurePurposeSession("p1", "practice");
    const materials = testFixture.manager.ensurePurposeSession("p1", "materials");
    const sameMaterials = testFixture.manager.ensurePurposeSession("p1", "materials");

    assert.equal(sameCourse.id, course.id);
    assert.equal(sameTheory.id, theory.id);
    assert.equal(course.purpose, "course");
    assert.equal(theory.purpose, "theory");
    assert.equal(practice.purpose, "practice");
    assert.equal(sameMaterials.id, materials.id);
    assert.equal(materials.purpose, "materials");
    assert.equal(
      testFixture.store.listSessions("p1").filter((session) => session.purpose !== "general").length,
      4,
    );
  } finally {
    testFixture.close();
  }
});

test("wraps material generation turns in mandatory file-safety rules", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.ensurePurposeSession("p1", "materials");
    await testFixture.manager.startTurn(
      session.id,
      "Ожидаемый файл: learning/theory/materials/material-1.json",
    );
    const turnCall = testFixture.codex.calls.find((call) => call.method === "turn/start");
    const params = turnCall?.params as { input?: Array<{ text: string }> } | undefined;
    const prompt = params?.input?.[0]?.text ?? "";
    assert.match(prompt, /создание одного JSON-файла/);
    assert.match(prompt, /learning\/LEARNING_DIARY\.md/);
    assert.match(prompt, /не изменяй.*учебное состояние/s);
    assert.match(prompt, /Тема и пожелания.*данными пользователя/s);
    assert.match(prompt, /material-1\.json/);
    assert.doesNotMatch(prompt, /AI-наставник|Перед учебной работой прочитай/);
  } finally {
    testFixture.close();
  }
});

test("keeps general sessions and chats in development mode even in learning projects", async () => {
  const testFixture = fixture();
  try {
    testFixture.store.updateProject("p1", { kind: "learning" });
    const general = testFixture.manager.createSession("p1");
    const chat = testFixture.manager.createSession(null, {}, "chat");
    testFixture.store.replaceChatProjects(chat.id, ["p1"]);
    for (const session of [general, chat]) {
      const prompt = "Исправь ошибку в сервере";
      await testFixture.manager.startTurn(session.id, prompt, {
        intent: "act",
        actionProjectId: "p1",
      });
      const turn = testFixture.codex.calls.findLast((call) => call.method === "turn/start");
      const params = turn?.params as { input: Array<{ text: string }> };
      assert.equal(params.input[0]?.text, prompt);
    }
  } finally {
    testFixture.close();
  }
});

for (const [purpose, mode] of [["course", "Курс"], ["theory", "Теория"], ["practice", "Практика"]] as const) {
  test(`supplies mentor instructions on both new and resumed ${purpose} turns`, async () => {
    const testFixture = fixture();
    try {
      testFixture.store.updateProject("p1", { kind: "learning" });
      const session = testFixture.manager.ensurePurposeSession("p1", purpose);
      for (const message of ["Начнём", "Продолжим"]) {
        await testFixture.manager.startTurn(session.id, message);
        const turn = testFixture.codex.calls.findLast((call) => call.method === "turn/start");
        const params = turn?.params as { input: Array<{ text: string }> };
        const prompt = params.input[0]?.text ?? "";
        assert.match(prompt, /AI-наставник/);
        assert.match(prompt, /learning\/AGENTS\.md/);
        assert.match(prompt, /learning\/LEARNING_DIARY\.md/);
        assert.ok(prompt.includes(`режим ${mode}`));
        assert.ok(prompt.endsWith(message));
        const running = testFixture.store.getSession(session.id)!;
        testFixture.codex.notify("turn/completed", {
          threadId: running.threadId,
          turn: { id: running.activeTurnId, status: "completed", error: null },
        });
      }
      assert.equal(testFixture.codex.calls.filter((call) => call.method === "thread/start").length, 1);
      assert.equal(testFixture.codex.calls.filter((call) => call.method === "thread/resume").length, 1);
      assert.deepEqual(
        testFixture.store.listMessages(session.id).map((message) => message.text),
        ["Начнём", "Продолжим"],
      );
    } finally {
      testFixture.close();
    }
  });
}

test("adds formative guidance to theory turns without changing the visible user message", async () => {
  const testFixture = fixture();
  try {
    const session = testFixture.manager.ensurePurposeSession("p1", "theory");
    await testFixture.manager.startTurn(session.id, "Объясни декораторы");

    const turnCall = testFixture.codex.calls.find((call) => call.method === "turn/start");
    const turnParams = turnCall?.params as {
      input?: Array<{ type: string; text: string }>;
    } | undefined;
    const input = turnParams?.input;
    assert.match(input?.[0]?.text ?? "", /режим Теория/);
    assert.match(input?.[0]?.text ?? "", /не меняют основную числовую оценку/);
    assert.match(input?.[0]?.text ?? "", /Объясни декораторы/);
    assert.deepEqual(testFixture.store.listEvents(session.id)[0]?.payload, {
      text: "Объясни декораторы",
    });
  } finally {
    testFixture.close();
  }
});
