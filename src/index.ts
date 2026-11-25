#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdpClient, type RegionCache } from "./adp-client.js";
import { callTool, failureResult, getTools } from "./tools.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const server = new Server(
  { name: "laiye-adp-mcp-nodejs-v2", version },
  {
    capabilities: { tools: {} },
    instructions: "When first using ADP in a conversation, consult get_adp_guide if the guide for the current ADP environment is not already in context. Reuse it across tasks and tool calls. Read it again if the user asks for a refresh or the available guidance no longer applies. Use list_apps to find an app when needed. If the user specifies one-off fields without choosing an app, call extract_document with fields directly. Submit one document per call and continue an accepted task using its original task_ref."
  }
);

const regions: RegionCache = new Map();
server.setRequestHandler(ListToolsRequestSchema, async (_request, { signal }) => {
  const client = new AdpClient(process.env, regions);
  const region = await client.getCatalogRegion(signal);
  return { tools: getTools(client.domesticInvoiceRegionConfirmed ? region : "global", client.language) };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  const result = await callTool(params.name, params.arguments ?? {}, new AdpClient(process.env, regions), version, signal)
    .catch((error: unknown) => failureResult(error));
  return {
    ...(result.status === "failed" ? { isError: true } : {}),
    structuredContent: result,
    content: [{
      type: "text",
      text: typeof result.markdown === "string" ? result.markdown : JSON.stringify(result)
    }]
  };
});

try {
  await server.connect(new StdioServerTransport());
} catch {
  console.error("Unable to start the Laiye ADP MCP server.");
  process.exitCode = 1;
}
