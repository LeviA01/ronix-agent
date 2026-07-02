import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadConfigFile } from "./env-file.js";

const configFile = loadConfigFile();

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

function choice<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string,
): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function optionalModule(prefix: "TTS" | "STT") {
  const enabled = boolean(process.env[`${prefix}_ENABLED`], false);
  const provider = process.env[`${prefix}_PROVIDER`]?.trim() || null;
  const endpoint = process.env[`${prefix}_ENDPOINT`]?.trim() || null;
  if (enabled && (!provider || !endpoint)) {
    throw new Error(`${prefix}_PROVIDER and ${prefix}_ENDPOINT are required when ${prefix}_ENABLED=true`);
  }
  return { enabled, provider, endpoint };
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
  configFile,
  deploymentMode: choice(
    process.env.RONIX_DEPLOYMENT_MODE,
    "local",
    ["local", "vds"] as const,
    "RONIX_DEPLOYMENT_MODE",
  ),
  accessMode: choice(
    process.env.RONIX_ACCESS_MODE,
    "local",
    ["local", "tailscale", "reverse-proxy"] as const,
    "RONIX_ACCESS_MODE",
  ),
  host: process.env.HOST ?? "127.0.0.1",
  port: integer(process.env.PORT, 8787),
  dataDir: resolve(process.env.DATA_DIR ?? "data"),
  authKey: process.env.AGENT_KEY ?? process.env.AGENT_TOKEN ?? "",
  authSessionDays: integer(process.env.AUTH_SESSION_DAYS, 30),
  secureAuthCookie: boolean(process.env.AUTH_COOKIE_SECURE, true),
  trustProxy: boolean(process.env.TRUST_PROXY, false),
  eventHistoryLimit: integer(process.env.EVENT_HISTORY_LIMIT, 200),
  eventRetention: integer(process.env.EVENT_RETENTION, 5_000),
  shutdownTimeoutMs: integer(process.env.SHUTDOWN_TIMEOUT_MS, 10_000),
  projectRoots: (process.env.PROJECT_ROOTS ?? join(homedir(), "Projects"))
    .split(",")
    .map((path) => resolve(path.trim()))
    .filter(Boolean),
  codexPath: findCodex(),
  modules: {
    tts: optionalModule("TTS"),
    stt: optionalModule("STT"),
  },
};

if (config.authKey && Buffer.byteLength(config.authKey, "utf8") < 32) {
  throw new Error("AGENT_KEY must contain at least 32 bytes");
}

if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.authKey) {
  throw new Error("AGENT_KEY is required when HOST is not loopback");
}
