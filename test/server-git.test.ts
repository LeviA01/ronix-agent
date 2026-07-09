import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config as defaultConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { FakeAppServer } from "./fake-app-server.js";

test("serves project git status from the registered project path", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-server-git-"));
  const projectRoot = join(directory, "projects");
  const plainProject = join(projectRoot, "plain");
  const gitProject = join(projectRoot, "git-project");
  mkdirSync(plainProject, { recursive: true });
  mkdirSync(gitProject);

  try {
    execFileSync("git", ["init"], { cwd: gitProject, stdio: "ignore" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("git is not available");
      return;
    }
    throw error;
  }
  writeFileSync(join(gitProject, "new-file.ts"), "export const value = 1;\n");

  const store = new Store(join(directory, "data"));
  const sessions = new SessionManager(store, new FakeAppServer(), 100);
  const config = {
    ...defaultConfig,
    dataDir: join(directory, "data"),
    projectRoots: [projectRoot],
    authKey: "",
    trustProxy: false,
  };
  const app = createApplication({ config, store, sessions });
  try {
    if (!await listen(app.server, t)) return;
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    store.createProject({
      id: "plain",
      name: "Plain",
      path: plainProject,
      kind: "dev",
      createdAt: new Date().toISOString(),
    });
    store.createProject({
      id: "git",
      name: "Git",
      path: gitProject,
      kind: "dev",
      createdAt: new Date().toISOString(),
    });

    const missing = await fetch(base + "/api/projects/missing/git/status");
    assert.equal(missing.status, 404);

    const plain = await fetch(
      `${base}/api/projects/plain/git/status?path=${encodeURIComponent(gitProject)}`,
    );
    assert.equal(plain.status, 200);
    const plainBody = await plain.json() as { repoFound: boolean; clean: boolean };
    assert.equal(plainBody.repoFound, false);
    assert.equal(plainBody.clean, true);

    const git = await fetch(base + "/api/projects/git/git/status");
    assert.equal(git.status, 200);
    const gitBody = await git.json() as {
      repoFound: boolean;
      clean: boolean;
      files: { untracked: Array<{ path: string }> };
    };
    assert.equal(gitBody.repoFound, true);
    assert.equal(gitBody.clean, false);
    assert.deepEqual(gitBody.files.untracked.map((file) => file.path), ["new-file.ts"]);
  } finally {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs project git sync actions from the registered project path", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-server-git-action-"));
  const projectRoot = join(directory, "projects");
  const remote = join(directory, "remote.git");
  const gitProject = join(projectRoot, "git-project");
  mkdirSync(gitProject, { recursive: true });

  try {
    try {
      execFileSync("git", ["init", "--bare", remote], { cwd: directory, stdio: "ignore" });
      execFileSync("git", ["init"], { cwd: gitProject, stdio: "ignore" });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("git is not available");
        return;
      }
      throw error;
    }
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitProject, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitProject, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: gitProject, stdio: "ignore" });
    writeFileSync(join(gitProject, "tracked.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: gitProject, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: gitProject, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: gitProject, stdio: "ignore" });
    writeFileSync(join(gitProject, "tracked.ts"), "export const value = 2;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: gitProject, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "second"], { cwd: gitProject, stdio: "ignore" });

    const store = new Store(join(directory, "data"));
    const sessions = new SessionManager(store, new FakeAppServer(), 100);
    const config = {
      ...defaultConfig,
      dataDir: join(directory, "data"),
      projectRoots: [projectRoot],
      authKey: "",
      trustProxy: false,
    };
    const app = createApplication({ config, store, sessions });
    try {
      if (!await listen(app.server, t)) return;
      const address = app.server.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;

      store.createProject({
        id: "git",
        name: "Git",
        path: gitProject,
        kind: "dev",
        createdAt: new Date().toISOString(),
      });

      const unknown = await fetch(base + "/api/projects/git/git/rebase", { method: "POST" });
      assert.equal(unknown.status, 400);

      const fetchResult = await fetch(base + "/api/projects/git/git/fetch", { method: "POST" });
      assert.equal(fetchResult.status, 200);
      assert.equal((await fetchResult.json() as { ok: boolean }).ok, true);

      const beforePush = await fetch(base + "/api/projects/git/git/status");
      assert.equal((await beforePush.json() as { ahead: number }).ahead, 1);

      const push = await fetch(base + "/api/projects/git/git/push", { method: "POST" });
      assert.equal(push.status, 200);
      const pushBody = await push.json() as { status: { ahead: number } };
      assert.equal(pushBody.status.ahead, 0);

      const otherClone = join(directory, "other-clone");
      execFileSync("git", ["clone", remote, otherClone], { cwd: directory, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: otherClone, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: otherClone, stdio: "ignore" });
      writeFileSync(join(otherClone, "tracked.ts"), "export const value = 3;\n");
      execFileSync("git", ["add", "tracked.ts"], { cwd: otherClone, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "third"], { cwd: otherClone, stdio: "ignore" });
      execFileSync("git", ["push"], { cwd: otherClone, stdio: "ignore" });

      const secondFetch = await fetch(base + "/api/projects/git/git/fetch", { method: "POST" });
      assert.equal(secondFetch.status, 200);
      assert.equal((await secondFetch.json() as { status: { behind: number } }).status.behind, 1);

      const pull = await fetch(base + "/api/projects/git/git/pull", { method: "POST" });
      assert.equal(pull.status, 200);
      const pullBody = await pull.json() as { status: { behind: number } };
      assert.equal(pullBody.status.behind, 0);
      assert.equal(readFileSync(join(gitProject, "tracked.ts"), "utf8"), "export const value = 3;\n");
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function listen(server: ReturnType<typeof createApplication>["server"], t: { skip(message?: string): void }): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Local sockets are unavailable in this sandbox");
      return false;
    }
    throw error;
  }
  return true;
}
