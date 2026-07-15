import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config as defaultConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { theoryMaterialPath } from "../src/theory-materials.js";
import { FakeAppServer } from "./fake-app-server.js";
import { correctTheoryAnswers, theoryMaterialFixture } from "./theory-material-fixture.js";

test("runs the material generation, attempt, revision, and delete API lifecycle", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-server-materials-"));
  const projectRoot = join(directory, "projects");
  mkdirSync(projectRoot);
  mkdirSync(join(projectRoot, "learning-project"));
  const store = new Store(join(directory, "data"));
  const codex = new FakeAppServer();
  const sessions = new SessionManager(store, codex, 100);
  const app = createApplication({
    store,
    sessions,
    config: {
      ...defaultConfig,
      dataDir: join(directory, "data"),
      projectRoots: [projectRoot],
      authKey: "",
      trustProxy: false,
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", () => {
        app.server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Local sockets are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const changing = { "content-type": "application/json", origin: base };

  try {
    const create = await fetch(base + "/api/projects", {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ path: "learning-project", kind: "learning" }),
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { project: { id: string; path: string } };
    const projectId = created.project.id;
    assert.equal(existsSync(join(created.project.path, "learning", "theory", "materials")), true);

    const learning = await fetch(`${base}/api/projects/${projectId}/learning`);
    const learningBody = await learning.json() as {
      sessions: { theory: { id: string }; materials: { id: string; purpose: string } };
    };
    assert.equal(learningBody.sessions.materials.purpose, "materials");
    const stableMaterialSessionId = learningBody.sessions.materials.id;

    const generate = await fetch(`${base}/api/projects/${projectId}/learning/materials/generate`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ topic: "Замыкания", size: "short", notes: "Больше аналогий" }),
    });
    assert.equal(generate.status, 202);
    const generation = await generate.json() as { materialId: string; sessionId: string };
    assert.equal(generation.sessionId, stableMaterialSessionId);
    assert.equal(store.getSession(generation.sessionId)?.status, "running");

    const duplicate = await fetch(`${base}/api/projects/${projectId}/learning/materials/generate`, {
      method: "POST",
      headers: changing,
      body: JSON.stringify({ topic: "Другая тема", size: "standard" }),
    });
    assert.equal(duplicate.status, 409);

    const turn = codex.calls.findLast((call) => call.method === "turn/start");
    const prompt = (turn?.params as { input?: Array<{ text: string }> })?.input?.[0]?.text ?? "";
    assert.match(prompt, new RegExp(`learning/theory/materials/${generation.materialId}\\.json`));
    assert.match(prompt, /LEARNING_DIARY\.md/);
    assert.match(prompt, /ровно 6 блоков/);

    const material = theoryMaterialFixture(generation.materialId, "short");
    writeFileSync(theoryMaterialPath(created.project.path, generation.materialId), JSON.stringify(material));
    const session = store.getSession(generation.sessionId);
    assert.ok(session?.threadId && session.activeTurnId);
    codex.notify("turn/completed", {
      threadId: session.threadId,
      turn: { id: session.activeTurnId, status: "completed" },
    });
    assert.equal(store.getSession(generation.sessionId)?.status, "ready");
    assert.ok(store.listEvents(generation.sessionId).some((event) =>
      event.type === "material.generation.completed"
      && (event.payload as { materialId?: string }).materialId === generation.materialId
    ));

    const list = await fetch(`${base}/api/projects/${projectId}/learning/materials`);
    assert.equal(list.status, 200);
    const library = await list.json() as {
      materials: Array<{ id: string; revision: string; lastAttempt: unknown }>;
      errors: unknown[];
      generationSession: { id: string };
    };
    assert.equal(library.materials.length, 1);
    assert.equal(library.errors.length, 0);
    assert.equal(library.generationSession.id, stableMaterialSessionId);
    const revision = library.materials[0]!.revision;

    const stale = await fetch(
      `${base}/api/projects/${projectId}/learning/materials/${generation.materialId}/attempt`,
      {
        method: "POST",
        headers: changing,
        body: JSON.stringify({ revision: "0".repeat(64), answersByBlock: correctTheoryAnswers(material) }),
      },
    );
    assert.equal(stale.status, 409);

    const attempt = await fetch(
      `${base}/api/projects/${projectId}/learning/materials/${generation.materialId}/attempt`,
      {
        method: "POST",
        headers: changing,
        body: JSON.stringify({ revision, answersByBlock: correctTheoryAnswers(material) }),
      },
    );
    assert.equal(attempt.status, 200);
    const result = await attempt.json() as { correct: number; total: number; percentage: number };
    assert.equal(result.correct, 3);
    assert.equal(result.total, 3);
    assert.equal(result.percentage, 100);

    const detail = await fetch(
      `${base}/api/projects/${projectId}/learning/materials/${generation.materialId}`,
    );
    const detailBody = await detail.json() as {
      lastAttempt: { revision: string };
      lastResult: { percentage: number };
    };
    assert.equal(detailBody.lastAttempt.revision, revision);
    assert.equal(detailBody.lastResult.percentage, 100);

    material.title = "Изменённая версия";
    writeFileSync(theoryMaterialPath(created.project.path, generation.materialId), JSON.stringify(material));
    const revisedList = await fetch(`${base}/api/projects/${projectId}/learning/materials`);
    const revisedLibrary = await revisedList.json() as {
      materials: Array<{ revision: string; lastAttempt: unknown }>;
    };
    assert.notEqual(revisedLibrary.materials[0]!.revision, revision);
    assert.equal(revisedLibrary.materials[0]!.lastAttempt, null);

    const remove = await fetch(
      `${base}/api/projects/${projectId}/learning/materials/${generation.materialId}`,
      { method: "DELETE", headers: { origin: base } },
    );
    assert.equal(remove.status, 204);
    assert.equal(existsSync(theoryMaterialPath(created.project.path, generation.materialId)), false);
    assert.equal(store.getTheoryMaterialAttempt(projectId, generation.materialId, revision), null);
  } finally {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
