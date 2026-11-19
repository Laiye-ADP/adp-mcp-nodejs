import { setTimeout as delay } from "node:timers/promises";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { AdpApiError, type AdpClient, type AdpRegion, type JsonObject } from "./adp-client.js";
import { batchConcurrency, batchLimit, defaultWaitSeconds, domesticBillsAppId, getGuide, parseAppId, presetExtractionIds } from "./guide.js";
import { resultSchemas } from "./result-schema.js";

type TaskKind = "parse" | "extract" | "classify" | "workflow";
type TaskRef = { kind: TaskKind; id: string };
type FileReference = { url: string; name?: string };
type ResultStatus = "pending" | "succeeded" | "failed" | "cancelled" | "partial_success";
type ScheduleRequest = <T>(request: () => Promise<T>) => Promise<T>;
type WaitStatus = "paused" | "timeout" | "query_failed";
type Schema = JsonSchemaType;
type ObjectSchema = Schema & { type: "object"; properties: Record<string, Schema>; required: string[] };
type ToolValidators = { validate: JsonSchemaValidator<unknown>; single?: JsonSchemaValidator<unknown> };

const requiredText: Schema = { type: "string", minLength: 1, pattern: "\\S" };
const fileUrl: Schema = { ...requiredText, format: "uri", description: "可访问的 HTTP(S) 文件 URL，或上传返回的 download_url。" };
const maxQueryRetries = 3;
const initialPollIntervalMs = 2000;
const maxPollIntervalMs = 10000;
const taskKinds = ["parse", "extract", "classify", "workflow"] as const;
const taskActions = {
  parse: { route: "/v1/app/doc/recognize", idKey: "task_id" },
  extract: { route: "/v1/app/doc/extract", idKey: "task_id" },
  classify: { route: "/v1/app/doc/classify", idKey: "task_id" },
  workflow: { route: "/v1/app/run", idKey: "run_id" }
} as const;
const taskReference = objectSchema({
  kind: { type: "string", enum: taskKinds, description: "原任务引用中的类型。" },
  id: { ...requiredText, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$",
    description: "原任务引用中的 ID，文档任务来自 task_id，工作流来自 run_id。" }
}, ["kind", "id"]);
const output = resultSchemas(taskReference);
const readOnly = { readOnlyHint: true, idempotentHint: true };
const submit = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true };
const parseModes = ["standard", "advance", "agentic_v2", "thai_ocr"] as const;
const documentFile = objectSchema({
  url: fileUrl, name: { ...requiredText, description: "可选文件名，建议包含扩展名。" }
}, ["url"]);
const customDocumentFile = objectSchema({ url: fileUrl }, ["url"]);
const localFile = objectSchema({
  file_path: { ...requiredText, description: "本机可读取的文件路径，支持绝对路径或 file:/// 地址。" }
}, ["file_path"]);
const waitProperties: Record<string, Schema> = {
  wait: { type: "boolean", default: true, description: "默认等待；false 在提交完成后立即返回任务引用，随后用 task 查询。" },
  wait_timeout_seconds: { type: "integer", minimum: 1, maximum: 900, default: defaultWaitSeconds,
    description: "等待结果的最长秒数。超时后返回原任务引用。" }
};
const pages: Schema = { type: "array", items: { type: "integer", minimum: 1 }, uniqueItems: true, default: [],
  description: "选填，省略或传 [] 时处理全部页面。只处理指定页时填写原始页码，从 1 开始且不能重复。" };

function buildTools(region: AdpRegion) {
  const global = region === "global";
  return [
    {
      name: "get_adp_guide", title: "获取引导说明文档",
      description: "获取与当前 MCP 连接版本和区域对应的 ADP 引导说明。正文包含预制应用名称与 app_id 对照表、文件上传步骤和文档处理调用示例。",
      inputSchema: objectSchema({}),
      annotations: { ...readOnly, openWorldHint: false },
      outputSchema: output.get_adp_guide
    },
    {
      name: "upload_temporary_file", title: "上传本地文件",
      description: "将本机路径放入 files，每项填写 file_path，单文件也传一项。上传成功后从 files[].data 取 download_url。已有可访问的 HTTP(S) 文件地址时可直接用于业务工具。",
      inputSchema: objectSchema({
        files: { ...arraySchema(localFile), description: `每次可传 1–${batchLimit} 份本地文件，逐份上传，最多 ${batchConcurrency} 个上传请求同时进行。` }
      }, ["files"]),
      annotations: submit,
      outputSchema: output.upload_temporary_file
    },
    {
      name: "parse_document", title: "解析文档全文",
      description: "需要阅读、检索或处理文档全文时使用。将文件地址放入 files，返回逐页文本和文档结构。可用 recognize_mode 选择解析模式，或用 pages 指定要解析的原始页码。",
      inputSchema: documentInput({
        ...waitProperties,
        pages,
        recognize_mode: { type: "string", enum: parseModes, description: "解析模式，适用场景见 get_adp_guide。" }
      }),
      annotations: submit,
      outputSchema: output.parse_document
    },
    {
      name: "extract_document", title: "常见文档抽取",
      description: global
        ? "从 get_adp_guide 选取全球区预制 app_id，传入文件地址，抽取海外发票和收据或采购订单的结构化字段。海外发票默认使用国际通用高速版。选填开关按预制应用支持范围生效。"
        : "已知文种且预制字段满足需求时使用。从 get_adp_guide 选取预制 app_id，传入文件地址，获取票据、卡证、采购订单等文档的结构化业务字段。海外发票默认使用国际通用高速版。附带解析结果、多票拆分、发票验真、字段值翻译、原文定位和字段置信度均为选填开关。无需覆盖时省略对应参数，显式 false 会关闭适用功能。发票验真仅适用于国内通用票据。",
      inputSchema: documentInput({
        app_id: { ...requiredText, enum: [...presetExtractionIds[region]], description: "从 get_adp_guide 的对照表选择对应文种的预制抽取应用 ID。" },
        pages: { ...pages, description: `${pages.description} 指定页码仅对支持页码筛选的预制应用生效。` },
        with_rec_result: { type: "boolean", title: "附带解析结果", description: "仅对支持附带解析结果的预制应用生效。需要全文时用 parse_document。" },
        enable_multi_ticket: { type: "boolean", title: "多票拆分", description: "将多张票据分别返回。海外发票仅国际通用高速版和东南亚高速版支持，省略时使用默认值 true。" },
        ...(!global && { enable_invoice_verify: {
          type: "boolean", title: "发票验真",
          description: "仅国内通用票据支持。true 或 false 覆盖本次发票验真设置，省略时沿用应用配置。"
        } }),
        enable_field_value_translation: { type: "boolean", title: "字段值翻译", description: "在支持的预制应用上覆盖本次字段值翻译设置。省略时沿用应用配置。" },
        enable_highlight: { type: "boolean", title: "原文定位", description: "在支持的高速版上覆盖本次原文定位设置。省略时沿用应用配置。" },
        enable_confidence: { type: "boolean", title: "字段置信度", description: "在支持的高速版上覆盖本次字段置信度设置。省略时沿用应用配置。" },
        ...waitProperties
      }, ["app_id"]),
      annotations: submit,
      outputSchema: output.extract_document
    },
    {
      name: "extract_custom_document", title: "自定义字段抽取",
      description: "预制应用未覆盖文种或所需字段时使用。传入文件地址和本次要抽取的 fields，每个字段提供 name，可选 prompt。同步返回这些字段的结构化结果。",
      inputSchema: documentInput({
        fields: {
          type: "array", minItems: 1, maxItems: 20,
          description: "本次抽取的字段定义，批量处理时对所有文件使用同一组字段。",
          items: objectSchema({
            name: { ...requiredText, description: "字段名称。同一组字段的名称不能重复。" },
            prompt: { type: "string", description: "可选字段说明，如目标格式或取值规则。" }
          }, ["name"])
        }
      }, ["fields"], customDocumentFile),
      annotations: submit,
      outputSchema: output.extract_custom_document
    },
    {
      name: "route_document", title: "按文种分类",
      description: "文种未知或同一文件混有多种文档时使用。传入已有分类应用的 app_id 和文件地址，返回分类片段的文种、原始页码及未分类页。需要继续抽取时，按分类结果选择抽取工具。",
      inputSchema: documentInput({
        app_id: { ...requiredText, description: "已有分类应用的 ID，由用户提供。预制抽取应用 ID 不适用。" },
        pages: { ...pages, maxItems: 260 },
        ...waitProperties
      }, ["app_id"]),
      annotations: submit,
      outputSchema: output.route_document
    },
    {
      name: "task", title: "任务管理",
      description: "查询异步任务的状态、可用结果和用量，或取消任务。传入 task_ref、run_id 或 task_id 与 task_type 中的一种。action 默认为 query。仅取消尚未被领取的待执行文档任务，工作流支持查询。",
      inputSchema: objectSchema({
        action: { type: "string", enum: ["query", "cancel"], default: "query", description: "query 查询状态、结果和用量；cancel 尝试取消尚未被领取的待执行文档任务。工作流仅支持 query，不重新提交任务。" },
        task_ref: { ...taskReference, description: "业务工具返回的完整任务引用。与 run_id、task_id、task_type 互斥。" },
        run_id: { ...requiredText, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description: "工作流运行 ID。与 task_ref、task_id、task_type 互斥。" },
        task_id: { ...requiredText, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description: "文档任务 ID，必须同时提供 task_type。与 task_ref、run_id 互斥。" },
        task_type: { type: "string", enum: ["parse", "extract", "classify"], description: "task_id 对应的文档任务类型：parse 解析、extract 抽取、classify 分类。" }
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
      outputSchema: output.task
    },
    {
      name: "submit_user_feedback", title: "提交用户反馈",
      description: "提交用户的使用问题（issue）或改进建议（suggestion）。传入去除凭证和无关敏感信息的事实摘要，成功返回反馈编号。可附上用户明确同意提交的本地材料。",
      inputSchema: objectSchema({
        feedback_type: { type: "string", enum: ["issue", "suggestion"], description: "issue 表示使用问题，suggestion 表示需求或改进建议。" },
        content: { ...requiredText, maxLength: 1000, description: "反馈摘要，最多 1000 字符。包括场景、目标、实际表现和已尝试的处理方式。" },
        allow_follow_up: { type: "boolean", default: true, description: "是否允许 ADP 通过当前账号联系用户。" },
        attachment_paths: {
          type: "array", maxItems: 5, items: requiredText,
          description: "获授权且已检查的本地附件路径，每个文件最多 50 MiB。"
        },
        attachments_authorized: { type: "boolean", description: "用户已明确同意提交这些附件时设为 true。" }
      }, ["feedback_type", "content"]),
      annotations: submit,
      outputSchema: output.submit_user_feedback
    }
  ];
}

export const tools = { cn: buildTools("cn"), global: buildTools("global") };
const schemaValidator = new AjvJsonSchemaValidator();
const documentToolNames = new Set(["parse_document", "extract_document", "extract_custom_document", "route_document"]);
const nullablePresetSwitches = ["enable_invoice_verify", "enable_field_value_translation", "enable_highlight", "enable_confidence"];
function buildInputValidators(catalog: typeof tools.cn) {
  return new Map<string, ToolValidators>(catalog.map(({ name, inputSchema }) => {
    const { properties, required } = inputSchema;
    const runtimeProperties: Record<string, Schema> = { ...properties };
    if (name === "get_adp_guide") {
      runtimeProperties.language = { type: "string", enum: ["zh", "zh-CN", "en", "en-US"] };
    } else if (name === "extract_document") {
      runtimeProperties.card_type = requiredText;
      for (const key of nullablePresetSwitches) {
        const property = runtimeProperties[key];
        if (property) runtimeProperties[key] = { ...property, type: ["boolean", "null"] };
      }
    } else if (name === "extract_custom_document") {
      // Preserve names as result labels for callers using the previous batch schema.
      runtimeProperties.files = arraySchema(documentFile);
    }
    const validate = schemaValidator.getValidator(objectSchema(runtimeProperties, required));
    if (name === "upload_temporary_file") {
      const single = schemaValidator.getValidator(localFile);
      return [name, { validate, single }] as const;
    }
    if (documentToolNames.has(name)) {
      const { files: _files, ...options } = runtimeProperties;
      const single = schemaValidator.getValidator(objectSchema({ file_url: fileUrl, file_name: requiredText, ...options },
        ["file_url", ...required.filter(key => key !== "files")]));
      return [name, { validate, single }] as const;
    }
    return [name, { validate }] as const;
  }));
}
const inputValidators = { cn: buildInputValidators(tools.cn), global: buildInputValidators(tools.global) };

export async function callTool(
  name: string, args: JsonObject, client: AdpClient, version: string, signal?: AbortSignal
): Promise<JsonObject> {
  const region = name === "get_adp_guide" ? await client.getCatalogRegion(signal) : await client.prepareConnection(signal);
  const validators = inputValidators[region].get(name);
  if (!validators) throw new Error("未知工具。");

  if (name === "extract_document" && typeof args.app_id === "string") {
    const appId = args.app_id.trim();
    if (!presetExtractionIds[region].has(appId)) throw new Error("请选择 get_adp_guide 中当前区域的预制抽取 app_id。");
    args = { ...args, app_id: appId };
  }
  const single = args.file_path !== undefined || args.file_url !== undefined ? validators.single : undefined;
  if (single && args.files !== undefined) {
    throw new Error("请只传 files。旧版单文件参数不能与 files 同时使用。");
  }
  const validate = single ?? validators.validate;
  const validation = validate(args);
  if (!validation.valid) throw new Error(`${name} 参数不符合工具定义。${validation.errorMessage}`);
  if (Array.isArray(args.pages) && args.pages.length === 0) {
    const { pages: _emptyPages, ...options } = args;
    args = options;
  }

  switch (name) {
    case "get_adp_guide":
      return {
        status: "succeeded", version,
        markdown: getGuide(version, (args.language as string | undefined) ?? client.language, region, client.catalogRegionConfirmed),
        next_steps: [{ message: "按引导说明选择工具。处理本地文件前先上传。" }]
      };
    case "upload_temporary_file":
      return uploadFiles(args, client, signal);
    case "task": {
      const ref = resolveTaskReference(args);
      return args.action === "cancel"
        ? cancelExistingTask(ref, client, signal)
        : { ...await queryExistingTask(ref, client, signal), action: "query" };
    }
    case "submit_user_feedback": {
      const attachmentPaths = (args.attachment_paths as string[] | undefined) ?? [];
      if (attachmentPaths.length && args.attachments_authorized !== true) {
        throw new AdpApiError("请先取得用户对这些附件的明确授权，或只提交文字反馈。", {
          code: "ATTACHMENT_AUTHORIZATION_REQUIRED", retryable: false
        });
      }
      const envelope = await client.submitFeedback({
        feedbackType: args.feedback_type as "suggestion" | "issue",
        content: (args.content as string).trim(),
        allowFollowUp: args.allow_follow_up !== false,
        attachmentPaths
      }, signal);
      const data = envelope.data;
      if (!isObject(data) || typeof data.id !== "string" || !data.id.trim()
          || typeof data.created_at !== "string" || !data.created_at.trim()) {
        throw new AdpApiError("未收到完整的反馈回执，提交状态未知。请保留摘要，避免自动重复提交。", {
          code: "FEEDBACK_RECEIPT_MISSING", retryable: false, acceptance_unknown: true
        });
      }
      return {
        status: "succeeded", data: { id: data.id, created_at: data.created_at },
        next_steps: [{ message: "反馈已受理，请保存 data.id 作为反馈编号。" }]
      };
    }
    case "extract_custom_document": {
      const fields = args.fields as { name: string; prompt?: string }[];
      const normalized = fields.map(({ name, ...options }) => ({ name: name.trim(), ...options }));
      if (new Set(normalized.map(({ name }) => name.toLowerCase())).size !== normalized.length) {
        throw new Error("fields 中的字段名称必须唯一。");
      }
      return processDocuments(args, (file) => extractDirect(file.url, normalized, client, signal), client, signal);
    }
    case "parse_document": {
      const recognizeConfig = {
        ...(args.recognize_mode === undefined ? {} : { recognize_mode: args.recognize_mode }),
        // PDF text-first parsing can return pages outside the requested selection.
        ...(args.pages === undefined ? {} : { enable_pdf_parse: false })
      };
      const modelParams = {
        ...(args.pages === undefined ? {} : { pages: args.pages }),
        ...(Object.keys(recognizeConfig).length ? { recognize_config: recognizeConfig } : {})
      };
      return processDocuments(args, (file) => createTask("parse", {
        app_id: parseAppId, ...documentBody(file), ...(Object.keys(modelParams).length ? { model_params: modelParams } : {})
      }, client, signal), client, signal);
    }
    case "extract_document": {
      const appId = args.app_id as string;
      if (args.enable_invoice_verify !== undefined && appId !== domesticBillsAppId) {
        throw new Error("enable_invoice_verify 仅支持国内通用票据预制应用。");
      }
      const options = Object.fromEntries(
        ["card_type", "with_rec_result", "enable_multi_ticket", "enable_invoice_verify", "enable_field_value_translation",
          "enable_highlight", "enable_confidence"]
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]])
      );
      return processDocuments(args, (file) => createTask("extract", {
        app_id: appId, ...documentBody(file), ...pageOptions(args), ...options
      }, client, signal), client, signal);
    }
    case "route_document":
      return processDocuments(args, (file) => createTask("classify", {
        app_id: (args.app_id as string).trim(), ...documentBody(file), ...pageOptions(args)
      }, client, signal), client, signal);
    default:
      throw new Error(`未知工具 ${name}。`);
  }
}

function objectSchema(properties: Record<string, Schema>, required: string[] = []): ObjectSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function arraySchema(items: Schema): Schema {
  return { type: "array", items, minItems: 1, maxItems: batchLimit };
}

function documentInput(properties: Record<string, Schema>, required: string[] = [], file = documentFile): ObjectSchema {
  return objectSchema({
    files: { ...arraySchema(file), description: `每次可传 1–${batchLimit} 份待处理文件，每项填写 url。逐文件提交，单次调用最多 ${batchConcurrency} 个提交或轮询请求在途。` },
    ...properties
  }, ["files", ...required]);
}

function normalizeFileUrl(value: string): string {
  // Preserve the exact value of signed URLs.
  const fileUrl = value.trim();
  if (/^https?:\/\//i.test(fileUrl)) {
    try {
      const url = new URL(fileUrl);
      if (url.hostname && !url.username && !url.password) return fileUrl;
    } catch {
      // Invalid file URLs receive the same actionable message.
    }
  }
  throw new Error("文件必须使用可访问的 HTTP(S) URL。本地文件请先用 upload_temporary_file 上传。");
}

function documentBody(file: FileReference): JsonObject {
  return { file_url: file.url, ...(file.name === undefined ? {} : { file_name: file.name }) };
}

function pageOptions(args: JsonObject): JsonObject {
  return args.pages === undefined ? {} : { model_params: { pages: args.pages } };
}

async function processDocuments(
  args: JsonObject, execute: (file: FileReference) => Promise<JsonObject>, client: AdpClient, signal?: AbortSignal
): Promise<JsonObject> {
  if (args.files === undefined) {
    const submitted = await execute({ url: normalizeFileUrl(args.file_url as string), name: args.file_name as string | undefined });
    return waitForTask(submitted, args, client, signal);
  }
  if (args.file_name !== undefined) throw new Error("批量处理时请在 files 中分别提供 name。");

  const files = (args.files as FileReference[]).map((file) => ({ ...file, url: normalizeFileUrl(file.url) }));
  const schedule = limitBatchRequests();
  const submitted = await Promise.all(files.map((file, index) => schedule(async () => {
    signal?.throwIfAborted();
    return { index, ...(file.name === undefined ? {} : { name: file.name }), ...await execute(file) };
  })));
  if (args.wait === false) return batchResult(submitted);

  const deadline = waitDeadline(args);
  const results = await Promise.all(submitted.map(async (result) => ({
    ...result, ...await waitForTask(result, args, client, signal, deadline, schedule)
  })));
  return batchResult(results);
}

function limitBatchRequests(): ScheduleRequest {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (request) => {
    if (active < batchConcurrency) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await request();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

async function uploadFiles(args: JsonObject, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
  async function upload(filePath: string): Promise<JsonObject> {
    try {
      const { data } = await client.upload(filePath, signal);
      if (!isObject(data) || typeof data.download_url !== "string" || !data.download_url) {
        throw unknownReceipt("上传接口未返回 download_url。");
      }
      return {
        status: "succeeded", data,
        next_steps: [{ message: "将本项 data.download_url 填入后续工具的 files[].url。" }]
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return failureResult(error);
    }
  }

  if (args.files === undefined) return upload(args.file_path as string);
  const schedule = limitBatchRequests();
  const results = await Promise.all((args.files as { file_path: string }[]).map(({ file_path }, index) =>
    schedule(async () => {
      signal?.throwIfAborted();
      return { index, ...await upload(file_path) };
    })
  ));
  return batchResult(results);
}

function batchResult(files: JsonObject[]): JsonObject {
  const statuses = files.map(({ status }) => status);
  let status: ResultStatus = "partial_success";
  if (statuses.includes("pending")) status = "pending";
  else if (statuses.every((item) => item === "succeeded")) status = "succeeded";
  else if (statuses.every((item) => item === "failed")) status = "failed";
  else if (statuses.every((item) => item === "cancelled")) status = "cancelled";
  return { status, files };
}

async function extractDirect(
  url: string, fields: { name: string; prompt?: string }[], client: AdpClient, signal?: AbortSignal
): Promise<JsonObject> {
  try {
    const envelope = await client.request(client.documentPath("/v1/app/doc/extract/direct-fast"), {
      method: "POST", body: { file: { url }, fields }, signal
    });
    const data = envelope.data;
    if (!isObject(data) || !Array.isArray(data.extraction_result)) throw unknownReceipt("自定义抽取接口未返回抽取结果。");
    return { status: "succeeded", data, ...usageFields(envelope) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return failureResult(error, true);
  }
}

function taskPath(kind: TaskKind, suffix: string, client: AdpClient): string {
  const path = taskActions[kind].route + suffix;
  return kind === "workflow" ? client.workflowPath(path) : client.documentPath(path);
}

async function createTask(
  kind: Exclude<TaskKind, "workflow">, body: JsonObject, client: AdpClient, signal?: AbortSignal
): Promise<JsonObject> {
  try {
    const envelope = await client.request(taskPath(kind, "/create/task", client), { method: "POST", body, signal });
    const data = envelope.data;
    const id = isObject(data) ? data[taskActions[kind].idKey] : undefined;
    if (!isObject(data) || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw unknownReceipt("接口未返回可查询的任务 ID。");
    }
    const status = data.status === undefined ? "pending" : taskStatus(kind, data.status);
    return taskResult(envelope, data, { kind, id }, status, client);
  } catch (error) {
    if (signal?.aborted) throw error;
    return failureResult(error, true);
  }
}

function waitDeadline(args: JsonObject): number {
  return performance.now() + ((args.wait_timeout_seconds as number | undefined) ?? defaultWaitSeconds) * 1000;
}

async function waitForTask(
  submitted: JsonObject, args: JsonObject, client: AdpClient, signal?: AbortSignal,
  deadline = waitDeadline(args), schedule?: ScheduleRequest
): Promise<JsonObject> {
  if (args.wait === false || submitted.status !== "pending" || submitted.wait_status === "paused") return submitted;
  return pollTask(submitted.task_ref as TaskRef, submitted, deadline, client, signal, schedule);
}

async function pollTask(
  ref: TaskRef, latest: JsonObject, deadline: number, client: AdpClient, signal?: AbortSignal,
  schedule: ScheduleRequest = (request) => request()
): Promise<JsonObject> {
  const polling = new AbortController();
  const cancel = () => polling.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => polling.abort(), Math.max(0, deadline - performance.now()));
  let interval = initialPollIntervalMs;
  try {
    while (!polling.signal.aborted && performance.now() < deadline) {
      latest = await queryWithRetries(ref, client, polling.signal, deadline, schedule);
      if (latest.status !== "pending" || latest.wait_status === "paused") return latest;
      await delay(Math.min(interval, Math.max(0, deadline - performance.now())), undefined, { signal: polling.signal });
      interval = Math.min(maxPollIntervalMs, Math.round(interval * 1.5));
    }
    signal?.throwIfAborted();
    return waitingResult(latest, ref, "timeout");
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = polling.signal.aborted || performance.now() >= deadline;
    const queryError = !timedOut || (error instanceof AdpApiError && error.details.retryable === true)
      ? errorDetails(error) : undefined;
    return waitingResult(latest, ref, timedOut ? "timeout" : "query_failed", queryError);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

async function queryWithRetries(
  ref: TaskRef, client: AdpClient, signal: AbortSignal, deadline: number, schedule: ScheduleRequest
): Promise<JsonObject> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await schedule(() => {
        signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error("已到查询截止时间。");
        return queryTask(ref, client, signal);
      });
    } catch (error) {
      if (signal.aborted || performance.now() >= deadline || attempt >= maxQueryRetries
        || !(error instanceof AdpApiError) || error.details.retryable !== true) throw error;

      const retryAfter = error.details.retry_after_ms;
      const backoff = 250 * 2 ** attempt;
      const wait = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter : backoff + Math.random() * backoff / 2;
      const remaining = Math.max(0, deadline - performance.now());
      try {
        await delay(Math.min(wait, Math.ceil(remaining)), undefined, { signal });
      } catch {
        throw error;
      }
      if (wait >= remaining) throw error;
    }
  }
}

async function queryExistingTask(ref: TaskRef, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
  try {
    return await queryTask(ref, client, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const result = { ...failureResult(error, true), task_ref: ref };
    if (error instanceof AdpApiError && error.details.retryable === true) {
      return { ...result, next_steps: [taskStep(ref, "稍后继续查询原任务。", error.details)] };
    }
    return result;
  }
}

function resolveTaskReference(args: JsonObject): TaskRef {
  const hasRef = args.task_ref !== undefined;
  const hasRun = args.run_id !== undefined;
  const hasDocument = args.task_id !== undefined || args.task_type !== undefined;
  if (Number(hasRef) + Number(hasRun) + Number(hasDocument) !== 1) {
    throw new Error("任务标识只能选择一种：task_ref、run_id，或 task_id 与 task_type。");
  }
  if (hasRef) return args.task_ref as TaskRef;
  if (hasRun) return { kind: "workflow", id: args.run_id as string };
  if (args.task_id === undefined || args.task_type === undefined) {
    throw new Error("文档任务必须同时提供 task_id 和 task_type。");
  }
  return { kind: args.task_type as TaskKind, id: args.task_id as string };
}

async function cancelExistingTask(ref: TaskRef, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
  if (ref.kind === "workflow") {
    return {
      ...failureResult(new AdpApiError("工作流仅支持查询，暂不支持通过此工具取消。", {
        code: "TASK_CANCELLATION_UNSUPPORTED", retryable: false
      })), action: "cancel", task_ref: ref,
      next_steps: [taskStep(ref, "查询原工作流的实际状态与可用结果。")]
    };
  }
  try {
    const envelope = await client.request(taskPath(ref.kind, `/cancel/task/${ref.id}`, client), { method: "POST", signal });
    const data = envelope.data;
    if (!isObject(data)) throw unknownReceipt("取消接口未返回任务数据。请查询原任务确认状态。");
    if (data[taskActions[ref.kind].idKey] !== ref.id) throw unknownReceipt("取消响应中的任务 ID 与原任务不一致。请查询原任务确认状态。");
    const statuses = ["cancelled", "running", "succeeded", "failed"];
    if (typeof data.status !== "string" || !statuses.includes(data.status)) {
      throw unknownReceipt("取消接口未返回可识别的实际任务状态。请查询原任务确认状态。");
    }
    if (typeof data.cancelled !== "boolean" || typeof data.already_cancelled !== "boolean"
      || data.cancelled !== (data.status === "cancelled") || (data.already_cancelled && !data.cancelled)) {
      throw unknownReceipt("取消接口未返回一致的取消回执。请查询原任务确认状态。");
    }
    const cancelled = data.status === "cancelled" && data.cancelled === true;
    const result = { action: "cancel", task_ref: ref, data };
    if (cancelled) return { ...result, status: "succeeded" };
    return {
      ...result,
      ...failureResult(new AdpApiError(/^en(?:-|$)/i.test(client.language)
        ? "The task has been claimed, expired, or finished and could not be cancelled."
        : "任务已被领取、过期或结束，当前无法取消。", {
        code: "TASK_NOT_CANCELLABLE", retryable: false
      })),
      next_steps: [taskStep(ref, "查询原任务的实际状态与可用结果。")]
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...failureResult(error), action: "cancel", task_ref: ref };
  }
}

async function queryTask(ref: TaskRef, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
  const envelope = await client.request(taskPath(ref.kind, `/query/task/${ref.id}`, client), { signal });
  const data = requireData(envelope);
  if (data[taskActions[ref.kind].idKey] !== ref.id) throw new Error("查询响应中的任务 ID 与原任务不一致。");
  const status = taskStatus(ref.kind, data.status);
  if (!status) throw new Error("查询接口未返回可识别的任务状态。");
  return taskResult(envelope, data, ref, status, client);
}

function taskStatus(kind: TaskKind, status: unknown): ResultStatus | undefined {
  if (kind === "parse" || kind === "extract") {
    if (status === 4) return "succeeded";
    if (status === 5) return "failed";
    if (status === 6) return "cancelled";
    if (status === 0 || status === 1 || status === 2) return "pending";
  } else if (kind === "classify") {
    if (status === "success") return "succeeded";
    if (status === "failed") return "failed";
    if (status === "cancelled") return "cancelled";
    if (status === "pending" || status === "running") return "pending";
  } else {
    if (status === "succeeded") return "succeeded";
    if (status === "failed" || status === "timeout") return "failed";
    if (status === "cancelled") return "cancelled";
    if (status === "pending" || status === "running" || status === "paused") return "pending";
  }
  return undefined;
}

function taskResult(
  envelope: JsonObject, data: JsonObject, ref: TaskRef, status: ResultStatus | undefined, client: AdpClient
): JsonObject {
  if (!status) {
    return {
      ...failureResult(new Error("接口返回未知任务状态。"), true), task_ref: ref,
      next_steps: [taskStep(ref, "使用原任务引用查询最新状态。")]
    };
  }
  const result = {
    status, task_ref: ref, data, ...usageFields(envelope),
    ...(typeof envelope.message === "string" && envelope.message ? { message: envelope.message } : {})
  };
  if (status === "failed") {
    const error = client.taskFailure(envelope) ?? new AdpApiError("任务未成功完成。", { code: "TASK_FAILED", retryable: false });
    const details = errorDetails(error);
    return { ...result, error: details, next_steps: [errorStep(details)] };
  }
  if (status === "pending") {
    return waitingResult(result, ref, data.status === "paused" ? "paused" : undefined);
  }
  return result;
}

function waitingResult(latest: JsonObject, ref: TaskRef, status?: WaitStatus, queryError?: JsonObject): JsonObject {
  const message = status === "paused" ? "工作流已暂停。处理待办后继续查询原任务。"
    : status === "timeout" ? "达到本次等待上限。继续查询原任务。"
    : status === "query_failed" ? "本次查询未完成。继续查询原任务。"
    : "稍后查询原任务。";
  return {
    ...latest,
    ...(status ? { wait_status: status } : {}),
    ...(queryError ? { query_error: queryError } : {}),
    next_steps: [taskStep(ref, message, queryError)]
  };
}

function taskStep(ref: TaskRef, message: string, queryError?: JsonObject): JsonObject {
  const retryAfter = queryError?.retry_after_ms;
  const stepMessage = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
    ? `${message} 请等待至少 ${Math.ceil(retryAfter / 1000)} 秒再查询。` : message;
  return { message: stepMessage, tool: "task", arguments: { task_ref: ref } };
}

function usageFields(envelope: JsonObject): JsonObject {
  const usage = isObject(envelope.usage) ? envelope.usage : undefined;
  const recordedCredits = envelope.recorded_credits;
  const consumed = usage?.credits_consumed;
  const hasRecordedCredits = typeof recordedCredits === "number" && Number.isFinite(recordedCredits);
  const hasConsumedCredits = typeof consumed === "number" && Number.isFinite(consumed);
  return {
    usage_status: hasConsumedCredits || hasRecordedCredits ? "available" : "unavailable",
    ...(usage && Object.keys(usage).length ? { usage } : {}),
    ...(hasRecordedCredits ? { recorded_credits: recordedCredits } : {})
  };
}

function requireData(envelope: JsonObject): JsonObject {
  if (!isObject(envelope.data)) throw new Error("ADP 响应缺少结果数据。");
  return envelope.data;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorDetails(error: unknown): JsonObject {
  if (error instanceof AdpApiError) return { ...error.details, message: error.message };
  return { message: error instanceof Error && error.message ? error.message : "ADP 调用失败。" };
}

function unknownReceipt(message: string): AdpApiError {
  return new AdpApiError(message, { code: "RECEIPT_MISSING", acceptance_unknown: true, retryable: false });
}

function errorStep(error: JsonObject): JsonObject {
  if (error.acceptance_unknown === true) return { message: "保留本次请求信息，先确认是否已受理，再决定是否提交。" };
  if (typeof error.fix === "string" && error.fix) return { message: error.fix };
  switch (error.code) {
    case "MISSING_API_KEY":
    case "INVALID_API_KEY":
      return { message: "按错误提示获取同一区域的 API Key，并核对本地配置后继续。" };
    case "CLI_CREDENTIALS_UNAVAILABLE":
      return { message: "在当前系统账号下重新配置 CLI，或设置目标服务的 ADP_API_KEY。" };
    case "CLI_CREDENTIAL_TARGET_MISMATCH":
      return { message: "移除冲突配置以继承 CLI 地址和租户，或为目标服务设置独立的 ADP_API_KEY。" };
    case "INSUFFICIENT_CREDITS":
      return { message: "在 API Key 对应的区域补充积分后继续。" };
    case "TASK_NOT_AVAILABLE":
      return { message: "核对原任务引用、区域及当前账号。" };
    case "ATTACHMENT_AUTHORIZATION_REQUIRED":
      return { message: "取得用户对附件的明确授权，或仅提交文字反馈。" };
    case "TASK_FAILED":
      return { message: "先核对原任务的失败原因，再决定如何处理。" };
    default:
      return { message: "按错误信息核对参数或调用条件后继续。" };
  }
}

export function failureResult(error: unknown, metered = false): JsonObject {
  const details = errorDetails(error);
  return {
    status: "failed", error: details, next_steps: [errorStep(details)],
    ...(metered ? { usage_status: "unavailable" } : {})
  };
}
