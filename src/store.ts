import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ArchivedMessage,
  LearningObservation,
  LearningRoadmapItem,
  LearningTopic,
  MemoryItem,
  MemoryKind,
  MemoryScopeType,
  MessageRole,
  Project,
  ProjectKind,
  SandboxMode,
  Session,
  SessionPurpose,
  SessionStatus,
  StoredEvent,
  TheoryMaterialAttempt,
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
  project_id: string | null;
  purpose: SessionPurpose;
  title: string | null;
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

type MessageRow = {
  id: string;
  session_id: string;
  turn_id: string | null;
  role: MessageRole;
  text: string;
  created_at: string;
};

type MemoryRow = {
  id: string;
  scope_type: MemoryScopeType;
  scope_id: string | null;
  kind: MemoryKind;
  content: string;
  confidence: number;
  source_session_id: string | null;
  source_turn_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type LearningTopicRow = {
  project_id: string;
  title: string;
  score: number;
  confidence: number;
  last_evidence: string;
  updated_at: string;
};

type LearningObservationRow = {
  id: string;
  project_id: string;
  topic: string;
  kind: LearningObservation["kind"];
  score_delta: number;
  result_score: number | null;
  rationale: string;
  source_session_id: string | null;
  created_at: string;
};

type LearningRoadmapRow = {
  id: string;
  project_id: string;
  lane: LearningRoadmapItem["lane"];
  title: string;
  status: LearningRoadmapItem["status"];
  position: number;
  rationale: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: string;
};

type TheoryMaterialAttemptRow = {
  project_id: string;
  material_id: string;
  revision: string;
  answers_by_block: string;
  correct: number;
  total: number;
  completed_at: string;
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
    title: row.title,
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

function messageFromRow(row: MessageRow): ArchivedMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
  };
}

function memoryFromRow(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    sourceSessionId: row.source_session_id,
    sourceTurnId: row.source_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function learningTopicFromRow(row: LearningTopicRow): LearningTopic {
  return {
    projectId: row.project_id,
    title: row.title,
    score: row.score,
    confidence: row.confidence,
    lastEvidence: row.last_evidence,
    updatedAt: row.updated_at,
  };
}

function learningObservationFromRow(row: LearningObservationRow): LearningObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    topic: row.topic,
    kind: row.kind,
    scoreDelta: row.score_delta,
    resultScore: row.result_score,
    rationale: row.rationale,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
  };
}

function learningRoadmapFromRow(row: LearningRoadmapRow): LearningRoadmapItem {
  return {
    id: row.id,
    projectId: row.project_id,
    lane: row.lane,
    title: row.title,
    status: row.status,
    position: row.position,
    rationale: row.rationale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

function materialAttemptFromRow(row: TheoryMaterialAttemptRow): TheoryMaterialAttempt {
  return {
    projectId: row.project_id,
    materialId: row.material_id,
    revision: row.revision,
    answersByBlock: JSON.parse(row.answers_by_block) as Record<string, unknown>,
    correct: row.correct,
    total: row.total,
    completedAt: row.completed_at,
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
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'general',
        title TEXT,
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

      CREATE TABLE IF NOT EXISTS theory_material_attempts (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        material_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        answers_by_block TEXT NOT NULL,
        correct INTEGER NOT NULL,
        total INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, material_id, revision)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_session_created
      ON messages(session_id, created_at, id);

      CREATE TABLE IF NOT EXISTS chat_project_links (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'chat', 'project', 'learning')),
        scope_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'task', 'summary')),
        content TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memory_scope_hash_active
      ON memory_items(scope_type, ifnull(scope_id, ''), normalized_hash)
      WHERE deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS memory_scope_updated
      ON memory_items(scope_type, scope_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_suppressions (
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        normalized_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_type, scope_id, normalized_hash)
      );

      CREATE TABLE IF NOT EXISTS learning_profiles (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_topics (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        last_evidence TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, title)
      );

      CREATE TABLE IF NOT EXISTS learning_observations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('practice', 'theory', 'control', 'note')),
        score_delta INTEGER NOT NULL,
        result_score REAL,
        rationale TEXT NOT NULL,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS learning_observations_project_created
      ON learning_observations(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS learning_roadmap_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        lane TEXT NOT NULL CHECK (lane IN ('now', 'next', 'later')),
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'done', 'dropped')),
        position INTEGER NOT NULL,
        rationale TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS learning_roadmap_project_lane
      ON learning_roadmap_items(project_id, lane, position);

      CREATE TABLE IF NOT EXISTS learning_legacy_migrations (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        imported_at TEXT NOT NULL,
        archive_path TEXT
      );
    `);
    this.ensureMemoryFts();
    this.migrate();
  }

  private ensureMemoryFts(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content,
        content='memory_items',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF content ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  private migrate(): void {
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const projectNames = new Set(projectColumns.map((column) => column.name));
    if (!projectNames.has("kind")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'dev'");
    }

    let sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
      notnull: number;
    }>;
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
    if (!sessionNames.has("title")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
      sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{
        name: string;
        notnull: number;
      }>;
    }
    if (sessionColumns.find((column) => column.name === "project_id")?.notnull === 1) {
      this.rebuildSessionsForChat();
    }
    const observationColumns = this.db.prepare("PRAGMA table_info(learning_observations)")
      .all() as Array<{ name: string }>;
    if (!observationColumns.some((column) => column.name === "result_score")) {
      this.db.exec("ALTER TABLE learning_observations ADD COLUMN result_score REAL");
    }
    this.db.exec(`
      DROP INDEX IF EXISTS sessions_project_learning_purpose;
      CREATE UNIQUE INDEX sessions_project_learning_purpose
      ON sessions(project_id, purpose)
      WHERE purpose IN ('course', 'theory', 'practice', 'materials');
    `);
  }

  private rebuildSessionsForChat(): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE sessions_next (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL DEFAULT 'general',
          title TEXT,
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
        INSERT INTO sessions_next (
          id, project_id, purpose, title, thread_id, active_turn_id, status, sandbox_mode,
          model, reasoning_effort, last_error, created_at, last_activity_at
        )
        SELECT id, project_id, purpose, title, thread_id, active_turn_id, status, sandbox_mode,
               model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_next RENAME TO sessions;
        COMMIT;
      `);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
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

  updateProject(
    id: string,
    update: {
      name?: string;
      path?: string;
      kind?: ProjectKind;
    },
  ): Project {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project not found: ${id}`);
    const next: Project = {
      ...current,
      name: update.name ?? current.name,
      path: update.path ?? current.path,
      kind: update.kind ?? current.kind,
    };
    this.db
      .prepare("UPDATE projects SET name = ?, path = ?, kind = ? WHERE id = ?")
      .run(next.name, next.path, next.kind, id);
    return next;
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return result.changes > 0;
  }

  createSession(session: Session): Session {
    this.db
      .prepare(`
        INSERT INTO sessions (
          id, project_id, purpose, title, thread_id, active_turn_id, status, sandbox_mode, model,
          reasoning_effort, last_error, created_at, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.projectId,
        session.purpose,
        session.title ?? null,
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
            SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
                   purpose, model, reasoning_effort, last_error, created_at, last_activity_at
            FROM sessions WHERE project_id = ? ORDER BY created_at DESC
          `)
          .all(projectId) as SessionRow[])
      : (this.db
          .prepare(`
            SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
                   purpose, model, reasoning_effort, last_error, created_at, last_activity_at
            FROM sessions ORDER BY created_at DESC
          `)
          .all() as SessionRow[]);
    return rows.map(sessionFromRow);
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE id = ?
      `)
      .get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getSessionByPurpose(projectId: string, purpose: SessionPurpose): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE project_id = ? AND purpose = ?
      `)
      .get(projectId, purpose) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  getSessionByThreadId(threadId: string): Session | null {
    const row = this.db
      .prepare(`
        SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
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
      title?: string | null;
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
      title: update.title === undefined ? current.title ?? null : update.title,
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
        SET title = ?, thread_id = ?, active_turn_id = ?, status = ?, sandbox_mode = ?,
            model = ?, reasoning_effort = ?, last_error = ?, last_activity_at = ?
        WHERE id = ?
      `)
      .run(
        next.title ?? null,
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

  latestEventSequence(sessionId: string): number {
    const row = this.db.prepare(
      "SELECT max(sequence) AS sequence FROM events WHERE session_id = ?",
    ).get(sessionId) as { sequence: number | null };
    return row.sequence ?? 0;
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

  listChatSessions(): Session[] {
    return (
      this.db.prepare(`
        SELECT id, project_id, title, thread_id, active_turn_id, status, sandbox_mode,
               purpose, model, reasoning_effort, last_error, created_at, last_activity_at
        FROM sessions WHERE purpose = 'chat' ORDER BY last_activity_at DESC
      `).all() as SessionRow[]
    ).map(sessionFromRow);
  }

  addMessage(message: ArchivedMessage): ArchivedMessage {
    this.db.prepare(`
      INSERT INTO messages (id, session_id, turn_id, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.turnId,
      message.role,
      message.text,
      message.createdAt,
    );
    return message;
  }

  listMessages(sessionId: string, limit = 200, before?: string): ArchivedMessage[] {
    const rows = before
      ? this.db.prepare(`
          SELECT id, session_id, turn_id, role, text, created_at
          FROM messages
          WHERE session_id = ? AND created_at < ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(sessionId, before, limit) as MessageRow[]
      : this.db.prepare(`
          SELECT id, session_id, turn_id, role, text, created_at
          FROM messages
          WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(sessionId, limit) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  replaceChatProjects(sessionId: string, projectIds: string[]): string[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM chat_project_links WHERE session_id = ?").run(sessionId);
      const insert = this.db.prepare(`
        INSERT INTO chat_project_links (session_id, project_id, created_at) VALUES (?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const projectId of [...new Set(projectIds)]) insert.run(sessionId, projectId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listChatProjectIds(sessionId);
  }

  listChatProjectIds(sessionId: string): string[] {
    return (this.db.prepare(`
      SELECT project_id FROM chat_project_links WHERE session_id = ? ORDER BY created_at, project_id
    `).all(sessionId) as Array<{ project_id: string }>).map((row) => row.project_id);
  }

  insertMemory(item: MemoryItem, normalizedHash: string): MemoryItem {
    this.db.prepare(`
      INSERT INTO memory_items (
        id, scope_type, scope_id, kind, content, normalized_hash, confidence,
        source_session_id, source_turn_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.scopeType,
      item.scopeId,
      item.kind,
      item.content,
      normalizedHash,
      item.confidence,
      item.sourceSessionId,
      item.sourceTurnId,
      item.createdAt,
      item.updatedAt,
      item.deletedAt,
    );
    return item;
  }

  getMemory(id: string): MemoryItem | null {
    const row = this.db.prepare(`
      SELECT id, scope_type, scope_id, kind, content, confidence, source_session_id,
             source_turn_id, created_at, updated_at, deleted_at
      FROM memory_items WHERE id = ?
    `).get(id) as MemoryRow | undefined;
    return row ? memoryFromRow(row) : null;
  }

  findActiveMemoryByHash(
    scopeType: MemoryScopeType,
    scopeId: string | null,
    normalizedHash: string,
  ): MemoryItem | null {
    const row = this.db.prepare(`
      SELECT id, scope_type, scope_id, kind, content, confidence, source_session_id,
             source_turn_id, created_at, updated_at, deleted_at
      FROM memory_items
      WHERE scope_type = ? AND ifnull(scope_id, '') = ifnull(?, '')
        AND normalized_hash = ? AND deleted_at IS NULL
    `).get(scopeType, scopeId, normalizedHash) as MemoryRow | undefined;
    return row ? memoryFromRow(row) : null;
  }

  updateMemory(
    id: string,
    update: { content: string; normalizedHash: string; kind: MemoryKind; confidence: number },
  ): MemoryItem {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_items
      SET content = ?, normalized_hash = ?, kind = ?, confidence = ?, updated_at = ?, deleted_at = NULL
      WHERE id = ?
    `).run(update.content, update.normalizedHash, update.kind, update.confidence, now, id);
    const result = this.getMemory(id);
    if (!result) throw new Error("Memory item not found");
    return result;
  }

  listMemory(input: {
    query?: string;
    scopeType?: MemoryScopeType;
    scopeId?: string | null;
    kind?: MemoryKind;
    includeDeleted?: boolean;
    limit: number;
    offset: number;
  }): { items: MemoryItem[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    let join = "";
    if (!input.includeDeleted) where.push("m.deleted_at IS NULL");
    if (input.scopeType) {
      where.push("m.scope_type = ?");
      params.push(input.scopeType);
    }
    if (input.scopeId !== undefined) {
      where.push("ifnull(m.scope_id, '') = ifnull(?, '')");
      params.push(input.scopeId);
    }
    if (input.kind) {
      where.push("m.kind = ?");
      params.push(input.kind);
    }
    if (input.query) {
      join = "JOIN memory_fts f ON f.rowid = m.rowid";
      where.push("memory_fts MATCH ?");
      params.push(input.query);
    }
    const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`
      SELECT count(*) AS count FROM memory_items m ${join} ${predicate}
    `).get(...params) as { count: number }).count);
    const rows = this.db.prepare(`
      SELECT m.id, m.scope_type, m.scope_id, m.kind, m.content, m.confidence,
             m.source_session_id, m.source_turn_id, m.created_at, m.updated_at, m.deleted_at
      FROM memory_items m ${join} ${predicate}
      ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?
    `).all(...params, input.limit, input.offset) as MemoryRow[];
    return { items: rows.map(memoryFromRow), total };
  }

  suppressMemory(item: MemoryItem, normalizedHash: string): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE memory_items SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, item.id);
      this.db.prepare(`
        INSERT INTO memory_suppressions (scope_type, scope_id, normalized_hash, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, normalized_hash) DO UPDATE SET created_at = excluded.created_at
      `).run(item.scopeType, item.scopeId ?? "", normalizedHash, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  isMemorySuppressed(
    scopeType: MemoryScopeType,
    scopeId: string | null,
    normalizedHash: string,
  ): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM memory_suppressions
      WHERE scope_type = ? AND scope_id = ? AND normalized_hash = ?
    `).get(scopeType, scopeId ?? "", normalizedHash));
  }

  clearMemorySuppression(
    scopeType: MemoryScopeType,
    scopeId: string | null,
    normalizedHash: string,
  ): void {
    this.db.prepare(`
      DELETE FROM memory_suppressions WHERE scope_type = ? AND scope_id = ? AND normalized_hash = ?
    `).run(scopeType, scopeId ?? "", normalizedHash);
  }

  getLearningGoal(projectId: string): string {
    return (this.db.prepare("SELECT goal FROM learning_profiles WHERE project_id = ?")
      .get(projectId) as { goal: string } | undefined)?.goal ?? "";
  }

  setLearningGoal(projectId: string, goal: string): void {
    this.db.prepare(`
      INSERT INTO learning_profiles (project_id, goal, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at
    `).run(projectId, goal, new Date().toISOString());
  }

  listLearningTopics(projectId: string): LearningTopic[] {
    return (this.db.prepare(`
      SELECT project_id, title, score, confidence, last_evidence, updated_at
      FROM learning_topics WHERE project_id = ? ORDER BY score ASC, title COLLATE NOCASE
    `).all(projectId) as LearningTopicRow[]).map(learningTopicFromRow);
  }

  getLearningTopic(projectId: string, title: string): LearningTopic | null {
    const row = this.db.prepare(`
      SELECT project_id, title, score, confidence, last_evidence, updated_at
      FROM learning_topics WHERE project_id = ? AND title = ? COLLATE NOCASE
    `).get(projectId, title) as LearningTopicRow | undefined;
    return row ? learningTopicFromRow(row) : null;
  }

  recordLearningObservation(observation: LearningObservation, score: number, confidence: number): LearningTopic {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO learning_observations (
          id, project_id, topic, kind, score_delta, result_score, rationale, source_session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.id,
        observation.projectId,
        observation.topic,
        observation.kind,
        observation.scoreDelta,
        observation.resultScore,
        observation.rationale,
        observation.sourceSessionId,
        observation.createdAt,
      );
      this.db.prepare(`
        INSERT INTO learning_topics (
          project_id, title, score, confidence, last_evidence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, title) DO UPDATE SET
          score = excluded.score,
          confidence = excluded.confidence,
          last_evidence = excluded.last_evidence,
          updated_at = excluded.updated_at
      `).run(
        observation.projectId,
        observation.topic,
        score,
        confidence,
        observation.rationale,
        now,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const topic = this.getLearningTopic(observation.projectId, observation.topic);
    if (!topic) throw new Error("Learning topic was not saved");
    return topic;
  }

  listLearningObservations(projectId: string, limit = 100): LearningObservation[] {
    return (this.db.prepare(`
      SELECT id, project_id, topic, kind, score_delta, result_score, rationale, source_session_id, created_at
      FROM learning_observations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(projectId, limit) as LearningObservationRow[]).map(learningObservationFromRow);
  }

  importLearningState(input: {
    projectId: string;
    goal?: string;
    topics?: LearningTopic[];
    observations?: LearningObservation[];
    roadmap?: LearningRoadmapItem[];
  }): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.goal?.trim()) {
        this.db.prepare(`
          INSERT INTO learning_profiles (project_id, goal, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at
        `).run(input.projectId, input.goal.trim(), now);
      }
      const topicStatement = this.db.prepare(`
        INSERT INTO learning_topics (
          project_id, title, score, confidence, last_evidence, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, title) DO UPDATE SET
          score = excluded.score,
          confidence = excluded.confidence,
          last_evidence = excluded.last_evidence,
          updated_at = excluded.updated_at
      `);
      for (const topic of input.topics ?? []) {
        topicStatement.run(
          input.projectId,
          topic.title,
          topic.score,
          topic.confidence,
          topic.lastEvidence,
          topic.updatedAt || now,
        );
      }
      const observationStatement = this.db.prepare(`
        INSERT OR IGNORE INTO learning_observations (
          id, project_id, topic, kind, score_delta, result_score, rationale, source_session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const observation of input.observations ?? []) {
        observationStatement.run(
          observation.id,
          input.projectId,
          observation.topic,
          observation.kind,
          observation.scoreDelta,
          observation.resultScore,
          observation.rationale,
          observation.sourceSessionId,
          observation.createdAt,
        );
      }
      const roadmapStatement = this.db.prepare(`
        INSERT INTO learning_roadmap_items (
          id, project_id, lane, title, status, position, rationale, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          lane = excluded.lane,
          title = excluded.title,
          status = excluded.status,
          position = excluded.position,
          rationale = excluded.rationale,
          updated_at = excluded.updated_at
      `);
      for (const item of input.roadmap ?? []) {
        roadmapStatement.run(
          item.id,
          input.projectId,
          item.lane,
          item.title,
          item.status,
          item.position,
          item.rationale,
          item.createdAt,
          item.updatedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertRoadmapItem(item: LearningRoadmapItem): LearningRoadmapItem {
    this.db.prepare(`
      INSERT INTO learning_roadmap_items (
        id, project_id, lane, title, status, position, rationale, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        lane = excluded.lane,
        title = excluded.title,
        status = excluded.status,
        position = excluded.position,
        rationale = excluded.rationale,
        updated_at = excluded.updated_at
    `).run(
      item.id,
      item.projectId,
      item.lane,
      item.title,
      item.status,
      item.position,
      item.rationale,
      item.createdAt,
      item.updatedAt,
    );
    return item;
  }

  listRoadmapItems(projectId: string): LearningRoadmapItem[] {
    return (this.db.prepare(`
      SELECT id, project_id, lane, title, status, position, rationale, created_at, updated_at
      FROM learning_roadmap_items
      WHERE project_id = ?
      ORDER BY CASE lane WHEN 'now' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, position, created_at
    `).all(projectId) as LearningRoadmapRow[]).map(learningRoadmapFromRow);
  }

  hasLegacyLearningMigration(projectId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM learning_legacy_migrations WHERE project_id = ?",
    ).get(projectId));
  }

  markLegacyLearningMigration(projectId: string, archivePath: string | null): void {
    this.db.prepare(`
      INSERT INTO learning_legacy_migrations (project_id, imported_at, archive_path)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        imported_at = excluded.imported_at,
        archive_path = excluded.archive_path
    `).run(projectId, new Date().toISOString(), archivePath);
  }

  getTheoryMaterialAttempt(
    projectId: string,
    materialId: string,
    revision: string,
  ): TheoryMaterialAttempt | null {
    const row = this.db.prepare(`
      SELECT project_id, material_id, revision, answers_by_block, correct, total, completed_at
      FROM theory_material_attempts
      WHERE project_id = ? AND material_id = ? AND revision = ?
    `).get(projectId, materialId, revision) as TheoryMaterialAttemptRow | undefined;
    return row ? materialAttemptFromRow(row) : null;
  }

  saveTheoryMaterialAttempt(attempt: TheoryMaterialAttempt): TheoryMaterialAttempt {
    this.db.prepare(`
      INSERT INTO theory_material_attempts (
        project_id, material_id, revision, answers_by_block, correct, total, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, material_id, revision) DO UPDATE SET
        answers_by_block = excluded.answers_by_block,
        correct = excluded.correct,
        total = excluded.total,
        completed_at = excluded.completed_at
    `).run(
      attempt.projectId,
      attempt.materialId,
      attempt.revision,
      JSON.stringify(attempt.answersByBlock),
      attempt.correct,
      attempt.total,
      attempt.completedAt,
    );
    return attempt;
  }

  deleteTheoryMaterialAttempts(projectId: string, materialId: string): number {
    const result = this.db.prepare(`
      DELETE FROM theory_material_attempts WHERE project_id = ? AND material_id = ?
    `).run(projectId, materialId);
    return Number(result.changes);
  }
}
