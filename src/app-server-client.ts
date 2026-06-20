import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type RpcId = number | string;

type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type AppServerNotification = {
  method: string;
  params: Record<string, unknown>;
};

export type AppServerRequest = AppServerNotification & { id: RpcId };

type NotificationListener = (notification: AppServerNotification) => void;
type ServerRequestListener = (request: AppServerRequest) => void;
type ExitListener = (error: Error) => void;

export interface CodexAppServer {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, code: number, message: string): void;
  onNotification(listener: NotificationListener): () => void;
  onServerRequest(listener: ServerRequestListener): () => void;
  onExit(listener: ExitListener): () => void;
  close(): Promise<void>;
}

export class AppServerClient implements CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private nextId = 1;
  private stderr = "";
  private closing = false;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly serverRequestListeners = new Set<ServerRequestListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(private readonly codexPath: string | null) {}

  async request<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    await this.ensureConnected();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const child = this.child;
    if (!child) return;

    this.closePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    return this.closePromise;
  }

  private async ensureConnected(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.closing) throw new Error("Codex app-server is shutting down");

    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    const child = spawn(this.codexPath ?? "codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.stderr = "";
    this.lines = createInterface({ input: child.stdout });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
    child.stdin.on("error", (error) => this.handleExit(error));
    child.on("error", (error) => this.handleExit(error));
    child.on("exit", (code, signal) => {
      const details = this.stderr.trim();
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleExit(new Error(details || `Codex app-server exited with ${suffix}`));
    });
    this.lines.on("line", (line) => this.handleLine(line));

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "ronix_agent",
        title: "Ronix Agent",
        version: "0.2.0",
      },
    }, 15_000);
    this.write({ method: "initialized", params: {} });
  }

  private sendRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: RpcMessage): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Codex app-server is not connected");
    }
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    const params = isRecord(message.params) ? message.params : {};
    if (message.id !== undefined) {
      const request = { id: message.id, method: message.method, params };
      if (this.serverRequestListeners.size === 0) {
        this.respondError(message.id, -32601, "Ronix does not handle this server request");
        return;
      }
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }

    const notification = { method: message.method, params };
    for (const listener of this.notificationListeners) listener(notification);
  }

  private handleExit(error: Error): void {
    if (!this.child) return;
    this.lines?.close();
    this.lines = null;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) {
      for (const listener of this.exitListeners) listener(error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
