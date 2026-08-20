import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthKind, JsonObject, Operation, RequestConfig } from "./types.js";

const DOMESTIC_BASE_URL = "https://adp.laiye.com";
const GLOBAL_BASE_URL = "https://adp-global.laiye.com";
const DEFAULT_TENANT_NAME = "laiye";
const DEFAULT_ACCEPT_LANGUAGE = "zh";

export function resolveConfig(args: JsonObject): RequestConfig {
  const acceptLanguage = readString(args.accept_language) ?? process.env.ADP_ACCEPT_LANGUAGE ?? DEFAULT_ACCEPT_LANGUAGE;

  return {
    baseUrl: selectBaseUrl(acceptLanguage),
    apiKey: process.env.ADP_API_KEY,
    tenantName: DEFAULT_TENANT_NAME,
    acceptLanguage
  };
}

export async function callAdpOperation(operation: Operation, args: JsonObject): Promise<unknown> {
  const config = resolveConfig(args);
  const url = buildUrl(config.baseUrl, operation, args, config);
  const headers = buildHeaders(operation.auth, config);

  if (operation.usesAcceptLanguage) {
    headers.set("accept-language", config.acceptLanguage);
  }

  if (operation.bodyMode === "json") {
    headers.set("Content-Type", "application/json");
    return request(url, operation.method, headers, JSON.stringify(pickBody(args, operation)), getTimeoutMs(args));
  }

  if (operation.bodyMode === "multipart") {
    return request(url, operation.method, headers, await buildMultipartBody(args), getTimeoutMs(args));
  }

  try {
    return await request(url, operation.method, headers, undefined, getTimeoutMs(args));
  } catch (error) {
    if (!operation.fallbackPath) {
      throw error;
    }

    const fallbackUrl = buildUrl(config.baseUrl, operation, args, config, operation.fallbackPath);
    return request(fallbackUrl, operation.method, headers, undefined, getTimeoutMs(args));
  }
}

function buildHeaders(_auth: AuthKind, config: RequestConfig): Headers {
  const headers = new Headers();

  if (!config.apiKey) {
    throw new Error("ADP_API_KEY is required.");
  }

  headers.set("X-API-KEY", config.apiKey);
  headers.set("X-Api-Source", "npm-mcp");
  return headers;
}

function buildUrl(
  baseUrl: string,
  operation: Operation,
  args: JsonObject,
  config: RequestConfig,
  overridePath?: string
): string {
  const pathParams: JsonObject = {};
  const operationPath = overridePath ?? (shouldUseAsyncPath(operation, args) ? operation.asyncPath : operation.path);

  if (operation.usesTenant) {
    pathParams.tenant_name = config.tenantName;
  }

  for (const param of operation.pathParams ?? []) {
    const value = args[param];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${param}`);
    }
    pathParams[param] = value;
  }

  const path = operationPath.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = pathParams[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });

  return new URL(path, baseUrl).toString();
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

  return body;
}

function shouldUseAsyncPath(operation: Operation, args: JsonObject): operation is Operation & { asyncPath: string } {
  return Boolean(operation.asyncPath && args.wait === false);
}

async function buildMultipartBody(args: JsonObject): Promise<FormData> {
  const chunk = readString(args.chunk);
  if (!chunk) {
    throw new Error("chunk is required.");
  }

  const formData = new FormData();
  const upload = await readUploadFile(chunk);

  formData.set("chunk", upload.blob, upload.fileName);
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
