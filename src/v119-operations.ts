import type { JsonObject, JsonSchema, Operation } from "./types.js";

const identifier = { type: "string", minLength: 1, pattern: "\\S" };
export const clientProperties = {
  accept_language: { type: "string", enum: ["zh", "en"], description: "与创建任务时一致的账号区域及返回语言。" },
  timeout_seconds: { type: "integer", minimum: 1, maximum: 900, default: 300 }
};
export const resultSwitchProperties = {
  enable_highlight: { type: ["boolean", "null"], description: "本次高速抽取的原文定位开关；省略/null 沿用应用配置，false 关闭。" },
  enable_field_value_translation: { type: ["boolean", "null"], description: "本次字段值翻译开关；省略/null 沿用应用配置，false 关闭。目标语言由 accept_language 决定。" },
  enable_confidence: { type: ["boolean", "null"], description: "本次高速抽取的字段置信度开关；省略/null 沿用应用配置，false 关闭。" }
};
const pages = { type: ["array", "null"], minItems: 1, maxItems: 260, uniqueItems: true, items: { type: "integer", minimum: 1 }, description: "从 1 开始的原始页码，不可重复。" };
export const extractModelParamsSchema: JsonSchema = {
  type: ["object", "null"], additionalProperties: false,
  properties: {
    pages: { type: ["array", "null"], uniqueItems: true, items: { type: "integer", minimum: 1 }, description: "从 1 开始的原始页码，不可重复；省略/null/空数组不筛选页面，原生 Markdown 只有逻辑页 1。" },
    scale: { type: "number", exclusiveMinimum: 0, description: "页面图片转换比例，默认 1；不保证影响原生 XLSX/Markdown。" },
    keep_content: { type: "boolean", description: "支持该能力的经典抽取应用返回链接时保留内联内容；不使高速自定义抽取返回解析结果。" },
    disable_collaboration: { anyOf: [{ type: "boolean" }, { type: "integer", enum: [0, 1] }], description: "高速自定义抽取始终禁用人机协同。" },
    page_task_timeout_seconds: { type: "number", exclusiveMinimum: 0, description: "解析结果逐页整理等待时限，不是整次抽取超时。" },
    card_type: { type: "string", description: "仅支持卡证类型选择的应用生效，显式顶层值优先。" },
    enable_multi_ticket: { type: "boolean", description: "仅支持多票处理的应用生效，显式顶层值优先。" }
  }
};
const fileProperties = {
  file: { type: "string", minLength: 1, pattern: "\\S", description: "PDF/PNG/JPEG 的 HTTP URL 或 Base64；最大 100 MB，原文件最多 260 页。" },
  file_name: { type: "string", description: "文件名及扩展名，Base64 输入建议提供。" },
  wait: { type: "boolean", default: true, description: "默认同步；用户明确要求异步时传 false。" },
  ...clientProperties
};
const querySchema: JsonSchema = {
  type: "object", additionalProperties: false, required: ["task_id"],
  properties: { task_id: { ...identifier, description: "由同类型异步创建返回的 task_id；同步响应 task_id 不表示可异步查询。" }, ...clientProperties }
};
export const appListInputSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { ai_function: { type: "integer", enum: [1406, 1423, 1424, 1425] }, ...clientProperties }
};
const classificationInput: JsonSchema = {
  type: "object", additionalProperties: false, required: ["app_id", "file"],
  properties: { app_id: identifier, ...fileProperties,
    model_params: { type: "object", additionalProperties: false, properties: { pages } } }
};
const routedInput: JsonSchema = {
  type: "object", additionalProperties: false, required: ["app_ids", "file"],
  properties: {
    app_ids: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: identifier,
      description: "候选应用限 1425/1423/1424；ID 不重复，应用名称去除首尾空白后也须不区分大小写唯一。" },
    ...fileProperties,
    model_params: { type: "object", additionalProperties: false, properties: { pages, ...resultSwitchProperties } }
  }
};
function taskOutput(routed: boolean): JsonSchema {
  return {
    type: "object", required: ["code", "data"], additionalProperties: true,
    properties: { code: { const: "success" }, data: {
      type: "object", required: ["task_id", "status"], additionalProperties: true,
      properties: { task_id: identifier, status: { type: "string", enum: ["pending", "running", "success", ...(routed ? ["partial_success"] : []), "failed"] },
        ...(routed ? { extraction_result: { type: "array", items: { type: "object", additionalProperties: true } } }
          : { segments: { type: "array", items: { type: "object", additionalProperties: true } } }),
        unclassified_pages: { type: "array", items: { type: "integer", minimum: 1 } }
      }
    } }
  };
}
const docPrefix = "/open/agentic_doc_processor/{tenant_name}/v1";
function taskOperations(routed: boolean): Operation[] {
  const suffix = routed ? "extract/routed" : "classify";
  return [
    {
      name: routed ? "extract_routed_document" : "classify_document",
      title: routed ? "自动分类路由抽取" : "独立文档分类",
      operationId: routed ? "extractRoutedDocument" : "classifyDocument",
      description: routed
        ? "按候选应用名称与描述分类，将每份文档实例交给对应应用抽取。默认同步，异步 wait=false 后只用 query_routed_task 查询。partial_success 表示部分失败，须保留成功结果并说明逐实例错误；全未分类仍可能 success 且结果为空。仅 PDF/PNG/JPEG。不要因失败或受理不明自动重复提交。"
        : "使用 1426 分类应用返回文档实例类别和原始页码。先用 list_classification_apps 获取 app_id。默认同步；异步 wait=false 后只用 query_classify_task 查询。全未分类可为 success 且 segments 为空。同步 task_id 只用于关联，不代表生成可查询异步任务。",
      method: "POST", path: `${docPrefix}/app/doc/${suffix}`, asyncPath: `${docPrefix}/app/doc/${suffix}/create/task`,
      auth: "adp", bodyMode: "json", inputSchema: routed ? routedInput : classificationInput,
      outputSchema: taskOutput(routed), validateInput: true, validateOutput: true,
      bodyFields: routed ? ["app_ids", "file_name", "model_params"] : ["file_name", "model_params"],
      ...(routed ? {} : { appIdField: "app_id" }),
      annotations: { readOnlyHint: false }, usesTenant: true, usesAcceptLanguage: true
    },
    {
      name: routed ? "query_routed_task" : "query_classify_task",
      title: routed ? "查询自动路由抽取异步任务" : "查询文档分类异步任务",
      operationId: routed ? "queryRoutedTask" : "queryClassifyTask",
      description: routed
        ? "只查询 extract_routed_document 在 wait=false 时返回的任务 ID。保留 pending/running/success/partial_success/failed、全部实例结果及错误；partial_success 不等于全部成功。"
        : "只查询 classify_document 在 wait=false 时返回的任务 ID。返回 pending/running/success/failed、segments 和未分类页；不使用普通解析或抽取查询接口。",
      method: "GET", path: `${docPrefix}/app/doc/${suffix}/query/task/{task_id}`,
      auth: "adp", bodyMode: "none", inputSchema: querySchema, outputSchema: taskOutput(routed),
      validateInput: true, validateOutput: true, responseIdentityFields: ["task_id"], pathParams: ["task_id"],
      annotations: { readOnlyHint: true }, usesTenant: true, usesAcceptLanguage: true
    }
  ];
}
const nullableStrings = { type: ["array", "null"], items: identifier };
export const workflowExportInputSchema: JsonSchema = {
  type: "object", additionalProperties: false, required: ["application_id"],
  properties: {
    application_id: identifier,
    run_ids: { ...nullableStrings, description: "建议显式指定范围；通用模式省略/null/空数组可选择当前用户符合条件的运行，服务端筛选后参与导出最多 200 个。" },
    node_ids: nullableStrings, node_types: nullableStrings,
    variable_filters: { type: ["object", "null"], additionalProperties: true },
    format: { type: "string", enum: ["excel", "word", "markdown", "html", "json"], default: "excel" },
    report_mode: { type: "string", enum: ["merged", "per_run", "task_data", "task_package"], default: "merged" },
    include_failed_runs: { type: "boolean", default: false },
    primary_key_variable: { type: ["string", "null"] },
    max_text_length: { type: ["integer", "null"], minimum: 1, maximum: 30000, default: 10000 },
    locale: { type: ["string", "null"], enum: ["zh-CN", "en-US", null], description: "任务报告展示语言，不重跑抽取或翻译；与账号区域 accept_language 不同。" },
    ...clientProperties
  },
  allOf: [
    { if: { properties: { report_mode: { enum: ["task_data", "task_package"] } }, required: ["report_mode"] }, then: {
      required: ["run_ids"], properties: {
        run_ids: { type: "array", minItems: 1, maxItems: 1, items: identifier },
        node_ids: { ...nullableStrings, maxItems: 0 }, node_types: { ...nullableStrings, maxItems: 0 },
        variable_filters: { type: ["object", "null"], maxProperties: 0 }
      }
    } },
    { if: { properties: { report_mode: { const: "task_data" } }, required: ["report_mode"] }, then: { properties: { format: { enum: ["excel", "json"] } } } },
    { if: { properties: { report_mode: { const: "task_package" } }, required: ["report_mode"] }, then: { required: ["format"], properties: { format: { enum: ["word", "markdown", "html"] } } } }
  ]
};
export const v119Operations: Operation[] = [
  {
    name: "list_classification_apps", title: "列出文档分类应用", operationId: "listClassificationApps",
    description: "列出当前用户创建的 1426 独立分类应用，自动读取全部分页。分类配置创建或更新后立即生效，无需抽取配置发布。返回 app_id 后用 classify_document。",
    method: "GET", path: `${docPrefix}/app-list`, auth: "adp", bodyMode: "none",
    inputSchema: { type: "object", additionalProperties: false, properties: clientProperties }, validateInput: true,
    annotations: { readOnlyHint: true }, usesTenant: true, usesAcceptLanguage: true
  },
  ...taskOperations(false), ...taskOperations(true),
  {
    name: "export_workflow_runs", title: "导出工作流运行结果（受限预览）", operationId: "exportWorkflowRuns",
    description: "仅在用户明确要求导出时使用受限预览接口。导出当前账号在当前租户中指定应用的运行，无需管理员；应用或运行 ID 不授予其他用户数据权限。merged/per_run 为通用导出，task_data/task_package 只允许一个任务且不能有非空筛选。下载链接是临时地址。受理不明时不自动重发。",
    method: "POST", path: "/open/agentic_engine/laiye/v1/app/runs/export", auth: "adp", bodyMode: "json",
    inputSchema: workflowExportInputSchema, validateInput: true,
    bodyFields: ["application_id", "run_ids", "node_ids", "node_types", "variable_filters", "format", "report_mode", "include_failed_runs", "primary_key_variable", "max_text_length", "locale"],
    annotations: { readOnlyHint: false }, usesAcceptLanguage: true
  }
];

export function isFailedAdpResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const envelope = result as JsonObject;
  if (envelope.code !== undefined && envelope.code !== "success") return true;
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as JsonObject : envelope;
  return ["failed", "partial_success", "cancelled", "timeout", 5, 6].includes(data.status as string | number);
}

export function validateExportResult(args: JsonObject, value: unknown): void {
  const response = value as { code?: unknown; data?: JsonObject };
  const data = response?.data;
  if (response?.code !== "success" || !data || !["file_id", "download_url", "filename"].every(key => typeof data[key] === "string" && (data[key] as string).length > 0)
      || !/^https?:\/\//.test(String(data.download_url)) || !Number.isInteger(data.file_size) || Number(data.file_size) < 0
      || data.format !== (args.format ?? "excel") || data.report_mode !== (args.report_mode ?? "merged")
      || !["total_runs", "included_runs", "skipped_runs"].every(key => Number.isInteger(data[key]) && Number(data[key]) >= 0)
      || Number(data.included_runs) > 200 || Number(data.included_runs) + Number(data.skipped_runs) !== data.total_runs
      || !Array.isArray(data.run_summaries) || !data.run_summaries.every(summary => summary !== null && typeof summary === "object"
        && typeof (summary as JsonObject).run_id === "string" && typeof (summary as JsonObject).status === "string")
      || typeof data.export_time !== "string" || Number.isNaN(Date.parse(data.export_time))) {
    throw new Error("Export response did not satisfy the requested contract; acceptance may be unknown. Do not automatically resubmit.");
  }
  if (["task_data", "task_package"].includes(String(data.report_mode))) {
    const summaries = data.run_summaries as JsonObject[];
    if (data.total_runs !== 1 || data.included_runs !== 1 || data.skipped_runs !== 0 || summaries.length !== 1
        || summaries[0].run_id !== (args.run_ids as string[])[0]) {
      throw new Error("Task export response did not match the requested run; acceptance may be unknown. Do not automatically resubmit.");
    }
  }
}
