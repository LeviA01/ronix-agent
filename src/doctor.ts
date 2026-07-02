import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { moduleStatuses } from "./modules.js";

const execFileAsync = promisify(execFile);

type CheckLevel = "ok" | "warning" | "error";
type Check = { level: CheckLevel; label: string; details: string };

async function inspect(): Promise<Check[]> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    level: major > 22 || (major === 22 && minor >= 5) ? "ok" : "error",
    label: "Node.js",
    details: `${process.version}; требуется 22.5+`,
  });

  checks.push({
    level: existsSync(config.configFile) ? "ok" : "warning",
    label: "Конфиг",
    details: existsSync(config.configFile)
      ? config.configFile
      : `${config.configFile} не найден; используются значения по умолчанию`,
  });

  checks.push(await directoryCheck("Данные", config.dataDir));
  for (const root of config.projectRoots) {
    checks.push(await directoryCheck("Проекты", root));
  }

  const codex = config.codexPath ?? "codex";
  try {
    const version = await execFileAsync(codex, ["--version"], { timeout: 10_000 });
    checks.push({
      level: "ok",
      label: "Codex CLI",
      details: version.stdout.trim() || codex,
    });
    const login = await execFileAsync(codex, ["login", "status"], { timeout: 10_000 });
    checks.push({
      level: "ok",
      label: "Codex auth",
      details: login.stdout.trim() || login.stderr.trim() || "авторизация подтверждена",
    });
  } catch (error) {
    checks.push({
      level: "error",
      label: "Codex CLI",
      details: error instanceof Error ? error.message : String(error),
    });
  }

  checks.push({
    level: config.deploymentMode === "vds" && !config.authKey ? "warning" : "ok",
    label: "Доступ",
    details: config.authKey
      ? `${config.accessMode}; вход по ключу включён`
      : `${config.accessMode}; вход по ключу выключен`,
  });
  const loopback = config.host === "127.0.0.1" || config.host === "localhost";
  const proxySettingsValid = config.accessMode === "local"
    ? !config.authKey || !config.secureAuthCookie
    : config.trustProxy && config.secureAuthCookie;
  checks.push({
    level: (config.deploymentMode === "vds" && !loopback) || !proxySettingsValid
      ? "error"
      : "ok",
    label: "Сеть",
    details: [
      `${config.host}:${config.port}`,
      `trustProxy=${config.trustProxy}`,
      `secureCookie=${config.secureAuthCookie}`,
    ].join("; "),
  });

  for (const module of moduleStatuses(config.modules)) {
    checks.push({
      level: module.enabled && !module.configured ? "error" : "ok",
      label: module.id.toUpperCase(),
      details: module.enabled
        ? `включён; provider=${module.provider ?? "не задан"}`
        : "необязательный модуль выключен",
    });
  }

  if (config.deploymentMode === "vds") {
    const service = join(process.cwd(), ".ronix", "ronix-agent.service");
    checks.push({
      level: existsSync(service) ? "ok" : "warning",
      label: "systemd",
      details: existsSync(service)
        ? service
        : "unit не сгенерирован; повторите `npm run setup -- --mode vds`",
    });
  }
  return checks;
}

async function directoryCheck(label: string, path: string): Promise<Check> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return { level: "ok", label, details: path };
  } catch {
    return {
      level: "error",
      label,
      details: `${path} отсутствует или недоступен для записи`,
    };
  }
}

async function main(): Promise<void> {
  const checks = await inspect();
  for (const check of checks) {
    const marker = check.level === "ok" ? "OK" : check.level === "warning" ? "WARN" : "FAIL";
    console.log(`[${marker}] ${check.label}: ${check.details}`);
  }
  if (checks.some((check) => check.level === "error")) process.exitCode = 1;
}

void main();
