#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callAdpOperation } from "./adp-client.js";
import { operations } from "./operations.js";
import type { JsonObject } from "./types.js";

const server = new Server(
  {
    name: "laiye-adp-mcp-nodejs",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: operations.map((operation) => ({
    name: operation.name,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    annotations: operation.annotations,
    _meta: operation.metadata
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const operation = operations.find((candidate) => candidate.name === request.params.name);

  if (!operation) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }]
    };
  }

  try {
    const result = await callAdpOperation(operation, (request.params.arguments ?? {}) as JsonObject);
    return {
      structuredContent: toStructuredContent(result),
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function toStructuredContent(result: unknown): JsonObject | undefined {
  return result !== null && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject) : undefined;
}
