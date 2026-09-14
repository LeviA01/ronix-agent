import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null },
});
// @ts-expect-error Browser modules are intentionally shipped as JavaScript.
const { state } = await import("../public/js/core/state.js");
// @ts-expect-error Browser modules are intentionally shipped as JavaScript.
const { rememberSessionView, restoreSessionView, hasSessionView, forgetSessionView, invalidateSessionView, sessionViewToken } = await import("../public/js/core/session-view.js");

function ready(id: string) {
  Object.assign(state, {
    sessionId: id, selectedSession: { id, status: "ready" }, historyReady: true,
    events: [{ sequence: 12 }], archivedMessages: [{ id: "message" }],
    approvals: {}, lastSequence: 12, firstSequence: 12, hasMoreEvents: true,
    liveTurnActive: false, liveResponse: null,
  });
}

test("reopened history keeps its cursor and scroll without sharing mutable arrays", () => {
  ready("cached");
  state.followLatest = false;
  rememberSessionView(430);
  state.followLatest = true;
  state.events.push({ sequence: 13 });
  const view = restoreSessionView("cached");
  assert.equal(view.scrollTop, 430);
  assert.equal(state.followLatest, false);
  assert.deepEqual(state.events, [{ sequence: 12 }]);
  assert.equal(state.lastSequence, 12);
  assert.equal(state.hasMoreEvents, true);
  state.events.push({ sequence: 14 });
  restoreSessionView("cached");
  assert.equal(state.events.length, 1);
  forgetSessionView("cached");
  assert.equal(hasSessionView("cached"), false);
});

test("incomplete histories are not cached and old views are evicted", () => {
  ready("incomplete");
  state.historyReady = false;
  rememberSessionView();
  assert.equal(hasSessionView("incomplete"), false);
  for (let i = 0; i < 8; i++) { ready(`view-${i}`); rememberSessionView(); }
  restoreSessionView("view-0");
  ready("view-8");
  rememberSessionView();
  assert.equal(hasSessionView("view-0"), true);
  assert.equal(hasSessionView("view-1"), false);
});

test("late responses are rejected even after returning to the same session", () => {
  ready("a");
  const old = sessionViewToken();
  invalidateSessionView();
  ready("b");
  invalidateSessionView();
  ready("a");
  assert.equal(old(), false);
  assert.equal(sessionViewToken()(), true);
});
