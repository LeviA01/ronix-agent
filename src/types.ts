export type SessionStatus = "ready" | "running" | "stopped" | "error";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ProjectKind = "dev" | "learning";
export type SessionPurpose = "general" | "chat" | "course" | "theory" | "practice" | "materials";
export type ChatIntent = "ask" | "act";
export type MessageRole = "user" | "assistant";
export type MemoryScopeType = "global" | "chat" | "project" | "learning";
export type MemoryKind = "preference" | "fact" | "decision" | "task" | "summary";

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
  kind: ProjectKind;
  createdAt: string;
};

export type Session = {
  id: string;
  projectId: string | null;
  purpose: SessionPurpose;
  title?: string | null;
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

export type ArchivedMessage = {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: MessageRole;
  text: string;
  createdAt: string;
};

export type MemoryItem = {
  id: string;
  scopeType: MemoryScopeType;
  scopeId: string | null;
  kind: MemoryKind;
  content: string;
  confidence: number;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type LearningTopic = {
  projectId: string;
  title: string;
  score: number;
  confidence: number;
  lastEvidence: string;
  updatedAt: string;
};

export type LearningObservation = {
  id: string;
  projectId: string;
  topic: string;
  kind: "practice" | "theory" | "control" | "note";
  scoreDelta: number;
  resultScore: number | null;
  rationale: string;
  sourceSessionId: string | null;
  createdAt: string;
};

export type LearningRoadmapItem = {
  id: string;
  projectId: string;
  lane: "now" | "next" | "later";
  title: string;
  status: "todo" | "done" | "dropped";
  position: number;
  rationale: string | null;
  createdAt: string;
  updatedAt: string;
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

export type TheoryMaterialAttempt = {
  projectId: string;
  materialId: string;
  revision: string;
  answersByBlock: Record<string, unknown>;
  correct: number;
  total: number;
  completedAt: string;
};
