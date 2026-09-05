import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type {
  LearningObservation,
  LearningRoadmapItem,
  MemoryItem,
  MemoryKind,
  MemoryScopeType,
} from "./types.js";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,})\b/g,
];

export type MemorySearch = {
  query?: string;
  scopeType?: MemoryScopeType;
  scopeId?: string | null;
  kind?: MemoryKind;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
};

export type LearningState = {
  goal: string;
  topics: ReturnType<Store["listLearningTopics"]>;
  observations: ReturnType<Store["listLearningObservations"]>;
  roadmap: ReturnType<Store["listRoadmapItems"]>;
};

export class MemoryService {
  constructor(private readonly store: Store) {}

  remember(input: {
    scopeType: MemoryScopeType;
    scopeId?: string | null;
    kind: MemoryKind;
    content: string;
    confidence?: number;
    sourceSessionId?: string | null;
    sourceTurnId?: string | null;
    allowSuppressed?: boolean;
  }): MemoryItem {
    const scopeId = this.validateScope(input.scopeType, input.scopeId ?? null);
    const content = sanitizeMemoryContent(input.content);
    const normalizedHash = memoryHash(content);
    if (!input.allowSuppressed && this.store.isMemorySuppressed(input.scopeType, scopeId, normalizedHash)) {
      throw new Error("This memory was explicitly forgotten. Correct it manually to restore it.");
    }
    const existing = this.store.findActiveMemoryByHash(input.scopeType, scopeId, normalizedHash);
    if (existing) return existing;
    const now = new Date().toISOString();
    const item: MemoryItem = {
      id: randomUUID(),
      scopeType: input.scopeType,
      scopeId,
      kind: input.kind,
      content,
      confidence: clampConfidence(input.confidence ?? 1),
      sourceSessionId: input.sourceSessionId ?? null,
      sourceTurnId: input.sourceTurnId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return this.store.insertMemory(item, normalizedHash);
  }

  correct(
    id: string,
    update: { content: string; kind?: MemoryKind; confidence?: number },
  ): MemoryItem {
    const current = this.requireMemory(id);
    const content = sanitizeMemoryContent(update.content);
    const normalizedHash = memoryHash(content);
    this.store.clearMemorySuppression(current.scopeType, current.scopeId, normalizedHash);
    return this.store.updateMemory(id, {
      content,
      normalizedHash,
      kind: update.kind ?? current.kind,
      confidence: clampConfidence(update.confidence ?? current.confidence),
    });
  }

  forget(id: string): void {
    const current = this.requireMemory(id);
    this.store.suppressMemory(current, memoryHash(current.content));
  }

  search(input: MemorySearch = {}): { items: MemoryItem[]; total: number; hasMore: boolean } {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = Math.max(0, input.offset ?? 0);
    const query = input.query?.trim() ? ftsQuery(input.query) : undefined;
    const result = this.store.listMemory({
      ...input,
      ...(query ? { query } : {}),
      limit,
      offset,
    });
    return {
      ...result,
      hasMore: offset + result.items.length < result.total,
    };
  }

  context(scopes: Array<{ scopeType: MemoryScopeType; scopeId: string | null }>, query: string): MemoryItem[] {
    const seen = new Set<string>();
    const items: MemoryItem[] = [];
    for (const scope of scopes) {
      const matches = this.search({
        query,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        limit: 6,
      });
      const recent = this.search({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        limit: 2,
      });
      for (const item of [...matches.items, ...recent.items]) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
  }

  learningState(projectId: string): LearningState {
    this.requireLearningProject(projectId);
    return {
      goal: this.store.getLearningGoal(projectId),
      topics: this.store.listLearningTopics(projectId),
      observations: this.store.listLearningObservations(projectId, 100),
      roadmap: this.store.listRoadmapItems(projectId),
    };
  }

  setLearningGoal(projectId: string, goal: string): LearningState {
    this.requireLearningProject(projectId);
    this.store.setLearningGoal(projectId, cleanText(goal, 4_000));
    return this.learningState(projectId);
  }

  recordLearningEvidence(input: {
    projectId: string;
    topic: string;
    kind: LearningObservation["kind"];
    scoreDelta: number;
    resultScore?: number | null;
    rationale: string;
    confidence?: number;
    sourceSessionId?: string | null;
  }): { observation: LearningObservation; topic: ReturnType<Store["getLearningTopic"]> } {
    this.requireLearningProject(input.projectId);
    const maximumDelta = input.kind === "control" ? 2 : input.kind === "theory" ? 0 : 1;
    if (!Number.isInteger(input.scoreDelta) || Math.abs(input.scoreDelta) > maximumDelta) {
      throw new Error(`scoreDelta for ${input.kind} must be between ${-maximumDelta} and ${maximumDelta}`);
    }
    if (input.resultScore != null && !Number.isFinite(input.resultScore)) {
      throw new Error("resultScore must be a number between 0 and 10");
    }
    const title = cleanText(input.topic, 160);
    const current = this.store.getLearningTopic(input.projectId, title);
    const baseScore = current?.score ?? 5;
    const score = Math.min(10, Math.max(1, baseScore + input.scoreDelta));
    const observation: LearningObservation = {
      id: randomUUID(),
      projectId: input.projectId,
      topic: title,
      kind: input.kind,
      scoreDelta: input.scoreDelta,
      resultScore: input.resultScore == null
        ? null
        : Math.min(10, Math.max(0, input.resultScore)),
      rationale: cleanText(input.rationale, 2_000),
      sourceSessionId: input.sourceSessionId ?? null,
      createdAt: new Date().toISOString(),
    };
    const topic = this.store.recordLearningObservation(
      observation,
      score,
      clampConfidence(input.confidence ?? current?.confidence ?? 0.6),
    );
    return { observation, topic };
  }

  updateRoadmap(input: {
    projectId: string;
    id?: string;
    lane: LearningRoadmapItem["lane"];
    title: string;
    status?: LearningRoadmapItem["status"];
    position?: number;
    rationale?: string | null;
  }): LearningRoadmapItem {
    this.requireLearningProject(input.projectId);
    const existing = input.id
      ? this.store.listRoadmapItems(input.projectId).find((item) => item.id === input.id)
      : undefined;
    const now = new Date().toISOString();
    return this.store.upsertRoadmapItem({
      id: existing?.id ?? input.id ?? randomUUID(),
      projectId: input.projectId,
      lane: input.lane,
      title: cleanText(input.title, 240),
      status: input.status ?? existing?.status ?? "todo",
      position: Math.max(0, Math.trunc(input.position ?? existing?.position ?? 0)),
      rationale: input.rationale === undefined
        ? existing?.rationale ?? null
        : input.rationale ? cleanText(input.rationale, 1_000) : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private validateScope(scopeType: MemoryScopeType, scopeId: string | null): string | null {
    if (scopeType === "global") return null;
    if (!scopeId) throw new Error(`${scopeType} memory requires scopeId`);
    if (scopeType === "chat") {
      const session = this.store.getSession(scopeId);
      if (!session || session.purpose !== "chat") throw new Error("Chat scope not found");
      return scopeId;
    }
    const project = this.store.getProject(scopeId);
    if (!project) throw new Error("Project scope not found");
    if (scopeType === "learning" && project.kind !== "learning") {
      throw new Error("Learning scope requires a learning project");
    }
    return scopeId;
  }

  private requireLearningProject(projectId: string): void {
    const project = this.store.getProject(projectId);
    if (!project || project.kind !== "learning") throw new Error("Learning project not found");
  }

  private requireMemory(id: string): MemoryItem {
    const memory = this.store.getMemory(id);
    if (!memory) throw new Error("Memory item not found");
    return memory;
  }
}

export function sanitizeMemoryContent(value: string): string {
  let content = cleanText(value, 8_000);
  for (const pattern of SECRET_PATTERNS) content = content.replace(pattern, "[secret removed]");
  if (!content || content === "[secret removed]") throw new Error("Memory contains no safe content");
  return content;
}

export function memoryHash(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
  return createHash("sha256").update(normalized).digest("hex");
}

function cleanText(value: string, maximum: number): string {
  if (typeof value !== "string") throw new Error("Expected text");
  const result = value.trim();
  if (!result) throw new Error("Text must not be empty");
  if (result.length > maximum) throw new Error(`Text must not exceed ${maximum} characters`);
  if (/\p{Cc}/u.test(result.replaceAll("\n", "").replaceAll("\t", ""))) {
    throw new Error("Text contains control characters");
  }
  return result;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Confidence must be a number");
  return Math.min(1, Math.max(0, value));
}

function ftsQuery(value: string): string {
  const tokens = value.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ") : '""';
}
