import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config as defaultConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { SessionManager } from "../src/session-manager.js";
import { Store } from "../src/store.js";
import { FakeAppServer } from "./fake-app-server.js";

test("serves security headers, rejects foreign origins, and pages event history", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-server-"));
  const projectRoot = join(directory, "projects");
  mkdirSync(projectRoot);
  const store = new Store(join(directory, "data"));
  const codex = new FakeAppServer();
  const sessions = new SessionManager(store, codex, 100);
  const config = {
    ...defaultConfig,
    dataDir: join(directory, "data"),
    projectRoots: [projectRoot],
    authKey: "",
    trustProxy: false,
  };
  const app = createApplication({ config, store, sessions });
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

  try {
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-security-policy") ?? "", /default-src/);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    const healthBody = await health.json() as {
      deploymentMode: string;
      modules: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(healthBody.deploymentMode, "local");
    assert.deepEqual(healthBody.modules, [
      { id: "tts", enabled: false, configured: false, provider: null },
      { id: "stt", enabled: false, configured: false, provider: null },
    ]);

    const modules = await fetch(base + "/api/modules");
    assert.equal(modules.status, 200);
    assert.deepEqual(await modules.json(), { modules: healthBody.modules });

    const foreign = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ projectId: "missing" }),
    });
    assert.equal(foreign.status, 403);

    const devRoot = join(projectRoot, "dev-api");
    mkdirSync(devRoot);
    const createdDev = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ path: "dev-api" }),
    });
    assert.equal(createdDev.status, 201);
    const createdDevBody = await createdDev.json() as {
      project: { id: string; kind: string; path: string };
    };
    assert.equal(createdDevBody.project.kind, "dev");
    assert.equal(existsSync(join(createdDevBody.project.path, "learning")), false);

    const enableLearning = await fetch(
      `${base}/api/projects/${createdDevBody.project.id}/learning/enable`,
      { method: "POST", headers: { origin: base } },
    );
    assert.equal(enableLearning.status, 200);
    assert.equal(store.getProject(createdDevBody.project.id)?.kind, "learning");
    assert.equal(existsSync(join(createdDevBody.project.path, "AGENTS.md")), true);
    assert.equal(existsSync(join(createdDevBody.project.path, "learning", "AGENTS.md")), true);
    assert.equal(existsSync(join(createdDevBody.project.path, "learning", "LEARNING_DIARY.md")), true);
    assert.equal(existsSync(join(createdDevBody.project.path, "learning", "ROADMAP.md")), true);
    assert.match(
      readFileSync(join(createdDevBody.project.path, "learning", "AGENTS.md"), "utf8"),
      /## Теория/,
    );
    assert.match(
      readFileSync(join(createdDevBody.project.path, "learning", "LEARNING_DIARY.md"), "utf8"),
      /## Теоретические разборы/,
    );
    const customRoadmap = "# Custom roadmap\n";
    const customRootAgents = "# Custom root agents\n";
    const customLearningAgents = "# Custom learning agents\n";
    writeFileSync(join(createdDevBody.project.path, "AGENTS.md"), customRootAgents);
    writeFileSync(
      join(createdDevBody.project.path, "learning", "AGENTS.md"),
      customLearningAgents,
    );
    writeFileSync(join(createdDevBody.project.path, "learning", "ROADMAP.md"), customRoadmap);
    const enableAgain = await fetch(
      `${base}/api/projects/${createdDevBody.project.id}/learning/enable`,
      { method: "POST", headers: { origin: base } },
    );
    assert.equal(enableAgain.status, 200);
    assert.equal(
      readFileSync(join(createdDevBody.project.path, "AGENTS.md"), "utf8"),
      customRootAgents,
    );
    assert.equal(
      readFileSync(join(createdDevBody.project.path, "learning", "AGENTS.md"), "utf8"),
      customLearningAgents,
    );
    assert.equal(
      readFileSync(join(createdDevBody.project.path, "learning", "ROADMAP.md"), "utf8"),
      customRoadmap,
    );

    const managedRoot = join(projectRoot, "managed-api");
    const movedRoot = join(projectRoot, "managed-moved");
    mkdirSync(managedRoot);
    mkdirSync(movedRoot);
    const managedProject = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ path: "managed-api" }),
    });
    assert.equal(managedProject.status, 201);
    const managedProjectBody = await managedProject.json() as {
      project: { id: string; name: string; path: string; kind: string };
    };
    const editedProject = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: "Managed renamed", path: "managed-moved" }),
    });
    assert.equal(editedProject.status, 200);
    const editedProjectBody = await editedProject.json() as {
      project: { name: string; path: string; kind: string };
    };
    assert.equal(editedProjectBody.project.name, "Managed renamed");
    assert.equal(editedProjectBody.project.path, movedRoot);
    assert.equal(editedProjectBody.project.kind, "dev");

    const duplicateProjectPath = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ path: createdDevBody.project.path }),
    });
    assert.equal(duplicateProjectPath.status, 409);

    const missingProjectPath = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ path: "missing-managed" }),
    });
    assert.equal(missingProjectPath.status, 409);

    const managedSession = sessions.createSession(managedProjectBody.project.id);
    store.updateSession(managedSession.id, {
      status: "running",
      activeTurnId: "turn-managed",
    });
    const activeProjectEdit = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: "Blocked" }),
    });
    assert.equal(activeProjectEdit.status, 409);
    const activeProjectDelete = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.equal(activeProjectDelete.status, 409);

    store.updateSession(managedSession.id, {
      status: "ready",
      activeTurnId: null,
    });
    const learningViaPatch = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ kind: "learning" }),
    });
    assert.equal(learningViaPatch.status, 200);
    assert.equal(store.getProject(managedProjectBody.project.id)?.kind, "learning");
    assert.equal(existsSync(join(movedRoot, "learning", "ROADMAP.md")), true);

    const removeProject = await fetch(`${base}/api/projects/${managedProjectBody.project.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.equal(removeProject.status, 204);
    assert.equal(store.getProject(managedProjectBody.project.id), null);
    assert.equal(store.getSession(managedSession.id), null);
    assert.equal(existsSync(movedRoot), true);

    const learningRoot = join(projectRoot, "learning-api");
    mkdirSync(learningRoot);
    const createdLearning = await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ path: "learning-api", kind: "learning" }),
    });
    assert.equal(createdLearning.status, 201);
    const createdLearningBody = await createdLearning.json() as {
      project: { id: string; kind: string; path: string };
    };
    assert.equal(createdLearningBody.project.kind, "learning");
    assert.match(
      readFileSync(join(createdLearningBody.project.path, "AGENTS.md"), "utf8"),
      /learning\/AGENTS\.md/,
    );
    writeFileSync(join(createdLearningBody.project.path, "learning", "LEARNING_DIARY.md"), [
      "# Учебный дневник",
      "",
      "Последнее обновление: 2026-07-07",
      "",
      "## Текущая карта знаний",
      "",
      "| Тема или подтема | Балл | Уверенность | Последнее основание |",
      "|---|---:|---|---|",
      "| Функции | 7 | высокая | Самостоятельная работа |",
      "| Исключения | 4 | средняя | Нужна практика |",
      "",
      "## Журнал заданий",
      "",
      "### Задание 1",
      "",
      "Итоговая оценка: 6/10",
      "",
      "### Задание 2",
      "",
      "Текущая оценка после доработки: 8/10",
      "",
      "## Текущий учебный фокус",
      "",
      "1. Исключения",
      "",
    ].join("\n"));
    writeFileSync(join(createdLearningBody.project.path, "learning", "ROADMAP.md"), [
      "# Дорожная карта",
      "",
      "## Сейчас",
      "",
      "- [x] Настроить цель",
      "- [ ] Пройти исключения",
      "",
      "## Следующие шаги",
      "",
      "- [ ] Практика с файлами",
      "",
      "## Позже",
      "",
      "- [ ] Контрольная",
      "",
    ].join("\n"));
    const learningState = await fetch(
      `${base}/api/projects/${createdLearningBody.project.id}/learning`,
    );
    assert.equal(learningState.status, 200);
    const learningStateBody = await learningState.json() as {
      available: boolean;
      source: string;
      rootAgentsPath: string;
      rootAgentsPresent: boolean;
      diaryPath: string;
      roadmapPath: string;
      diarySummary: {
        weakTopics: Array<{ title: string; score: number }>;
        strongTopics: Array<{ title: string; score: number }>;
        focus: string[];
        latestGrades: Array<{ title: string; score: number }>;
      };
      roadmapSummary: {
        currentStage: string;
        nextSteps: Array<{ title: string; done: boolean }>;
        completed: string[];
      };
      sessions: {
        course: { id: string; purpose: string };
        theory: { id: string; purpose: string };
        practice: { id: string; purpose: string };
      };
    };
    assert.equal(learningStateBody.available, true);
    assert.equal(learningStateBody.source, "learning");
    assert.equal(learningStateBody.rootAgentsPath, "AGENTS.md");
    assert.equal(learningStateBody.rootAgentsPresent, true);
    assert.equal(learningStateBody.diaryPath, "learning/LEARNING_DIARY.md");
    assert.equal(learningStateBody.roadmapPath, "learning/ROADMAP.md");
    assert.deepEqual(learningStateBody.diarySummary.focus, ["Исключения"]);
    assert.equal(learningStateBody.diarySummary.weakTopics[0]?.title, "Исключения");
    assert.equal(learningStateBody.diarySummary.strongTopics[0]?.title, "Функции");
    assert.deepEqual(learningStateBody.diarySummary.latestGrades, [
      { title: "Задание 1", score: 6 },
      { title: "Задание 2", score: 8 },
    ]);
    assert.equal(learningStateBody.roadmapSummary.currentStage, "Пройти исключения");
    assert.deepEqual(learningStateBody.roadmapSummary.nextSteps, [
      { title: "Практика с файлами", done: false },
    ]);
    assert.deepEqual(learningStateBody.roadmapSummary.completed, ["Настроить цель"]);
    assert.equal(learningStateBody.sessions.course.purpose, "course");
    assert.equal(learningStateBody.sessions.theory.purpose, "theory");
    assert.equal(learningStateBody.sessions.practice.purpose, "practice");
    const repeatedLearningState = await fetch(
      `${base}/api/projects/${createdLearningBody.project.id}/learning`,
    );
    const repeatedLearningBody = await repeatedLearningState.json() as {
      sessions: {
        course: { id: string };
        theory: { id: string };
        practice: { id: string };
      };
    };
    assert.equal(repeatedLearningBody.sessions.course.id, learningStateBody.sessions.course.id);
    assert.equal(repeatedLearningBody.sessions.theory.id, learningStateBody.sessions.theory.id);
    assert.equal(repeatedLearningBody.sessions.practice.id, learningStateBody.sessions.practice.id);

    const now = new Date().toISOString();
    store.createProject({ id: "p1", name: "Test", path: projectRoot, kind: "dev", createdAt: now });
    const examples = join(projectRoot, "examples");
    mkdirSync(examples);
    writeFileSync(join(examples, "AGENTS.md"), "# Инструкция\n\nРаботай как наставник.\n");
    writeFileSync(join(examples, "LEARNING_DIARY.md"), [
      "# Учебный дневник",
      "",
      "Последнее обновление: 2026-07-07",
      "",
      "## Текущая карта знаний",
      "",
      "| Тема или подтема | Балл | Уверенность | Последнее основание |",
      "|---|---:|---|---|",
      "| Функции | 7 | высокая | Самостоятельная работа |",
      "",
      "## Журнал заданий",
      "",
      "### Задание 1",
      "",
      "## Текущий учебный фокус",
      "",
      "1. Функции",
      "",
    ].join("\n"));
    const learning = await fetch(base + "/api/projects/p1/learning");
    assert.equal(learning.status, 200);
    const learningBody = await learning.json() as {
      available: boolean;
      agentsPath: string;
      diaryPath: string;
      agents: string;
      diary: string;
      summary: {
        lastUpdated: string;
        topicCount: number;
        assignmentCount: number;
        focus: string[];
        averageScore: number;
        weakTopics: Array<{
          title: string;
          score: number;
          confidence: string;
          rationale: string;
        }>;
        strongTopics: Array<{
          title: string;
          score: number;
          confidence: string;
          rationale: string;
        }>;
        assignments: Array<{ title: string; score: number | null }>;
      };
    };
    assert.equal(learningBody.available, true);
    assert.equal(learningBody.agentsPath, "examples/AGENTS.md");
    assert.equal(learningBody.diaryPath, "examples/LEARNING_DIARY.md");
    assert.match(learningBody.agents, /наставник/);
    assert.match(learningBody.diary, /Функции/);
    assert.equal(learningBody.summary.lastUpdated, "2026-07-07");
    assert.equal(learningBody.summary.topicCount, 1);
    assert.equal(learningBody.summary.assignmentCount, 1);
    assert.equal(learningBody.summary.averageScore, 7);
    assert.deepEqual(learningBody.summary.focus, ["Функции"]);
    assert.deepEqual(learningBody.summary.weakTopics, [{
      title: "Функции",
      score: 7,
      confidence: "высокая",
      rationale: "Самостоятельная работа",
    }]);
    assert.deepEqual(learningBody.summary.strongTopics, [{
      title: "Функции",
      score: 7,
      confidence: "высокая",
      rationale: "Самостоятельная работа",
    }]);
    assert.deepEqual(learningBody.summary.assignments, [{ title: "Задание 1", score: null }]);

    const models = await fetch(base + "/api/codex/models");
    assert.equal(models.status, 200);
    const modelsBody = await models.json() as {
      models: Array<{ model: string; supportedReasoningEfforts: unknown[] }>;
    };
    assert.equal(modelsBody.models[0]?.model, "gpt-5.5");
    assert.equal(modelsBody.models[0]?.supportedReasoningEfforts.length, 3);

    const created = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: base,
      },
      body: JSON.stringify({
        projectId: "p1",
        model: "gpt-5.5",
        reasoningEffort: "high",
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as {
      session: { id: string; model: string; reasoningEffort: string };
    };
    assert.equal(createdBody.session.model, "gpt-5.5");
    assert.equal(createdBody.session.reasoningEffort, "high");

    const updated = await fetch(
      `${base}/api/sessions/${createdBody.session.id}/settings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
        },
        body: JSON.stringify({ model: "gpt-5.5", reasoningEffort: "xhigh" }),
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(store.getSession(createdBody.session.id)?.reasoningEffort, "xhigh");

    const invalidEffort = await fetch(
      `${base}/api/sessions/${createdBody.session.id}/settings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
        },
        body: JSON.stringify({ model: "gpt-5.5", reasoningEffort: "impossible" }),
      },
    );
    assert.equal(invalidEffort.status, 400);

    store.updateSession(createdBody.session.id, {
      status: "running",
      activeTurnId: "turn-active",
    });
    const activeUpdate = await fetch(
      `${base}/api/sessions/${createdBody.session.id}/settings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
        },
        body: JSON.stringify({ reasoningEffort: "medium" }),
      },
    );
    assert.equal(activeUpdate.status, 409);

    const session = sessions.createSession("p1");
    store.addEvent(session.id, "user.message", { text: "one" });
    const second = store.addEvent(session.id, "user.message", { text: "two" });
    const history = await fetch(
      `${base}/api/sessions/${session.id}/events/history?before=${second.sequence}&limit=10`,
    );
    assert.equal(history.status, 200);
    const body = await history.json() as { events: Array<{ payload: { text: string } }> };
    assert.deepEqual(body.events.map((event) => event.payload.text), ["one"]);
  } finally {
    await app.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
