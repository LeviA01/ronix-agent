#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryService } from "./memory-service.js";
import { Store } from "./store.js";

const CHARACTER_LIMIT = 25_000;
const ScopeType = z.enum(["global", "chat", "project", "learning"]);
const MemoryKind = z.enum(["preference", "fact", "decision", "task", "summary"]);
const ResponseFormat = z.enum(["markdown", "json"]);

const server = new McpServer(
  { name: "ronix-memory-mcp-server", version: "0.2.0" },
  {
    instructions: [
      "Ronix memory stores durable user preferences, project decisions, tasks, summaries and learning evidence.",
      "Search before assuming prior context. Save only durable information, never secrets, tokens, passwords, raw tool output or temporary chatter.",
      "Use the session_id and scope identifiers supplied in the Ronix turn context. Learning updates belong in ronix_learning_record_evidence and ronix_learning_update_roadmap.",
    ].join(" "),
  },
);

const dataDir = argument("--data-dir") ?? process.env.RONIX_DATA_DIR;
if (!dataDir) {
  console.error("ronix-memory-mcp-server requires --data-dir or RONIX_DATA_DIR");
  process.exit(2);
}
const store = new Store(dataDir);
const memory = new MemoryService(store);

server.registerTool(
  "ronix_memory_search",
  {
    title: "Search Ronix memory",
    description: `Search durable Ronix memory within one optional scope.

Use this before answering questions about earlier decisions, preferences, tasks, project history or learning progress. Results are ordered by recent updates. Use query filters to keep context compact.

Returns JSON or Markdown with memory IDs, scope, kind, content, confidence and source session.`,
    inputSchema: z.object({
      query: z.string().max(500).optional().describe("Words or phrase to search for"),
      scope_type: ScopeType.optional().describe("Limit search to global, chat, project or learning memory"),
      scope_id: z.string().uuid().nullable().optional().describe("Chat or project ID; null for global memory"),
      kind: MemoryKind.optional().describe("Optional memory kind filter"),
      limit: z.number().int().min(1).max(50).default(20),
      offset: z.number().int().min(0).default(0),
      response_format: ResponseFormat.default("json"),
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => {
    const result = memory.search({
      ...(input.query ? { query: input.query } : {}),
      ...(input.scope_type ? { scopeType: input.scope_type } : {}),
      ...(input.scope_id !== undefined ? { scopeId: input.scope_id } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      limit: input.limit,
      offset: input.offset,
    });
    return input.response_format === "markdown" ? memoryMarkdown(result) : result;
  }),
);

server.registerTool(
  "ronix_memory_remember",
  {
    title: "Remember durable Ronix context",
    description: `Save one durable fact, preference, decision, task or summary in Ronix memory.

Use automatically when the user states a lasting preference, a project decision is made, a task remains open, or a conversation reaches a reusable conclusion. Do not save secrets, raw logs, transient status messages or entire responses. Exact duplicates are returned instead of inserted again.`,
    inputSchema: z.object({
      scope_type: ScopeType,
      scope_id: z.string().uuid().nullable().describe("Null for global; chat or project ID otherwise"),
      kind: MemoryKind,
      content: z.string().min(1).max(8_000),
      confidence: z.number().min(0).max(1).default(1),
      session_id: z.string().uuid().nullable().default(null),
      turn_id: z.string().nullable().default(null),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.remember({
    scopeType: input.scope_type,
    scopeId: input.scope_id,
    kind: input.kind,
    content: input.content,
    confidence: input.confidence,
    sourceSessionId: input.session_id,
    sourceTurnId: input.turn_id,
  })),
);

server.registerTool(
  "ronix_memory_correct",
  {
    title: "Correct Ronix memory",
    description: "Correct the content, kind or confidence of an existing memory item. Use when new evidence replaces an old statement; do not create conflicting duplicates.",
    inputSchema: z.object({
      id: z.string().uuid(),
      content: z.string().min(1).max(8_000),
      kind: MemoryKind.optional(),
      confidence: z.number().min(0).max(1).optional(),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.correct(input.id, {
    content: input.content,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  })),
);

server.registerTool(
  "ronix_memory_forget",
  {
    title: "Forget Ronix memory",
    description: "Stop using one memory item and suppress automatic recreation of the same content. Use only after an explicit user request to forget it.",
    inputSchema: z.object({ id: z.string().uuid() }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => {
    memory.forget(input.id);
    return { forgotten: true, id: input.id };
  }),
);

server.registerTool(
  "ronix_learning_get_state",
  {
    title: "Read Ronix learning state",
    description: "Read the structured goal, topic mastery, recent evidence and roadmap for one learning project before teaching, reviewing work or choosing the next lesson.",
    inputSchema: z.object({ project_id: z.string().uuid() }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.learningState(input.project_id)),
);

server.registerTool(
  "ronix_learning_set_goal",
  {
    title: "Set the learning goal",
    description: "Set or correct the durable learning goal for one learning project after the learner states it explicitly.",
    inputSchema: z.object({
      project_id: z.string().uuid(),
      goal: z.string().min(1).max(4_000),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.setLearningGoal(input.project_id, input.goal)),
);

server.registerTool(
  "ronix_learning_record_evidence",
  {
    title: "Record learning evidence",
    description: `Record one grounded observation about a learner and update the topic score atomically.

Practice and ordinary evidence can change a score by at most 1, control work by at most 2, and theory checks do not change the numeric score. Always include a short observable rationale.`,
    inputSchema: z.object({
      project_id: z.string().uuid(),
      topic: z.string().min(1).max(160),
      kind: z.enum(["practice", "theory", "control", "note"]),
      score_delta: z.number().int().min(-2).max(2),
      result_score: z.number().min(0).max(10).nullable().default(null)
        .describe("Optional assignment or control-work grade out of 10"),
      rationale: z.string().min(1).max(2_000),
      confidence: z.number().min(0).max(1).default(0.6),
      session_id: z.string().uuid().nullable().default(null),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.recordLearningEvidence({
    projectId: input.project_id,
    topic: input.topic,
    kind: input.kind,
    scoreDelta: input.score_delta,
    resultScore: input.result_score,
    rationale: input.rationale,
    confidence: input.confidence,
    sourceSessionId: input.session_id,
  })),
);

server.registerTool(
  "ronix_learning_update_roadmap",
  {
    title: "Update the learning roadmap",
    description: "Create or update one ordered roadmap item when evidence changes the learning route. Reuse an existing item ID when changing status, lane or rationale.",
    inputSchema: z.object({
      project_id: z.string().uuid(),
      id: z.string().uuid().optional(),
      lane: z.enum(["now", "next", "later"]),
      title: z.string().min(1).max(240),
      status: z.enum(["todo", "done", "dropped"]).default("todo"),
      position: z.number().int().min(0).default(0),
      rationale: z.string().max(1_000).nullable().default(null),
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input) => toolResult(() => memory.updateRoadmap({
    projectId: input.project_id,
    ...(input.id ? { id: input.id } : {}),
    lane: input.lane,
    title: input.title,
    status: input.status,
    position: input.position,
    rationale: input.rationale,
  })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.resume();
  (process.stdin as NodeJS.ReadStream & { ref?: () => void }).ref?.();
  setInterval(() => {}, 60_000);
  console.error("ronix-memory-mcp-server ready");
}

function toolResult(operation: () => unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  try {
    const value = operation();
    const text = formatValue(value);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: error instanceof Error ? `Ronix memory error: ${error.message}` : "Ronix memory error",
      }],
    };
  }
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= CHARACTER_LIMIT) return text;
  return text.slice(0, CHARACTER_LIMIT) + "\n[truncated; narrow the query or use pagination]";
}

function memoryMarkdown(result: ReturnType<MemoryService["search"]>): string {
  const lines = [`# Ronix memory`, `Found ${result.total}; showing ${result.items.length}.`, ""];
  for (const item of result.items) {
    lines.push(`- **${item.kind}** (${item.scopeType}:${item.scopeId ?? "global"}, ${item.id}) — ${item.content}`);
  }
  if (result.hasMore) lines.push("", "More items are available; increase offset to continue.");
  return lines.join("\n");
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

process.once("SIGINT", () => {
  store.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  store.close();
  process.exit(0);
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  store.close();
  process.exit(1);
});
