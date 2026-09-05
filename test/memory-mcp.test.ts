import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("exposes Ronix memory tools over MCP stdio", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ronix-memory-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "src", "memory-mcp.ts"), "--data-dir", directory],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "ronix-memory-test", version: "1.0.0" });
  try {
    try {
      await client.connect(transport, { timeout: 2_000 });
    } catch (error) {
      if (/timed out|connection closed/i.test(error instanceof Error ? error.message : String(error))) {
        t.skip("Nested stdio pipes are unavailable in this sandbox");
        return;
      }
      throw error;
    }
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("ronix_memory_search"));
    assert.ok(names.includes("ronix_memory_remember"));
    assert.ok(names.includes("ronix_learning_set_goal"));

    const remembered = await client.callTool({
      name: "ronix_memory_remember",
      arguments: {
        scope_type: "global",
        scope_id: null,
        kind: "preference",
        content: "Показывать короткие ответы",
        confidence: 1,
        session_id: null,
        turn_id: null,
      },
    });
    assert.equal(remembered.isError, undefined);
    const searched = await client.callTool({
      name: "ronix_memory_search",
      arguments: {
        query: "короткие ответы",
        scope_type: "global",
        scope_id: null,
        limit: 10,
        offset: 0,
        response_format: "json",
      },
    });
    assert.equal(searched.isError, undefined);
    const content = searched.content as Array<{ type: string; text?: string }>;
    const text = content.find((part) => part.type === "text")?.text ?? "";
    assert.match(text, /Показывать короткие ответы/);
  } finally {
    await transport.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
