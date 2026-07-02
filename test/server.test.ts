import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

    const now = new Date().toISOString();
    store.createProject({ id: "p1", name: "Test", path: projectRoot, createdAt: now });
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
