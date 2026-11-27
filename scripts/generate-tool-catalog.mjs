import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validationInputSchema } from "../dist/tools.js";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--check")) {
  throw new Error("Usage: node scripts/generate-tool-catalog.mjs [--check]");
}

const beginMarker = "<!-- tool-catalog:start -->";
const endMarker = "<!-- tool-catalog:end -->";
const documents = [
  {
    filename: "README.md", language: "en-US", headers: "| Tool | Required inputs | Purpose |", none: "None",
    alternatives: inputs => `(${inputs.join(" or ")})`,
    introduction: (version, count) =>
      `The table below lists **${count} tools** available in both regions. See the tool definitions on your connection for region-specific tools and parameters.`
  },
  {
    filename: "README_CN.md", language: "zh-CN", headers: "| 工具 | 必填参数 | 用途 |", none: "无",
    alternatives: inputs => `（${inputs.join(" 或 ")}）`,
    introduction: (version, count) =>
      `下表列出两区通用的 **${count}** 个工具。区域专属工具和参数以当前连接的工具定义为准。`
  }
];

async function readTools(region, language) {
  const client = new Client({ name: "node-v2-tool-catalog", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: {
      ADP_API_KEY: "", ADP_API_BASE_URL: region === "cn" ? "https://adp.laiye.com" : "https://adp-global.laiye.com",
      ADP_REGION: region, ADP_TENANT_NAME: "laiye", ADP_ACCEPT_LANGUAGE: language
    }
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
    throw new Error(`Expected a version and unique ${region} tool definitions.`);
  }
  return { version, tools };
}
const commonNames = new Set([
  "get_adp_guide", "upload_file", "parse_document", "extract_document", "classify_document",
  "create_app", "update_app", "delete_app", "list_apps",
  "get_app", "get_task", "cancel_task", "get_credits", "submit_user_feedback"
]);
const regionalOnly = { cn: ["verify_invoice"], global: [] };
const catalogs = await Promise.all(documents.map(async doc => {
  const [cn, global] = await Promise.all([readTools("cn", doc.language), readTools("global", doc.language)]);
  return { doc, regions: { cn, global } };
}));
const version = catalogs[0].regions.global.version;
const referenceInputs = new Map(catalogs[0].regions.global.tools.map(tool => [tool.name, requiredToolInput(tool, documents[0])]));
for (const { doc, regions } of catalogs) {
  for (const [region, result] of Object.entries(regions)) {
    const expected = new Set([...commonNames, ...regionalOnly[region]]);
    if (result.version !== version || result.tools.length !== expected.size || result.tools.some(({ name }) => !expected.has(name))) {
      throw new Error(`Unexpected ${doc.language} ${region} catalog. Expected version ${version} and ${expected.size} tools.`);
    }
    for (const tool of result.tools.filter(({ name }) => commonNames.has(name))) {
      if (requiredToolInput(tool, documents[0]) !== referenceInputs.get(tool.name)) {
        throw new Error(`Required inputs differ for ${doc.language} ${region} ${tool.name}.`);
      }
    }
  }
}

for (const { doc, regions } of catalogs) {
  const readmePath = new URL(`../${doc.filename}`, import.meta.url);
  const original = await readFile(readmePath, "utf8");
  const readme = original.replaceAll("\r\n", "\n");
  const begin = readme.indexOf(beginMarker);
  const end = readme.indexOf(endMarker);
  if (begin < 0 || end < begin || readme.lastIndexOf(beginMarker) !== begin || readme.lastIndexOf(endMarker) !== end) {
    throw new Error(`${doc.filename} must contain one ordered pair of tool catalog markers.`);
  }
  const tools = regions.global.tools.filter(({ name }) => commonNames.has(name));
  const rows = tools.map(tool =>
    `| ${code(tool.name)} | ${requiredToolInput(tool, doc)} | ${markdownCell(tool.description ?? "")} |`);
  const catalog = [
    beginMarker, "", doc.introduction(version, tools.length), "", doc.headers, "| --- | --- | --- |", ...rows, "", endMarker
  ].join("\n");
  const updated = readme.slice(0, begin) + catalog + readme.slice(end + endMarker.length);
  if (/verify_invoice|enable_invoice_verify|发票验真|invoice verification/i.test(updated)) {
    throw new Error(`${doc.filename} must describe common tools only; regional capabilities stay in tool discovery.`);
  }
  if (updated !== readme && args.includes("--check")) {
    console.error(`${doc.filename} tool catalog is stale. Build and run npm run catalog:generate.`);
    process.exitCode = 1;
  } else {
    if (updated !== readme) {
      await writeFile(readmePath, original.includes("\r\n") ? updated.replaceAll("\n", "\r\n") : updated);
    }
    console.log(`${doc.filename} matches ${tools.length} common tools from ${version} (CN=${regions.cn.tools.length}, Global=${regions.global.tools.length}).`);
  }
}

function requiredToolInput(tool, doc) {
  // Both modes expose the same file fields; the private schema also accepts the legacy nested file.
  if (tool.name === "extract_document") {
    return [code("file_url"), doc.alternatives(["app_id", "fields"].map(code))].join(" + ");
  }
  return requiredInput(validationInputSchema(tool), doc);
}

function requiredInput(schema, doc) {
  const parts = (schema.required ?? []).map(code);
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches?.length && branches.every(branch => branch.required?.length)) {
    parts.push(doc.alternatives(branches.map(branch => requiredInput(branch, doc))));
  }
  return parts.join(" + ") || doc.none;
}

function code(value) {
  return `\`${markdownCell(value)}\``;
}

function markdownCell(value) {
  return value.trim().replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}
