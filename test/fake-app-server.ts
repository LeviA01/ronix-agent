import type {
  AppServerNotification,
  AppServerRequest,
  CodexAppServer,
} from "../src/app-server-client.js";

type Listener<T> = (value: T) => void;

export class FakeAppServer implements CodexAppServer {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: number | string; result?: unknown; error?: unknown }> = [];
  readonly failures = new Map<string, Error>();
  private readonly notificationListeners = new Set<Listener<AppServerNotification>>();
  private readonly requestListeners = new Set<Listener<AppServerRequest>>();
  private readonly exitListeners = new Set<Listener<Error>>();
  private nextThread = 1;
  private nextTurn = 1;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failures.get(method);
    if (failure) throw failure;
    if (method === "thread/start" || method === "thread/resume") {
      const supplied = (params as { threadId?: string } | undefined)?.threadId;
      return { thread: { id: supplied ?? `thread-${this.nextThread++}` } } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    if (method === "account/read") return { account: null } as T;
    if (method === "account/rateLimits/read") {
      return { rateLimits: {}, rateLimitsByLimitId: null, rateLimitResetCredits: null } as T;
    }
    if (method === "account/usage/read") {
      return { summary: {}, dailyUsageBuckets: null } as T;
    }
    return {} as T;
  }

  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.responses.push({ id, error: { code, message } });
  }

  onNotification(listener: Listener<AppServerNotification>): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: Listener<AppServerRequest>): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onExit(listener: Listener<Error>): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {}

  notify(method: string, params: Record<string, unknown>): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  serverRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    for (const listener of this.requestListeners) listener({ id, method, params });
  }

  exit(message: string): void {
    for (const listener of this.exitListeners) listener(new Error(message));
  }
}
