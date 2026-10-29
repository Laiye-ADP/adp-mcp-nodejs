import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import type { AuthKind, JsonObject, Operation, RequestConfig } from "./types.js";
import { workflowTemplateApplicationIds } from "./workflow-templates.js";
import { validateExportResult } from "./v119-operations.js";

const DOMESTIC_BASE_URL = "https://adp.laiye.com";
const GLOBAL_BASE_URL = "https://adp-global.laiye.com";
const DEFAULT_TENANT_NAME = "laiye";
const DEFAULT_ACCEPT_LANGUAGE = "zh";
const DEFAULT_API_SOURCE = "npm-mcp";
const schemaValidator = new AjvJsonSchemaValidator();

export function resolveConfig(args: JsonObject): RequestConfig {
  const acceptLanguage = readString(args.accept_language) ?? process.env.ADP_ACCEPT_LANGUAGE ?? DEFAULT_ACCEPT_LANGUAGE;

  return {
    baseUrl: selectBaseUrl(acceptLanguage),
    apiKey: process.env.ADP_API_KEY,
    apiSource: readString(process.env.API_SOURCE) ?? DEFAULT_API_SOURCE,
    tenantName: DEFAULT_TENANT_NAME,
    acceptLanguage
  };
}

export async function callAdpOperation(operation: Operation, args: JsonObject): Promise<unknown> {
  if (operation.validateInput) {
    const validation = schemaValidator.getValidator(operation.inputSchema as JsonSchemaType)(args);
    if (!validation.valid) throw new Error(`Invalid tool arguments: ${validation.errorMessage}`);
  }
  if (operation.name === "upload_temporary_file" && typeof args.application_id === "string" && args.application_id.startsWith("wftp_app_")) {
    throw new Error("Template IDs cannot be used for uploads. Create an application first and use its application_id, or upload with sharing_scope=user and omit application_id before running the template.");
  }
  const config = resolveConfig(args);
  const url = buildUrl(config.baseUrl, operation, args, config);
  const headers = buildHeaders(operation.auth, config);

  if (operation.usesAcceptLanguage) {
    headers.set("accept-language", config.acceptLanguage);
  }

  if (operation.name === "list_custom_extract_apps" || operation.name === "list_classification_apps") {
    return listDocumentApplications(operation, args, config, headers);
  }

  if (operation.bodyMode === "json") {
    headers.set("Content-Type", "application/json");
    return validateResponse(operation, args, await request(url, operation.method, headers, JSON.stringify(pickBody(args, operation)), getTimeoutMs(args)));
  }

  if (operation.bodyMode === "multipart") {
    return validateResponse(operation, args, await request(url, operation.method, headers, await buildMultipartBody(args, operation), getTimeoutMs(args)));
  }

  return validateResponse(operation, args, await request(url, operation.method, headers, undefined, getTimeoutMs(args)));
}

function validateResponse(operation: Operation, args: JsonObject, result: unknown): unknown {
  // Preserve an explicit business rejection, including its code and message.
  // Success-shape validation must not relabel a known rejection as uncertain acceptance.
  if (result && typeof result === "object" && "code" in result && (result as JsonObject).code !== "success") return result;
  if (operation.name === "export_workflow_runs") validateExportResult(args, result);
  if (operation.validateOutput && operation.outputSchema) {
    const validation = schemaValidator.getValidator(operation.outputSchema as JsonSchemaType)(result);
    if (!validation.valid) {
      throw new Error(`ADP response did not satisfy the tool contract; request acceptance may be unknown. Do not automatically resubmit. ${validation.errorMessage}`);
    }
  }
  for (const field of operation.responseIdentityFields ?? []) {
    const data = (result as { data?: JsonObject })?.data;
    if (data?.[field] !== args[field]) {
      throw new Error(`ADP response ${field} did not match the request. Do not automatically resubmit.`);
    }
  }
  return result;
}

async function listDocumentApplications(operation: Operation, args: JsonObject, config: RequestConfig, headers: Headers): Promise<unknown> {
  const items: JsonObject[] = [];
  const seen = new Set<string>();
  const allowedFunctions = operation.name === "list_classification_apps" ? [1426]
    : args.ai_function === undefined ? [1406, 1423, 1424, 1425] : [Number(args.ai_function)];
  let offset = 0;
  let first: JsonObject | undefined;
  let total = 0;
  while (true) {
    const url = new URL(buildUrl(config.baseUrl, operation, args, config));
    for (const [key, value] of Object.entries({ app_type: 1, owner_only: true, published_only: false,
      with_output_schema: operation.name === "list_custom_extract_apps", offset, limit: 1000 })) url.searchParams.set(key, String(value));
    url.searchParams.append("sort[]", "created_at");
    url.searchParams.append("sort[]", "id");
    const aiFunction = operation.name === "list_classification_apps" ? 1426 : args.ai_function;
    if (aiFunction !== undefined) url.searchParams.set("ai_function", String(aiFunction));
    const response = await request(url.toString(), "GET", headers, undefined, getTimeoutMs(args)) as JsonObject;
    const data = response?.data as JsonObject | undefined;
    const range = data?.range as JsonObject | undefined;
    if (response?.code !== "success" || !Array.isArray(data?.list) || !Number.isInteger(range?.total) || Number(range?.total) < 0) {
      throw new Error("ADP did not return a valid application list and range");
    }
    first ??= response;
    total = Number(range!.total);
    const page = data!.list as JsonObject[];
    let added = 0;
    for (const item of page) {
      if (!item || typeof item.id !== "string" || !item.id) throw new Error("ADP returned an application without an id");
      if (!seen.has(item.id)) {
        seen.add(item.id);
        added++;
        // The unfiltered app-list can also contain parsing and workflow apps.
        if (allowedFunctions.includes(Number(item.ai_function))) items.push(item);
      }
    }
    offset += page.length;
    if (offset >= total) break;
    if (page.length === 0 || added === 0) throw new Error("ADP application pagination did not advance");
  }
  const firstData = first!.data as JsonObject;
  return { ...first, data: { ...firstData, list: items, range: { ...(firstData.range as JsonObject), offset: 0, limit: items.length, total: items.length } } };
}

function buildHeaders(_auth: AuthKind, config: RequestConfig): Headers {
  const headers = new Headers();

  if (!config.apiKey) {
    throw new Error("ADP_API_KEY is required.");
  }

  headers.set("X-API-KEY", config.apiKey);
  headers.set("X-Api-Source", config.apiSource);
  return headers;
}

function buildUrl(
  baseUrl: string,
  operation: Operation,
  args: JsonObject,
  config: RequestConfig
): string {
  const pathParams: JsonObject = {};
  const operationPath = shouldUseAsyncPath(operation, args) ? operation.asyncPath : operation.path;

  if (operation.usesTenant) {
    pathParams.tenant_name = config.tenantName;
  }

  for (const param of operation.pathParams ?? []) {
    const value = args[param];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${param}`);
    }
    if (value === "." || value === "..") throw new Error(`Invalid path parameter: ${param}`);
    pathParams[param] = value;
  }

  const path = operationPath.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = pathParams[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });

  const url = new URL(path, baseUrl);
  for (const param of operation.queryParams ?? []) {
    if (args[param] !== undefined && args[param] !== null) url.searchParams.set(param, String(args[param]));
  }
  return url.toString();
}

function pickBody(args: JsonObject, operation: Operation): JsonObject {
  const body: JsonObject = {};

  if (operation.appId) {
    body.app_id = operation.appId;
  }

  if (operation.appIdField) {
    const appId = readString(args[operation.appIdField]);
    if (appId) {
      body.app_id = appId;
    }
  }

  const file = readString(args.file);
  if (file) {
    if (isUrl(file)) {
      body.file_url = file;
    } else {
      body.file_base64 = stripDataUrlPrefix(file);
    }
  }

  if (operation.mode === "extract") {
    body.with_rec_result = typeof args.with_rec_result === "boolean" ? args.with_rec_result : true;
  }

  for (const field of operation.bodyFields ?? []) {
    if (args[field] !== undefined) {
      body[field] = args[field];
    }
  }

  if (operation.name === "execute_workflow_app" && typeof args.template_key === "string") {
    body.application_id = workflowTemplateApplicationIds[args.template_key as keyof typeof workflowTemplateApplicationIds];
  }

  return body;
}

function shouldUseAsyncPath(operation: Operation, args: JsonObject): operation is Operation & { asyncPath: string } {
  return Boolean(operation.asyncPath && args.wait === false);
}

async function buildMultipartBody(args: JsonObject, operation: Operation): Promise<FormData> {
  const chunk = readString(args.chunk);
  if (!chunk) {
    throw new Error("chunk is required.");
  }

  const formData = new FormData();
  const upload = await readUploadFile(chunk);

  formData.set("chunk", upload.blob, upload.fileName);
  for (const field of operation.bodyFields ?? []) {
    if (args[field] !== undefined && args[field] !== null) formData.set(field, String(args[field]));
  }
  return formData;
}

async function readUploadFile(file: string): Promise<{ blob: Blob; fileName: string }> {
  if (isLocalFileInput(file)) {
    const filePath = toLocalFilePath(file);
    const bytes = await readFile(filePath);
    return {
      blob: new Blob([bytes]),
      fileName: basename(filePath)
    };
  }

  const bytes = Buffer.from(stripDataUrlPrefix(file), "base64");
  return {
    blob: new Blob([bytes]),
    fileName: "chunk"
  };
}

async function request(
  url: string,
  method: string,
  headers: Headers,
  body?: BodyInit,
  timeoutMs?: number
): Promise<unknown> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  let text: string;

  try {
    response = await fetch(url, { method, headers, body, signal: controller?.signal });
    text = await response.text();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  const payload = parseResponseBody(text);

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`ADP API request failed with HTTP ${response.status}: ${detail}`);
  }

  return payload;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function selectBaseUrl(acceptLanguage: string): string {
  return normalizeBaseUrl(acceptLanguage.toLowerCase() === "en" ? GLOBAL_BASE_URL : DOMESTIC_BASE_URL);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLocalFileInput(value: string): boolean {
  return (
    /^file:\/\//i.test(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("/") ||
    value.startsWith("\\")
  );
}

function toLocalFilePath(value: string): string {
  return /^file:\/\//i.test(value) ? fileURLToPath(value) : value;
}

function stripDataUrlPrefix(value: string): string {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  return index === -1 ? value : value.slice(index + marker.length);
}

function getTimeoutMs(args: JsonObject): number {
  const seconds = typeof args.timeout_seconds === "number" && args.timeout_seconds > 0 ? args.timeout_seconds : 300;
  return seconds * 1000;
}
