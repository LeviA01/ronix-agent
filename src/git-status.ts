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
  upstream: string | null;
  ahead: number;
  behind: number;
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

export type GitAction = "fetch" | "pull" | "push";

export type GitActionResult = {
  action: GitAction;
  ok: true;
  output: string;
  status: GitStatus;
};

export class GitActionError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

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
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      changedCount: 0,
      files: emptyFiles(),
      error: shortGitError(error),
    };
  }

  const parsed = parseGitStatus(statusOutput);
  const tracking = await readGitTracking(cwd);
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
    upstream: tracking.upstream ?? parsed.upstream,
    ahead: tracking.ahead ?? parsed.ahead,
    behind: tracking.behind ?? parsed.behind,
    error: null,
  };
}

export function parseGitStatus(output: string): GitStatus {
  const files = emptyFiles();
  const changedPaths = new Set<string>();
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const branchInfo = parseBranchInfo(line.slice(3));
      branch = branchInfo.branch;
      upstream = branchInfo.upstream;
      ahead = branchInfo.ahead;
      behind = branchInfo.behind;
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
    upstream,
    ahead,
    behind,
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

export function isGitAction(action: string): action is GitAction {
  return action === "fetch" || action === "pull" || action === "push";
}

export async function runGitAction(cwd: string, action: GitAction): Promise<GitActionResult> {
  const args: Record<GitAction, string[]> = {
    fetch: ["fetch", "--prune"],
    pull: ["pull", "--ff-only"],
    push: ["push"],
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      args[action],
      { cwd, timeout: 60_000, maxBuffer: 1_000_000 },
    );
    return {
      action,
      ok: true,
      output: truncateOutput([stdout, stderr].filter(Boolean).join("\n").trim()),
      status: await readGitStatus(cwd),
    };
  } catch (error) {
    throw new GitActionError(shortGitError(error), truncateOutput(gitCommandOutput(error)));
  }
}

async function readGitTracking(cwd: string): Promise<{
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}> {
  let upstream: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { cwd, timeout: 5_000, maxBuffer: 64_000 },
    );
    upstream = stdout.trim() || null;
  } catch {
    return { upstream: null, ahead: null, behind: null };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      { cwd, timeout: 5_000, maxBuffer: 64_000 },
    );
    const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/);
    const ahead = Number(aheadRaw);
    const behind = Number(behindRaw);
    return {
      upstream,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
    };
  } catch {
    return { upstream, ahead: null, behind: null };
  }
}

function parseBranchInfo(value: string): Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind"> {
  const detailMatch = value.match(/\s+\[(.+)\]$/);
  const detail = detailMatch?.[1] ?? "";
  const branchPart = detailMatch?.index === undefined
    ? value.trim()
    : value.slice(0, detailMatch.index).trim();
  let branch: string | null;
  let upstream: string | null = null;

  if (branchPart.startsWith("No commits yet on ")) {
    branch = branchPart.slice("No commits yet on ".length).trim() || null;
  } else if (branchPart.startsWith("HEAD ")) {
    branch = "HEAD";
  } else {
    const [branchName, upstreamName] = branchPart.split("...", 2);
    branch = branchName?.trim() || null;
    upstream = upstreamName?.trim() || null;
  }

  return {
    branch,
    upstream,
    ahead: numberFromDetail(detail, "ahead"),
    behind: numberFromDetail(detail, "behind"),
  };
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

function numberFromDetail(detail: string, key: "ahead" | "behind"): number {
  const match = new RegExp(`${key} (\\d+)`).exec(detail);
  return match ? Number(match[1]) : 0;
}

function gitCommandOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeOutput = error as Error & { stderr?: string; stdout?: string };
  return [maybeOutput.stdout, maybeOutput.stderr, error.message]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateOutput(output: string): string {
  if (output.length <= 4_000) return output;
  return `${output.slice(0, 4_000)}\n…`;
}
