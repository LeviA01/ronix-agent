import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitFileState =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "untracked"
  | "unknown";

export type GitChangedFile = {
  path: string;
  oldPath: string | null;
  index: string;
  worktree: string;
  state: GitFileState;
};

export type GitStatus = {
  repoFound: boolean;
  root: string | null;
  branch: string | null;
  clean: boolean;
  changedCount: number;
  files: {
    staged: GitChangedFile[];
    unstaged: GitChangedFile[];
    untracked: GitChangedFile[];
    conflicted: GitChangedFile[];
  };
  error: string | null;
};

const EMPTY_FILES: GitStatus["files"] = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

export async function readGitStatus(cwd: string): Promise<GitStatus> {
  let statusOutput: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-b"],
      { cwd, timeout: 5_000, maxBuffer: 512_000 },
    );
    statusOutput = stdout;
  } catch (error) {
    return {
      repoFound: false,
      root: null,
      branch: null,
      clean: true,
      changedCount: 0,
      files: emptyFiles(),
      error: shortGitError(error),
    };
  }

  const parsed = parseGitStatus(statusOutput);
  let root: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 5_000, maxBuffer: 64_000 },
    );
    root = stdout.trim() || null;
  } catch {
    root = null;
  }

  return {
    ...parsed,
    repoFound: true,
    root,
    error: null,
  };
}

export function parseGitStatus(output: string): GitStatus {
  const files = emptyFiles();
  const changedPaths = new Set<string>();
  let branch: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      branch = parseBranch(line.slice(3));
      continue;
    }
    if (line.length < 4) continue;

    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    const rawPath = line.slice(3);
    const file = parseChangedFile(index, worktree, rawPath);
    if (!file) continue;

    changedPaths.add(file.path);

    if (file.state === "untracked") {
      files.untracked.push(file);
      continue;
    }
    if (isConflict(index, worktree)) {
      files.conflicted.push(file);
      continue;
    }
    if (index !== " ") files.staged.push(file);
    if (worktree !== " ") files.unstaged.push(file);
  }

  return {
    repoFound: true,
    root: null,
    branch,
    clean: changedPaths.size === 0,
    changedCount: changedPaths.size,
    files,
    error: null,
  };
}

function emptyFiles(): GitStatus["files"] {
  return {
    staged: [...EMPTY_FILES.staged],
    unstaged: [...EMPTY_FILES.unstaged],
    untracked: [...EMPTY_FILES.untracked],
    conflicted: [...EMPTY_FILES.conflicted],
  };
}

function parseBranch(value: string): string | null {
  if (value.startsWith("No commits yet on ")) return value.slice("No commits yet on ".length).trim();
  if (value.startsWith("HEAD ")) return "HEAD";
  return value.split("...", 1)[0]?.trim() || null;
}

function parseChangedFile(index: string, worktree: string, rawPath: string): GitChangedFile | null {
  if (index === "!" && worktree === "!") return null;
  if (index === "?" && worktree === "?") {
    return {
      path: rawPath,
      oldPath: null,
      index,
      worktree,
      state: "untracked",
    };
  }

  const renameSeparator = " -> ";
  const renameIndex = rawPath.indexOf(renameSeparator);
  const oldPath = renameIndex >= 0 ? rawPath.slice(0, renameIndex) : null;
  const path = renameIndex >= 0 ? rawPath.slice(renameIndex + renameSeparator.length) : rawPath;
  if (!path) return null;

  return {
    path,
    oldPath,
    index,
    worktree,
    state: statusState(index, worktree),
  };
}

function statusState(index: string, worktree: string): GitFileState {
  if (isConflict(index, worktree)) return "unmerged";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "C" || worktree === "C") return "copied";
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "M" || worktree === "M") return "modified";
  return "unknown";
}

function isConflict(index: string, worktree: string): boolean {
  return (
    index === "U"
    || worktree === "U"
    || (index === "A" && worktree === "A")
    || (index === "D" && worktree === "D")
  );
}

function shortGitError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeOutput = error as Error & { stderr?: string; stdout?: string; code?: unknown };
  const detail = maybeOutput.stderr || maybeOutput.stdout || error.message;
  const firstLine = detail.split(/\r?\n/).find((line) => line.trim())?.trim();
  return firstLine || `git exited with code ${String(maybeOutput.code ?? "unknown")}`;
}
