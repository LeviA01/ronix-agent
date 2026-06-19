import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
};

export type CodexAccountUsage = {
  account: {
    type: string;
    email?: string;
    planType?: string;
  } | null;
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits: { availableCount: number } | null;
  usage: {
    summary: {
      lifetimeTokens: number | null;
      peakDailyTokens: number | null;
      longestRunningTurnSec: number | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
    };
    dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  };
};

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

const CACHE_TTL_MS = 30_000;

export class CodexAccountClient {
  private cached: { value: CodexAccountUsage; expiresAt: number } | null = null;
  private pending: Promise<CodexAccountUsage> | null = null;

  constructor(private readonly codexPath: string | null) {}

  getUsage(force = false): Promise<CodexAccountUsage> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) {
      return Promise.resolve(this.cached.value);
    }
    if (this.pending) return this.pending;

    this.pending = this.fetchUsage()
      .then((value) => {
        this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private fetchUsage(): Promise<CodexAccountUsage> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexPath ?? "codex", ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      const lines = createInterface({ input: child.stdout });
      const results = new Map<number, unknown>();
      let stderr = "";
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        lines.close();
        child.kill("SIGTERM");
        if (error) {
          reject(error);
          return;
        }
        const account = results.get(2) as { account: CodexAccountUsage["account"] };
        const limits = results.get(3) as Omit<CodexAccountUsage, "account" | "usage">;
        const usage = results.get(4) as CodexAccountUsage["usage"];
        resolve({ account: account.account, ...limits, usage });
      };

      const send = (message: unknown) => {
        child.stdin.write(JSON.stringify(message) + "\n");
      };

      const timeout = setTimeout(() => {
        finish(new Error("Codex did not return usage data in time"));
      }, 12_000);

      child.stdin.on("error", (error) => finish(error));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_000);
      });

      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        if (!settled) {
          const details = stderr.trim();
          finish(new Error(details || "Codex app-server exited with code " + (code ?? "unknown")));
        }
      });

      lines.on("line", (line) => {
        let response: RpcResponse;
        try {
          response = JSON.parse(line) as RpcResponse;
        } catch {
          return;
        }
        if (response.id === 1) {
          if (response.error) {
            finish(new Error(response.error.message ?? "Could not initialize Codex app-server"));
            return;
          }
          send({ method: "initialized", params: {} });
          send({ method: "account/read", id: 2, params: { refreshToken: false } });
          send({ method: "account/rateLimits/read", id: 3 });
          send({ method: "account/usage/read", id: 4 });
          return;
        }
        if (response.id === 2 || response.id === 3 || response.id === 4) {
          if (response.error) {
            finish(new Error(response.error.message ?? "Could not read Codex usage"));
            return;
          }
          results.set(response.id, response.result);
          if (results.has(2) && results.has(3) && results.has(4)) finish();
        }
      });

      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "ronix_agent",
            title: "Ronix Agent",
            version: "0.1.0",
          },
        },
      });
    });
  }
}
