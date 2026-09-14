import assert from "node:assert/strict";
import test from "node:test";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true, value: { getItem: () => null },
});
// @ts-expect-error The frontend is shipped as JavaScript.
const { describeChatActivity } = await import("../public/js/events/activity.js");

test("activity remains visible between items and when reopening a running session", () => {
  const view = { sessionId: "a", selectedSession: { status: "running" }, approvals: {}, liveResponse: null, liveTurnActive: false };
  assert.equal(describeChatActivity(view).text, "Codex работает над задачей…");
  assert.equal(describeChatActivity({ ...view, liveResponse: { detail: "Выполняет команду" } }).text, "Codex выполняет команду");
  assert.equal(describeChatActivity({ ...view, selectedSession: { status: "ready" }, liveTurnActive: true }).mode, "working");
});

test("approval waits take precedence over work and terminal sessions clear the indicator", () => {
  const view = { sessionId: "a", selectedSession: { status: "running" }, approvals: { request: {} } };
  assert.deepEqual(describeChatActivity(view), { mode: "waiting", text: "Codex ждёт вашего ответа" });
  for (const status of ["ready", "error", "stopped"]) {
    assert.equal(describeChatActivity({ ...view, approvals: {}, selectedSession: { status } }), null);
  }
  assert.equal(describeChatActivity({ ...view, sessionId: null }), null);
});
