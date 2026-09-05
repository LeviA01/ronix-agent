import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryService } from "../src/memory-service.js";
import { Store } from "../src/store.js";

test("stores, searches, corrects and suppresses durable memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-memory-"));
  const store = new Store(directory);
  const memory = new MemoryService(store);
  try {
    const now = new Date().toISOString();
    store.createProject({ id: "p1", name: "Alpha", path: "/tmp/alpha", kind: "dev", createdAt: now });
    const saved = memory.remember({
      scopeType: "project",
      scopeId: "p1",
      kind: "decision",
      content: "Use SQLite for durable project memory; api_key=do-not-store",
    });
    assert.match(saved.content, /\[secret removed\]/);
    assert.equal(memory.remember({
      scopeType: "project",
      scopeId: "p1",
      kind: "decision",
      content: saved.content,
    }).id, saved.id);
    assert.equal(memory.search({ query: "SQLite project", scopeType: "project", scopeId: "p1" }).total, 1);

    const corrected = memory.correct(saved.id, {
      content: "Use SQLite with FTS5 for durable project memory",
      kind: "decision",
      confidence: 0.9,
    });
    assert.equal(corrected.confidence, 0.9);
    memory.forget(saved.id);
    assert.equal(memory.search({ scopeType: "project", scopeId: "p1" }).total, 0);
    assert.throws(() => memory.remember({
      scopeType: "project",
      scopeId: "p1",
      kind: "decision",
      content: corrected.content,
    }), /explicitly forgotten/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps structured learning evidence and roadmap in SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-learning-memory-"));
  const store = new Store(directory);
  const memory = new MemoryService(store);
  try {
    const now = new Date().toISOString();
    store.createProject({ id: "learn", name: "Learn", path: "/tmp/learn", kind: "learning", createdAt: now });
    memory.setLearningGoal("learn", "Уверенно писать на TypeScript");
    const evidence = memory.recordLearningEvidence({
      projectId: "learn",
      topic: "Типы",
      kind: "practice",
      scoreDelta: 1,
      resultScore: 8,
      rationale: "Самостоятельно исправил union type",
    });
    assert.equal(evidence.topic?.score, 6);
    assert.equal(evidence.observation.resultScore, 8);
    assert.throws(() => memory.recordLearningEvidence({
      projectId: "learn",
      topic: "Типы",
      kind: "practice",
      scoreDelta: 2,
      rationale: "Too large",
    }), /between -1 and 1/);
    memory.updateRoadmap({ projectId: "learn", lane: "now", title: "Закрепить generics" });
    const state = memory.learningState("learn");
    assert.equal(state.goal, "Уверенно писать на TypeScript");
    assert.equal(state.topics[0]?.title, "Типы");
    assert.equal(state.observations[0]?.resultScore, 8);
    assert.equal(state.roadmap[0]?.title, "Закрепить generics");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

