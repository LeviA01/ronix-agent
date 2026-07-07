import { randomUUID } from "node:crypto";
import type {
  AppServerNotification,
  AppServerRequest,
  CodexAppServer,
} from "./app-server-client.js";
import type { Store } from "./store.js";
import type {
  CodexModel,
  PendingApproval,
  SandboxMode,
  Session,
  SessionPurpose,
  StoredEvent,
} from "./types.js";

type EventListener = (event: StoredEvent) => void;
type RpcId = number | string;

type ThreadResponse = { thread: { id: string } };
type TurnResponse = { turn: { id: string } };
type ModelListResponse = { data: CodexModel[]; nextCursor: string | null };

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

const TRANSIENT_EVENT_TYPES = [
  "codex.item.agentMessage.delta",
  "codex.item.commandExecution.outputDelta",
  "codex.item.fileChange.outputDelta",
  "codex.item.plan.delta",
  "codex.item.reasoning.summaryTextDelta",
  "codex.item.reasoning.textDelta",
];

export class SessionManager {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly pendingApprovals = new Map<string, PendingApproval & { rpcId: RpcId }>();
  private readonly unsubscribers: Array<() => void>;
  private shuttingDown = false;

  constructor(
    private readonly store: Store,
    private readonly codex: CodexAppServer,
    private readonly maximumEventsPerSession = 5_000,
  ) {
    this.unsubscribers = [
      codex.onNotification((notification) => this.handleNotification(notification)),
      codex.onServerRequest((request) => this.handleServerRequest(request)),
      codex.onExit((error) => this.handleAppServerExit(error)),
    ];
    for (const session of this.store.recoverRunningSessions()) {
      this.publish(session.id, "session.error", { message: session.lastError });
    }
    for (const session of this.store.listSessions()) {
      this.store.deleteEventsByTypes(session.id, TRANSIENT_EVENT_TYPES);
    }
  }

  createSession(
    projectId: string,
    settings: { model?: string | null; reasoningEffort?: string | null } = {},
    purpose: SessionPurpose = "general",
  ): Session {
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      projectId,
      purpose,
      threadId: null,
      activeTurnId: null,
      status: "ready",
      sandboxMode: "workspace-write",
      model: settings.model ?? null,
      reasoningEffort: settings.reasoningEffort ?? null,
      lastError: null,
      createdAt: now,
      lastActivityAt: now,
    });
  }

  ensurePurposeSession(projectId: string, purpose: Exclude<SessionPurpose, "general">): Session {
    return this.store.getSessionByPurpose(projectId, purpose)
      ?? this.createSession(projectId, {}, purpose);
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  async startTurn(sessionId: string, prompt: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === "stopped") throw new Error("Session is stopped");
    if (session.status === "running" || session.activeTurnId) {
      throw new Error("A turn is already running");
    }
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error("Project not found");

    this.publish(sessionId, "user.message", { text: prompt });
    try {
      const thread = session.threadId
        ? await this.codex.request<ThreadResponse>("thread/resume", {
            threadId: session.threadId,
            cwd: project.path,
            sandbox: session.sandboxMode,
            approvalPolicy: approvalPolicy(session.sandboxMode),
            approvalsReviewer: "user",
            ...(session.model ? { model: session.model } : {}),
          })
        : await this.codex.request<ThreadResponse>("thread/start", {
            cwd: project.path,
            sandbox: session.sandboxMode,
            approvalPolicy: approvalPolicy(session.sandboxMode),
            approvalsReviewer: "user",
            ...(session.model ? { model: session.model } : {}),
          });

      if (thread.thread.id !== session.threadId) {
        this.store.updateSession(sessionId, { threadId: thread.thread.id });
      }
      const turn = await this.codex.request<TurnResponse>("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: prompt }],
        ...(session.model ? { model: session.model } : {}),
        ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
      });
      this.store.updateSession(sessionId, {
        status: "running",
        activeTurnId: turn.turn.id,
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateSession(sessionId, {
        status: "error",
        activeTurnId: null,
        lastError: message,
      });
      this.publish(sessionId, "session.error", { message });
      throw error;
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    if (!session.threadId || !session.activeTurnId) return false;
    await this.codex.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
    return true;
  }

  async stop(sessionId: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.activeTurnId) await this.interrupt(sessionId);
    const updated = this.store.updateSession(sessionId, {
      status: "stopped",
      activeTurnId: null,
    });
    this.publish(sessionId, "session.stopped", {});
    return updated;
  }

  resume(sessionId: string): Session {
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.activeTurnId) {
      throw new Error("Session has an active turn");
    }
    const updated = this.store.updateSession(sessionId, {
      status: "ready",
      activeTurnId: null,
      lastError: null,
    });
    this.publish(sessionId, "session.resumed", {});
    return updated;
  }

  updateSandboxMode(sessionId: string, sandboxMode: SandboxMode): Session {
    return this.updateSettings(sessionId, { sandboxMode });
  }

  updateSettings(
    sessionId: string,
    update: {
      sandboxMode?: SandboxMode;
      model?: string;
      reasoningEffort?: string;
    },
  ): Session {
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.activeTurnId) {
      throw new Error("Cannot change session settings while a turn is running");
    }
    const updated = this.store.updateSession(sessionId, update);
    this.publish(sessionId, "session.settings", update);
    return updated;
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const response: ModelListResponse =
        await this.codex.request<ModelListResponse>("model/list", {
          cursor,
          includeHidden: false,
        });
      models.push(...response.data.filter((model) => !model.hidden));
      cursor = response.nextCursor;
    } while (cursor);
    return models;
  }

  listApprovals(sessionId: string): PendingApproval[] {
    return [...this.pendingApprovals.values()]
      .filter((approval) => approval.sessionId === sessionId)
      .map(({ rpcId: _rpcId, ...approval }) => approval);
  }

  respondToApproval(sessionId: string, approvalId: string, decision: string): void {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.sessionId !== sessionId) throw new Error("Approval not found");
    const allowed = ["accept", "acceptForSession", "decline", "cancel"];
    if (!allowed.includes(decision)) throw new Error("Invalid approval decision");
    this.codex.respond(approval.rpcId, { decision });
    this.pendingApprovals.delete(approvalId);
    this.publish(sessionId, "approval.resolved", { approvalId, decision });
  }

  delete(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.status === "running" || session.activeTurnId) {
      throw new Error("Cannot delete a session while a turn is running");
    }
    if (!this.store.deleteSession(sessionId)) throw new Error("Session not found");
    this.listeners.delete(sessionId);
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.sessionId === sessionId) {
        this.codex.respond(approval.rpcId, { decision: "cancel" });
        this.pendingApprovals.delete(id);
      }
    }
  }

  async getUsage(): Promise<unknown> {
    const [account, limits, usage] = await Promise.all([
      this.codex.request<{ account: unknown }>("account/read", { refreshToken: false }),
      this.codex.request<Record<string, unknown>>("account/rateLimits/read"),
      this.codex.request<Record<string, unknown>>("account/usage/read"),
    ]);
    return { account: account.account, ...limits, usage };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const running = this.store.listSessions().filter(
      (session) => session.status === "running" && session.threadId && session.activeTurnId,
    );
    await Promise.allSettled(running.map((session) => this.interrupt(session.id)));
    for (const session of running) {
      this.store.updateSession(session.id, {
        status: "error",
        activeTurnId: null,
        lastError: "Ronix stopped while the turn was running",
      });
    }
    for (const approval of this.pendingApprovals.values()) {
      this.codex.respond(approval.rpcId, { decision: "cancel" });
    }
    this.pendingApprovals.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.codex.close();
  }

  private handleNotification(notification: AppServerNotification): void {
    const threadId = stringField(notification.params, "threadId")
      ?? nestedStringField(notification.params, "thread", "id");
    if (!threadId) return;
    const session = this.store.getSessionByThreadId(threadId);
    if (!session) return;

    this.publish(
      session.id,
      "codex." + notification.method.replaceAll("/", "."),
      notification.params,
    );

    if (notification.method === "turn/started") {
      const turnId = nestedStringField(notification.params, "turn", "id");
      if (turnId) {
        this.store.updateSession(session.id, {
          status: "running",
          activeTurnId: turnId,
          lastError: null,
        });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const status = nestedStringField(notification.params, "turn", "status");
      const error = nestedStringField(notification.params, "turn", "error", "message");
      const stopped = this.store.getSession(session.id)?.status === "stopped";
      this.store.updateSession(session.id, {
        status: stopped ? "stopped" : status === "failed" ? "error" : "ready",
        activeTurnId: null,
        lastError: status === "failed" ? error ?? "Codex turn failed" : null,
      });
      if (status === "failed") {
        this.publish(session.id, "session.error", { message: error ?? "Codex turn failed" });
      } else if (status === "interrupted") {
        this.publish(session.id, "turn.interrupted", {});
      } else {
        this.publish(session.id, "session.ready", {});
      }
      this.store.deleteEventsByTypes(session.id, TRANSIENT_EVENT_TYPES);
    }
  }

  private handleServerRequest(request: AppServerRequest): void {
    const threadId = stringField(request.params, "threadId");
    const session = threadId ? this.store.getSessionByThreadId(threadId) : null;
    if (!session || !APPROVAL_METHODS.has(request.method)) {
      this.codex.respondError(request.id, -32601, "Unsupported Ronix server request");
      return;
    }
    const approvalId = String(request.id);
    const approval = {
      id: approvalId,
      rpcId: request.id,
      sessionId: session.id,
      method: request.method,
      payload: request.params,
      createdAt: new Date().toISOString(),
    };
    this.pendingApprovals.set(approvalId, approval);
    this.publish(session.id, "approval.requested", {
      approvalId,
      method: request.method,
      ...request.params,
    });
  }

  private handleAppServerExit(error: Error): void {
    if (this.shuttingDown) return;
    for (const session of this.store.listSessions()) {
      if (session.status !== "running") continue;
      this.store.updateSession(session.id, {
        status: "error",
        activeTurnId: null,
        lastError: error.message,
      });
      this.publish(session.id, "session.error", { message: error.message });
    }
    this.pendingApprovals.clear();
  }

  private requireSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return session;
  }

  private publish(sessionId: string, type: string, payload: unknown): StoredEvent {
    const event = this.store.addEvent(sessionId, type, payload);
    if (event.sequence % 100 === 0) {
      this.store.pruneEvents(sessionId, this.maximumEventsPerSession);
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    return event;
  }
}

function approvalPolicy(sandboxMode: SandboxMode): "never" | "on-request" {
  return sandboxMode === "danger-full-access" ? "never" : "on-request";
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

function nestedStringField(
  record: Record<string, unknown>,
  ...path: string[]
): string | null {
  let value: unknown = record;
  for (const key of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : null;
}
