import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function validateProjectPath(
  inputPath: string,
  allowedRoots: string[],
): Promise<string> {
  const candidate = await realpath(resolve(inputPath));
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));

  if (!roots.some((root) => isWithin(root, candidate))) {
    throw new Error(`Project path must be inside: ${roots.join(", ")}`);
  }

  return candidate;
}
