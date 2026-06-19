import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function findOnPath(command: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: integer(process.env.PORT, 8787),
  dataDir: resolve(process.env.DATA_DIR ?? "data"),
  authToken: process.env.AGENT_TOKEN ?? "",
  projectRoots: (process.env.PROJECT_ROOTS ?? "/home/ronix/Projects/RONIX")
    .split(",")
    .map((path) => resolve(path.trim()))
    .filter(Boolean),
  codexPath: process.env.CODEX_PATH
    ? resolve(process.env.CODEX_PATH)
    : findOnPath(process.platform === "win32" ? "codex.exe" : "codex"),
};

if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.authToken) {
  throw new Error("AGENT_TOKEN is required when HOST is not loopback");
}
