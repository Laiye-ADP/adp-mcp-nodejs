import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/generate-tool-catalog.mjs [--check]");
}

const readmePath = new URL("../README.md", import.meta.url);
const beginMarker = "<!-- tool-catalog:start -->";
const endMarker = "<!-- tool-catalog:end -->";
const original = await readFile(readmePath, "utf8");
const readme = original.replaceAll("\r\n", "\n");
const begin = readme.indexOf(beginMarker);
const end = readme.indexOf(endMarker);
if (begin < 0 || end < begin || readme.lastIndexOf(beginMarker) !== begin || readme.lastIndexOf(endMarker) !== end) {
  throw new Error("README.md must contain one ordered pair of tool catalog markers.");
}

const client = new Client({ name: "node-v2-tool-catalog", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  env: { ADP_API_KEY: "", ADP_API_BASE_URL: "https://adp.laiye.com", ADP_REGION: "cn", ADP_TENANT_NAME: "laiye" }
});
const tools = [];
let version;
try {
  await client.connect(transport);
  version = client.getServerVersion()?.version;
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error("Tool list returned a repeated cursor.");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
} finally {
  await client.close();
}
if (!version || !tools.length || new Set(tools.map(({ name }) => name)).size !== tools.length) {
  throw new Error("Expected a version and a nonempty tool list with unique names.");
}

const rows = tools.map(({ name, description, inputSchema }) =>
  `| ${code(name)} | ${requiredInput(inputSchema)} | ${markdownCell(description ?? "")} |`);
const catalog = [
  beginMarker,
  "",
  `版本 ${code(version)}，中国区共 **${tools.length}** 个工具。全球区预制应用和参数以当前连接的工具定义及引导说明为准。`,
  "",
  "| 工具 | 必填参数 | 用途 |",
  "| --- | --- | --- |",
  ...rows,
  "",
  endMarker
].join("\n");
const updated = readme.slice(0, begin) + catalog + readme.slice(end + endMarker.length);
if (updated !== readme && args.includes("--check")) {
  console.error("Node v2 tool catalog is stale. Build and run npm run catalog:generate.");
  process.exitCode = 1;
} else {
  if (updated !== readme) {
    await writeFile(readmePath, original.includes("\r\n") ? updated.replaceAll("\n", "\r\n") : updated);
  }
  console.log(`Node v2 tool catalog matches ${tools.length} tools from ${version}.`);
}

function requiredInput(schema) {
  if (schema.properties.task_ref && schema.properties.run_id && schema.properties.task_id && schema.properties.task_type) {
    return "`task_ref`、`run_id` 或 `task_id` + `task_type`（三选一）";
  }
  const required = (schema.required ?? []).map(code);
  if (schema.oneOf?.length && schema.oneOf.every(({ required }) => required?.length)) {
    const choices = schema.oneOf.map(({ required }) => required.map(code).join("、")).join(" 或 ");
    required.push(required.length ? `（${choices}）` : choices);
  }
  return required.join("、") || "无";
}

function code(value) {
  return `\`${markdownCell(value)}\``;
}

function markdownCell(value) {
  return value.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ").trim();
}
