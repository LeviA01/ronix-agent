import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGitStatus, readGitStatus } from "../src/git-status.js";

test("parses porcelain git status by staged, unstaged, renamed, deleted, and untracked files", () => {
  const status = parseGitStatus([
    "## main...origin/main",
    " M src/modified.ts",
    "D  src/staged-delete.ts",
    "R  src/old-name.ts -> src/new-name.ts",
    "MM src/staged-and-unstaged.ts",
    "A  src/added.ts",
    "?? src/new-module.ts",
    "",
  ].join("\n"));

  assert.equal(status.repoFound, true);
  assert.equal(status.branch, "main");
  assert.equal(status.clean, false);
  assert.equal(status.changedCount, 6);
  assert.deepEqual(status.files.unstaged.map((file) => file.path), [
    "src/modified.ts",
    "src/staged-and-unstaged.ts",
  ]);
  assert.deepEqual(status.files.staged.map((file) => file.path), [
    "src/staged-delete.ts",
    "src/new-name.ts",
    "src/staged-and-unstaged.ts",
    "src/added.ts",
  ]);
  assert.equal(status.files.staged[1]?.oldPath, "src/old-name.ts");
  assert.equal(status.files.staged[1]?.state, "renamed");
  assert.deepEqual(status.files.untracked.map((file) => file.path), ["src/new-module.ts"]);
});

test("reports usable non-git status without throwing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-git-status-"));
  try {
    const status = await readGitStatus(directory);
    assert.equal(status.repoFound, false);
    assert.equal(status.clean, true);
    assert.equal(status.changedCount, 0);
    assert.equal(status.files.untracked.length, 0);
    assert.equal(typeof status.error, "string");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads status from the supplied project cwd", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-git-status-"));
  try {
    try {
      execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("git is not available");
        return;
      }
      throw error;
    }
    mkdirSync(join(directory, "src"));
    execFileSync("git", ["status", "--porcelain=v1", "-b"], { cwd: directory, stdio: "ignore" });
    const status = await readGitStatus(directory);
    assert.equal(status.repoFound, true);
    assert.equal(status.root, directory);
    assert.equal(status.clean, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
