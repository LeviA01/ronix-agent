import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AccessStore, proxyIdentity, USER_MODULES, type AccessUser } from "./access.js";
import { config } from "./config.js";
import { HttpError, json, readJson } from "./http.js";
import { startUserRuntime, type RuntimeConfig, type UserRuntime } from "./user-runtime.js";

export type MultiUserOptions = {
  accessDirectory: string;
  proxySecret: string;
  trustedAddresses: string[];
  adminSubjects: string[];
  createRuntime(user: AccessUser): Promise<UserRuntime>;
};

export function createMultiUserServer(options: MultiUserOptions) {
  if (options.proxySecret.length < 32) throw new Error("RONIX_PROXY_SECRET must contain at least 32 characters");
  if (!options.adminSubjects.length) throw new Error("RONIX_ADMIN_SUBJECTS must name an explicit Authentik user ID");
  const access = new AccessStore(options.accessDirectory, options.adminSubjects);
  const runtimes = new Map<string, { revision: number; promise: Promise<UserRuntime> }>();
  const responses = new Map<string, Set<ServerResponse>>();
  const stopping = new Map<string, Promise<void>>();
  let closing = false;

  function stopUser(id: string): Promise<void> {
    const pending = stopping.get(id);
    if (pending) return pending;
    const entry = runtimes.get(id);
    runtimes.delete(id);
    for (const response of responses.get(id) ?? []) response.destroy();
    responses.delete(id);
    const done = (entry ? entry.promise.then(runtime => runtime.stop(), () => {}) : Promise.resolve())
      .finally(() => stopping.delete(id));
    stopping.set(id, done);
    return done;
  }
  async function runtimeFor(user: AccessUser) {
    await stopping.get(user.id);
    let entry = runtimes.get(user.id);
    if (entry && entry.revision !== user.revision) { await stopUser(user.id); entry = undefined; }
    if (!entry) {
      const promise = options.createRuntime(user);
      entry = { revision: user.revision, promise };
      runtimes.set(user.id, entry);
      void promise.catch(() => { if (runtimes.get(user.id)?.promise === promise) runtimes.delete(user.id); });
    }
    return entry.promise;
  }
  const server = createServer(async (request, response) => {
    try {
      if (closing) throw new HttpError(503, "Сервер завершает работу");
      const identity = proxyIdentity(request, options.proxySecret, options.trustedAddresses);
      const user = access.identify(identity);
      if (user.disabled) throw new HttpError(403, "Учётная запись отключена администратором");
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) {
        const origin = request.headers.origin;
        if (!origin || new URL(origin).host !== request.headers.host
          || new URL(origin).protocol !== "https:") throw new HttpError(403, "Недопустимый источник запроса");
      }
      if (url.pathname === "/api/auth/status" || url.pathname === "/api/me") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
        json(response, 200, { enabled: true, authenticated: true, user, modules: USER_MODULES,
          logoutUrl: "/outpost.goauthentik.io/sign_out" });
        return;
      }
      if (url.pathname.startsWith("/api/admin/")) {
        if (user.role !== "admin") throw new HttpError(403, "Требуются права администратора");
        if (url.pathname === "/api/admin/users" && request.method === "GET") {
          json(response, 200, { users: access.list(), modules: USER_MODULES }); return;
        }
        const match = /^\/api\/admin\/users\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
        if (match && request.method === "PATCH") {
          const body = await readJson<{ role?: unknown; disabled?: unknown; modules?: unknown; chatModel?: unknown }>(request);
          const updated = access.update(match[1]!, body);
          await stopUser(updated.id);
          json(response, 200, { user: updated }); return;
        }
        throw new HttpError(404, "API route not found");
      }
      if (url.pathname === "/admin" || url.pathname === "/admin.js" || url.pathname === "/access.css") {
        if (user.role !== "admin") throw new HttpError(403, "Требуются права администратора");
        const filename = url.pathname === "/admin" ? "admin.html" : url.pathname.slice(1);
        const type = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html";
        response.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        response.end(readFileSync(join(process.cwd(), "public", filename))); return;
      }
      if (!user.modules.some(module => module !== "outline")) {
        if (url.pathname.startsWith("/api/")) throw new HttpError(403, "Дождитесь выдачи доступа к модулям");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Ronix — доступ</title><body><h1>Доступ ещё не выдан</h1><p>Аккаунт создан. Администратор может включить для вас чат и обучение.</p>'
          + (user.role === "admin" ? '<p><a href="/admin">Управление пользователями</a></p>' : "")
          + '<p><a href="/outpost.goauthentik.io/sign_out">Выйти</a></p></body></html>'); return;
      }
      const runtime = await runtimeFor(user);
      // Permissions may change while the sandbox is starting.
      const current = access.get(user.id);
      if (current.disabled || current.revision !== user.revision) throw new HttpError(403, "Права изменились. Обновите страницу");
      if (url.pathname === "/api/codex/usage" && user.role !== "admin") throw new HttpError(403, "Требуются права администратора");
      const open = responses.get(user.id) ?? new Set<ServerResponse>();
      open.add(response); responses.set(user.id, open);
      response.once("close", () => open.delete(response));
      const headers = { ...request.headers };
      for (const key of Object.keys(headers)) {
        if (key.startsWith("x-authentik-") || key === "x-ronix-proxy-secret" || key === "authorization" || key === "cookie") delete headers[key];
      }
      headers["x-forwarded-proto"] = "https";
      const upstream = httpRequest({ socketPath: runtime.socket, path: request.url, method: request.method, headers }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) json(response, 502, { error: "Пользовательское окружение недоступно. Повторите запрос" });
        else response.destroy();
        if (runtimes.get(user.id)?.revision === user.revision) void stopUser(user.id);
      });
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent) json(response, status, { error: status >= 500 ? "Не удалось запустить пользовательское окружение" : (error as Error).message });
      else response.destroy();
      if (status >= 500) console.error(error);
    }
  });
  async function shutdown() {
    closing = true;
    const stopped = new Promise<void>(done => server.close(() => done()));
    await Promise.all([...runtimes.keys()].map(stopUser));
    server.closeAllConnections();
    await stopped;
    access.close();
  }
  return { server, access, shutdown };
}

export async function startMultiUserServer(): Promise<void> {
  const list = (value: string | undefined) => (value ?? "").split(",").map(x => x.trim()).filter(Boolean);
  const runtime: RuntimeConfig = {
    root: resolve(process.env.RONIX_USERS_DIR ?? join(config.dataDir, "users")),
    appRoot: process.cwd(), codexPath: config.codexPath ?? "/usr/bin/codex",
    authFile: process.env.RONIX_SHARED_AUTH_FILE ?? join(process.env.HOME ?? "", ".codex/auth.json"),
    ...(process.env.RONIX_OUTLINE_CONFIG ? { outlineConfig: readFileSync(process.env.RONIX_OUTLINE_CONFIG, "utf8") } : {}),
    ...(process.env.OUTLINE_API_KEY ? { outlineApiKey: process.env.OUTLINE_API_KEY } : {}),
    ...(process.env.RONIX_OWNER_SUBJECT ? { owner: {
      subject: process.env.RONIX_OWNER_SUBJECT,
      projectRoots: config.projectRoots,
      codexHomeAlias: process.env.RONIX_OWNER_CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"),
    } } : {}),
  };
  const app = createMultiUserServer({
    accessDirectory: resolve(process.env.RONIX_ACCESS_DIR ?? join(config.dataDir, "access")),
    proxySecret: process.env.RONIX_PROXY_SECRET ?? "",
    trustedAddresses: list(process.env.RONIX_TRUSTED_PROXIES ?? "127.0.0.1,::1"),
    adminSubjects: list(process.env.RONIX_ADMIN_SUBJECTS),
    createRuntime: user => startUserRuntime(user, runtime),
  });
  app.server.listen(config.port, config.host, () => console.log(`Ronix multi-user gateway listening on ${config.host}:${config.port}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.shutdown().finally(() => process.exit(0)));
}
