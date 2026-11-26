#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdpClient, type RegionCache } from "./adp-client.js";
import { callTool, failureResult, getTools } from "./tools.js";
import { analyticsParametersEnabled, extractAnalyticsArguments, reportToolStatistics } from "./analytics.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const server = new Server(
  { name: "laiye-adp-mcp-nodejs-v2", version },
  {
    capabilities: { tools: {} },
    instructions: "When first using ADP in a conversation, consult get_adp_guide if the guide for the current ADP environment is not already in context. Reuse it across tasks and tool calls. Read it again if the user asks for a refresh or the available guidance no longer applies. Use list_apps to find an app when needed. If the user specifies one-off fields without choosing an app, call extract_document with fields directly. Process multiple independent documents concurrently by default within the applicable processing allowances. For parsing, extraction, and classification, make one call per document and use synchronous processing by default. When the client supports parallel tool calls, issue multiple synchronous calls together in the same turn instead of waiting for each document to finish before starting the next. If the client cannot wait for synchronous results concurrently or the user wants background processing, use wait=false for parsing, app-based extraction, and classification. Submit these tasks concurrently when supported, or consecutively without waiting for task completion when parallel submission is unavailable. Preserve a mapping from each original file to its task_ref and query get_task afterwards. One-off fields extraction is synchronous only. Follow the default concurrency policy for independent fields calls when supported, and do not create an app solely for concurrency. Do not automatically resubmit a timed-out synchronous request as an asynchronous task. Continue an accepted task using its original task_ref. For multiple local files, include the entire batch in files in one upload_file call. The tool uploads the files in parallel. Uploading files is separate from parsing and extraction concurrency allowances."
  }
);

const regions: RegionCache = new Map();
server.setRequestHandler(ListToolsRequestSchema, async (_request, { signal }) => {
  const client = new AdpClient(process.env, regions);
  const region = await client.getCatalogRegion(signal);
  return { tools: getTools(client.domesticInvoiceRegionConfirmed ? region : "global", client.language) };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  const startedAt = performance.now();
  const client = new AdpClient(process.env, regions);
  const enabled = analyticsParametersEnabled();
  const input = extractAnalyticsArguments(params.name, params.arguments ?? {}, enabled);
  const result = await callTool(params.name, input.arguments, client, version, signal)
    .catch((error: unknown) => failureResult(error));
  await reportToolStatistics(client, params.name, result, {
    startedAt, enabled, parameters: input.metadata, requestMetadata: params._meta, clientInfo: server.getClientVersion()
  });
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
