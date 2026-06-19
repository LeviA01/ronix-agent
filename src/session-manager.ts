import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Session, StoredEvent } from "./types.js";

type EventListener = (event: StoredEvent) => void;

export class SessionManager {
  private readonly codex: Codex;
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly store: Store,
    codexPath: string | null = null,
  ) {
    this.codex = new Codex(codexPath ? { codexPathOverride: codexPath } : undefined);
  }

  createSession(projectId: string): Session {
    const now = new Date().toISOString();
    return this.store.createSession({
      id: randomUUID(),
      projectId,
      threadId: null,
      status: "ready",
      lastError: null,
      createdAt: now,
      lastActivityAt: now,
    });
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
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.status === "stopped") throw new Error("Session is stopped");
    if (this.activeTurns.has(sessionId)) throw new Error("A turn is already running");

    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error("Project not found");

    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    this.store.updateSession(sessionId, { status: "running", lastError: null });
    this.publish(sessionId, "user.message", { text: prompt });

    const options: ThreadOptions = {
      workingDirectory: project.path,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: false,
    };
    const thread = session.threadId
      ? this.codex.resumeThread(session.threadId, options)
      : this.codex.startThread(options);

    void this.consumeTurn(sessionId, thread.runStreamed(prompt, { signal: controller.signal }));
  }

  interrupt(sessionId: string): boolean {
    const controller = this.activeTurns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  stop(sessionId: string): Session {
    this.interrupt(sessionId);
    const session = this.store.updateSession(sessionId, { status: "stopped" });
    this.publish(sessionId, "session.stopped", {});
    return session;
  }

  resume(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (this.activeTurns.has(sessionId)) throw new Error("Session has an active turn");
    const updated = this.store.updateSession(sessionId, {
      status: "ready",
      lastError: null,
    });
    this.publish(sessionId, "session.resumed", {});
    return updated;
  }

  delete(sessionId: string): void {
    if (this.activeTurns.has(sessionId)) {
      throw new Error("Cannot delete a session while a turn is running");
    }
    if (!this.store.deleteSession(sessionId)) {
      throw new Error("Session not found");
    }
    this.listeners.delete(sessionId);
  }

  private async consumeTurn(
    sessionId: string,
    streamedPromise: ReturnType<ReturnType<Codex["startThread"]>["runStreamed"]>,
  ): Promise<void> {
    let reportedTurnFailure: string | null = null;
    try {
      const { events } = await streamedPromise;
      for await (const event of events) {
        if (event.type === "turn.failed") reportedTurnFailure = event.error.message;
        this.handleCodexEvent(sessionId, event);
      }
      const current = this.store.getSession(sessionId);
      if (current?.status !== "stopped") {
        if (reportedTurnFailure) {
          this.store.updateSession(sessionId, {
            status: "error",
            lastError: reportedTurnFailure,
          });
          this.publish(sessionId, "session.error", { message: reportedTurnFailure });
        } else {
          this.store.updateSession(sessionId, { status: "ready" });
          this.publish(sessionId, "session.ready", {});
        }
      }
    } catch (error) {
      const processError = error instanceof Error ? error.message : String(error);
      const message = reportedTurnFailure ?? processError;
      const aborted = this.activeTurns.get(sessionId)?.signal.aborted ?? false;
      const current = this.store.getSession(sessionId);
      if (current?.status !== "stopped") {
        this.store.updateSession(sessionId, {
          status: aborted ? "ready" : "error",
          lastError: aborted ? null : message,
        });
      }
      if (aborted) {
        this.publish(sessionId, "turn.interrupted", { message });
      } else if (reportedTurnFailure) {
        this.publish(sessionId, "session.error", { message });
      } else {
        this.publish(sessionId, "turn.error", { message });
      }
    } finally {
      this.activeTurns.delete(sessionId);
    }
  }

  private handleCodexEvent(sessionId: string, event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.store.updateSession(sessionId, { threadId: event.thread_id });
    }
    this.publish(sessionId, `codex.${event.type}`, event);
  }

  private publish(sessionId: string, type: string, payload: unknown): StoredEvent {
    const event = this.store.addEvent(sessionId, type, payload);
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    return event;
  }
}
