import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AccessUser } from "./access.js";

export type RuntimeConfig = {
  root: string;
  appRoot: string;
  codexPath: string;
  authFile: string;
  outlineConfig?: string;
  outlineApiKey?: string;
  outlineFileAuth?: { helper: string; keyFile: string };
  owner?: { subject: string; projectRoots: string[]; codexHomeAlias: string };
};
export type UserRuntime = { socket: string; stop(): Promise<void> };

export function sandboxArguments(root: string, appRoot: string, codexPath: string): string[] {
  // SSH resolves the real UID through NSS, independently of HOME.
  // Keep the host account database private and point the account at this user's home.
  const identityDirectory = join(root, ".runtime-etc");
  mkdirSync(identityDirectory, { recursive: true, mode: 0o700 });
  const uid = process.getuid!();
  const gid = process.getgid!();
  const home = join(root, "home");
  if (/[\r\n:]/.test(home)) throw new Error("Invalid runtime home path");
  for (const [name, contents] of Object.entries({
    passwd: `ronix:x:${uid}:${gid}::${home}:/bin/bash\n`,
    group: `ronix:x:${gid}:\n`,
    "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
  })) writeFileSync(join(identityDirectory, name), contents, { mode: 0o600 });
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net", "--clearenv"];
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/etc/ssl", "/etc/resolv.conf", "/etc/hosts"]) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  for (const name of ["passwd", "group", "nsswitch.conf"]) {
    args.push("--ro-bind", join(identityDirectory, name), "/etc/" + name);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  // Bind application files individually: the checkout's .env and .git stay outside.
  for (const name of ["dist", "node_modules", "public", "package.json"]) {
    const path = join(appRoot, name);
    args.push("--ro-bind", path, path);
  }
  args.push("--ro-bind", dirname(codexPath), "/run/ronix-codex-bin");
  args.push("--bind", root, root, "--chdir", root);
  return args;
}

// The host helper and its one secret are exposed only to Outline-enabled users.
export function outlineRuntimeAuth(modules: readonly string[], config: Pick<RuntimeConfig, "outlineConfig" | "outlineApiKey" | "outlineFileAuth">) {
  if (!modules.includes("outline") || !config.outlineConfig) return { config: "", env: {}, mounts: [] as string[] };
  if (config.outlineFileAuth) {
    const { helper, keyFile } = config.outlineFileAuth;
    let section = "";
    let inserted = false;
    const lines = config.outlineConfig.split("\n").flatMap(line => {
      if (/^\s*\[/.test(line)) section = line.replace(/\s*#.*$/, "").trim();
      if (section !== "[mcp_servers.outline]") return [line];
      if (/^\s*(bearer_token_env_var|http_headers_helper)\s*=/.test(line)) return [];
      if (/^\s*\[mcp_servers\.outline\]/.test(line)) {
        inserted = true;
        return [line, "http_headers_helper = " + JSON.stringify(helper)];
      }
      return [line];
    });
    if (!inserted) throw new Error("Outline config must contain [mcp_servers.outline]");
    return { config: lines.join("\n"), env: {}, mounts: ["--ro-bind", helper, helper, "--ro-bind", keyFile, keyFile] };
  }
  return { config: config.outlineConfig, env: config.outlineApiKey ? { OUTLINE_API_KEY: config.outlineApiKey } : {}, mounts: [] as string[] };
}

export async function startUserRuntime(user: AccessUser, config: RuntimeConfig): Promise<UserRuntime> {
  const root = join(resolve(config.root), user.id);
  const appRoot = resolve(config.appRoot);
  const codexPath = realpathSync(config.codexPath);
  const socket = join(root, "worker.sock");
  const codexHome = join(root, "codex");
  const owner = config.owner?.subject === user.subject ? config.owner : undefined;
  for (const dir of [root, codexHome, join(root, "data"), join(root, "projects"), join(root, "home")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(config.authFile)) throw new Error("Shared Codex auth.json is missing; sign in on the server first");
  copyFileSync(config.authFile, join(codexHome, "auth.json"));
  const outline = outlineRuntimeAuth(user.modules, config);
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n' + outline.config, { mode: 0o600 });
  rmSync(socket, { force: true });
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin", HOME: join(root, "home"), CODEX_HOME: owner?.codexHomeAlias ?? codexHome,
    LANG: "C.UTF-8", NODE_ENV: "production", DATA_DIR: join(root, "data"),
    PROJECT_ROOTS: owner?.projectRoots.join(",") || join(root, "projects"), CODEX_PATH: "/run/ronix-codex-bin/" + codexPath.split("/").at(-1),
    HOST: "127.0.0.1", RONIX_DEPLOYMENT_MODE: "vds", RONIX_ACCESS_MODE: "reverse-proxy",
    TRUST_PROXY: "true", RONIX_WORKER_SOCKET: socket, RONIX_USER_MODULES: JSON.stringify(user.modules),
    RONIX_USER_ROLE: user.role, RONIX_CHAT_MODEL: user.chatModel ?? "",
  };
  Object.assign(env, outline.env);
  const args = sandboxArguments(root, appRoot, codexPath);
  if (owner) {
    args.push("--bind", codexHome, owner.codexHomeAlias);
    // Only the explicitly configured owner may use the service account's SSH keys.
    const sshDirectory = join(userInfo().homedir, ".ssh");
    if (existsSync(sshDirectory)) args.push("--ro-bind", sshDirectory, join(root, "home", ".ssh"));
    for (const path of owner.projectRoots) args.push("--bind", path, path);
  }
  args.push(...outline.mounts);
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push(process.execPath, join(appRoot, "dist/src/user-worker.js"));
  const child = spawn("bwrap", args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  let errorOutput = "";
  child.stderr.on("data", data => { errorOutput = (errorOutput + data).slice(-2000); });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("User runtime startup timed out")); }, 15_000);
    const fail = (error: Error) => { clearTimeout(timer); reject(error); };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("User runtime exited before ready: " + errorOutput)));
    let output = "";
    child.stdout.on("data", data => {
      output = (output + data).slice(-4000);
      if (output.includes("RONIX_WORKER_READY")) { clearTimeout(timer); resolveReady(); }
    });
  });
  return { socket, stop: () => stopChild(child) };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveStop => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    child.kill("SIGTERM");
  });
}
