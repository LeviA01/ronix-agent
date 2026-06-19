import { execFile } from "node:child_process";
import { stat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolvedRoots(allowedRoots: string[]): Promise<string[]> {
  return Promise.all(allowedRoots.map((root) => realpath(root)));
}

function validateFolderName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Project folder must be a single directory name");
  }
  return name;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export type ProjectPathResolution = {
  path: string;
  exists: boolean;
  folder: string;
};

export async function resolveProjectPath(
  inputPath: string,
  allowedRoots: string[],
): Promise<ProjectPathResolution> {
  const roots = await resolvedRoots(allowedRoots);
  if (roots.length === 0) throw new Error("No project roots are configured");
  const creationRoot = roots[0] as string;
  const input = inputPath.trim();

  if (!isAbsolute(input)) {
    const folder = validateFolderName(input);
    for (const root of roots) {
      const candidate = resolve(root, folder);
      if (await exists(candidate)) {
        const realCandidate = await realpath(candidate);
        if (!isWithin(root, realCandidate)) {
          throw new Error("Project path must be inside: " + roots.join(", "));
        }
        return { path: realCandidate, exists: true, folder };
      }
    }
    return { path: resolve(creationRoot, folder), exists: false, folder };
  }

  const candidate = resolve(input);
  if (await exists(candidate)) {
    const realCandidate = await realpath(candidate);
    if (!roots.some((root) => isWithin(root, realCandidate))) {
      throw new Error("Project path must be inside: " + roots.join(", "));
    }
    return { path: realCandidate, exists: true, folder: realCandidate.split(sep).at(-1) ?? realCandidate };
  }

  const parent = resolve(candidate, "..");
  if (!roots.some((root) => isWithin(root, parent))) {
    throw new Error("Project path must be inside: " + roots.join(", "));
  }
  const folder = validateFolderName(candidate.split(sep).at(-1) ?? "");
  return { path: candidate, exists: false, folder };
}

export async function validateProjectPath(
  inputPath: string,
  allowedRoots: string[],
): Promise<string> {
  const resolution = await resolveProjectPath(inputPath, allowedRoots);
  if (!resolution.exists) throw new Error("Project directory does not exist: " + resolution.path);
  return resolution.path;
}

export async function createProjectDirectory(path: string, allowedRoots: string[]): Promise<string> {
  const resolution = await resolveProjectPath(path, allowedRoots);
  if (resolution.exists) return resolution.path;

  let created = false;
  try {
    await mkdir(resolution.path);
    created = true;
    await execFileAsync("git", ["init", resolution.path]);
    return await realpath(resolution.path);
  } catch (error) {
    if (created) await rm(resolution.path, { recursive: true, force: true });
    throw error;
  }
}
