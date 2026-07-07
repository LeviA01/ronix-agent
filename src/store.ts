import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Project,
  ProjectKind,
  SandboxMode,
  Session,
  SessionPurpose,
  SessionStatus,
  StoredEvent,
} from "./types.js";

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  created_at: string;
};

type SessionRow = {
  id: string;
  project_id: string;
  purpose: SessionPurpose;
  thread_id: string | null;
  active_turn_id: string | null;
  status: SessionStatus;
  sandbox_mode: SandboxMode;
  model: string | null;
  reasoning_effort: string | null;
  last_error: string | null;
  created_at: string;
  last_activity_at: string;
};

type EventRow = {
  sequence: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
};

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    purpose: row.purpose,
    threadId: row.thread_id,
    activeTurnId: row.active_turn_id,
    status: row.status,
    sandboxMode: row.sandbox_mode,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    lastError: row.last_error,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

function eventFromRow(row: EventRow): StoredEvent {
  return {
    sequence: row.sequence,
    sessionId: row.session_id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "ronix-agent.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'dev',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'general',
        thread_id TEXT,
        active_turn_id TEXT,
        status TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
        model TEXT,
        reasoning_effort TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_session_sequence
      ON events(session_id, sequence);
    `);
    this.migrate();
  }

  private migrate(): void {
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const projectNames = new Set(projectColumns.map((column) => column.name));
    if (!projectNames.has("kind")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'dev'");
    }

    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const sessionNames = new Set(sessionColumns.map((column) => column.name));
    if (!sessionNames.has("purpose")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general'");
    }
    if (!sessionNames.has("active_turn_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN active_turn_id TEXT");
    }
    if (!sessionNames.has("sandbox_mode")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write'",
      );
    }
    if (!sessionNames.has("model")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
    }
    if (!sessionNames.has("reasoning_effort")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_project_learning_purpose
      ON sessions(project_id, purpose)
      WHERE purpose IN ('course', 'practice')
    `);
  }

  close(): void {
    this.db.close();
  }

  createProject(project: Project): Project {
    this.db
      .prepare("INSERT INTO projects (id, name, path, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.path, project.kind, project.createdAt);
    return project;
  }

  listProjects(): Project[] {
    return (
      this.db
        .prepare("SELECT id, name, path, kind, created_at FROM projects ORDER BY created_at DESC")
        .all() as ProjectRow[]
    ).map(projectFromRow);
  }

  getProject(id: string): Project | null {
    const row = this.db
      .prepare("SELECT id, name, path, kind, created_at FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  updateProjectKind(id: string, kind: ProjectKind): Project {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    this.db.prepare("UPDATE projects SET kind = ? WHERE id = ?").run(kind, id);
    return { ...current, kind };
  }

  createSession(session: Session): Session {
    this.db
      .prepare(`
        INSERT INTO sessions (
          id, project_id, purpose, thread_id, active_turn_id, status, sandbox_mode, model,
          reasoning_effort, last_error, created_at, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.projectId,
        session.purpose,
        session.threadId,
        session.activeTurnId,
        session.status,
        session.sandboxMode,
        session.model,
        session.reasoningEffort,
        session.lastError,
        session.createdAt,
        session.lastActivityAt,
      );
    return session;
  }

  listSessions(projectId?: string): Session[] {
    const rows = projectId
      ? (this.db
          .prepare(`
            SELECT id, project_id, thread_id, active_turn_id, status, sandbox_mode,
                   purpose, model, reasoning_effort, last_error, created_at, last_activity_at
            FROM sessions WHERE project_id = ? ORDER BY created_at DESC
          `)
          .all(projectId) as SessionRow[])
      : (this.db
          .prepare(`
            SELECT id, project_id, thread_id, active_turn_id, status, sandbox_mode,
                   purpose, model, reasoning_effort, last_error, created_at, last_activity_at
            FROM sessions ORDER BY created_at DESC
          `)
          .all() as SessionRow[]);
    return rows.map(sessionFromRow);
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE id = ?
      `)
      .get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getSessionByPurpose(projectId: string, purpose: SessionPurpose): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE project_id = ? AND purpose = ?
      `)
      .get(projectId, purpose) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getSessionByThreadId(threadId: string): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE thread_id = ?
      `)
      .get(threadId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updateSession(
    id: string,
    update: {
      threadId?: string | null;
      activeTurnId?: string | null;
      status?: SessionStatus;
      sandboxMode?: SandboxMode;
      model?: string | null;
      reasoningEffort?: string | null;
      lastError?: string | null;
    },
  ): Session {
    const current = this.getSession(id);
    if (!current) throw new Error(`Session not found: ${id}`);

    const next: Session = {
      ...current,
      threadId: update.threadId === undefined ? current.threadId : update.threadId,
      activeTurnId:
        update.activeTurnId === undefined ? current.activeTurnId : update.activeTurnId,
      status: update.status ?? current.status,
      sandboxMode: update.sandboxMode ?? current.sandboxMode,
      model: update.model === undefined ? current.model : update.model,
      reasoningEffort:
        update.reasoningEffort === undefined
          ? current.reasoningEffort
          : update.reasoningEffort,
      lastError: update.lastError === undefined ? current.lastError : update.lastError,
      lastActivityAt: new Date().toISOString(),
    };

    this.db
      .prepare(`
        UPDATE sessions
        SET thread_id = ?, active_turn_id = ?, status = ?, sandbox_mode = ?,
            model = ?, reasoning_effort = ?, last_error = ?, last_activity_at = ?
        WHERE id = ?
      `)
      .run(
        next.threadId,
        next.activeTurnId,
        next.status,
        next.sandboxMode,
        next.model,
        next.reasoningEffort,
        next.lastError,
        next.lastActivityAt,
        id,
      );
    return next;
  }

  recoverRunningSessions(message = "Ronix restarted while the turn was running"): Session[] {
    const running = this.listSessions().filter((session) => session.status === "running");
    return running.map((session) =>
      this.updateSession(session.id, {
        status: "error",
        activeTurnId: null,
        lastError: message,
      }),
    );
  }

  addEvent(sessionId: string, type: string, payload: unknown): StoredEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT INTO events (session_id, type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(sessionId, type, JSON.stringify(payload), createdAt);

    return {
      sequence: Number(result.lastInsertRowid),
      sessionId,
      type,
      payload,
      createdAt,
    };
  }

  listEvents(sessionId: string, after = 0): StoredEvent[] {
    return (
      this.db
        .prepare(`
          SELECT sequence, session_id, type, payload, created_at
          FROM events
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC
        `)
        .all(sessionId, after) as EventRow[]
    ).map(eventFromRow);
  }

  listRecentEvents(sessionId: string, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare(`
        SELECT sequence, session_id, type, payload, created_at
        FROM (
          SELECT sequence, session_id, type, payload, created_at
          FROM events
          WHERE session_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        )
        ORDER BY sequence ASC
      `)
      .all(sessionId, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  listEventsBefore(sessionId: string, before: number, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare(`
        SELECT sequence, session_id, type, payload, created_at
        FROM (
          SELECT sequence, session_id, type, payload, created_at
          FROM events
          WHERE session_id = ? AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?
        )
        ORDER BY sequence ASC
      `)
      .all(sessionId, before, limit) as EventRow[];
    return rows.map(eventFromRow);
  }

  pruneEvents(sessionId: string, maximum: number): number {
    const result = this.db
      .prepare(`
        DELETE FROM events
        WHERE session_id = ?
          AND sequence NOT IN (
            SELECT sequence FROM events
            WHERE session_id = ?
            ORDER BY sequence DESC
            LIMIT ?
          )
      `)
      .run(sessionId, sessionId, maximum);
    return Number(result.changes);
  }

  deleteEventsByTypes(sessionId: string, types: string[]): number {
    if (types.length === 0) return 0;
    const placeholders = types.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM events WHERE session_id = ? AND type IN (${placeholders})`)
      .run(sessionId, ...types);
    return Number(result.changes);
  }
}
