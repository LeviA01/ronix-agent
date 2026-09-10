import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Browser modules are intentionally shipped as JavaScript.
import { SURFACES, availableSurface, migrateProjectNavigation, projectsForSurface, resolveSurface, selectedProjectId } from "../public/js/core/navigation.js";

const projects = [
  { id: "dev-a", kind: "dev" }, { id: "learn-a", kind: "learning" },
  { id: "dev-b", kind: "dev" }, { id: "learn-b", kind: "learning" },
];
const allModules = () => true;

test("project sections are disjoint while the shared project list remains complete", () => {
  assert.deepEqual(projectsForSurface(projects, "development"), [projects[0], projects[2]]);
  assert.deepEqual(projectsForSurface(projects, "learning"), [projects[1], projects[3]]);
  assert.deepEqual(projectsForSurface(projects, "chat"), []);
  assert.equal(projects.length, 4);
});

test("legacy navigation restores the original project in its section without replacing new preferences", () => {
  for (const project of projects) {
    const navigation = { projectId: project.id, sessionsByProject: { [project.id]: "session" } };
    migrateProjectNavigation(navigation, projects);
    const surface = project.kind === "learning" ? "learning" : "development";
    assert.equal(resolveSurface("projects", projects, navigation, allModules), surface);
    assert.equal(selectedProjectId(projects, surface, navigation), project.id);
    assert.equal(navigation.sessionsByProject[project.id], "session");
  }
  const navigation = { projectId: "dev-a", projectsBySurface: { development: "dev-b", learning: "learn-b" } };
  migrateProjectNavigation(navigation, projects);
  assert.equal(selectedProjectId(projects, "development", navigation), "dev-b");
  assert.equal(selectedProjectId(projects, "learning", navigation), "learn-b");
});

test("missing, removed and converted projects fall back only within the current section", () => {
  const navigation = { projectId: "deleted", projectsBySurface: { development: "learn-a", learning: "deleted" } };
  assert.equal(resolveSurface("projects", projects, navigation, allModules), "development");
  assert.equal(selectedProjectId(projects, "development", navigation), "dev-a");
  assert.equal(selectedProjectId(projects, "learning", navigation), "learn-a");
  assert.equal(selectedProjectId(projectsForSurface(projects, "learning"), "development", navigation), null);
  assert.equal(selectedProjectId([], "learning", navigation), null);
});

test("section access respects learning, development and chat module permissions", () => {
  for (const [modules, expected] of [
    [["learning"], ["learning"]],
    [["development"], ["development", "memory"]],
    [["chat"], ["chat"]],
    [["learning", "chat"], ["learning", "chat"]],
  ] as const) {
    const allowed = (module: string) => (modules as readonly string[]).includes(module);
    assert.deepEqual(SURFACES.filter((surface: string) => availableSurface(surface, allowed)), expected);
    assert.equal(resolveSurface("unknown", projects, {}, allowed), expected[0]);
  }
  assert.equal(resolveSurface("projects", [], {}, allModules), "development");
  assert.equal(resolveSurface("chat", projects, {}, allModules), "chat");
  assert.equal(resolveSurface("memory", projects, {}, allModules), "memory");
});
