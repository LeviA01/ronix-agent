export type SessionStatus = "ready" | "running" | "stopped" | "error";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
};

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
};

export type Session = {
  id: string;
  projectId: string;
  threadId: string | null;
  activeTurnId: string | null;
  status: SessionStatus;
  sandboxMode: SandboxMode;
  model: string | null;
  reasoningEffort: string | null;
  lastError: string | null;
  createdAt: string;
  lastActivityAt: string;
};

export type PendingApproval = {
  id: string;
  sessionId: string;
  method: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type StoredEvent = {
  sequence: number;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};
