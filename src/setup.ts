import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  parseEnvFile,
  serializeEnvFile,
} from "./env-file.js";

type DeploymentMode = "local" | "vds";
type AccessMode = "local" | "tailscale" | "reverse-proxy";

type SetupArguments = {
  mode?: DeploymentMode;
  output: string;
  yes: boolean;
};

type SetupResult = {
  mode: DeploymentMode;
  accessMode: AccessMode;
  port: number;
  configPath: string;
  servicePath: string | null;
  generatedKey: string | null;
  directoriesToCreate: string[];
};

export function renderSystemdService(options: {
  user: string;
  appRoot: string;
  configPath: string;
  nodePath: string;
}): string {
  const entrypoint = join(options.appRoot, "dist", "src", "server.js");
  return `[Unit]
Description=Ronix Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${systemdUser(options.user)}
WorkingDirectory=${systemdPath(options.appRoot)}
Environment=NODE_ENV=production
Environment=${systemdQuote(`RONIX_CONFIG=${options.configPath}`)}
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(entrypoint)}
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`;
}

async function runSetup(args: SetupArguments): Promise<SetupResult> {
  const configPath = resolve(args.output);
  const previous = await readExistingConfig(configPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (previous && !args.yes) {
      const update = await askBoolean(
        rl,
        `Конфиг ${configPath} уже существует. Обновить его?`,
        false,
      );
      if (!update) throw new SetupCancelled();
    }

    const mode = args.mode ?? await askChoice<DeploymentMode>(
      rl,
      "Где будет работать Ronix?",
      [
        ["local", "Локально на этом компьютере"],
        ["vds", "На VDS как systemd-сервис"],
      ],
      normalizeDeploymentMode(value(previous, "RONIX_DEPLOYMENT_MODE", "local")),
      args.yes,
    );
    const accessMode = mode === "local"
      ? "local"
      : await askChoice<"tailscale" | "reverse-proxy">(
          rl,
          "Как будет открываться web-интерфейс?",
          [
            ["tailscale", "Через Tailscale, без публичного порта"],
            ["reverse-proxy", "Через домен и HTTPS reverse proxy"],
          ],
          normalizeAccessMode(value(previous, "RONIX_ACCESS_MODE", "tailscale")),
          args.yes,
        );

    const defaultProjectRoot = mode === "vds"
      ? "/srv/ronix-projects"
      : join(homedir(), "Projects");
    console.log(`\nБаза относительных путей проектов: ${defaultProjectRoot}`);
    const projectRootsInput = await askText(
      rl,
      "Каталоги с проектами, через запятую (абсолютные, ~/... или внутри базы)",
      value(previous, "PROJECT_ROOTS", defaultProjectRoot),
      args.yes,
    );
    const projectRoots = resolveProjectRoots(projectRootsInput, defaultProjectRoot);
    if (projectRoots.length === 0) throw new Error("Нужен хотя бы один каталог проектов");
    console.log("Итоговые каталоги проектов:");
    for (const root of projectRoots) console.log(`  ${root}`);

    const dataDir = absolutePath(await askText(
      rl,
      "Каталог данных Ronix",
      value(
        previous,
        "DATA_DIR",
        mode === "vds" ? "/var/lib/ronix-agent" : join(process.cwd(), "data"),
      ),
      args.yes,
    ));
    const port = await askPort(
      rl,
      value(previous, "PORT", "8787"),
      args.yes,
    );

    const defaultProtect = mode === "vds";
    const protect = await askBoolean(
      rl,
      "Включить вход по ключу?",
      Boolean(value(previous, "AGENT_KEY", "")) || defaultProtect,
      args.yes,
    );
    const existingKey = value(previous, "AGENT_KEY", value(previous, "AGENT_TOKEN", ""));
    let authKey = "";
    let generatedKey: string | null = null;
    if (protect) {
      const keepExisting = existingKey
        ? await askBoolean(rl, "Сохранить текущий ключ доступа?", true, args.yes)
        : false;
      authKey = keepExisting ? existingKey : randomBytes(32).toString("hex");
      if (!keepExisting) generatedKey = authKey;
    }

    const codexPath = await askText(
      rl,
      "Путь к Codex CLI",
      value(previous, "CODEX_PATH", findExecutable("codex") ?? "codex"),
      args.yes,
    );
    const entries: Array<readonly [string, string]> = [
      ["RONIX_DEPLOYMENT_MODE", mode],
      ["RONIX_ACCESS_MODE", accessMode],
      ["HOST", "127.0.0.1"],
      ["PORT", String(port)],
      ["DATA_DIR", dataDir],
      ["PROJECT_ROOTS", projectRoots.join(",")],
      ["CODEX_PATH", codexPath],
      ["AGENT_KEY", authKey],
      ["AUTH_SESSION_DAYS", value(previous, "AUTH_SESSION_DAYS", "30")],
      ["AUTH_COOKIE_SECURE", String(accessMode !== "local")],
      ["TRUST_PROXY", String(accessMode !== "local")],
      ["EVENT_HISTORY_LIMIT", value(previous, "EVENT_HISTORY_LIMIT", "200")],
      ["EVENT_RETENTION", value(previous, "EVENT_RETENTION", "5000")],
      ["SHUTDOWN_TIMEOUT_MS", value(previous, "SHUTDOWN_TIMEOUT_MS", "10000")],
      ["TTS_ENABLED", value(previous, "TTS_ENABLED", "false")],
      ["TTS_PROVIDER", value(previous, "TTS_PROVIDER", "")],
      ["TTS_ENDPOINT", value(previous, "TTS_ENDPOINT", "")],
      ["STT_ENABLED", value(previous, "STT_ENABLED", "false")],
      ["STT_PROVIDER", value(previous, "STT_PROVIDER", "")],
      ["STT_ENDPOINT", value(previous, "STT_ENDPOINT", "")],
    ];

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, serializeEnvFile(entries), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const directoriesToCreate: string[] = [];
    for (const directory of [dataDir, ...projectRoots]) {
      if (!await ensureDirectory(directory)) directoriesToCreate.push(directory);
    }

    let servicePath: string | null = null;
    if (mode === "vds") {
      const generatedDir = join(process.cwd(), ".ronix");
      servicePath = join(generatedDir, "ronix-agent.service");
      await mkdir(generatedDir, { recursive: true });
      await writeFile(
        servicePath,
        renderSystemdService({
          user: userInfo().username,
          appRoot: process.cwd(),
          configPath,
          nodePath: process.execPath,
        }),
      );
    }

    return {
      mode,
      accessMode,
      port,
      configPath,
      servicePath,
      generatedKey,
      directoriesToCreate,
    };
  } finally {
    rl.close();
  }
}

function printResult(result: SetupResult): void {
  const configPrefix = result.configPath === resolve(process.cwd(), ".env")
    ? ""
    : `RONIX_CONFIG=${shellQuote(result.configPath)} `;
  console.log(`\nКонфиг записан: ${result.configPath}`);
  if (result.generatedKey) {
    console.log(`Ключ доступа: ${result.generatedKey}`);
    console.log("Сохраните ключ в менеджере паролей: повторно он не показывается.");
  }
  if (result.directoriesToCreate.length > 0) {
    console.log("\nЭти каталоги требуют создания с подходящими правами:");
    for (const directory of result.directoriesToCreate) {
      console.log(`  sudo mkdir -p ${shellQuote(directory)}`);
      console.log(`  sudo chown ${shellQuote(`${userInfo().username}:${userInfo().username}`)} ${shellQuote(directory)}`);
    }
  }

  console.log("\nПроверка и сборка:");
  console.log(`  ${configPrefix}npm run doctor`);
  console.log("  npm run build");
  if (result.mode === "local") {
    console.log(`  ${configPrefix}npm start`);
    return;
  }

  console.log("\nУстановка systemd-сервиса:");
  console.log(`  sudo cp ${shellQuote(result.servicePath ?? "")} /etc/systemd/system/ronix-agent.service`);
  console.log("  sudo systemctl daemon-reload");
  console.log("  sudo systemctl enable --now ronix-agent");
  if (result.accessMode === "tailscale") {
    console.log(`  sudo tailscale serve --bg http://127.0.0.1:${result.port}`);
  } else {
    console.log(`  Настройте HTTPS reverse proxy на http://127.0.0.1:${result.port}`);
  }
}

async function readExistingConfig(path: string): Promise<Record<string, string> | null> {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function askText(
  rl: Interface,
  label: string,
  fallback: string,
  acceptDefault: boolean,
): Promise<string> {
  if (acceptDefault) return fallback;
  const answer = (await rl.question(`${label} [${fallback}]: `)).trim();
  return answer || fallback;
}

async function askPort(
  rl: Interface,
  fallback: string,
  acceptDefault: boolean,
): Promise<number> {
  const answer = await askText(rl, "Порт backend", fallback, acceptDefault);
  const port = Number.parseInt(answer, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Некорректный порт: ${answer}`);
  }
  return port;
}

async function askBoolean(
  rl: Interface,
  label: string,
  fallback: boolean,
  acceptDefault = false,
): Promise<boolean> {
  if (acceptDefault) return fallback;
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) return fallback;
  if (["д", "да", "y", "yes"].includes(answer)) return true;
  if (["н", "нет", "n", "no"].includes(answer)) return false;
  throw new Error(`Ожидался ответ y или n, получено: ${answer}`);
}

async function askChoice<T extends string>(
  rl: Interface,
  label: string,
  choices: ReadonlyArray<readonly [T, string]>,
  fallback: T,
  acceptDefault: boolean,
): Promise<T> {
  if (acceptDefault) return fallback;
  console.log(`\n${label}`);
  choices.forEach(([, description], index) => {
    const selected = choices[index]?.[0] === fallback ? " (по умолчанию)" : "";
    console.log(`  ${index + 1}. ${description}${selected}`);
  });
  const answer = (await rl.question("> ")).trim();
  if (!answer) return fallback;
  const index = Number.parseInt(answer, 10) - 1;
  const selected = choices[index]?.[0];
  if (!selected) throw new Error(`Некорректный вариант: ${answer}`);
  return selected;
}

function parseArguments(argv: string[]): SetupArguments {
  let mode: DeploymentMode | undefined;
  let output = ".env";
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const [name, inlineValue] = argument.split("=", 2);
    if (name === "--yes" || name === "-y") {
      yes = true;
      continue;
    }
    if (name === "--mode") {
      const selected = inlineValue ?? argv[++index];
      if (selected !== "local" && selected !== "vds") {
        throw new Error("--mode must be local or vds");
      }
      mode = selected;
      continue;
    }
    if (name === "--output") {
      const selected = inlineValue ?? argv[++index];
      if (!selected) throw new Error("--output requires a path");
      output = selected;
      continue;
    }
    throw new Error(`Unknown setup argument: ${argument}`);
  }
  return mode ? { mode, output, yes } : { output, yes };
}

function value(
  values: Record<string, string> | null,
  key: string,
  fallback: string,
): string {
  return values?.[key] ?? fallback;
}

function normalizeAccessMode(value: string): "tailscale" | "reverse-proxy" {
  return value === "reverse-proxy" ? value : "tailscale";
}

function normalizeDeploymentMode(value: string): DeploymentMode {
  return value === "vds" ? value : "local";
}

function absolutePath(path: string): string {
  return absolutePathFrom(path, process.cwd());
}

function absolutePathFrom(path: string, base: string): string {
  const trimmed = path.trim();
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function resolveProjectRoots(input: string, baseRoot: string): string[] {
  const base = absolutePath(baseRoot);
  const roots = input
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => {
      const expandedFromHome = path === "~" || path.startsWith("~/");
      const candidate = absolutePathFrom(path, base);
      if (!isAbsolute(path) && !expandedFromHome) {
        const pathFromBase = relative(base, candidate);
        if (
          pathFromBase === ".."
          || pathFromBase.startsWith(`..${sep}`)
          || isAbsolute(pathFromBase)
        ) {
          throw new Error(`Относительный путь выходит за базовый каталог: ${path}`);
        }
      }
      return candidate;
    });
  return [...new Set(roots)];
}

function findExecutable(command: string): string | null {
  const path = process.env.PATH?.split(process.platform === "win32" ? ";" : ":") ?? [];
  for (const directory of path) {
    const candidate = join(directory, command);
    if (isAbsolute(candidate) && basename(candidate) === command && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%")}"`;
}

function systemdPath(value: string): string {
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\x5c")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09")
    .replaceAll("\"", "\\x22")
    .replaceAll("'", "\\x27");
}

function systemdUser(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*[$]?$/.test(value)) {
    throw new Error(`Unsupported systemd user name: ${value}`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class SetupCancelled extends Error {}

async function main(): Promise<void> {
  try {
    printResult(await runSetup(parseArguments(process.argv.slice(2))));
  } catch (error) {
    if (error instanceof SetupCancelled) {
      console.log("Настройка отменена.");
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) void main();
