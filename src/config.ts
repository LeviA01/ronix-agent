import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Expected a boolean, received: ${value}`);
}

function findCodex(): string | null {
  if (process.env.CODEX_PATH) {
    const configured = resolve(process.env.CODEX_PATH);
    if (existsSync(configured)) return configured;
    console.warn(`Configured CODEX_PATH does not exist: ${configured}`);
  }

  const command = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }

  const userInstall = join(homedir(), ".local", "bin", command);
  return existsSync(userInstall) ? userInstall : null;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: integer(process.env.PORT, 8787),
  dataDir: resolve(process.env.DATA_DIR ?? "data"),
  authKey: process.env.AGENT_KEY ?? process.env.AGENT_TOKEN ?? "",
  authSessionDays: integer(process.env.AUTH_SESSION_DAYS, 30),
  secureAuthCookie: boolean(process.env.AUTH_COOKIE_SECURE, true),
  projectRoots: (process.env.PROJECT_ROOTS ?? "/home/ronix/Projects/RONIX")
    .split(",")
    .map((path) => resolve(path.trim()))
    .filter(Boolean),
  codexPath: findCodex(),
};

if (config.authKey && Buffer.byteLength(config.authKey, "utf8") < 32) {
  throw new Error("AGENT_KEY must contain at least 32 bytes");
}

if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.authKey) {
  throw new Error("AGENT_KEY is required when HOST is not loopback");
}
