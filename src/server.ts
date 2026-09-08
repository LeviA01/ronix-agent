import { readLearningFile, roadmapSummary as summarizeFileRoadmap } from "./learning-files.js";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
import { requireModule, type UserAccess, type UserModule } from "./access.js";
import { config as defaultConfig } from "./config.js";
import { HttpError, json, readJson, requireString } from "./http.js";
import { GitActionError, isGitAction, readGitStatus, runGitAction } from "./git-status.js";
import { moduleStatuses } from "./modules.js";
import { createProjectDirectory, resolveProjectPath } from "./project-path.js";
import { SessionManager } from "./session-manager.js";
import { MemoryService } from "./memory-service.js";
import { Store } from "./store.js";
import {
  buildMaterialGenerationPrompt,
  buildMaterialRepairPrompt,
  deleteTheoryMaterial,
  ensureTheoryMaterialsDirectory,
  listTheoryMaterials,
  loadTheoryMaterial,
  scoreTheoryMaterial,
  TheoryMaterialError,
  THEORY_MATERIAL_BLOCK_COUNTS,
  validateGeneratedTheoryMaterial,
  type TheoryMaterialSize,
  type TheoryMaterialTopicMode,
} from "./theory-materials.js";
import type {
  ChatIntent,
  CodexModel,
  LearningObservation as StoredLearningObservation,
  LearningRoadmapItem as StoredLearningRoadmapItem,
  LearningTopic as StoredLearningTopic,
  MemoryKind,
  MemoryScopeType,
  Project,
  ProjectKind,
  SandboxMode,
  Session,
  SessionPurpose,
  StoredEvent,
} from "./types.js";

type Config = typeof defaultConfig;

type Application = {
  server: Server;
  store: Store;
  sessions: SessionManager;
  memory: MemoryService;
  shutdown(): Promise<void>;
};

export type ApplicationOptions = {
  config?: Config;
  store?: Store;
  sessions?: SessionManager;
  auth?: AuthManager;
  publicDir?: string;
  access?: UserAccess;
};

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const PROJECT_KINDS = new Set<ProjectKind>(["dev", "learning"]);
const CHAT_INTENTS = new Set<ChatIntent>(["ask", "act"]);
const MEMORY_SCOPES = new Set<MemoryScopeType>(["global", "chat", "project", "learning"]);
const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "decision", "task", "summary"]);
const MAX_MATERIAL_REPAIR_ATTEMPTS = 2;

export function createApplication(options: ApplicationOptions = {}): Application {
  const config = options.config ?? defaultConfig;
  const store = options.store ?? new Store(config.dataDir);
  const memory = new MemoryService(store);
  const chatWorkspace = join(config.dataDir, "chat-workspace");
  mkdirSync(chatWorkspace, { recursive: true });
  const codex = new AppServerClient(config.codexPath, { dataDir: config.dataDir });
  const sessions = options.sessions
    ?? new SessionManager(store, codex, config.eventRetention, memory, chatWorkspace);
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
  const generatingMaterials = new Set<string>();
  const allowed = (module: UserModule) => !options.access || options.access.modules.includes(module);
  const projectModule = (kind: string): UserModule => kind === "learning" ? "learning" : "development";
  const sessionModule = (purpose: SessionPurpose): UserModule => purpose === "chat" ? "chat"
    : purpose === "general" ? "development" : "learning";

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

  function ensureLearningSessions(projectId: string): LearningSessions {
    return {
      course: sessions.ensurePurposeSession(projectId, "course"),
      theory: sessions.ensurePurposeSession(projectId, "theory"),
      practice: sessions.ensurePurposeSession(projectId, "practice"),
      materials: sessions.ensurePurposeSession(projectId, "materials"),
    };
  }

  function monitorMaterialGeneration(input: {
    project: Project;
    materialId: string;
    sessionId: string;
    onDone(): void;
  }): () => void {
    let finished = false;
    let repairAttempts = 0;
    let repairStarting = false;
    let unsubscribe = () => {};
    const finish = (type: string, payload: unknown) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      input.onDone();
      sessions.emit(input.sessionId, type, payload);
    };
    const repair = async (validationError: string) => {
      if (finished || repairStarting) return;
      if (repairAttempts >= MAX_MATERIAL_REPAIR_ATTEMPTS) {
        finish("material.generation.failed", {
          materialId: input.materialId,
          message: `Codex не исправил материал после ${MAX_MATERIAL_REPAIR_ATTEMPTS} попыток: ${validationError}`,
          validationError,
        });
        return;
      }
      repairAttempts += 1;
      repairStarting = true;
      sessions.emit(input.sessionId, "material.generation.repairing", {
        materialId: input.materialId,
        attempt: repairAttempts,
        maximumAttempts: MAX_MATERIAL_REPAIR_ATTEMPTS,
        message: validationError,
      });
      try {
        await sessions.startTurn(input.sessionId, buildMaterialRepairPrompt({
          materialId: input.materialId,
          validationError,
          attempt: repairAttempts,
          maximumAttempts: MAX_MATERIAL_REPAIR_ATTEMPTS,
        }));
      } catch (error) {
        finish("material.generation.failed", {
          materialId: input.materialId,
          message: error instanceof Error ? error.message : String(error),
          validationError,
        });
      } finally {
        repairStarting = false;
      }
    };
    unsubscribe = sessions.subscribe(input.sessionId, (event) => {
      if (event.type === "session.ready") {
        try {
          const loaded = loadTheoryMaterial(input.project.path, input.materialId);
          validateGeneratedTheoryMaterial(loaded.material);
          finish("material.generation.completed", {
            materialId: input.materialId,
            revision: loaded.revision,
          });
        } catch (error) {
          void repair(error instanceof Error ? error.message : String(error));
        }
      } else if (event.type === "session.error" || event.type === "turn.interrupted") {
        const payload = event.payload && typeof event.payload === "object"
          ? event.payload as Record<string, unknown>
          : {};
        finish("material.generation.failed", {
          materialId: input.materialId,
          message: typeof payload.message === "string"
            ? payload.message
            : event.type === "turn.interrupted"
              ? "Создание материала остановлено"
              : "Codex не завершил создание материала",
        });
      }
    });
    return () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      input.onDone();
    };
  }

  function hasActiveProjectSessions(projectId: string): boolean {
    return store.listSessions(projectId).some((session) =>
      session.status === "running" || Boolean(session.activeTurnId)
    );
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
    if (parts[1] === "chats") requireModule(options.access, "chat");
    if (parts[1] === "memory") requireModule(options.access, "development");
    if (parts[1] === "projects" && parts[2]) {
      const project = store.getProject(parts[2]);
      if (project) requireModule(options.access, projectModule(project.kind));
      if (parts[3] === "learning") requireModule(options.access, "learning");
      if (parts[3] === "git") requireModule(options.access, "development");
    }
    if (parts[1] === "sessions" && parts[2]) {
      const session = store.getSession(parts[2]);
      if (session) requireModule(options.access, sessionModule(session.purpose));
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, shuttingDown ? 503 : 200, {
        ok: !shuttingDown,
        codexRuntime: config.codexPath ?? "codex",
        deploymentMode: config.deploymentMode,
        accessMode: config.accessMode,
        modules: moduleStatuses(config.modules),
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/modules") {
      json(response, 200, { modules: moduleStatuses(config.modules) });
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
      json(response, 200, {
        projects: store.listProjects().filter(project => allowed(projectModule(project.kind))),
        projectRoots: allowed("development") || allowed("learning") ? config.projectRoots : [],
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/chats") {
      json(response, 200, {
        chats: store.listChatSessions().map((session) => ({
          ...session,
          projectIds: store.listChatProjectIds(session.id),
        })),
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/chats") {
      const body = await readJson<{
        title?: unknown;
        projectIds?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      }>(request);
      const projectIds = projectIdList(body.projectIds, store);
      for (const id of projectIds) requireModule(options.access, projectModule(store.getProject(id)!.kind));
      const requestedModel = optionalString(body.model, "model");
      const requestedEffort = optionalString(body.reasoningEffort, "reasoningEffort");
      const modelSettings = requestedModel || requestedEffort
        ? resolveModelSettings(await getModels(), null, null, requestedModel, requestedEffort)
        : {};
      let chat = sessions.createSession(null, modelSettings, "chat");
      if (body.title !== undefined) {
        chat = store.updateSession(chat.id, { title: boundedText(body.title, "title", 120) });
      }
      store.replaceChatProjects(chat.id, projectIds);
      json(response, 201, { chat: { ...chat, projectIds } });
      return true;
    }

    if (parts[1] === "chats" && parts[2] && parts.length === 3 && request.method === "PATCH") {
      const chat = store.getSession(parts[2]);
      if (!chat || chat.purpose !== "chat") throw new HttpError(404, "Chat not found");
      if (chat.status === "running" || chat.activeTurnId) {
        throw new HttpError(409, "Wait for the active chat turn to finish");
      }
      const body = await readJson<{ title?: unknown; projectIds?: unknown }>(request);
      let updated = chat;
      if (body.title !== undefined) {
        updated = store.updateSession(chat.id, { title: boundedText(body.title, "title", 120) });
      }
      const projectIds = body.projectIds === undefined
        ? store.listChatProjectIds(chat.id)
        : projectIdList(body.projectIds, store);
      for (const id of projectIds) requireModule(options.access, projectModule(store.getProject(id)!.kind));
      if (body.projectIds !== undefined) store.replaceChatProjects(chat.id, projectIds);
      json(response, 200, { chat: { ...updated, projectIds } });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/memory") {
      const scopeType = optionalEnum(url.searchParams.get("scopeType"), MEMORY_SCOPES, "scopeType");
      const kind = optionalEnum(url.searchParams.get("kind"), MEMORY_KINDS, "kind");
      const scopeId = url.searchParams.has("scopeId") ? url.searchParams.get("scopeId") : undefined;
      const limit = boundedLimit(url.searchParams.get("limit"), 50);
      const offset = positiveInteger(url.searchParams.get("offset"), 0);
      try {
        json(response, 200, memory.search({
          ...(url.searchParams.get("query") ? { query: url.searchParams.get("query") ?? "" } : {}),
          ...(scopeType ? { scopeType } : {}),
          ...(scopeId !== undefined ? { scopeId: scopeId || null } : {}),
          ...(kind ? { kind } : {}),
          limit,
          offset,
        }));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid memory query");
      }
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/memory") {
      const body = await readJson<{
        scopeType?: unknown;
        scopeId?: unknown;
        kind?: unknown;
        content?: unknown;
        confidence?: unknown;
      }>(request);
      const scopeType = requiredEnum(body.scopeType, MEMORY_SCOPES, "scopeType");
      const scopeId = body.scopeId === undefined || body.scopeId === null || body.scopeId === ""
        ? null
        : requireString(body.scopeId, "scopeId");
      try {
        json(response, 201, {
          memory: memory.remember({
            scopeType,
            scopeId,
            kind: requiredEnum(body.kind, MEMORY_KINDS, "kind"),
            content: boundedText(body.content, "content", 8_000),
            confidence: body.confidence === undefined
              ? 1
              : boundedNumber(body.confidence, "confidence", 0, 1),
          }),
        });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Memory creation failed");
      }
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/memory/export") {
      response.setHeader("content-disposition", "attachment; filename=ronix-memory.json");
      json(response, 200, createMemorySnapshot(store));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/memory/import") {
      const body = await readJson<{ snapshot?: unknown; confirmed?: unknown }>(request);
      const preview = previewMemorySnapshot(body.snapshot, store);
      if (body.confirmed !== true) {
        json(response, 200, { preview });
        return true;
      }
      json(response, 200, {
        preview,
        result: importMemorySnapshot(body.snapshot, store, sessions, memory),
      });
      return true;
    }

    if (parts[1] === "memory" && parts[2] && parts.length === 3 && request.method === "PATCH") {
      const body = await readJson<{ content?: unknown; kind?: unknown; confidence?: unknown }>(request);
      const current = store.getMemory(parts[2]);
      if (!current) throw new HttpError(404, "Memory item not found");
      const kind = body.kind === undefined
        ? current.kind
        : requiredEnum(body.kind, MEMORY_KINDS, "kind");
      const confidence = body.confidence === undefined
        ? current.confidence
        : boundedNumber(body.confidence, "confidence", 0, 1);
      try {
        json(response, 200, {
          memory: memory.correct(current.id, {
            content: boundedText(body.content, "content", 8_000),
            kind,
            confidence,
          }),
        });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Memory update failed");
      }
      return true;
    }

    if (parts[1] === "memory" && parts[2] && parts.length === 3 && request.method === "DELETE") {
      if (!store.getMemory(parts[2])) throw new HttpError(404, "Memory item not found");
      memory.forget(parts[2]);
      response.writeHead(204);
      response.end();
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJson<{
        name?: unknown;
        path?: unknown;
        create?: unknown;
        kind?: unknown;
      }>(request);
      const requestedPath = requireString(body.path, "path");
      const kind = projectKind(body.kind);
      requireModule(options.access, projectModule(kind));
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
          kind,
          createdAt: new Date().toISOString(),
        });
        if (project.kind === "learning") {
          ensureLearningWorkspace(project.path);
          ensureLearningSessions(project.id);
        }
        json(response, 201, { project });
      } catch (error) {
        if (isSqliteConstraint(error)) throw new HttpError(409, "Project is already registered");
        throw error;
      }
      return true;
    }

    if (
      request.method === "PATCH"
      && parts.length === 3
      && parts[1] === "projects"
      && parts[2]
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (hasActiveProjectSessions(project.id)) {
        throw new HttpError(409, "Stop active project sessions before editing the project");
      }
      const body = await readJson<{
        name?: unknown;
        path?: unknown;
        kind?: unknown;
      }>(request);
      const update: {
        name?: string;
        path?: string;
        kind?: ProjectKind;
      } = {};
      if (body.name !== undefined) {
        update.name = requireString(body.name, "name").trim();
      }
      if (body.path !== undefined) {
        const resolution = await resolveProjectPath(requireString(body.path, "path"), config.projectRoots);
        if (!resolution.exists) {
          json(response, 409, {
            error: "Project directory does not exist",
            code: "PROJECT_NOT_FOUND",
            path: resolution.path,
            folder: resolution.folder,
          });
          return true;
        }
        update.path = resolution.path;
      }
      if (body.kind !== undefined) {
        update.kind = projectKind(body.kind);
        requireModule(options.access, projectModule(update.kind));
      }
      if (Object.keys(update).length === 0) {
        throw new HttpError(400, "No project fields were provided");
      }
      try {
        const updated = store.updateProject(project.id, update);
        if (project.kind !== "learning" && updated.kind === "learning") {
          ensureLearningWorkspace(updated.path);
          ensureLearningSessions(updated.id);
        }
        json(response, 200, { project: updated });
      } catch (error) {
        if (isSqliteConstraint(error)) throw new HttpError(409, "Project path is already registered");
        throw error;
      }
      return true;
    }

    if (
      request.method === "DELETE"
      && parts.length === 3
      && parts[1] === "projects"
      && parts[2]
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (hasActiveProjectSessions(project.id)) {
        throw new HttpError(409, "Stop active project sessions before removing the project");
      }
      store.deleteProject(project.id);
      response.writeHead(204);
      response.end();
      return true;
    }

    if (
      request.method === "POST"
      && parts[1] === "projects"
      && parts[2]
      && parts[3] === "learning"
      && parts[4] === "enable"
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (project.kind !== "learning" && hasActiveProjectSessions(project.id)) {
        throw new HttpError(409, "Stop active project sessions before enabling learning mode");
      }
      ensureLearningWorkspace(project.path);
      const updated = project.kind === "learning"
        ? project
        : store.updateProjectKind(project.id, "learning");
      json(response, 200, {
        project: updated,
        learning: readLearningWorkspace(updated, ensureLearningSessions(updated.id)),
      });
      return true;
    }

    if (
      request.method === "POST"
      && parts.length === 5
      && parts[1] === "projects"
      && parts[2]
      && parts[3] === "learning"
      && parts[4] === "migrate"
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (project.kind !== "learning") throw new HttpError(409, "Project is not in learning mode");
      throw new HttpError(410, "Дневник и Roadmap хранятся в файлах learning; импорт в базу отключён");
    }

    if (
      request.method === "GET"
      && parts.length === 5
      && parts[1] === "projects"
      && parts[2]
      && parts[3] === "git"
      && parts[4] === "status"
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      json(response, 200, await readGitStatus(project.path));
      return true;
    }

    if (
      request.method === "POST"
      && parts.length === 5
      && parts[1] === "projects"
      && parts[2]
      && parts[3] === "git"
    ) {
      const action = parts[4];
      if (!action || !isGitAction(action)) throw new HttpError(400, "Unknown Git action");
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      try {
        json(response, 200, await runGitAction(project.path, action));
      } catch (error) {
        if (error instanceof GitActionError) {
          json(response, 409, { error: error.message, output: error.output });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (
      parts[1] === "projects"
      && parts[2]
      && parts[3] === "learning"
      && parts[4] === "materials"
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (project.kind !== "learning") throw new HttpError(409, "Project is not in learning mode");

      if (request.method === "GET" && parts.length === 5) {
        const library = listTheoryMaterials(project.path, (materialId, revision) =>
          store.getTheoryMaterialAttempt(project.id, materialId, revision)
        );
        json(response, 200, {
          ...library,
          generationSession: ensureLearningSessions(project.id).materials,
        });
        return true;
      }

      if (request.method === "POST" && parts[5] === "generate" && parts.length === 6) {
        const body = await readJson<{
          topicMode?: unknown;
          topic?: unknown;
          size?: unknown;
          notes?: unknown;
        }>(request);
        const topicMode = materialTopicMode(body.topicMode);
        const topic = topicMode === "manual" ? boundedText(body.topic, "topic", 160) : undefined;
        const notes = body.notes === undefined ? undefined : boundedText(body.notes, "notes", 1_000, true);
        const size = materialSize(body.size);
        if (generatingMaterials.has(project.id)) {
          throw new HttpError(409, "Для проекта уже создаётся материал");
        }
        const learningSessions = ensureLearningSessions(project.id);
        const generationSession = learningSessions.materials;
        if (generationSession.status === "running" || generationSession.activeTurnId) {
          throw new HttpError(409, "Для проекта уже создаётся материал");
        }
        if (generationSession.status === "stopped") sessions.resume(generationSession.id);
        sessions.updateSettings(generationSession.id, {
          sandboxMode: "workspace-write",
          model: learningSessions.theory.model,
          reasoningEffort: learningSessions.theory.reasoningEffort,
        });
        ensureTheoryMaterialsDirectory(project.path);
        const materialId = randomUUID();
        const existingTopics = topicMode === "auto"
          ? listTheoryMaterials(project.path, () => null).materials.map((material) => material.topic)
          : [];
        const prompt = buildMaterialGenerationPrompt({
          materialId,
          topicMode,
          ...(topic ? { topic } : {}),
          size,
          ...(notes ? { notes } : {}),
          ...(existingTopics.length ? { existingTopics } : {}),
        });
        generatingMaterials.add(project.id);
        const unsubscribe = monitorMaterialGeneration({
          project,
          materialId,
          sessionId: generationSession.id,
          onDone: () => generatingMaterials.delete(project.id),
        });
        try {
          await sessions.startTurn(generationSession.id, prompt);
        } catch (error) {
          unsubscribe();
          generatingMaterials.delete(project.id);
          throw sessionHttpError(error);
        }
        json(response, 202, { materialId, sessionId: generationSession.id });
        return true;
      }

      const materialId = parts[5];
      if (materialId && request.method === "GET" && parts.length === 6) {
        try {
          const loaded = loadTheoryMaterial(project.path, materialId);
          const lastAttempt = store.getTheoryMaterialAttempt(project.id, materialId, loaded.revision);
          json(response, 200, {
            material: loaded.material,
            revision: loaded.revision,
            lastAttempt,
            lastResult: lastAttempt
              ? scoreTheoryMaterial(loaded.material, lastAttempt.answersByBlock)
              : null,
          });
        } catch (error) {
          throw materialHttpError(error);
        }
        return true;
      }

      if (materialId && request.method === "POST" && parts[6] === "attempt" && parts.length === 7) {
        const body = await readJson<{ revision?: unknown; answersByBlock?: unknown }>(request);
        const revision = boundedText(body.revision, "revision", 64);
        let loaded;
        try {
          loaded = loadTheoryMaterial(project.path, materialId);
        } catch (error) {
          throw materialHttpError(error);
        }
        if (revision !== loaded.revision) {
          throw new HttpError(409, "Материал изменился. Откройте актуальную версию и пройдите её заново.");
        }
        try {
          const score = scoreTheoryMaterial(loaded.material, body.answersByBlock);
          const completedAt = new Date().toISOString();
          store.saveTheoryMaterialAttempt({
            projectId: project.id,
            materialId,
            revision,
            answersByBlock: body.answersByBlock as Record<string, unknown>,
            correct: score.correct,
            total: score.total,
            completedAt,
          });
          json(response, 200, { ...score, completedAt });
        } catch (error) {
          throw materialHttpError(error);
        }
        return true;
      }

      if (materialId && request.method === "DELETE" && parts.length === 6) {
        try {
          if (!deleteTheoryMaterial(project.path, materialId)) {
            throw new HttpError(404, "Материал не найден");
          }
          store.deleteTheoryMaterialAttempts(project.id, materialId);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw materialHttpError(error);
        }
        response.writeHead(204);
        response.end();
        return true;
      }
    }

    if (
      request.method === "GET"
      && parts.length === 4
      && parts[1] === "projects"
      && parts[2]
      && parts[3] === "learning"
    ) {
      const project = store.getProject(parts[2]);
      if (!project) throw new HttpError(404, "Project not found");
      if (project.kind === "learning") ensureLearningWorkspace(project.path);
      const purposeSessions = project.kind === "learning"
        ? ensureLearningSessions(project.id)
        : undefined;
      json(response, 200, readLearningWorkspace(project, purposeSessions));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      json(response, 200, { sessions: store.listSessions(projectId).filter(session => allowed(sessionModule(session.purpose))) });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      requireModule(options.access, "development");
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
          lastSequence: store.latestEventSequence(sessionId),
        });
        return true;
      }

      if (request.method === "GET" && parts[3] === "messages" && parts.length === 4) {
        const limit = boundedLimit(url.searchParams.get("limit"), 200);
        const before = url.searchParams.get("before") ?? undefined;
        json(response, 200, {
          messages: store.listMessages(sessionId, limit, before),
          lastSequence: store.latestEventSequence(sessionId),
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
        const events = store.listEventsBefore(sessionId, before, limit + 1);
        json(response, 200, { events: events.slice(-limit), hasMore: events.length > limit });
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
        const replay = afterParam !== undefined && afterParam !== null
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
        const body = await readJson<{
          prompt?: unknown;
          intent?: unknown;
          actionProjectId?: unknown;
        }>(request);
        const intent = session.purpose === "chat"
          ? body.intent === undefined ? "ask" : requiredEnum(body.intent, CHAT_INTENTS, "intent")
          : undefined;
        const actionProjectId = body.actionProjectId === undefined
          ? null
          : requireString(body.actionProjectId, "actionProjectId");
        if (intent === "act") requireModule(options.access, "development");
        try {
          await sessions.startTurn(sessionId, requireString(body.prompt, "prompt"), {
            ...(intent ? { intent } : {}),
            ...(actionProjectId ? { actionProjectId } : {}),
          });
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
        const body = await readJson<{ decision?: unknown; answers?: unknown }>(request);
        const decision = requireString(body.decision, "decision");
        try {
          sessions.respondToApproval(sessionId, parts[4], decision, body.answers);
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
      ".svg": "image/svg+xml",
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

  return { server, store, sessions, memory, shutdown };
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

function projectKind(value: unknown): ProjectKind {
  if (value === undefined || value === null || value === "") return "dev";
  if (typeof value !== "string" || !PROJECT_KINDS.has(value as ProjectKind)) {
    throw new HttpError(400, "Invalid project kind");
  }
  return value as ProjectKind;
}

function requiredEnum<T extends string>(value: unknown, allowed: Set<T>, name: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(value: string | null, allowed: Set<T>, name: string): T | undefined {
  if (value === null || value === "") return undefined;
  return requiredEnum(value, allowed, name);
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function projectIdList(value: unknown, store: Store): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new HttpError(400, "projectIds must be an array with at most 50 items");
  }
  const result = [...new Set(value.map((item) => requireString(item, "projectId")))];
  for (const projectId of result) {
    if (!store.getProject(projectId)) throw new HttpError(404, `Project not found: ${projectId}`);
  }
  return result;
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

function materialHttpError(error: unknown): HttpError {
  if (error instanceof TheoryMaterialError) {
    if (error.code === "NOT_FOUND") return new HttpError(404, error.message);
    if (error.code === "TOO_LARGE") return new HttpError(413, error.message);
    if (error.code === "INCOMPLETE_ATTEMPT") return new HttpError(400, error.message);
    return new HttpError(422, error.message);
  }
  return new HttpError(500, error instanceof Error ? error.message : String(error));
}

function materialSize(value: unknown): TheoryMaterialSize {
  if (typeof value !== "string" || !(value in THEORY_MATERIAL_BLOCK_COUNTS)) {
    throw new HttpError(400, "size должен быть short, standard или deep");
  }
  return value as TheoryMaterialSize;
}

function materialTopicMode(value: unknown): TheoryMaterialTopicMode {
  if (value === undefined) return "manual";
  if (value !== "manual" && value !== "auto") {
    throw new HttpError(400, "topicMode должен быть manual или auto");
  }
  return value;
}

type MemorySnapshot = {
  format: "ronix-memory";
  version: 1;
  exportedAt: string;
  projects: Array<{ id: string; name: string; path: string; kind: ProjectKind }>;
  memories: ReturnType<Store["listMemory"]>["items"];
  chats: Array<{
    id: string;
    title: string | null;
    projectIds: string[];
    messages: ReturnType<Store["listMessages"]>;
  }>;
  learning: Array<{
    projectId: string;
    goal: string;
    topics: StoredLearningTopic[];
    observations: StoredLearningObservation[];
    roadmap: StoredLearningRoadmapItem[];
  }>;
};

function createMemorySnapshot(store: Store): MemorySnapshot {
  const projects = store.listProjects();
  return {
    format: "ronix-memory",
    version: 1,
    exportedAt: new Date().toISOString(),
    projects: projects.map(({ id, name, path, kind }) => ({ id, name, path, kind })),
    memories: store.listMemory({ limit: 1_000_000, offset: 0 }).items,
    chats: store.listChatSessions().map((chat) => ({
      id: chat.id,
      title: chat.title ?? null,
      projectIds: store.listChatProjectIds(chat.id),
      messages: store.listMessages(chat.id, 1_000_000),
    })),
    learning: projects.filter((project) => project.kind === "learning").map((project) => ({
      projectId: project.id,
      goal: store.getLearningGoal(project.id),
      topics: store.listLearningTopics(project.id),
      observations: store.listLearningObservations(project.id, 1_000_000),
      roadmap: store.listRoadmapItems(project.id),
    })),
  };
}

function previewMemorySnapshot(value: unknown, store: Store): {
  format: "ronix-memory";
  version: 1;
  memories: number;
  chats: number;
  messages: number;
  learningProjects: number;
  unmatchedProjects: Array<{ name: string; path: string }>;
} {
  const snapshot = requireMemorySnapshot(value);
  const currentPaths = new Set(store.listProjects().map((project) => project.path));
  return {
    format: snapshot.format,
    version: snapshot.version,
    memories: snapshot.memories.length,
    chats: snapshot.chats.length,
    messages: snapshot.chats.reduce((sum, chat) => sum + chat.messages.length, 0),
    learningProjects: snapshot.learning.length,
    unmatchedProjects: snapshot.projects
      .filter((project) => !currentPaths.has(project.path))
      .map(({ name, path }) => ({ name, path })),
  };
}

function importMemorySnapshot(
  value: unknown,
  store: Store,
  sessions: SessionManager,
  memory: MemoryService,
): { memories: number; chats: number; messages: number; learningProjects: number; skipped: number } {
  const snapshot = requireMemorySnapshot(value);
  const currentByPath = new Map(store.listProjects().map((project) => [project.path, project]));
  const oldProjects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const projectIds = new Map<string, string>();
  for (const project of snapshot.projects) {
    const current = currentByPath.get(project.path);
    if (current) projectIds.set(project.id, current.id);
  }

  const chatIds = new Map<string, string>();
  let chatsImported = 0;
  let messagesImported = 0;
  let skipped = 0;
  for (const archived of snapshot.chats) {
    let chat = sessions.createSession(null, {}, "chat");
    if (archived.title?.trim()) chat = store.updateSession(chat.id, { title: archived.title.trim().slice(0, 120) });
    chatIds.set(archived.id, chat.id);
    store.replaceChatProjects(
      chat.id,
      archived.projectIds.map((id) => projectIds.get(id)).filter((id): id is string => Boolean(id)),
    );
    for (const message of archived.messages) {
      if ((message.role !== "user" && message.role !== "assistant") || !message.text?.trim()) {
        skipped += 1;
        continue;
      }
      store.addMessage({
        id: randomUUID(),
        sessionId: chat.id,
        turnId: null,
        role: message.role,
        text: message.text.slice(0, 100_000),
        createdAt: validIsoDate(message.createdAt),
      });
      messagesImported += 1;
    }
    chatsImported += 1;
  }

  let memoriesImported = 0;
  for (const item of snapshot.memories) {
    const scopeId = item.scopeType === "global"
      ? null
      : item.scopeType === "chat"
        ? chatIds.get(item.scopeId ?? "") ?? null
        : projectIds.get(item.scopeId ?? "") ?? null;
    if (item.scopeType !== "global" && !scopeId) {
      skipped += 1;
      continue;
    }
    if (!MEMORY_SCOPES.has(item.scopeType) || !MEMORY_KINDS.has(item.kind) || !item.content?.trim()) {
      skipped += 1;
      continue;
    }
    try {
      memory.remember({
        scopeType: item.scopeType,
        scopeId,
        kind: item.kind,
        content: item.content,
        confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0)),
        allowSuppressed: true,
      });
      memoriesImported += 1;
    } catch {
      skipped += 1;
    }
  }

  let learningProjects = 0;
  for (const learning of snapshot.learning) {
    const currentProjectId = projectIds.get(learning.projectId);
    const oldProject = oldProjects.get(learning.projectId);
    const currentProject = currentProjectId ? store.getProject(currentProjectId) : null;
    if (!currentProject || currentProject.kind !== "learning" || !oldProject) {
      skipped += 1;
      continue;
    }
    store.importLearningState({
      projectId: currentProject.id,
      goal: typeof learning.goal === "string" ? learning.goal.slice(0, 4_000) : "",
      topics: normalizeSnapshotTopics(learning.topics, currentProject.id),
      observations: normalizeSnapshotObservations(learning.observations, currentProject.id),
      roadmap: normalizeSnapshotRoadmap(learning.roadmap, currentProject.id),
    });
    learningProjects += 1;
  }
  return {
    memories: memoriesImported,
    chats: chatsImported,
    messages: messagesImported,
    learningProjects,
    skipped,
  };
}

function requireMemorySnapshot(value: unknown): MemorySnapshot {
  if (!isRecord(value) || value.format !== "ronix-memory" || value.version !== 1) {
    throw new HttpError(400, "Unsupported Ronix memory archive");
  }
  for (const field of ["projects", "memories", "chats", "learning"] as const) {
    if (!Array.isArray(value[field])) throw new HttpError(400, `Archive field ${field} must be an array`);
  }
  if (value.projects.length > 10_000 || value.memories.length > 100_000 || value.chats.length > 10_000) {
    throw new HttpError(413, "Ronix memory archive is too large");
  }
  if (!value.projects.every((item: unknown) => isRecord(item)
    && typeof item.id === "string" && typeof item.name === "string" && typeof item.path === "string")) {
    throw new HttpError(400, "Archive contains an invalid project entry");
  }
  if (!value.memories.every((item: unknown) => isRecord(item))) {
    throw new HttpError(400, "Archive contains an invalid memory entry");
  }
  if (!value.chats.every((item: unknown) => isRecord(item)
    && typeof item.id === "string" && Array.isArray(item.projectIds) && Array.isArray(item.messages))) {
    throw new HttpError(400, "Archive contains an invalid chat entry");
  }
  if (!value.learning.every((item: unknown) => isRecord(item)
    && typeof item.projectId === "string" && Array.isArray(item.topics)
    && Array.isArray(item.observations) && Array.isArray(item.roadmap))) {
    throw new HttpError(400, "Archive contains an invalid learning entry");
  }
  return value as unknown as MemorySnapshot;
}

function normalizeSnapshotTopics(values: StoredLearningTopic[], projectId: string): StoredLearningTopic[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((topic) => {
    if (!isRecord(topic) || typeof topic.title !== "string" || !topic.title.trim()) return [];
    return [{
      projectId,
      title: topic.title.trim().slice(0, 160),
      score: Math.min(10, Math.max(1, Math.round(Number(topic.score) || 5))),
      confidence: Math.min(1, Math.max(0, Number(topic.confidence) || 0)),
      lastEvidence: typeof topic.lastEvidence === "string"
        ? topic.lastEvidence.slice(0, 2_000)
        : "Импортировано из архива Ronix",
      updatedAt: validIsoDate(topic.updatedAt),
    }];
  });
}

function normalizeSnapshotObservations(
  values: StoredLearningObservation[],
  projectId: string,
): StoredLearningObservation[] {
  if (!Array.isArray(values)) return [];
  const kinds = new Set<StoredLearningObservation["kind"]>(["practice", "theory", "control", "note"]);
  return values.flatMap((item) => {
    if (!isRecord(item) || typeof item.topic !== "string" || !item.topic.trim() || !kinds.has(item.kind)) return [];
    return [{
      id: randomUUID(),
      projectId,
      topic: item.topic.trim().slice(0, 160),
      kind: item.kind,
      scoreDelta: Math.trunc(Number(item.scoreDelta) || 0),
      resultScore: item.resultScore == null
        ? null
        : Math.min(10, Math.max(0, Number(item.resultScore) || 0)),
      rationale: typeof item.rationale === "string"
        ? item.rationale.slice(0, 2_000)
        : "Импортировано из архива Ronix",
      sourceSessionId: null,
      createdAt: validIsoDate(item.createdAt),
    }];
  });
}

function normalizeSnapshotRoadmap(
  values: StoredLearningRoadmapItem[],
  projectId: string,
): StoredLearningRoadmapItem[] {
  if (!Array.isArray(values)) return [];
  const lanes = new Set<StoredLearningRoadmapItem["lane"]>(["now", "next", "later"]);
  const statuses = new Set<StoredLearningRoadmapItem["status"]>(["todo", "done", "dropped"]);
  return values.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== "string" || !item.title.trim()
      || !lanes.has(item.lane) || !statuses.has(item.status)) return [];
    return [{
      id: randomUUID(),
      projectId,
      lane: item.lane,
      title: item.title.trim().slice(0, 240),
      status: item.status,
      position: Math.max(0, Math.trunc(Number(item.position) || 0)),
      rationale: typeof item.rationale === "string" ? item.rationale.slice(0, 1_000) : null,
      createdAt: validIsoDate(item.createdAt),
      updatedAt: validIsoDate(item.updatedAt),
    }];
  });
}

function validIsoDate(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const result = value.trim();
  if (!allowEmpty && !result) throw new HttpError(400, `${field} must not be empty`);
  if (result.length > maximum) throw new HttpError(400, `${field} is too long`);
  if (/\p{Cc}/u.test(result.replaceAll("\n", "").replaceAll("\t", ""))) {
    throw new HttpError(400, `${field} contains control characters`);
  }
  return result;
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && /constraint/i.test(error.message);
}

type LearningTopic = {
  title: string;
  score: number;
  confidence: string;
  rationale: string;
};

type LearningAssignment = {
  title: string;
  score: number | null;
};

type LearningSessions = {
  course: Session;
  theory: Session;
  practice: Session;
  materials: Session;
};

const LEARNING_AGENTS_TEMPLATE = `# Инструкция для AI-наставника

## Роль

Эти правила действуют только в учебных сессиях Ronix «Курс», «Теория» и «Практика»,
когда запрос содержит соответствующий служебный контекст. В этих сессиях работай
как AI-наставник. Для задач разработки и обычных чатов учебная роль не действует,
в том числе при работе с файлами в \`learning/\`.
Генератор материалов следует отдельному служебному заданию Ronix.

## Правила владения данными

1. Дневник и маршрут хранятся в файлах проекта; сохраняй пользовательские правки.
2. Codex читает и обновляет файлы learning/LEARNING_DIARY.md и learning/ROADMAP.md.
   Сохраняй все разделы, многострочные пункты и историю. Создавай отсутствующий
   документ только после чтения инструкций проекта и согласования цели обучения.
3. UI Ronix читает эти файлы; отдельного учебного состояния в SQLite нет.
4. Учебные записи ведутся на русском языке.

## Первый учебный диалог

Если дневник и roadmap еще не заполнены по смыслу, сначала уточни:

- цель обучения;
- текущий уровень;
- удобный формат практики;
- ограничения по времени и темпу;
- какие прежние материалы или дневник нужно импортировать.

После этого сохрани цель, начальные наблюдения и roadmap в файлах learning/LEARNING_DIARY.md и learning/ROADMAP.md.

## Курс

В режиме курса объясняй темы, выбирай следующий блок по текущему roadmap, задавай
короткие проверочные вопросы и корректируй маршрут, если он устарел. Если меняешь
roadmap, сохраняй краткое основание в истории корректировок.

## Теория

В режиме теории помогай точечно закрывать пробелы без требования писать или
запускать код. Объясняй через понятия, аналогии, разборы и короткие примеры для
чтения. После объяснения задай по одному 2-4 коротких вопроса на воспроизведение.

Теоретические ошибки не снижают основную числовую оценку темы. После проверки
запиши теоретическое наблюдение в learning/LEARNING_DIARY.md:
тему, статус \`разобрано\` или \`нужно повторить\` и краткое основание.
Меняй roadmap только если найденный пробел действительно влияет на маршрут.

Интерактивные материалы создавай только по прямому служебному заданию Ronix и
только как один JSON-файл в \`learning/theory/materials/\`. Не добавляй HTML,
JavaScript, CSS, внешние ссылки или медиа. Результаты прохождения материалов не
переноси в учебный дневник, числовые оценки или roadmap.

## Практика

В режиме практики пользователь сдает код обычным сообщением. Проверяй решение,
задавай уточняющие вопросы, оценивай самостоятельность и после завершенной
практики запиши свидетельства по затронутым темам
в learning/LEARNING_DIARY.md, включая основание и изменение оценки.

## Оценивание

Одна опечатка не снижает оценку. Повторяющаяся концептуальная ошибка может
снизить ее. Полностью сгенерированный AI-код не подтверждает владение темой.
Обычное новое свидетельство меняет тематическую оценку не более чем на 1 балл,
контрольная или крупная самостоятельная работа - не более чем на 2 балла.
`;

function ensureLearningWorkspace(projectPath: string): void {
  const learningRoot = join(projectPath, "learning");
  mkdirSync(learningRoot, { recursive: true });
  writeMissingLearningTemplate(
    join(learningRoot, "AGENTS.md"),
    LEARNING_AGENTS_TEMPLATE,
  );
  ensureTheoryMaterialsDirectory(projectPath);
}

function writeMissingLearningTemplate(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, "utf8");
    return;
  }
  // Existing project instructions belong to the user and are not upgraded implicitly.
}

function readLearningWorkspace(
  project: Project,
  purposeSessions?: LearningSessions,
) {
  const diary = readLearningFile(project.path, "LEARNING_DIARY.md");
  const roadmap = readLearningFile(project.path, "ROADMAP.md");
  const diarySummary = { ...summarizeDiary(diary), goal: legacyLearningGoal(diary) };
  return {
    kind: project.kind, available: project.kind === "learning", source: "files",
    agentsPath: existsSync(join(project.path, "learning", "AGENTS.md")) ? "learning/AGENTS.md" : null,
    diary, roadmap, summary: diarySummary, diarySummary,
    roadmapSummary: summarizeFileRoadmap(roadmap), sessions: purposeSessions ?? null,
  };
}

function legacyLearningGoal(diary: string): string {
  return markdownSection(diary, "## Цель обучения")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/^Пока не уточнена\.?$/i, "");
}

function summarizeDiary(diary: string): {
  lastUpdated: string | null;
  topicCount: number;
  assignmentCount: number;
  focus: string[];
  latestGrades: LearningAssignment[];
  averageScore: number | null;
  topics: LearningTopic[];
  weakTopics: LearningTopic[];
  strongTopics: LearningTopic[];
  assignments: LearningAssignment[];
} {
  const lastUpdated = diary.match(/^Последнее обновление:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const topics = parseKnowledgeTopics(markdownSection(diary, "## Текущая карта знаний"));
  const assignments = parseAssignments(markdownSection(diary, "## Журнал заданий"));
  const focus = markdownSection(diary, "## Текущий учебный фокус")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:\d+\.|-)\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const averageScore = topics.length
    ? Math.round((topics.reduce((sum, topic) => sum + topic.score, 0) / topics.length) * 10) / 10
    : null;
  return {
    lastUpdated,
    topicCount: topics.length,
    assignmentCount: assignments.length,
    focus,
    latestGrades: assignments.filter((assignment) => assignment.score != null).slice(-6),
    averageScore,
    topics,
    weakTopics: [...topics].sort((a, b) => a.score - b.score).slice(0, 6),
    strongTopics: [...topics].sort((a, b) => b.score - a.score).slice(0, 6),
    assignments,
  };
}

function parseKnowledgeTopics(section: string): LearningTopic[] {
  const topics = [];
  for (const line of section.split(/\r?\n/)) {
    const cells = tableCells(line);
    if (
      cells.length < 4
      || cells[0] === "Тема или подтема"
      || /^-+$/.test(cells[0] ?? "")
    ) {
      continue;
    }
    const score = Number.parseInt(cells[1] ?? "", 10);
    if (!cells[0] || !Number.isInteger(score)) continue;
    topics.push({
      title: stripMarkdown(cells[0]),
      score,
      confidence: cells[2] ?? "",
      rationale: stripMarkdown(cells.slice(3).join(" | ")),
    });
  }
  return topics;
}

function parseAssignments(section: string): Array<{ title: string; score: number | null }> {
  const headings = [...section.matchAll(/^###\s+(.+)$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? section.length;
    const body = section.slice(start, end);
    const scores = [...body.matchAll(
      /(?:Итоговая оценка(?: первой сдачи)?|Текущая оценка после доработки):\s*([\d.]+)\/10/gi,
    )];
    const score = scores.at(-1)?.[1];
    return {
      title: stripMarkdown(heading[1]?.trim() ?? "Задание"),
      score: score ? Number.parseFloat(score) : null,
    };
  });
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\\\|/g, "|")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const afterHeading = start + heading.length;
  const next = markdown.slice(afterHeading).search(/\n##\s+/);
  return next < 0
    ? markdown.slice(afterHeading)
    : markdown.slice(afterHeading, afterHeading + next);
}

async function main(): Promise<void> {
  if (process.env.RONIX_AUTH_MODE === "authentik") {
    const { startMultiUserServer } = await import("./multi-user.js");
    await startMultiUserServer();
    return;
  }
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
