import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { AdpApiError, type AdpClient, type JsonObject } from "./adp-client.js";
import { businessGuide } from "./business-guides.js";

type TaskKind = "parse" | "extract" | "classify";
type TaskRef = { kind: TaskKind; id: string };
type ResultStatus = "pending" | "succeeded" | "failed" | "cancelled";
type ScheduleRequest = <T>(request: () => Promise<T>) => Promise<T>;

const cnCatalog: Tool[] = JSON.parse(readFileSync(new URL("../catalog/tools.zh-CN.json", import.meta.url), "utf8"));
const inputRules: Record<string, Partial<Tool["inputSchema"]>> =
  JSON.parse(readFileSync(new URL("../catalog/input-rules.json", import.meta.url), "utf8"));
const globalCatalog = structuredClone(cnCatalog).filter(({ name }) => name !== "verify_invoice");
for (const tool of globalCatalog) {
  if (tool.name === "extract_document") delete tool.inputSchema.properties!.enable_invoice_verify;
}
export const tools = { cn: cnCatalog, global: globalCatalog };
const translations: Record<string, string> =
  JSON.parse(readFileSync(new URL("../catalog/translations.en-US.json", import.meta.url), "utf8"));

function translateToolText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(translateToolText);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    (key === "title" || key === "description") && typeof item === "string"
      ? translations[item] ?? item
      : translateToolText(item)
  ]));
}

const englishTools = {
  cn: translateToolText(cnCatalog) as Tool[],
  global: translateToolText(globalCatalog) as Tool[]
};

export function getTools(region: "cn" | "global", language: string): Tool[] {
  return /^en(?:-|$)/i.test(language) ? englishTools[region] : tools[region];
}
const validator = new Ajv2020({ strict: false, formats: fullFormats });

// Cross-field rules are kept out of the advertised schema so form clients only render real parameters.
export function validationInputSchema({ name, inputSchema }: Pick<Tool, "name" | "inputSchema">): Tool["inputSchema"] {
  if (name === "get_adp_guide") {
    return { ...inputSchema, properties: { language: { enum: ["zh", "zh-CN", "en", "en-US"] } } };
  }
  const rules = inputRules[name];
  if (!rules) return inputSchema;
  return {
    ...inputSchema, ...rules,
    properties: { ...inputSchema.properties, ...rules.properties },
    ...(["create_extraction_app", "update_extraction_app"].includes(name) ? { $defs: inputRules.$defs } : {})
  };
}

function compileCatalog(catalog: Tool[]) {
  return new Map(catalog.map(tool => [tool.name, {
    input: validator.compile(validationInputSchema(tool)), output: validator.compile(tool.outputSchema!)
  }]));
}
const validators = { cn: compileCatalog(tools.cn), global: compileCatalog(tools.global) };
const parseAppId = "ootb_k7m2x9p4v1n8w3q6r5t0y2b4";
const domesticBillsAppId = "ootb_v9x2y5z8a1b4c7d0e3f6h9j1k4m7";
const defaultWaitSeconds = 60;
const batchConcurrency = 3;
const taskActions = {
  parse: { route: "/v1/app/doc/recognize", idKey: "task_id" },
  extract: { route: "/v1/app/doc/extract", idKey: "task_id" },
  classify: { route: "/v1/app/doc/classify", idKey: "task_id" }
} as const;
const syncResultFields: Record<TaskKind, string[]> = {
  parse: ["doc_recognize_result"],
  extract: ["extraction_result"],
  classify: ["segments", "unclassified_pages"]
};
const defaultInvoiceType = "vat_electronic_invoice_new";
const invoiceInputFields = ["fpNumber", "fpDate", "fpCode", "fpAmount", "fpNoTaxAmount", "fpCRC", "instance_id"] as const;

const inputRepairMessages = {
  missing_file_source: {
    zh: "缺少待处理文件。请通过 file_url 或 file_base64 提供一份文件。",
    en: "A document is required. Provide one file using file_url or file_base64."
  },
  incomplete_task_ref: {
    zh: "任务引用不完整。请原样传入提交任务时返回的 task_ref（包含 kind 和 id），或改为同时传入 task_type 和 task_id。",
    en: "The task reference is incomplete. Pass the original task_ref containing kind and id, or supply both task_type and task_id instead."
  },
  file_name_not_supported_with_fields: {
    zh: "按 fields 抽取时，请移除 file_name，保留文件来源和 fields 后重试。",
    en: "For extraction with fields, remove file_name and retry with the file source and fields."
  }
} as const;

function inputRepairReason(name: string, args: JsonObject): keyof typeof inputRepairMessages | undefined {
  if (name === "get_task" || name === "cancel_task") {
    if ("task_ref" in args) {
      if (!isObject(args.task_ref) || !("kind" in args.task_ref) || !("id" in args.task_ref)) return "incomplete_task_ref";
    } else if (!("task_type" in args) || !("task_id" in args)) {
      return "incomplete_task_ref";
    }
  }
  const fieldExtraction = name === "extract_document" && !("app_id" in args) && Array.isArray(args.fields) && args.fields.length > 0;
  if (fieldExtraction && "file_name" in args) {
    return "file_name_not_supported_with_fields";
  }
  const missingFieldsFile = fieldExtraction && (!("file" in args) || isEmptyObject(args.file));
  const requiresFile = name === "parse_document" || name === "classify_document"
    || (name === "extract_document" && "app_id" in args) || missingFieldsFile;
  if (requiresFile && !("file_url" in args) && !("file_base64" in args)) {
    return "missing_file_source";
  }
}

export async function callTool(name: string, args: JsonObject, client: AdpClient, version: string, signal?: AbortSignal): Promise<JsonObject> {
  const region = name === "get_adp_guide" ? await client.getCatalogRegion(signal) : await client.prepareConnection(signal);
  if (name === "verify_invoice" && !client.domesticInvoiceRegionConfirmed) {
    throw new AdpApiError("国内发票验真仅支持已确认的中国区连接。", { code: "INVOICE_VERIFICATION_REGION_UNSUPPORTED", retryable: false });
  }
  const entry = validators[client.domesticInvoiceRegionConfirmed ? region : "global"].get(name);
  if (!entry) throw new Error("未知工具。");
  args = normalizeToolInput(name, args);
  if (!entry.input(args)) {
    const reason = inputRepairReason(name, args);
    if (reason) {
      const locale = /^en(?:-|$)/i.test(client.language) ? "en" : "zh";
      throw new AdpApiError(inputRepairMessages[reason][locale], { code: "INVALID_ARGUMENTS", reason, retryable: false });
    }
    throw new AdpApiError(name + " 参数不符合工具定义。" + validator.errorsText(entry.input.errors),
      { code: name === "verify_invoice" ? "INVOICE_VERIFICATION_INPUT_REQUIRED" : "INVALID_ARGUMENTS", retryable: false });
  }
  const result = await runTool(name, args, client, version, signal);
  if (!entry.output(result)) {
    const msg = "ADP 返回的数据不符合 " + name + " 的结果契约。";
    if (["create_extraction_app", "update_extraction_app", "delete_extraction_app"].includes(name)) throw unknownReceipt(msg);
    throw new AdpApiError(msg, { code: "INVALID_RESPONSE", retryable: false });
  }
  return result;
}

function normalizeToolInput(name: string, args: JsonObject): JsonObject {
  if (name === "extract_document") return normalizeExtractionInput(args);
  if (name === "classify_document" && Array.isArray(args.pages) && args.pages.length === 0) {
    const { pages, ...rest } = args;
    return rest;
  }
  if ((name === "get_task" || name === "cancel_task") && isEmptyObject(args.task_ref)
      && args.task_id !== undefined && args.task_type !== undefined) {
    const { task_ref, ...identifiers } = args;
    return identifiers;
  }
  if (name !== "create_extraction_app" && name !== "update_extraction_app") return args;
  if (name === "create_extraction_app") {
    args = { ...args };
    // Some form clients submit empty arrays for the unselected application type.
    for (const key of args.ai_function === 1426 ? ["extract_fields", "app_label"] : ["classify_types"]) {
      const value = args[key];
      if (Array.isArray(value) && value.length === 0) delete args[key];
    }
  }
  if (!Array.isArray(args.extract_fields)) return args;
  if (name === "update_extraction_app" && !args.extract_fields.length && args.config_version === undefined
      && (args.app_name !== undefined || args.description !== undefined)) {
    const { extract_fields, ...metadata } = args;
    return metadata;
  }
  const fields = args.extract_fields.map(field => {
    if (!isObject(field)) return field;
    const clean = { ...field };
    if (isEmptyObject(clean.format)) delete clean.format;
    if (Array.isArray(clean.sub_fields)) {
      if (clean.field_type !== "table" && clean.sub_fields.length === 0) delete clean.sub_fields;
      else clean.sub_fields = clean.sub_fields.map(column => {
        if (!isObject(column) || !isEmptyObject(column.format)) return column;
        const { format, ...rest } = column;
        return rest;
      });
    }
    return clean;
  });
  return { ...args, extract_fields: fields };
}

function isEmptyObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

function classificationCategories(categories: JsonObject[]): JsonObject[] {
  const keys = new Set<string>();
  const names = new Set<string>();
  return categories.map(category => {
    const key = category.category_key as string;
    const typeName = (category.type_name as string).trim();
    const folded = typeName.toLowerCase();
    if (!typeName || folded === "unclassified" || keys.has(key) || names.has(folded)) {
      throw new AdpApiError("类别标识必须唯一，类别名称忽略大小写且必须唯一、非空，不能使用 UNCLASSIFIED。",
        { code: "INVALID_ARGUMENTS", retryable: false });
    }
    keys.add(key);
    names.add(folded);
    return { ...category, type_name: typeName };
  });
}

function normalizeExtractionInput(args: JsonObject): JsonObject {
  const input = { ...args };
  if ("app_id" in input) {
    if (Array.isArray(input.fields) && input.fields.length === 0) delete input.fields;
    return input;
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) return input;

  // Form clients can send untouched application-mode defaults for a one-off extraction.
  if (input.wait === true) delete input.wait;
  if (input.wait_timeout_seconds === defaultWaitSeconds) delete input.wait_timeout_seconds;
  if (Array.isArray(input.pages) && input.pages.length === 0) delete input.pages;
  if (input.file_name === "") delete input.file_name;

  // An older client can still send the native direct-fast file object. Keeping
  // both shapes in a mixed request lets validation reject the ambiguous source.
  if (!("file" in input) && ("file_url" in input || "file_base64" in input)) {
    const file: JsonObject = {};
    if ("file_url" in input) file.url = input.file_url;
    if ("file_base64" in input) file.base64 = input.file_base64;
    delete input.file_url;
    delete input.file_base64;
    input.file = file;
  }
  return input;
}

async function runTool(name: string, args: JsonObject, client: AdpClient, version: string, signal?: AbortSignal): Promise<JsonObject> {
  switch (name) {
    case "get_adp_guide":
      return { status: "succeeded", version,
        markdown: businessGuide((args.language as string | undefined) ?? client.language, client.guideWorkspace, client.domesticInvoiceRegionConfirmed) };
    case "upload_file":
      return uploadFiles(args, client, signal);
    case "submit_user_feedback": {
      const attachmentPaths = (args.attachment_paths as string[] | undefined) ?? [];
      const english = /^en(?:-|$)/i.test(client.language);
      if (attachmentPaths.length && args.attachments_authorized !== true) {
        throw new AdpApiError(english ? "Obtain the user's approval for these attachments, or submit text only."
          : "请先取得用户对这些附件的明确同意，或只提交文字反馈。", {
          code: "ATTACHMENT_AUTHORIZATION_REQUIRED", retryable: false
        });
      }
      const { data } = await client.submitFeedback({
        feedbackType: args.feedback_type as "issue" | "suggestion",
        content: (args.content as string).trim(),
        allowFollowUp: args.allow_follow_up !== false,
        attachmentPaths
      }, signal);
      if (!isObject(data) || typeof data.id !== "string" || !data.id.trim()
          || typeof data.created_at !== "string" || !data.created_at.trim()) {
        throw new AdpApiError(english ? "The feedback receipt is incomplete. Submission could not be confirmed."
          : "反馈回执不完整，暂时无法确认提交结果。", {
          code: "FEEDBACK_RECEIPT_MISSING", retryable: false, acceptance_unknown: true
        });
      }
      return {
        status: "succeeded", data: { id: data.id, created_at: data.created_at },
        next_steps: [{ message: english ? "Keep data.id as your feedback ID." : "请保存 data.id 作为反馈编号。" }]
      };
    }
    case "verify_invoice":
      return verifyDomesticInvoice(args, client, signal);
    case "get_task":
      return { ...await queryExistingTask(taskReference(args), client, signal), action: "query" };
    case "cancel_task":
      return cancelExistingTask(taskReference(args), client, signal);
    case "list_apps": {
      const filters = { engine_type: "document", ...args };
      const query = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)]));
      const data = requireData(await client.request(client.documentPath("/v1/app-catalog"), { query, signal }));
      return { status: "succeeded", data };
    }
    case "get_app":
      return { status: "succeeded", data: await getAppDetail(client, args.app_id as string, signal, args.config_version as string | undefined) };
    case "create_extraction_app": {
      const { timeout_seconds, ai_function = 1425, ...config } = args;
      if (ai_function === 1426) config.classify_types = classificationCategories(config.classify_types as JsonObject[]);
      const data = mutationData(await client.request(client.documentPath("/v1/app-manage/create"), {
        method: "POST", body: { ...config, ai_function }, timeoutMs: Number(timeout_seconds ?? 300) * 1000, signal
      }));
      const receivedType = data.ai_function === undefined ? 1425 : data.ai_function;
      if (receivedType !== ai_function) throw unknownReceipt("应用创建回执中的类型与请求不一致。");
      return data;
    }
    case "update_extraction_app":
    case "delete_extraction_app": {
      const operation = name === "update_extraction_app" ? "update" : "delete";
      const data = mutationData(await client.request(client.documentPath("/v1/app-catalog/extraction/" + operation), {
        method: "POST", body: args, signal
      }));
      if (name === "update_extraction_app" && data.app_id !== args.app_id) {
        throw unknownReceipt("应用更新回执的 ID 与请求不一致，请检查目标应用的配置。");
      }
      if (name === "delete_extraction_app" && data.success === false) {
        throw new AdpApiError("应用删除失败。", { code: "DELETE_FAILED", retryable: false });
      }
      return data;
    }
    case "get_credits": {
      const receipt = await client.request(client.documentPath("/v1/user/payment"), { signal, rawResponse: true });
      const balance = isObject(receipt.data) ? receipt.data : receipt;
      const data = Object.fromEntries(["total_credits", "used_credits", "expired_credits", "remaining_credits"]
        .map(key => [key, balance[key]]));
      return { status: "succeeded", data };
    }
    case "parse_document": {
      const config = selectOptions(args, ["enable_highlight", "remove_header_footer", "enable_stamp_recognition"]);
      config.recognize_mode = args.recognize_mode ?? (args.remove_header_footer === true ? "agentic_v2" : "fast_vlm");
      const pages = pageOptions(args);
      if (pages.pages) config.enable_pdf_parse = false;
      return processDocument("parse", args, {
        ...documentSource(args), app_id: parseAppId, model_params: { ...pages, recognize_config: config }
      }, client, signal);
    }
    case "extract_document": {
      if (Array.isArray(args.fields)) {
        const fields = (args.fields as { name: string; prompt?: string | null }[]).map(field => ({ ...field, name: field.name.trim() }));
        if (new Set(fields.map(({ name }) => name.toLowerCase())).size !== fields.length) throw new Error("字段名称必须唯一。");
        const file = args.file as JsonObject;
        return extractDirect(typeof file.url === "string" ? { url: normalizeFileUrl(file.url) } : file, fields, client, signal);
      }
      const appId = (args.app_id as string).trim();
      if (args.enable_invoice_verify !== undefined && appId !== domesticBillsAppId) {
        throw new Error("enable_invoice_verify 仅支持国内通用票据预置应用。");
      }
      if (appId.startsWith("ootb_")) {
        const preset = await getAppDetail(client, appId, signal);
        if (preset.source !== "preset" || preset.engine_type !== "extract") {
          throw new AdpApiError("请选择当前账号可用的预置抽取应用。", { code: "EXTRACTION_PRESET_REQUIRED", retryable: false });
        }
      }
      const options = selectOptions(args, ["with_rec_result", "enable_multi_ticket", "enable_invoice_verify",
        "enable_field_value_translation", "enable_highlight", "enable_confidence"]);
      const pages = pageOptions(args);
      return processDocument("extract", args, { ...documentSource(args, true), app_id: appId, ...options,
        ...(pages.pages ? { model_params: pages } : {}) }, client, signal);
    }
    case "classify_document": {
      const pages = pageOptions(args);
      return processDocument("classify", args, { ...documentSource(args), app_id: (args.app_id as string).trim(),
        ...(pages.pages ? { model_params: pages } : {}) }, client, signal);
    }
    default:
      throw new Error("未知工具。");
  }
}

async function getAppDetail(client: AdpClient, appId: string, signal?: AbortSignal, configVersion?: string): Promise<JsonObject> {
  const query = { app_id: appId, ...(configVersion === undefined ? {} : { config_version: configVersion }) };
  const data = requireData(await client.request(client.documentPath("/v1/app-catalog/detail"), { query, signal }));
  if (data.app_id !== appId) {
    throw new AdpApiError("应用详情回执的 ID 与请求不一致。", { code: "APP_ID_MISMATCH", retryable: false });
  }
  return data;
}

function selectOptions(args: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}

function documentSource(args: JsonObject, allowJobId = false): JsonObject {
  const file = selectOptions(args, ["file_url", "file_base64", "file_name"]);
  if (typeof file.file_url === "string" && !(allowJobId && /^jobid:\/\/[a-f0-9]{32}$/i.test(file.file_url))) {
    file.file_url = normalizeFileUrl(file.file_url);
  }
  return file;
}

function pageOptions(args: JsonObject): JsonObject {
  return Array.isArray(args.pages) && args.pages.length ? { pages: args.pages } : {};
}

function taskReference(args: JsonObject): TaskRef {
  return (args.task_ref as TaskRef | undefined) ?? { kind: args.task_type as TaskKind, id: args.task_id as string };
}

async function processDocument(kind: TaskKind, args: JsonObject, body: JsonObject, client: AdpClient, signal?: AbortSignal) {
  if (args.wait === false) return createTask(kind, body, client, signal);

  try {
    const envelope = await client.request(taskPath(kind, "", client), {
      method: "POST", body, signal, timeoutMs: Number(args.wait_timeout_seconds ?? defaultWaitSeconds) * 1000
    });
    const data = envelope.data;
    const status = isObject(data) ? taskStatus(kind, data.status) : undefined;
    if (!isObject(data) || !status || status === "pending") {
      throw unknownReceipt("同步接口未返回最终处理状态。", 502);
    }
    if (status === "succeeded" && !syncResultFields[kind].every(field => Array.isArray(data[field]))) {
      throw unknownReceipt("同步接口未返回完整的文档处理结果。", 502);
    }
    return documentResult(envelope, data, status, client);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof AdpApiError && (error.details.code === "REQUEST_TIMEOUT" || error.details.api_code === "timeout"
      || error.details.http_status === 408 || error.details.http_status === 504)) {
      return failureResult(new AdpApiError(error.message, {
        ...error.details, code: "REQUEST_TIMEOUT", http_status: error.details.http_status ?? 504,
        retryable: false, acceptance_unknown: true
      }), true);
    }
    return failureResult(error, true);
  }
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
  throw new Error("文件必须使用可访问的 HTTP(S) URL。本地文件请先用 upload_file 上传。");
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
        next_steps: [{ message: "使用本项 data.download_url 调用文档工具。" }]
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return failureResult(error);
    }
  }

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
  const succeeded = files.filter(file => file.status === "succeeded").length;
  const status = succeeded === files.length ? "succeeded" : succeeded === 0 ? "failed" : "partial_success";
  return { status, files };
}

async function extractDirect(
  file: JsonObject, fields: { name: string; prompt?: string | null }[], client: AdpClient, signal?: AbortSignal
): Promise<JsonObject> {
  try {
    const envelope = await client.request(client.documentPath("/v1/app/doc/extract/direct-fast"), {
      method: "POST", body: { file, fields }, signal
    });
    const data = envelope.data;
    if (!isObject(data) || !Array.isArray(data.extraction_result)) throw unknownReceipt("自定义抽取接口未返回抽取结果。");
    return { status: "succeeded", data, ...usageFields(envelope) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return failureResult(error, true);
  }
}

async function verifyDomesticInvoice(args: JsonObject, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
  const typeKey = (args.type_key as string | undefined) ?? defaultInvoiceType;
  const body: JsonObject = { type_key: typeKey };
  for (const field of invoiceInputFields) {
    if (typeof args[field] === "string" && args[field].trim()) body[field] = args[field].trim();
  }
  try {
    const envelope = await client.request(client.documentPath("/v1/app/invoice/verify"), { method: "POST", body, signal });
    const data = requireData(envelope);
    const rawStatus = isObject(data.result) ? data.result.fpVerification : undefined;
    const statuses: Record<string, string> = {
      "查验成功发票一致": "consistent", "查验成功发票不一致": "inconsistent", "发票不存在": "not_found",
      "未能查验": "unverifiable", "不支持查验": "unsupported"
    };
    const normalizedStatus = typeof rawStatus === "string" ? rawStatus.trim() : "";
    const verificationStatus = Object.hasOwn(statuses, normalizedStatus) ? statuses[normalizedStatus] : "unknown";
    const result = { data, verification_status: verificationStatus, ...usageFields(envelope) };
    if (["consistent", "inconsistent", "not_found"].includes(verificationStatus)) return { status: "succeeded", ...result };
    const failure = verificationStatus === "unverifiable"
      ? { code: "INVOICE_UNVERIFIABLE", message: "未能完成查验，请查看原始验真提示。" }
      : verificationStatus === "unsupported"
        ? { code: "INVOICE_VERIFICATION_UNSUPPORTED", message: "当前发票不支持查验，请查看原始验真提示。" }
        : { code: "INVOICE_VERIFICATION_UNKNOWN", message: "无法判定验真结论，请查看原始验真结果。" };
    return { ...failureResult(new AdpApiError(failure.message, { code: failure.code, retryable: false })), ...result };
  } catch (error) {
    if (signal?.aborted) throw error;
    return failureResult(error, true);
  }
}

function taskPath(kind: TaskKind, suffix: string, client: AdpClient): string {
  const path = taskActions[kind].route + suffix;
  return client.documentPath(path);
}

async function createTask(
  kind: TaskKind, body: JsonObject, client: AdpClient, signal?: AbortSignal
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

async function cancelExistingTask(ref: TaskRef, client: AdpClient, signal?: AbortSignal): Promise<JsonObject> {
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
  const result = { ...documentResult(envelope, data, status, client), task_ref: ref };
  if (status === "pending") {
    return { ...result, next_steps: [taskStep(ref, "稍后查询原任务。")] };
  }
  return result;
}

function documentResult(envelope: JsonObject, data: JsonObject, status: ResultStatus, client: AdpClient): JsonObject {
  const result = {
    status, data, ...usageFields(envelope),
    ...(typeof envelope.message === "string" && envelope.message ? { message: envelope.message } : {})
  };
  if (status === "failed") {
    const error = client.taskFailure(envelope) ?? new AdpApiError("任务未成功完成。", { code: "TASK_FAILED", retryable: false });
    const details = errorDetails(error);
    return { ...result, error: details, next_steps: [errorStep(details)] };
  }
  return result;
}

function taskStep(ref: TaskRef, message: string, queryError?: JsonObject): JsonObject {
  const retryAfter = queryError?.retry_after_ms;
  const stepMessage = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
    ? `${message} 请等待至少 ${Math.ceil(retryAfter / 1000)} 秒再查询。` : message;
  return { message: stepMessage, tool: "get_task", arguments: { task_ref: ref } };
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

function mutationData(envelope: JsonObject): JsonObject {
  if (!isObject(envelope.data)) throw unknownReceipt("应用变更接口未返回确认结果，请先查询原应用。");
  return envelope.data;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorDetails(error: unknown): JsonObject {
  if (error instanceof AdpApiError) return { ...error.details, message: error.message };
  return { message: error instanceof Error && error.message ? error.message : "ADP 调用失败。" };
}

function unknownReceipt(message: string, httpStatus?: number): AdpApiError {
  return new AdpApiError(message, {
    code: "RECEIPT_MISSING", acceptance_unknown: true, retryable: false,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus })
  });
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
