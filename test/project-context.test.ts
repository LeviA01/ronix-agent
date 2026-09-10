import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null },
});
// @ts-expect-error Browser modules are intentionally shipped as JavaScript.
const { state } = await import("../public/js/core/state.js");
// @ts-expect-error Browser modules are intentionally shipped as JavaScript.
const { currentProjectId, selectedProject, isLearningProject } = await import("../public/js/features/context.js");

test("working context follows stored section selection without a DOM control", () => {
  state.projects = [
    { id: "dev-a", kind: "dev", name: "Alpha" },
    { id: "dev-b", kind: "dev", name: "Beta" },
    { id: "learn", kind: "learning", name: "Course" },
  ];
  state.navigation = { projectId: "dev-a", projectsBySurface: { development: "dev-b", learning: "learn" } };
  state.surface = "development";
  assert.equal(currentProjectId(), "dev-b");
  assert.equal(selectedProject().name, "Beta");
  assert.equal(isLearningProject(), false);
  state.surface = "learning";
  assert.equal(currentProjectId(), "learn");
  assert.equal(isLearningProject(), true);
  for (const surface of ["chat", "memory"]) {
    state.surface = surface;
    assert.equal(currentProjectId(), null);
    assert.equal(selectedProject(), null);
  }
});

test("renaming, conversion and removal update context without a stale displayed selection", () => {
  state.surface = "development";
  state.navigation = { projectsBySurface: { development: "a" } };
  state.projects = [{ id: "a", kind: "dev", name: "Old" }, { id: "b", kind: "dev", name: "Other" }];
  state.projects[0] = { id: "a", kind: "dev", name: "Renamed" };
  assert.equal(selectedProject().name, "Renamed");
  state.projects[0].kind = "learning";
  assert.equal(currentProjectId(), "b");
  state.projects = state.projects.filter((project: { id: string }) => project.id !== "b");
  assert.equal(currentProjectId(), null);
  assert.equal(selectedProject(), null);
});
