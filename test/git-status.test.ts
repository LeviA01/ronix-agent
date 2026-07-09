import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGitStatus, readGitStatus, runGitAction } from "../src/git-status.js";

test("parses porcelain git status by staged, unstaged, renamed, deleted, and untracked files", () => {
  const status = parseGitStatus([
    "## main...origin/main [ahead 2, behind 1]",
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
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
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

test("runs read-only and sync git actions from the supplied cwd", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-git-action-"));
  const remote = join(directory, "remote.git");
  const repo = join(directory, "repo");
  mkdirSync(repo);
  try {
    try {
      execFileSync("git", ["init", "--bare", remote], { cwd: directory, stdio: "ignore" });
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("git is not available");
        return;
      }
      throw error;
    }
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "file.txt"), "one\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: repo, stdio: "ignore" });

    writeFileSync(join(repo, "file.txt"), "two\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "second"], { cwd: repo, stdio: "ignore" });
    assert.equal((await readGitStatus(repo)).ahead, 1);

    const fetch = await runGitAction(repo, "fetch");
    assert.equal(fetch.ok, true);

    const push = await runGitAction(repo, "push");
    assert.equal(push.ok, true);
    assert.equal(push.status.ahead, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
