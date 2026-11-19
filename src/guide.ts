import type { AdpRegion } from "./adp-client.js";

// Public app IDs from api-reference/preset-{domestic-bills,overseas-documents,purchase-orders,cards}.yaml.
export const domesticBillsAppId = "ootb_v9x2y5z8a1b4c7d0e3f6h9j1k4m7";
const globalExtractionPresets = [
  { zh: "海外发票和收据（高速版，国际通用，默认）", en: "Global invoices and receipts (high-speed, default)", id: "ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2" },
  { zh: "海外发票和收据（东南亚版）", en: "Southeast Asian invoices and receipts", id: "ootb_u2v5w8x1y4z7a0b3c6d9e2f5g8" },
  { zh: "海外发票和收据（标准版）", en: "Global invoices and receipts (standard)", id: "ootb_a3f8h1j5k9n2p7q4w6x0y3b5c8d1" },
  { zh: "采购订单", en: "Purchase orders", id: "ootb_m9n2p5q8r1t4v7w0x3y6z9a2b5" },
];
const domesticExtractionPresets = [
  { zh: "国内通用票据", en: "Domestic general bills", id: domesticBillsAppId },
  ...globalExtractionPresets,
  { zh: "银行卡", en: "Bank cards", id: "ootb_c2h5k8n1p4q7r0t3v6w9x2y5z8" },
  { zh: "港澳通行证", en: "Hong Kong and Macao travel permits", id: "ootb_n2m5n8p1q4r7t0v3w6x9y2z5a8b1c" },
  { zh: "组织机构代码证", en: "Organization code certificates", id: "ootb_k8m2n5p1q4r7t0v3w6x9y2z5a8b4" },
  { zh: "身份证", en: "Chinese ID cards", id: "ootb_b7k2m5n8p1q4r7t0v3w6x9y2z5" },
  { zh: "户口本", en: "Household registration books", id: "ootb_l5k8n1p4q7r0t3v6w9x2y5z8a1b7" },
  { zh: "护照-中国", en: "Chinese passports", id: "ootb_h5m8n1p4q7r0t3v6w9x2y5z8a1b4" },
  { zh: "行驶证", en: "Vehicle registration certificates", id: "ootb_j2k5n8p1q4r7t0v3w6x9y2z5a8b1" },
  { zh: "开户许可证", en: "Bank account opening permits", id: "ootb_e5k8n1p4q7r0t3v6w9x2y5z8a1b" },
  { zh: "驾驶证", en: "Driver's licenses", id: "ootb_f2m5n8p1q4r7t0v3w6x9y2z5a8b" },
  { zh: "营业执照", en: "Business licenses", id: "ootb_g8k2n5p1q4r7t0v3w6x9y2z5a8b" },
  { zh: "车辆合格证", en: "Vehicle conformity certificates", id: "ootb_d9m2p5q8r1t4v7w0x3y6z9a2b5c" }
];

const extractionPresets = { cn: domesticExtractionPresets, global: globalExtractionPresets };
export const presetExtractionIds = {
  cn: new Set(domesticExtractionPresets.map(({ id }) => id)),
  global: new Set(globalExtractionPresets.map(({ id }) => id)),
};

export const parseAppId = "ootb_k7m2x9p4v1n8w3q6r5t0y2b4";
export const defaultWaitSeconds = 60;
export const batchLimit = 20;
export const batchConcurrency = 3;

export function getGuide(version: string, language: string, region: AdpRegion, regionConfirmed = true): string {
  const english = /^en(?:[-_]|$)/i.test(language);
  const global = region === "global";
  const regionName = english ? (global ? "Global" : "China") : (global ? "全球区" : "中国区");
  const regionNote = regionConfirmed
    ? (english ? `Service region: ${regionName}.` : `服务区域为${regionName}。`)
    : (english
      ? `The service region is unconfirmed. This guide shows the ${regionName} presets for reference.`
      : `服务区域尚未确认。本引导展示${regionName}预制应用供参考。`);
  const presets = [
    `| ${english ? "General document parsing" : "通用文档解析"} | \`${parseAppId}\` |`,
    ...extractionPresets[region].map(({ zh, en, id }) => `| ${english ? en : zh} | \`${id}\` |`)
  ].join("\n");

  if (english) {
    return `# ADP MCP v2 guide (${version})

${regionNote}

## Choose a tool

- \`upload_temporary_file\` uploads one or more local files. Pass \`{"files":[{"file_path":"file:///D:/Documents/invoice.pdf"}]}\`. For each successful upload, use \`files[].data.download_url\` in the next call. If the file already has a reachable HTTP(S) URL, use it directly.
- \`parse_document\` returns page text and document structure. Pass \`files\` with each file's \`url\` and optional \`name\`. Set \`recognize_mode\` to select a mode or \`pages\` to limit processing to the original page numbers, starting at 1. The tool selects the general parsing preset automatically.
- \`extract_document\` extracts a known document type with a preset. For a global invoice, pass \`{"app_id":"ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2","files":[{"url":"https://example.com/invoice.pdf"}]}\`.
- \`extract_custom_document\` extracts fields specified for this call. For example, pass \`{"files":[{"url":"https://example.com/report.pdf"}],"fields":[{"name":"Reporting period"}]}\`. Each of the 1–20 fields needs a unique \`name\` and can include a \`prompt\`.
- \`route_document\` takes \`files\` and the \`app_id\` of an existing classification app. Use the ID saved when the classification app was created. It returns document types, original page numbers, and unclassified pages. Optional \`pages\` limits the original page numbers to classify. [Classification app setup](https://adp-doc.laiye.com/en/api-reference/adp-api/document-classification/overview)
- \`task\` queries or cancels an existing task. Query is the default action. For parsing, preset extraction, or classification, copy \`files[i].task_ref\` from the result for the file you want. For an existing workflow run, pass its \`run_id\`. Pass the whole reference, for example \`{"task_ref":{"kind":"parse","id":"task-id-from-result"}}\`. You can also copy the \`arguments\` from a \`task\` entry in \`next_steps\`.
- \`submit_user_feedback\` submits a product issue or suggestion and returns the feedback ID.

## Preset applications

| Preset application | app_id |
| --- | --- |
${presets}

${global ? "" : "For the domestic bills preset, set `enable_invoice_verify` to enable or disable verification for this call. Omit it or pass `null` to use the app setting.\n\n"}\
The global and Southeast Asia high-speed invoice presets support \`enable_multi_ticket\` (default \`true\`), \`enable_highlight\`, and \`enable_confidence\`. Use \`enable_field_value_translation\` with an overseas invoice preset to override field-value translation for this call.

Set \`with_rec_result: true\` when you need the parsing result from a preset that supports it. To get full text independently, use \`parse_document\`.

- \`standard\` (Standard parsing) for clear digital documents.
- \`advance\` (Enhanced parsing 1.0) for documents with stamps, signatures, or multiple tables.
- \`agentic_v2\` (Smart parsing 2.0) for documents with complex layouts, tables, or formulas.
- \`thai_ocr\` (Thai-first mode) for documents primarily in Thai.

## File limits and concurrency

- Upload, parsing, preset extraction, custom extraction, and classification tools accept 1–${batchLimit} files per call. Each call handles files individually and allows up to ${batchConcurrency} OpenAPI requests in flight, including submissions and polling. Each file has its own result in \`files\`, in input order.
- ADP applies account processing concurrency and request rate limits separately. [Rate limits, concurrency, and timeouts](https://adp-doc.laiye.com/en/api-reference/rate-limits)

## Waiting and credits

For parsing, preset extraction, and classification, omit \`pages\` or pass \`[]\` to process all pages. Pass original page numbers such as \`[2, 4]\` where page selection is supported.

Parsing, preset extraction, and classification wait up to ${defaultWaitSeconds} seconds by default. Set \`wait: false\` to get the task reference after submission, or \`wait_timeout_seconds\` to adjust the wait. When the wait ends before completion, call \`task\` with the original \`task_ref\`. Custom extraction returns a synchronous result.

For \`task\`, provide exactly one identifier form: \`task_ref\`, a workflow \`run_id\`, or a document \`task_id\` together with \`task_type\` (\`parse\`, \`extract\`, or \`classify\`). For example, \`{"task_id":"task-id-from-result","task_type":"extract"}\` queries an extraction task. To cancel a document task, use \`{"action":"cancel","task_ref":{"kind":"extract","id":"task-id-from-result"}}\`. Only unclaimed pending document tasks can be cancelled. Workflows support queries only. A successful cancellation returns \`action: "cancel"\` and \`status: "succeeded"\`; inspect \`data.status\` for the actual task state. If cancellation is refused, the original state remains in \`data\`. Querying a cancelled task returns \`status: "cancelled"\` without a tool error. Query and cancellation keep the original task reference and never submit a new task.

\`usage\` contains the available page count and recorded credits. Treat unavailable values as unknown. Final deductions follow the account's billing record. If a tool reports insufficient credits, top up the account before retrying.

## Credentials

When \`ADP_API_KEY\` is unset, each business tool call automatically reads the key, API address and tenant saved by \`adp config set\` on the same machine under the same system account. Leave the MCP address, region and tenant unset to inherit the CLI settings. If you set them explicitly, the API address, tenant and official region must match the CLI target. Correct any conflict before retrying.

If no CLI credentials are available, get a key and save it with \`adp config set\` or set \`ADP_API_KEY\` in the MCP client. With a standalone key, MCP first looks for the same key's saved official API address and tenant in the CLI. For the public tenant \`laiye\`, it can otherwise detect the region using a read-only authentication request. It checks China first and checks Global only after an exact \`404 Accessor not found\`. A confirmed region is reused for the current process with the original key. Detection neither checks credits nor submits or retries business requests. Set \`ADP_REGION=cn\`, \`ADP_REGION=global\`, or an explicit \`ADP_API_BASE_URL\` to bypass detection. A tenant other than \`laiye\` also bypasses detection.

Listing tools or calling \`get_adp_guide\` can trigger the first check. If the region cannot be confirmed, the tool list uses the China presets as a fallback. \`get_adp_guide\` takes no parameters and follows \`ADP_ACCEPT_LANGUAGE\`. [China ADP](https://adp.laiye.com?from=getkey&utm_source=github) · [Global ADP](https://adp-global.laiye.com?from=getkey&utm_source=github)

## Feedback

Use \`feedback_type: "issue"\` for errors or incorrect results and \`"suggestion"\` for requests or improvements. Summarize the scenario, expected outcome, actual behavior and steps already tried. Separate facts from assumptions and omit credentials, unnecessary personal or financial details, and full transcripts.

Text-only feedback is supported. Include local logs, configuration, or files only after the user explicitly approves those specific attachments. Review them first, then pass \`attachment_paths\` with \`attachments_authorized: true\`. If the user declines follow-up, set \`allow_follow_up: false\`. On success report \`data.id\`. If submission is unconfirmed, keep the summary and avoid automatic resubmission.
`;
  }

  return `# ADP MCP v2 引导说明（${version}）

${regionNote}

## 选择工具

- \`upload_temporary_file\` 上传一份或多份本地文件。传入 \`{"files":[{"file_path":"file:///D:/Documents/invoice.pdf"}]}\`，后续使用每项上传结果中的 \`files[].data.download_url\`。已有可访问的 HTTP(S) 文件地址时可直接使用。
- \`parse_document\` 返回逐页文本和文档结构。传入 \`files\`，每项填写 \`url\`，可选 \`name\`。可用 \`recognize_mode\` 选择解析模式，或用 \`pages\` 指定从 1 开始的原始页码。工具会自动选择通用文档解析预制应用。
- \`extract_document\` 用预制应用抽取已知文种的业务字段。海外发票示例为 \`{"app_id":"ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2","files":[{"url":"https://example.com/invoice.pdf"}]}\`。
- \`extract_custom_document\` 按本次指定的字段抽取。可以传入 \`{"files":[{"url":"https://example.com/report.pdf"}],"fields":[{"name":"报告期间"}]}\`。\`fields\` 支持 1–20 项，每项的 \`name\` 必填且不可重复，可选 \`prompt\`。
- \`route_document\` 传入 \`files\` 和已有分类应用的 \`app_id\`。使用创建分类应用时保存的 ID。工具返回识别出的文种、原始页码和未分类页。可用 \`pages\` 指定要分类的原始页码。 [创建分类应用](https://adp-doc.laiye.com/api-reference/adp-api/document-classification/overview)
- \`task\` 查询或取消已提交的任务，默认查询。解析、常见文档抽取和分类从响应中对应文件的 \`files[i].task_ref\` 取引用，已有工作流运行可直接传 \`run_id\` 查询。原样传入整个引用，例如 \`{"task_ref":{"kind":"parse","id":"task-id-from-result"}}\`。如果响应的 \`next_steps\` 中有 \`task\`，可以直接复制该步骤的 \`arguments\`。
- \`submit_user_feedback\` 提交使用问题或改进建议，成功后返回反馈编号。

## 预制应用名称和 ID

| 预制应用 | app_id |
| --- | --- |
${presets}

${global ? "" : "国内通用票据支持用 `enable_invoice_verify` 为本次抽取开启或关闭发票验真。省略或传 `null` 时沿用应用配置。\n\n"}\
海外发票的国际通用高速版和东南亚高速版支持 \`enable_multi_ticket\`（默认 \`true\`）、\`enable_highlight\` 和 \`enable_confidence\`。海外发票可用 \`enable_field_value_translation\` 控制本次字段值翻译。

如果所选预制应用支持随抽取返回解析结果，可传 \`with_rec_result: true\`。需要单独取得全文时，使用 \`parse_document\`。

- \`standard\`（标准解析）适用于清晰的电子文档。
- \`advance\`（增强解析 1.0）适用于含印章、签名或多张表格的文档。
- \`agentic_v2\`（智能解析 2.0）适用于含复杂版式、表格或公式的文档。
- \`thai_ocr\`（泰语优先模式）适用于以泰语为主的文档。

## 文件数量与并发

- 上传、解析、预制抽取、自定义抽取和分类每次可传 1–${batchLimit} 份文件。每次调用逐文件发起请求，提交和轮询最多同时有 ${batchConcurrency} 个 OpenAPI 请求在途。响应 \`files\` 按输入顺序逐项返回结果。
- ADP 另行限制账号处理并发和请求速率。 [速率、并发与超时](https://adp-doc.laiye.com/api-reference/rate-limits)

## 等待方式与积分

解析、常见文档抽取和分类的 \`pages\` 都是选填，省略或传 \`[]\` 时处理全部页面。支持按页码筛选时，传 \`[2, 4]\` 可处理原文档的第 2、4 页。

解析、预制抽取和分类默认最多等待 ${defaultWaitSeconds} 秒。设置 \`wait: false\` 可在提交后获取任务引用，或用 \`wait_timeout_seconds\` 调整等待上限。达到上限时用原 \`task_ref\` 调用 \`task\` 续查。自定义抽取返回同步结果。

\`task\` 的任务标识三选一：\`task_ref\`、工作流 \`run_id\`，或文档 \`task_id\` 与 \`task_type\`（\`parse\`、\`extract\`、\`classify\`）。例如 \`{"task_id":"task-id-from-result","task_type":"extract"}\` 查询抽取任务。取消文档任务时传 \`{"action":"cancel","task_ref":{"kind":"extract","id":"task-id-from-result"}}\`。仅可取消尚未被领取的待执行文档任务，工作流仅支持查询。取消成功返回 \`action: "cancel"\`、\`status: "succeeded"\`，任务实际状态看 \`data.status\`；未取消时也会在 \`data\` 保留实际状态。查询已取消任务返回 \`status: "cancelled"\`，不视为工具错误。查询和取消均保留原任务引用，不重新提交任务。

\`usage\` 展示可用页数和已记录积分。字段缺失表示数据暂不可用，最终扣费以账户账单为准。收到积分不足提示时，请先充值再重试。

## 凭据

没有设置 \`ADP_API_KEY\` 时，每次业务工具调用都会自动读取同一台机器、同一系统账号下通过 \`adp config set\` 保存的 Key、API 地址和租户。省略 MCP 的地址、区域和租户即可继承 CLI 设置。若显式设置，API 地址、租户和官方区域须与 CLI 配置匹配。遇到冲突时先修正配置，再重试。

没有可用的 CLI 凭据时，先获取 Key，然后通过 \`adp config set\` 保存，或在 MCP 客户端中设置 \`ADP_API_KEY\`。仅配置 Key 时，MCP 优先沿用 CLI 为同一个 Key 保存的公有云地址和租户。公有云租户 \`laiye\` 在没有可沿用配置时，可通过只读鉴权请求自动识别区域。MCP 先检查中国区，只有收到明确的 \`404 Accessor not found\` 才检查全球区。成功后在当前进程内复用区域结果并沿用原 Key。识别不查询积分，不提交或重试业务请求。指定 \`ADP_REGION=cn\`、\`ADP_REGION=global\`、\`ADP_API_BASE_URL\` 或其他租户时跳过识别。

列出工具或调用 \`get_adp_guide\` 时可触发首次识别。未能确认区域时，工具列表以中国区预制应用为参考。\`get_adp_guide\` 无需参数，语言跟随 \`ADP_ACCEPT_LANGUAGE\`。 [中国区 ADP](https://adp.laiye.com?from=getkey&utm_source=github) · [全球区 ADP](https://adp-global.laiye.com?from=getkey&utm_source=github)

## 提交用户反馈

报错、抽取不准或运行异常用 \`feedback_type: "issue"\`，新增需求或改进建议用 \`"suggestion"\`。摘要写清场景、预期、实际表现和已尝试的处理方式，区分已确认事实与待核实判断，移除凭证、无关个人或财务信息和整段会话。

可以只提交文字。仅在用户明确授权具体材料后，将已检查的本地运行日志、抽取配置或文件列入 \`attachment_paths\`，并设 \`attachments_authorized: true\`。用户不希望被联系时，设 \`allow_follow_up: false\`。成功后告知 \`data.id\`。提交状态未知时保留摘要，避免自动重复提交。
`;
}
