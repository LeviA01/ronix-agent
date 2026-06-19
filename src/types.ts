export type SessionStatus = "ready" | "running" | "stopped" | "error";

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
  status: SessionStatus;
  lastError: string | null;
  createdAt: string;
  lastActivityAt: string;
};

export type StoredEvent = {
  sequence: number;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};
