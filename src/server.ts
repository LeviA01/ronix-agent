import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerClient } from "./app-server-client.js";
import { AuthManager } from "./auth.js";
import { config as defaultConfig } from "./config.js";
import { HttpError, json, readJson, requireString } from "./http.js";
import { createProjectDirectory, resolveProjectPath } from "./project-path.js";
import { SessionManager } from "./session-manager.js";
import { Store } from "./store.js";
import type { CodexModel, SandboxMode, StoredEvent } from "./types.js";

type Config = typeof defaultConfig;

type Application = {
  server: Server;
  store: Store;
  sessions: SessionManager;
  shutdown(): Promise<void>;
};

type ApplicationOptions = {
  config?: Config;
  store?: Store;
  sessions?: SessionManager;
  auth?: AuthManager;
  publicDir?: string;
};

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export function createApplication(options: ApplicationOptions = {}): Application {
  const config = options.config ?? defaultConfig;
  const store = options.store ?? new Store(config.dataDir);
  const codex = new AppServerClient(config.codexPath);
  const sessions = options.sessions
    ?? new SessionManager(store, codex, config.eventRetention);
  const auth = options.auth ?? new AuthManager(
    config.authKey,
    config.authSessionDays * 24 * 60 * 60 * 1000,
    config.secureAuthCookie,
  );
  const publicDir = options.publicDir ?? join(process.cwd(), "public");
  const sockets = new Set<import("node:net").Socket>();
  let shuttingDown = false;
  let usageCache: { value: unknown; expiresAt: number } | null = null;
  let usagePending: Promise<unknown> | null = null;
  let modelCache: { value: CodexModel[]; expiresAt: number } | null = null;
  let modelPending: Promise<CodexModel[]> | null = null;

  async function getUsage(force: boolean): Promise<unknown> {
    if (!force && usageCache && usageCache.expiresAt > Date.now()) return usageCache.value;
    if (usagePending) return usagePending;
    usagePending = sessions.getUsage()
      .then((value) => {
        usageCache = { value, expiresAt: Date.now() + 30_000 };
        return value;
      })
      .finally(() => {
        usagePending = null;
      });
    return usagePending;
  }

  async function getModels(): Promise<CodexModel[]> {
    if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.value;
    if (modelPending) return modelPending;
    modelPending = sessions.listModels()
      .then((value) => {
        modelCache = { value, expiresAt: Date.now() + 60_000 };
        return value;
      })
      .finally(() => {
        modelPending = null;
      });
    return modelPending;
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
      validateOrigin(request, config.trustProxy);
      const body = await readJson<{ key?: unknown }>(request);
      const suppliedKey = typeof body.key === "string" ? body.key : "";
      const result = auth.login(response, suppliedKey, clientId(request, config.trustProxy));
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
    if (isChangingRequest(request)) validateOrigin(request, config.trustProxy);

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      auth.logout(request, response);
      json(response, 200, { authenticated: false });
      return true;
    }

    const parts = pathParts(url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, shuttingDown ? 503 : 200, {
        ok: !shuttingDown,
        codexRuntime: config.codexPath ?? "codex",
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/codex/usage") {
      json(response, 200, await getUsage(url.searchParams.get("refresh") === "1"));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/codex/models") {
      json(response, 200, { models: await getModels() });
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
      try {
        const project = store.createProject({
          id: randomUUID(),
          name,
          path,
          createdAt: new Date().toISOString(),
        });
        json(response, 201, { project });
      } catch (error) {
        if (isSqliteConstraint(error)) throw new HttpError(409, "Project is already registered");
        throw error;
      }
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      json(response, 200, { sessions: store.listSessions(projectId) });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson<{
        projectId?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      }>(request);
      const projectId = requireString(body.projectId, "projectId");
      if (!store.getProject(projectId)) throw new HttpError(404, "Project not found");
      const requestedModel = optionalString(body.model, "model");
      const requestedEffort = optionalString(body.reasoningEffort, "reasoningEffort");
      const modelSettings = requestedModel || requestedEffort
        ? resolveModelSettings(
            await getModels(),
            null,
            null,
            requestedModel,
            requestedEffort,
          )
        : {};
      json(response, 201, {
        session: sessions.createSession(projectId, modelSettings),
      });
      return true;
    }

    if (parts[1] === "sessions" && parts[2]) {
      const sessionId = parts[2];
      const session = store.getSession(sessionId);
      if (!session) throw new HttpError(404, "Session not found");

      if (request.method === "GET" && parts.length === 3) {
        json(response, 200, {
          session,
          approvals: sessions.listApprovals(sessionId),
        });
        return true;
      }

      if (request.method === "DELETE" && parts.length === 3) {
        if (session.status === "running" || session.activeTurnId) {
          throw new HttpError(409, "Stop the running session before deleting it");
        }
        sessions.delete(sessionId);
        response.writeHead(204);
        response.end();
        return true;
      }

      if (
        request.method === "GET"
        && parts[3] === "events"
        && parts[4] === "history"
      ) {
        const before = positiveInteger(url.searchParams.get("before"), Number.MAX_SAFE_INTEGER);
        const limit = boundedLimit(url.searchParams.get("limit"), config.eventHistoryLimit);
        const events = store.listEventsBefore(sessionId, before, limit);
        json(response, 200, { events, hasMore: events.length === limit });
        return true;
      }

      if (request.method === "GET" && parts[3] === "events") {
        const afterParam =
          url.searchParams.get("after") ?? request.headers["last-event-id"];
        const tail = boundedLimit(
          url.searchParams.get("tail"),
          config.eventHistoryLimit,
        );
        const after = positiveInteger(
          Array.isArray(afterParam) ? afterParam[0] : afterParam,
          0,
        );
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(": connected\n\n");

        const queued: StoredEvent[] = [];
        let replaying = true;
        const unsubscribe = sessions.subscribe(sessionId, (event) => {
          if (replaying) queued.push(event);
          else sendSse(response, event);
        });
        const replay = after > 0
          ? store.listEvents(sessionId, after)
          : store.listRecentEvents(sessionId, tail);
        let lastSent = after;
        for (const event of replay) {
          sendSse(response, event);
          lastSent = event.sequence;
        }
        replaying = false;
        for (const event of queued) {
          if (event.sequence > lastSent) sendSse(response, event);
        }

        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return true;
      }

      if (request.method === "POST" && parts[3] === "turns") {
        const body = await readJson<{ prompt?: unknown }>(request);
        try {
          await sessions.startTurn(sessionId, requireString(body.prompt, "prompt"));
        } catch (error) {
          throw sessionHttpError(error);
        }
        json(response, 202, { accepted: true });
        return true;
      }

      if (request.method === "POST" && parts[3] === "interrupt") {
        json(response, 200, { interrupted: await sessions.interrupt(sessionId) });
        return true;
      }

      if (request.method === "POST" && parts[3] === "stop") {
        json(response, 200, { session: await sessions.stop(sessionId) });
        return true;
      }

      if (request.method === "POST" && parts[3] === "resume") {
        json(response, 200, { session: sessions.resume(sessionId) });
        return true;
      }

      if (request.method === "POST" && parts[3] === "settings") {
        const body = await readJson<{
          sandboxMode?: unknown;
          model?: unknown;
          reasoningEffort?: unknown;
        }>(request);
        const update: {
          sandboxMode?: SandboxMode;
          model?: string;
          reasoningEffort?: string;
        } = {};
        if (body.sandboxMode !== undefined) {
          if (
            typeof body.sandboxMode !== "string"
            || !SANDBOX_MODES.has(body.sandboxMode as SandboxMode)
          ) {
            throw new HttpError(400, "Invalid sandboxMode");
          }
          update.sandboxMode = body.sandboxMode as SandboxMode;
        }
        const requestedModel = optionalString(body.model, "model");
        const requestedEffort = optionalString(body.reasoningEffort, "reasoningEffort");
        if (requestedModel || requestedEffort) {
          Object.assign(
            update,
            resolveModelSettings(
              await getModels(),
              session.model,
              session.reasoningEffort,
              requestedModel,
              requestedEffort,
            ),
          );
        }
        if (Object.keys(update).length === 0) {
          throw new HttpError(400, "No session settings were provided");
        }
        try {
          json(response, 200, {
            session: sessions.updateSettings(sessionId, update),
          });
        } catch (error) {
          throw sessionHttpError(error);
        }
        return true;
      }

      if (
        request.method === "POST"
        && parts[3] === "approvals"
        && parts[4]
      ) {
        const body = await readJson<{ decision?: unknown }>(request);
        const decision = requireString(body.decision, "decision");
        try {
          sessions.respondToApproval(sessionId, parts[4], decision);
        } catch (error) {
          throw sessionHttpError(error);
        }
        json(response, 200, { resolved: true });
        return true;
      }
    }

    throw new HttpError(404, "API route not found");
  }

  function serveStatic(response: ServerResponse, pathname: string, headOnly = false): void {
    const requested = pathname === "/"
      ? "index.html"
      : normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
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
    if (headOnly) response.end();
    else createReadStream(filePath).pipe(response);
  }

  const server = createServer(async (request, response) => {
    applySecurityHeaders(response);
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
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const closeServer = new Promise<void>((resolve) => server.close(() => resolve()));
    const forceTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, config.shutdownTimeoutMs);
    await Promise.allSettled([sessions.shutdown(), closeServer]);
    clearTimeout(forceTimer);
    store.close();
  }

  return { server, store, sessions, shutdown };
}

function clientId(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const address = value?.split(",", 1)[0]?.trim();
    if (address) return address;
  }
  return request.socket.remoteAddress || "unknown";
}

function validateOrigin(request: IncomingMessage, trustProxy: boolean): void {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "Invalid request origin");
  }
  const forwardedProto = trustProxy ? request.headers["x-forwarded-proto"] : undefined;
  const protoValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const expectedProtocol = protoValue?.split(",", 1)[0]?.trim() || "http";
  const expectedHost = request.headers.host;
  if (!expectedHost || parsed.host !== expectedHost || parsed.protocol !== `${expectedProtocol}:`) {
    throw new HttpError(403, "Request origin is not allowed");
  }
}

function isChangingRequest(request: IncomingMessage): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
      + "object-src 'none'; form-action 'self'; connect-src 'self'; "
      + "img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
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

function positiveInteger(value: string | undefined | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedLimit(value: string | null, fallback: number): number {
  return Math.min(500, Math.max(1, positiveInteger(value, fallback)));
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function resolveModelSettings(
  models: CodexModel[],
  currentModel: string | null,
  currentEffort: string | null,
  requestedModel?: string,
  requestedEffort?: string,
): { model: string; reasoningEffort: string } {
  if (models.length === 0) throw new HttpError(503, "Codex returned no available models");
  const modelName = requestedModel ?? currentModel;
  const selected = modelName
    ? models.find((model) => model.model === modelName || model.id === modelName)
    : models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new HttpError(400, `Model is not available: ${modelName}`);

  const effort = requestedEffort
    ?? (requestedModel && requestedModel !== currentModel ? null : currentEffort)
    ?? selected.defaultReasoningEffort;
  if (
    !selected.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === effort,
    )
  ) {
    throw new HttpError(
      400,
      `Reasoning effort ${effort} is not supported by ${selected.displayName}`,
    );
  }
  return { model: selected.model, reasoningEffort: effort };
}

function sessionHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return new HttpError(404, message);
  if (/already running|active turn|while a turn|stopped|approval/i.test(message)) {
    return new HttpError(409, message);
  }
  return new HttpError(502, message);
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && /constraint/i.test(error.message);
}

async function main(): Promise<void> {
  const app = createApplication();
  app.server.once("error", (error) => {
    console.error(error);
    void app.shutdown().finally(() => process.exit(1));
  });
  app.server.listen(defaultConfig.port, defaultConfig.host, () => {
    console.log(`Ronix Agent listening on http://${defaultConfig.host}:${defaultConfig.port}`);
    console.log(`Allowed project roots: ${defaultConfig.projectRoots.join(", ")}`);
    console.log(`Codex runtime: ${defaultConfig.codexPath ?? "codex from PATH"}`);
  });
  const shutdown = () => {
    void app.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) void main();
