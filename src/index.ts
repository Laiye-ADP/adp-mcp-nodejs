#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdpClient, type RegionCache } from "./adp-client.js";
import { callTool, failureResult, tools } from "./tools.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const server = new Server(
  { name: "laiye-adp-mcp-nodejs-v2", version },
  {
    capabilities: { tools: {} },
    instructions: "Use get_adp_guide for preset IDs and workflow examples. Follow next_steps when available, and use the original task_ref to continue a pending task."
  }
);

const regions: RegionCache = new Map();
server.setRequestHandler(ListToolsRequestSchema, async (_request, { signal }) => {
  const region = await new AdpClient(process.env, regions).getCatalogRegion(signal);
  return { tools: tools[region] };
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
