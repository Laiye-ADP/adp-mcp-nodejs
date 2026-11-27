import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
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
    filename: "README.md", language: "en-US", headers: "| Tool | Region | Required inputs | Purpose |", none: "None",
    sharedRegion: "China & Global", chinaRegion: "China only", globalRegion: "Global only",
    invoiceRequirements: " + fields required for the invoice type (fpAmount when type_key is omitted)",
    regionalParameters: parameters => `Regional parameter difference: ${parameters} is available only in China.`,
    alternatives: inputs => `(${inputs.join(" or ")})`,
    introduction: (regions, count) =>
      `The table below lists all **${count} tools**: **${regions.cn.tools.length}** are available in China and **${regions.global.tools.length}** in Global. The Region column identifies availability; ${code("verify_invoice")} is available only in China. See ${code("tools/list")} on your connection for complete parameter definitions.`
  },
  {
    filename: "README_CN.md", language: "zh-CN", headers: "| 工具 | 适用区域 | 必填参数 | 用途 |", none: "无",
    sharedRegion: "国内版、国际版", chinaRegion: "仅国内版", globalRegion: "仅国际版",
    invoiceRequirements: " + 按票种补充必需字段（省略 type_key 时必填 fpAmount）",
    regionalParameters: parameters => `区域参数差异：${parameters} 仅国内版提供。`,
    alternatives: inputs => `（${inputs.join(" 或 ")}）`,
    introduction: (regions, count) =>
      `下表完整列出 **${count}** 个工具：国内版提供 **${regions.cn.tools.length}** 个，国际版提供其中 **${regions.global.tools.length}** 个。适用区域见表中标注，${code("verify_invoice")} 仅国内版可用。完整参数定义以当前连接的 ${code("tools/list")} 为准。`
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
const chinaOnlyInputs = { extract_document: ["enable_invoice_verify"] };
const catalogs = await Promise.all(documents.map(async doc => {
  const [cn, global] = await Promise.all([readTools("cn", doc.language), readTools("global", doc.language)]);
  return { doc, regions: { cn, global } };
}));
const version = catalogs[0].regions.global.version;
const referenceInputs = new Map(catalogs[0].regions.cn.tools.map(tool => [tool.name, requiredToolInput(tool, documents[0])]));
for (const { doc, regions } of catalogs) {
  for (const [region, result] of Object.entries(regions)) {
    const expected = new Set([...commonNames, ...regionalOnly[region]]);
    if (result.version !== version || result.tools.length !== expected.size || result.tools.some(({ name }) => !expected.has(name))) {
      throw new Error(`Unexpected ${doc.language} ${region} catalog. Expected version ${version} and ${expected.size} tools.`);
    }
    for (const tool of result.tools) {
      if (requiredToolInput(tool, documents[0]) !== referenceInputs.get(tool.name)) {
        throw new Error(`Required inputs differ for ${doc.language} ${region} ${tool.name}.`);
      }
    }
  }
  for (const name of commonNames) {
    const chinaTool = structuredClone(regions.cn.tools.find(tool => tool.name === name));
    const globalTool = regions.global.tools.find(tool => tool.name === name);
    for (const parameter of chinaOnlyInputs[name] ?? []) {
      if (!Object.hasOwn(chinaTool.inputSchema.properties, parameter)
          || Object.hasOwn(globalTool.inputSchema.properties, parameter)) {
        throw new Error(`Unexpected regional availability for ${name}.${parameter}.`);
      }
      delete chinaTool.inputSchema.properties[parameter];
    }
    deepStrictEqual(chinaTool, globalTool, `Unexpected regional tool difference for ${doc.language} ${name}.`);
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
  const tools = [...new Map([...regions.cn.tools, ...regions.global.tools].map(tool => [tool.name, tool])).values()];
  const chinaNames = new Set(regions.cn.tools.map(tool => tool.name));
  const globalNames = new Set(regions.global.tools.map(tool => tool.name));
  const rows = tools.map(tool => {
    const region = chinaNames.has(tool.name)
      ? globalNames.has(tool.name) ? doc.sharedRegion : doc.chinaRegion
      : doc.globalRegion;
    return `| ${code(tool.name)} | ${region} | ${requiredToolInput(tool, doc)} | ${markdownCell(tool.description ?? "")} |`;
  });
  const regionalParameters = Object.entries(chinaOnlyInputs)
    .flatMap(([name, parameters]) => parameters.map(parameter => code(`${name}.${parameter}`))).join(", ");
  const catalog = [
    beginMarker, "", doc.introduction(regions, tools.length), "", doc.headers, "| --- | --- | --- | --- |", ...rows,
    "", doc.regionalParameters(regionalParameters), "", endMarker
  ].join("\n");
  const updated = readme.slice(0, begin) + catalog + readme.slice(end + endMarker.length);
  if (updated !== readme && args.includes("--check")) {
    console.error(`${doc.filename} tool catalog is stale. Build and run npm run catalog:generate.`);
    process.exitCode = 1;
  } else {
    if (updated !== readme) {
      await writeFile(readmePath, original.includes("\r\n") ? updated.replaceAll("\n", "\r\n") : updated);
    }
    console.log(`${doc.filename} matches all ${tools.length} tools from ${version} (CN=${regions.cn.tools.length}, Global=${regions.global.tools.length}).`);
  }
}

function requiredToolInput(tool, doc) {
  // Both modes expose the same file fields; the private schema also accepts the legacy nested file.
  if (tool.name === "extract_document") {
    return [code("file_url"), doc.alternatives(["app_id", "fields"].map(code))].join(" + ");
  }
  const required = requiredInput(validationInputSchema(tool), doc);
  return tool.name === "verify_invoice" ? required + doc.invoiceRequirements : required;
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
