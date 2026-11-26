import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AdpClient, JsonObject } from "./adp-client.js";

export const CORE_ANALYTICS_TOOLS = new Set([
  "parse_document", "extract_document", "classify_document", "verify_invoice"
]);

const modelPattern = /^[a-zA-Z0-9._:/-]{1,128}$/;
const clientPattern = /^[\p{L}\p{N}_ .:/()+-]{1,128}$/u;
const sensitiveText = /[\x00-\x1f\x7f@{}\[\]]|[a-z][a-z0-9+.-]*:\/\/|www\.|\+?\d(?:[\s().-]?\d){6,}(?:x)?|[a-z0-9_+/=-]{24,}|(?:sk-|re_|ghp_)[a-z0-9_-]{8,}|\b(?:bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization)\b|(?:密码|密钥|令牌)\s*[:：=]|\b(?:file_url|file_base64|file_path|file_name|app_id|fields|arguments|extract_fields)\s*[:=]/iu;
const modelSecret = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:sk-|re_|ghp_)[a-z0-9_-]{12,})/i;

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function analyticsParametersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ADP_MCP_ANALYTICS_PARAMETERS?.trim().toLowerCase() !== "false";
}

export function businessInputSchema(name: string, schema: Tool["inputSchema"]): Tool["inputSchema"] {
  const business = structuredClone(schema);
  if (CORE_ANALYTICS_TOOLS.has(name)) {
    delete business.properties?.context;
    delete business.properties?.llm_model;
  }
  return business;
}

export function publishedTools(catalog: Tool[], enabled: boolean): Tool[] {
  return catalog.map(tool => ({ ...structuredClone(tool),
    inputSchema: enabled ? structuredClone(tool.inputSchema) : businessInputSchema(tool.name, tool.inputSchema) }));
}

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return;
  const model = value.trim();
  if (model.toLowerCase() !== "unknown" && modelPattern.test(model) && !modelSecret.test(model)) return model;
}

function safeContext(value: unknown): string | undefined {
  if (typeof value !== "string" || [...value].length > 256) return;
  const context = value.trim();
  if (context && !sensitiveText.test(context)) return context;
}

function clientLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || [...value].length > 128) return;
  const label = value.trim();
  if (clientPattern.test(label) && !sensitiveText.test(label)) return label;
}

export function extractAnalyticsArguments(name: string, args: JsonObject, enabled: boolean): {
  arguments: JsonObject; metadata: JsonObject;
} {
  if (!enabled || !CORE_ANALYTICS_TOOLS.has(name)) return { arguments: args, metadata: {} };
  const { context: rawContext, llm_model: rawModel, ...business } = args;
  const context = safeContext(rawContext);
  const model = safeModel(rawModel);
  return { arguments: business, metadata: {
    ...(context ? { context } : {}),
    ...(model ? { llm_model: model, llm_model_source: "self_reported" } : {})
  } };
}

function invocationModel(metadata: unknown): string | undefined {
  if (!record(metadata)) return;
  let codex = metadata["x-codex-turn-metadata"];
  if (typeof codex === "string" && codex.length <= 4096) {
    try { codex = JSON.parse(codex); } catch { codex = undefined; }
  }
  const codexModel = record(codex) ? safeModel(codex.model) : undefined;
  if (codexModel) return codexModel;
  const invocation = metadata["io.modelcontextprotocol/aiInvocation"];
  return record(invocation) && record(invocation.model) ? safeModel(invocation.model.name) : undefined;
}

const receiptReasons: Record<string, string> = {
  RECEIPT_MISSING: "invalid_receipt", TASK_ID_MISMATCH: "task_id_mismatch", TASK_STATUS_UNKNOWN: "task_status_unknown",
  INVALID_RESPONSE: "output_schema_mismatch"
};
const executionReasons: Record<string, string> = {
  APPLICATION_NOT_AVAILABLE: "application_not_available", INSUFFICIENT_CREDITS: "insufficient_credits",
  RATE_LIMITED: "rate_limited", REQUEST_TIMEOUT: "request_timeout", REQUEST_CANCELLED: "interrupted",
  TASK_FAILED: "task_failed", TASK_NOT_AVAILABLE: "task_not_available"
};
const inputReasons = new Set([
  "missing_file_source", "incomplete_task_ref", "file_name_not_supported_with_fields",
  "schema_validation_failed", "preset_unavailable", "invalid_arguments"
]);

function outcome(result: JsonObject): JsonObject {
  if (result.status !== "failed") {
    return { status: result.status === "partial_success" ? "partial_success" : "success", stage: "execution" };
  }
  const error = record(result.error) ? result.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "INVALID_ARGUMENTS" || code === "INVOICE_VERIFICATION_INPUT_REQUIRED") {
    const reason = typeof error.reason === "string" && inputReasons.has(error.reason)
      ? error.reason : "schema_validation_failed";
    return { status: "failure", stage: "input_validation", reason };
  }
  if (receiptReasons[code]) return { status: "failure", stage: "output_validation", reason: receiptReasons[code] };
  return { status: "failure", stage: "execution",
    reason: error.http_status === 403 ? "permission_denied" : executionReasons[code] ?? "execution_failed" };
}

export async function reportToolStatistics(client: AdpClient, name: string, result: JsonObject, options: {
  startedAt: number; enabled: boolean; parameters: JsonObject; requestMetadata: unknown; clientInfo: unknown;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const identity = record(options.clientInfo) ? options.clientInfo : {};
    const clientName = clientLabel(identity.name);
    const clientVersion = clientLabel(identity.version);
    const includeAnalysis = options.enabled && CORE_ANALYTICS_TOOLS.has(name);
    const model = includeAnalysis ? invocationModel(options.requestMetadata) : undefined;
    const metadata = {
      ...outcome(result), duration_ms: Math.max(0, Math.round(performance.now() - options.startedAt)),
      event_id: randomUUID().replaceAll("-", ""),
      ...(clientName ? { client_name: clientName } : {}),
      ...(clientVersion ? { client_version: clientVersion } : {}),
      ...(includeAnalysis ? options.parameters : {}),
      ...(model ? { llm_model: model, llm_model_source: "client_metadata" } : {})
    };
    const controller = new AbortController();
    const command = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) ? name : "unknown_tool";
    await Promise.race([
      client.request(client.documentPath("/v1/command/statistics"), {
        method: "POST", body: { command, metadata }, timeoutMs: 1000, signal: controller.signal
      }),
      new Promise<void>(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve(); }, 1000);
      })
    ]);
  } catch {
    // Statistics never change the tool outcome or trigger a repeated business request.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
