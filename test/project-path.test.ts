import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateProjectPath } from "../src/project-path.js";

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
