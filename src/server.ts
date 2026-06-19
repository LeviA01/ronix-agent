import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthManager } from "./auth.js";
import { CodexAccountClient } from "./codex-account.js";
import { config } from "./config.js";
import { HttpError, json, readJson, requireString } from "./http.js";
import { createProjectDirectory, resolveProjectPath } from "./project-path.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import type { StoredEvent } from "./types.js";

const store = new Store(config.dataDir);
const sessions = new SessionManager(store, config.codexPath);
const codexAccount = new CodexAccountClient(config.codexPath);
const publicDir = join(process.cwd(), "public");
const auth = new AuthManager(
  config.authKey,
  config.authSessionDays * 24 * 60 * 60 * 1000,
  config.secureAuthCookie,
);

function clientId(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",", 1)[0]?.trim() || request.socket.remoteAddress || "unknown";
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

function sendSse(response: ServerResponse, event: StoredEvent): void {
  response.write(`id: ${event.sequence}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    json(response, 200, {
      enabled: auth.enabled,
      authenticated: auth.authorized(request),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson<{ key?: unknown }>(request);
    const suppliedKey = typeof body.key === "string" ? body.key : "";
    const result = auth.login(response, suppliedKey, clientId(request));
    if (!result.ok) {
      if (result.retryAfterSeconds) {
        response.setHeader("retry-after", String(result.retryAfterSeconds));
        json(response, 429, { error: "Слишком много попыток. Попробуйте позже." });
      } else {
        json(response, 401, { error: "Неверный ключ доступа" });
      }
      return true;
    }
    json(response, 200, { authenticated: true });
    return true;
  }

  if (!auth.authorized(request)) {
    json(response, 401, { error: "Unauthorized" });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    auth.logout(request, response);
    json(response, 200, { authenticated: false });
    return true;
  }

  const parts = pathParts(url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, {
      ok: true,
      codexRuntime: config.codexPath ?? "sdk-bundled",
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/codex/usage") {
    json(response, 200, await codexAccount.getUsage(url.searchParams.get("refresh") === "1"));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    json(response, 200, { projects: store.listProjects(), projectRoots: config.projectRoots });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson<{ name?: unknown; path?: unknown; create?: unknown }>(request);
    const requestedPath = requireString(body.path, "path");
    const resolution = await resolveProjectPath(requestedPath, config.projectRoots);
    if (!resolution.exists && body.create !== true) {
      json(response, 409, {
        error: "Project directory does not exist",
        code: "PROJECT_NOT_FOUND",
        path: resolution.path,
        folder: resolution.folder,
      });
      return true;
    }
    const path = resolution.exists
      ? resolution.path
      : await createProjectDirectory(resolution.path, config.projectRoots);
    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : resolution.folder;
    const project = store.createProject({
      id: randomUUID(),
      name,
      path,
      createdAt: new Date().toISOString(),
    });
    json(response, 201, { project });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    json(response, 200, { sessions: store.listSessions(projectId) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson<{ projectId?: unknown }>(request);
    const projectId = requireString(body.projectId, "projectId");
    if (!store.getProject(projectId)) throw new HttpError(404, "Project not found");
    json(response, 201, { session: sessions.createSession(projectId) });
    return true;
  }

  if (parts[1] === "sessions" && parts[2]) {
    const sessionId = parts[2];
    const session = store.getSession(sessionId);
    if (!session) throw new HttpError(404, "Session not found");

    if (request.method === "GET" && parts.length === 3) {
      json(response, 200, { session });
      return true;
    }

    if (request.method === "DELETE" && parts.length === 3) {
      if (session.status === "running") {
        throw new HttpError(409, "Stop the running session before deleting it");
      }
      sessions.delete(sessionId);
      response.writeHead(204);
      response.end();
      return true;
    }

    if (request.method === "GET" && parts[3] === "events") {
      const afterParam =
        url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
      const after = Number.parseInt(Array.isArray(afterParam) ? afterParam[0] ?? "0" : afterParam, 10);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(": connected\n\n");
      for (const event of store.listEvents(sessionId, Number.isNaN(after) ? 0 : after)) {
        sendSse(response, event);
      }
      const unsubscribe = sessions.subscribe(sessionId, (event) => sendSse(response, event));
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return true;
    }

    if (request.method === "POST" && parts[3] === "turns") {
      const body = await readJson<{ prompt?: unknown }>(request);
      await sessions.startTurn(sessionId, requireString(body.prompt, "prompt"));
      json(response, 202, { accepted: true });
      return true;
    }

    if (request.method === "POST" && parts[3] === "interrupt") {
      json(response, 200, { interrupted: sessions.interrupt(sessionId) });
      return true;
    }

    if (request.method === "POST" && parts[3] === "stop") {
      json(response, 200, { session: sessions.stop(sessionId) });
      return true;
    }

    if (request.method === "POST" && parts[3] === "resume") {
      json(response, 200, { session: sessions.resume(sessionId) });
      return true;
    }
  }

  throw new HttpError(404, "API route not found");
}

function serveStatic(response: ServerResponse, pathname: string, headOnly = false): void {
  const requested = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, requested);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    json(response, 404, { error: "Not found" });
    return;
  }

  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
  });
  if (headOnly) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleApi(request, response, url)) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new HttpError(405, "Method not allowed");
    }
    if (auth.enabled && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!auth.authorized(request)) {
        redirect(response, "/login");
        return;
      }
    }
    if (url.pathname === "/login" || url.pathname === "/login.html") {
      if (auth.enabled && auth.authorized(request)) {
        redirect(response, "/");
        return;
      }
      serveStatic(response, "/login.html", request.method === "HEAD");
      return;
    }
    serveStatic(response, url.pathname, request.method === "HEAD");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) json(response, status, { error: message });
    else response.end();
    if (status >= 500) console.error(error);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Ronix Agent listening on http://${config.host}:${config.port}`);
  console.log(`Allowed project roots: ${config.projectRoots.join(", ")}`);
  console.log(`Codex runtime: ${config.codexPath ?? "SDK bundled binary"}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
