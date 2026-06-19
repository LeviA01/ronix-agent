import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProjectDirectory,
  resolveProjectPath,
  validateProjectPath,
} from "../src/project-path.js";

test("accepts paths inside an allowed root and rejects paths outside it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-path-"));
  const allowed = join(directory, "allowed");
  const project = join(allowed, "project");
  const outside = join(directory, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);

  try {
    assert.equal(await validateProjectPath(project, [allowed]), project);
    await assert.rejects(validateProjectPath(outside, [allowed]), /must be inside/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves a project folder name inside configured roots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-resolve-"));
  const first = join(directory, "first");
  const second = join(directory, "second");
  const project = join(second, "veyra");
  mkdirSync(first);
  mkdirSync(project, { recursive: true });

  try {
    assert.deepEqual(await resolveProjectPath("veyra", [first, second]), {
      path: project,
      exists: true,
      folder: "veyra",
    });
    await assert.rejects(resolveProjectPath("../outside", [first]), /single directory name/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a missing project folder and initializes git", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-agent-create-"));
  const allowed = join(directory, "projects");
  const project = join(allowed, "veyra");
  mkdirSync(allowed);

  try {
    const resolution = await resolveProjectPath("veyra", [allowed]);
    assert.equal(resolution.path, project);
    assert.equal(resolution.exists, false);

    assert.equal(await createProjectDirectory(project, [allowed]), project);
    assert.equal(existsSync(join(project, ".git")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
