import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliCredentials } from "./cli-credentials.js";

export type JsonObject = Record<string, unknown>;
export type AdpRegion = "cn" | "global";
export type GuideWorkspace = AdpRegion | "private" | "unknown";
export type RegionCache = Map<string, Promise<AdpRegion>>;

type RequestOptions = {
  method?: "GET" | "POST";
  body?: JsonObject | FormData;
  query?: Record<string, string>;
  timeoutMs?: number;
  rawResponse?: boolean;
  signal?: AbortSignal;
};

type FeedbackSubmission = {
  feedbackType: "suggestion" | "issue";
  content: string;
  allowFollowUp: boolean;
  attachmentPaths: string[];
};

type Connection = {
  origin: string;
  tenant: string;
  region: AdpRegion;
  guideWorkspace: GuideWorkspace;
  apiKey?: string;
  discoverRegion?: boolean;
};

const DOMESTIC_BASE_URL = "https://adp.laiye.com";
const GLOBAL_BASE_URL = "https://adp-global.laiye.com";
const REGION_PROBE_PATH = "/open/agentic_doc_processor/laiye/v1/webhook/events";
const REGION_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_API_SOURCE = "adp-node-mcp";
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_FEEDBACK_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const mimeTypes: Record<string, string> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown",
  ".ofd": "application/ofd",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeTypeFor(filename: string): string {
  return mimeTypes[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

const documentedErrorCodes = new Set([
  "RULE_CONFIG_INVALID",
  "WORKFLOW_INPUT_INVALID",
  "WORKFLOW_RUNTIME_INPUT_INVALID",
  "WORKFLOW_TEST_INPUT_REQUIRED",
  "WORKFLOW_VALIDATION_FAILED",
  "failed",
  "http_server_error",
  "invalid_params",
  "not_exists",
  "permission_denied",
  "server_error",
  "timeout",
]);

// These fixes are fixed catalog text for the reviewed OpenAPI detail codes.
// Matching the text also prevents arbitrary response strings from reaching the agent.
const documentedErrorFixes = {
  APPLICATION_NOT_AVAILABLE: {
    zh: "请核对应用标识或应用凭据，并确认当前账号可以访问该应用。",
    en: "Check the application identifier or application credentials and confirm the current account can access the application.",
  },
  FILE_SOURCE_REQUIRED: {
    zh: "请提供可访问的 file_url 或有效的 file_base64，再发起请求。",
    en: "Provide an accessible file_url or valid file_base64 before making another request.",
  },
  TASK_NOT_AVAILABLE: {
    zh: "请使用同类异步创建接口返回的 task_id，并核对账号、租户和区域；不要自动重新提交处理任务。",
    en: "Use the task_id returned by the matching asynchronous creation API and check the account, tenant, and region. Do not automatically resubmit the processing task.",
  },
} as const;

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

export class AdpApiError extends Error {
  constructor(message: string, readonly details: JsonObject) {
    super(message);
    this.name = "AdpApiError";
  }
}

export class AdpClient {
  readonly #env: NodeJS.ProcessEnv;
  readonly #language: string;
  readonly #english: boolean;
  readonly #source: string;
  readonly #regions: RegionCache;
  #connection?: Connection;
  #catalogRegionConfirmed = true;

  constructor(env: NodeJS.ProcessEnv = process.env, regions: RegionCache = new Map()) {
    this.#env = env;
    this.#language = env.ADP_ACCEPT_LANGUAGE?.trim() || "zh";
    this.#english = /^en(?:-|$)/i.test(this.#language);
    this.#source = env.API_SOURCE?.trim() || DEFAULT_API_SOURCE;
    this.#regions = regions;
  }

  get language(): string {
    return this.#language;
  }

  get catalogRegionConfirmed(): boolean {
    return this.#catalogRegionConfirmed;
  }

  get guideWorkspace(): GuideWorkspace {
    return this.#catalogRegionConfirmed ? this.#getConnection().guideWorkspace : "unknown";
  }

  get domesticInvoiceRegionConfirmed(): boolean {
    if (!this.#catalogRegionConfirmed) return false;
    const connection = this.#getConnection();
    const baseUrl = this.#env.ADP_API_BASE_URL?.trim() || this.#env.ADP_BASE_URL?.trim();
    const explicitChina = this.#env.ADP_REGION?.trim() === "cn"
      || (!!baseUrl && officialRegion(connection.origin) === "cn");
    const confirmedChina = !!connection.apiKey && !connection.discoverRegion && officialRegion(connection.origin) === "cn";
    return connection.region === "cn" && (explicitChina || confirmedChina);
  }

  async getCatalogRegion(signal?: AbortSignal): Promise<AdpRegion> {
    try {
      const region = await this.prepareConnection(signal);
      this.#catalogRegionConfirmed = true;
      return region;
    } catch (error) {
      if (!(error instanceof AdpApiError)) throw error;
      // Keep the guide available to repair an invalid connection configuration.
      this.#catalogRegionConfirmed = false;
      return this.#env.ADP_REGION?.trim() === "global" ? "global" : "cn";
    }
  }

  async prepareConnection(signal?: AbortSignal): Promise<AdpRegion> {
    signal?.throwIfAborted();
    const connection = this.#getConnection();
    if (!connection.discoverRegion || !connection.apiKey) return connection.region;

    const fingerprint = createHash("sha256").update(connection.apiKey).digest("hex");
    let discovery = this.#regions.get(fingerprint);
    if (!discovery) {
      discovery = this.#discoverRegion(connection).catch(error => {
        this.#regions.delete(fingerprint);
        throw error;
      });
      this.#regions.set(fingerprint, discovery);
    }
    const region = await discovery;
    signal?.throwIfAborted();
    this.#connection = {
      ...connection, region, guideWorkspace: region, origin: region === "global" ? GLOBAL_BASE_URL : DOMESTIC_BASE_URL, discoverRegion: false
    };
    return region;
  }

  async #discoverRegion(connection: Connection): Promise<AdpRegion> {
    try {
      await this.#probeRegion(connection);
      return "cn";
    } catch (error) {
      if (!isMissingAccessor(error)) throw error;
    }

    try {
      await this.#probeRegion({ ...connection, origin: GLOBAL_BASE_URL, region: "global" });
      return "global";
    } catch (error) {
      if (!isMissingAccessor(error)) throw error;
      throw new AdpApiError(this.#text(
        "中国区和全球区都未找到此 API Key。请核对 Key，或设置 ADP_API_BASE_URL 指向实际签发地址。",
        "Neither China nor Global found this API key. Check the key or set ADP_API_BASE_URL to its issuing address."
      ), { code: "INVALID_API_KEY", http_status: 404, retryable: false });
    }
  }

  async #probeRegion(connection: Connection): Promise<void> {
    const url = new URL(REGION_PROBE_PATH, connection.origin);
    const { result, status } = await this.#requestAt(connection, url, {}, REGION_PROBE_TIMEOUT_MS);
    if (status !== 200 || result.code !== "success" || !Array.isArray(asObject(result.data)?.events)) {
      throw new AdpApiError(this.#text(
        "ADP 未返回可确认区域的鉴权结果。请重试或显式设置 ADP_REGION。",
        "ADP did not confirm the API region. Retry or set ADP_REGION explicitly."
      ), { code: "REGION_DISCOVERY_FAILED", http_status: status, retryable: false });
    }
  }

  documentPath(suffix: string): string {
    return this.#path("agentic_doc_processor", suffix);
  }

  workflowPath(suffix: string): string {
    return this.#path("agentic_engine", suffix);
  }

  async request(path: string, options: RequestOptions = {}): Promise<JsonObject> {
    const { origin } = this.#getConnection();
    const url = new URL(path, origin);
    if (!path.startsWith("/") || url.origin !== origin || url.search || url.hash
        || !(url.pathname.startsWith(this.documentPath("/")) || url.pathname.startsWith(this.workflowPath("/")))) {
      throw new AdpApiError("Invalid ADP request path.", { code: "INVALID_REQUEST_PATH", retryable: false });
    }
    await this.prepareConnection(options.signal);
    const connection = this.#getConnection();
    const target = new URL(url.pathname, connection.origin);
    target.search = new URLSearchParams(options.query).toString();
    return (await this.#requestAt(connection, target, options, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)).result;
  }

  async #requestAt(connection: Connection, url: URL, options: RequestOptions, timeoutMs: number) {
    const headers = this.#headers(connection);
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    let body: string | FormData | undefined;
    if (options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const signal = controller.signal;
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    timeout.unref();

    let response: Response;
    let raw: string;
    try {
      response = await fetch(url, { method, headers, body, signal, redirect: "manual" });
      raw = await response.text();
    } catch {
      if (signal.aborted) {
        const timedOut = signal.reason?.name === "TimeoutError";
        const message = timedOut ? this.#text("ADP 请求等待超时。", "The ADP request timed out.")
          : this.#text("ADP 请求已取消。", "The ADP request was cancelled.");
        throw this.#transportError(message, timedOut ? "REQUEST_TIMEOUT" : "REQUEST_CANCELLED", method);
      }
      throw this.#transportError(
        this.#text("无法连接 ADP，请检查接口地址和网络。", "Could not reach ADP. Check the API address and network."),
        "NETWORK_ERROR",
        method,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    const result = parseObject(raw);
    if (!response.ok || (result && (result.error != null ||
        ((!options.rawResponse || result.code !== undefined) && !isSuccessCode(result.code))))) {
      throw this.#responseError(response, result, connection.origin, method);
    }
    if (!result) {
      throw this.#transportError(
        this.#text("ADP 未返回有效的 JSON 响应。", "ADP did not return a valid JSON response."),
        "INVALID_RESPONSE",
        method,
        response.status,
      );
    }
    return { result, status: response.status };
  }

  async upload(filePath: string, signal?: AbortSignal): Promise<JsonObject> {
    this.#headers(this.#getConnection());
    const { file, name } = await this.#openLocalFile(filePath);
    const form = new FormData();
    form.set("chunk", file, name);
    form.set("sharing_scope", "user");
    return this.request(this.workflowPath("/files/upload"), { method: "POST", body: form, signal });
  }

  async submitFeedback(submission: FeedbackSubmission, signal?: AbortSignal): Promise<JsonObject> {
    const key = this.#headers(this.#getConnection()).get("X-API-KEY");
    if (key && submission.content.includes(key)) {
      throw new AdpApiError(
        this.#text("请从反馈摘要中移除 API Key 后再提交。", "Remove the API key from the feedback summary before submitting."),
        { code: "CREDENTIAL_IN_FEEDBACK", retryable: false },
      );
    }
    const form = new FormData();
    form.set("feedback_type", submission.feedbackType);
    form.set("content", submission.content);
    form.set("allow_follow_up", String(submission.allowFollowUp));
    for (const filePath of submission.attachmentPaths) {
      const { file, name } = await this.#openLocalFile(filePath, MAX_FEEDBACK_ATTACHMENT_BYTES);
      form.append("attachments", file, name);
    }
    return this.request(this.documentPath("/user-feedback"), { method: "POST", body: form, signal });
  }

  async #openLocalFile(filePath: string, maxBytes?: number): Promise<{ file: Blob; name: string }> {
    let path: string;
    let file: Blob;
    try {
      path = /^file:/i.test(filePath) ? fileURLToPath(filePath) : filePath;
      if (!isAbsolute(path)) throw new Error("Expected an absolute file path");
      const info = await stat(path);
      if (!info.isFile() || !info.size) throw new Error("Invalid local file");
      file = await openAsBlob(path, { type: mimeTypeFor(path) });
    } catch {
      throw new AdpApiError(
        this.#text("请提供可读取的非空本地文件。", "Provide a readable, nonempty local file."),
        { code: "INVALID_LOCAL_FILE", retryable: false },
      );
    }
    if (maxBytes !== undefined && file.size > maxBytes) {
      throw new AdpApiError(
        this.#text("反馈附件每个文件不能超过 50 MiB。", "Each feedback attachment must be at most 50 MiB."),
        { code: "ATTACHMENT_TOO_LARGE", retryable: false },
      );
    }
    return { file, name: basename(path) };
  }

  taskFailure(result: JsonObject): AdpApiError | undefined {
    return hasInsufficientCredits(result) ? this.#creditError(this.#getConnection().origin) : undefined;
  }

  #path(service: string, suffix: string): string {
    return `/open/${service}/${this.#getConnection().tenant}${suffix}`;
  }

  #getConnection(): Connection {
    if (this.#connection) return this.#connection;

    const region = this.#env.ADP_REGION?.trim() || undefined;
    if (region !== undefined && region !== "cn" && region !== "global") {
      throw new AdpApiError(
        this.#text("请将 ADP_REGION 设为 cn 或 global。", "Set ADP_REGION to cn or global."),
        { code: "INVALID_CONFIG", retryable: false },
      );
    }
    const apiKey = this.#env.ADP_API_KEY?.trim();
    const baseUrl = this.#env.ADP_API_BASE_URL?.trim() || this.#env.ADP_BASE_URL?.trim();
    const tenant = this.#env.ADP_TENANT_NAME?.trim();
    if (tenant && !isTenant(tenant)) {
      throw new AdpApiError("Invalid ADP_TENANT_NAME.", { code: "INVALID_CONFIG", retryable: false });
    }
    if (!apiKey) {
      const cli = this.#cliConnection(baseUrl, tenant, region);
      if (cli) return this.#connection = cli;
    } else if (!baseUrl && !region && (!tenant || tenant === "laiye")) {
      // A local profile can identify the target only for the same key.
      try {
        const cli = this.#cliConnection(undefined, undefined, undefined);
        if (cli?.apiKey === apiKey && (!tenant || cli.tenant === tenant)
            && (cli.origin === DOMESTIC_BASE_URL || cli.origin === GLOBAL_BASE_URL)) {
          return this.#connection = cli;
        }
      } catch (error) {
        if (!(error instanceof AdpApiError) || error.details.code !== "CLI_CREDENTIALS_UNAVAILABLE") throw error;
      }
    }
    const origin = this.#origin(baseUrl || (region === "global" ? GLOBAL_BASE_URL : DOMESTIC_BASE_URL));
    const cloud = officialRegion(origin);
    return this.#connection = {
      origin,
      tenant: tenant || "laiye",
      region: cloud ?? (region === "global" ? "global" : "cn"),
      guideWorkspace: baseUrl || region ? cloud ?? "private" : "unknown",
      apiKey,
      discoverRegion: !!apiKey && !baseUrl && !region && (!tenant || tenant === "laiye")
    };
  }

  #cliConnection(baseUrl: string | undefined, tenant: string | undefined, region: AdpRegion | undefined): Connection | undefined {
    let profile: ReturnType<typeof readCliCredentials>;
    let origin: string;
    try {
      profile = readCliCredentials(this.#env);
      if (!profile) return undefined;
      origin = this.#origin(profile.baseUrl);
      if (!isTenant(profile.tenant)) throw new Error("Invalid CLI tenant");
    } catch {
      throw new AdpApiError(
        this.#text(
          "无法读取有效的 ADP CLI 凭据。请用当前系统账号重新运行 adp config set，或显式设置 ADP_API_KEY。",
          "Could not read valid ADP CLI credentials. Run adp config set as the current OS user, or set ADP_API_KEY explicitly."
        ),
        { code: "CLI_CREDENTIALS_UNAVAILABLE", retryable: false },
      );
    }
    const profileRegion = officialRegion(origin);
    if ((baseUrl && this.#origin(baseUrl) !== origin) || (tenant && tenant !== profile.tenant)
        || (region && profileRegion && region !== profileRegion)) {
      throw new AdpApiError(
        this.#text(
          "MCP 的地址、区域或租户与 CLI 配置冲突。请移除冲突配置以继承 CLI，或显式配置该目标的 ADP_API_KEY。",
          "The MCP address, region, or tenant conflicts with the CLI profile. Remove the conflicting setting to inherit the CLI target, or set ADP_API_KEY for the intended target."
        ),
        { code: "CLI_CREDENTIAL_TARGET_MISMATCH", retryable: false },
      );
    }
    return { origin, tenant: profile.tenant, region: profileRegion ?? region ?? "cn", guideWorkspace: profileRegion ?? "private", apiKey: profile.apiKey };
  }

  #origin(baseUrl: string): string {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw this.#invalidBaseUrl();
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) {
      throw this.#invalidBaseUrl();
    }
    return url.origin;
  }

  #invalidBaseUrl(): AdpApiError {
    return new AdpApiError(
      this.#text("请将 ADP_API_BASE_URL 设为 ADP 服务的 HTTP(S) 根地址。", "Set ADP_API_BASE_URL to the ADP service's HTTP(S) origin."),
      { code: "INVALID_CONFIG", retryable: false },
    );
  }

  #headers({ origin, apiKey: key }: Connection): Headers {
    if (!key) throw this.#keyError("MISSING_API_KEY", origin);
    try {
      return new Headers({
        "Accept": "application/json",
        "Accept-Language": this.#language,
        "X-API-KEY": key,
        "X-Api-Source": this.#source,
      });
    } catch {
      throw new AdpApiError(
        this.#text("请检查 ADP_API_KEY、ADP_ACCEPT_LANGUAGE 和 API_SOURCE 的配置。", "Check the ADP_API_KEY, ADP_ACCEPT_LANGUAGE and API_SOURCE settings."),
        { code: "INVALID_CONFIG", retryable: false },
      );
    }
  }

  #keyError(code: "MISSING_API_KEY" | "INVALID_API_KEY", origin: string, details: JsonObject = {}): AdpApiError {
    const keyUrl = `${this.#portal(origin)}?from=getkey&utm_source=github`;
    const message = code === "MISSING_API_KEY"
      ? this.#text(`请在 ${keyUrl} 获取同区域的 API Key，并设置 ADP_API_KEY。`, `Get an API key for this region at ${keyUrl} and set ADP_API_KEY.`)
      : this.#text(
        `ADP 凭据不可用，请核对 Key 的签发区域及 ADP_REGION 或 API 地址。当前区域获取 Key：${keyUrl}`,
        `ADP credentials were rejected. Check the issuing region and ADP_REGION or API address. Get a key for the current region at ${keyUrl}.`
      );
    return new AdpApiError(message, { ...details, code, retryable: false });
  }

  #creditError(origin: string, details: JsonObject = {}): AdpApiError {
    const portal = this.#portal(origin);
    return new AdpApiError(
      this.#text(`配额积分不足，如需继续使用请前往官网充值。${portal}`, `Insufficient credits. Top up in the same region at ${portal}.`),
      { ...details, code: "INSUFFICIENT_CREDITS", retryable: false },
    );
  }

  #portal(origin: string): string {
    return (officialRegion(origin) ?? this.#getConnection().region) === "global" ? GLOBAL_BASE_URL : DOMESTIC_BASE_URL;
  }

  #responseError(response: Response, result: JsonObject | undefined, origin: string, method: string): AdpApiError {
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    const apiCode = typeof result?.code === "string" && documentedErrorCodes.has(result.code) ? result.code : undefined;
    const details = {
      http_status: status,
      ...(apiCode ? { api_code: apiCode } : {}),
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    };
    if (status === 401 || (status === 404 && result?.detail === "Accessor not found")) {
      return this.#keyError("INVALID_API_KEY", origin, details);
    }
    const detail = asObject(result?.error);
    const detailCode = getDocumentedDetailCode(detail?.code);
    const fix = detailCode ? this.#documentedFix(detailCode, detail?.fix) : undefined;
    if (result && !detailCode && hasInsufficientCredits(result)) {
      return this.#creditError(origin, details);
    }

    const acceptanceUnknown = method === "POST" && (status >= 500 || status === 408 || apiCode === "timeout"
      || (status >= 200 && status < 300 && !apiCode && !detailCode));
    const message = this.#errorMessage(status, detailCode ?? apiCode);
    return new AdpApiError(
      acceptanceUnknown ? this.#withUnknownAcceptance(message) : message,
      {
        ...details,
        code: detailCode ?? (status === 429 ? "RATE_LIMITED" : "ADP_API_ERROR"),
        ...(fix ? { fix } : {}),
        retryable: method === "GET" && retryableStatuses.has(status) && !detailCode && detail?.retryable !== false,
        ...(acceptanceUnknown ? { acceptance_unknown: true } : {}),
      },
    );
  }

  #documentedFix(code: keyof typeof documentedErrorFixes, upstreamFix: unknown): string {
    const fixes = documentedErrorFixes[code];
    if (upstreamFix === fixes.zh) return fixes.zh;
    if (upstreamFix === fixes.en) return fixes.en;
    return this.#text(fixes.zh, fixes.en);
  }

  #errorMessage(status: number, apiCode?: string): string {
    switch (apiCode) {
      case "FILE_SOURCE_REQUIRED":
        return this.#text("请提供可访问的文件 URL，或先上传本地文件。", "Provide an accessible file URL or upload a local file first.");
      case "APPLICATION_NOT_AVAILABLE":
        return this.#text("应用不可用，请核对应用 ID、区域和账号权限。", "The application is unavailable. Check its ID, region and account access.");
      case "TASK_NOT_AVAILABLE":
        return this.#text("任务不可用，请核对原任务引用、区域和账号。", "The task is unavailable. Check the original task reference, region and account.");
      case "WORKFLOW_TEST_INPUT_REQUIRED":
        return this.#text("工作流需要文件，请上传后传入文件链接、名称和类型。", "The workflow requires files. Upload them and pass their links, names and types.");
      case "WORKFLOW_INPUT_INVALID":
      case "WORKFLOW_RUNTIME_INPUT_INVALID":
        return this.#text("请核对工作流要求的文件类型和运行参数。", "Check the workflow's required file types and input parameters.");
      case "RULE_CONFIG_INVALID":
      case "WORKFLOW_VALIDATION_FAILED":
        return this.#text("当前工作流配置无法运行，请联系应用维护者。", "The workflow configuration cannot run. Contact the application maintainer.");
    }
    if (status === 429) return this.#text("请求过于频繁，请降低查询频率后再试。", "Too many requests. Reduce polling frequency and try again.");
    if (status === 422) return this.#text("ADP 参数校验失败，请核对必填项和字段类型。", "ADP rejected the input. Check required fields and field types.");
    if (status === 403) return this.#text("ADP 拒绝访问，请核对资源权限和访问条件。", "ADP denied access. Check permissions and access requirements.");
    if (status === 404) return this.#text("ADP 未找到资源，请核对路径、租户和资源 ID。", "ADP did not find the resource. Check the path, tenant and resource ID.");
    return this.#text(`ADP 请求失败（HTTP ${status}）。`, `ADP request failed (HTTP ${status}).`);
  }

  #transportError(message: string, code: string, method: string, status?: number): AdpApiError {
    return new AdpApiError(method === "POST" ? this.#withUnknownAcceptance(message) : message, {
      code,
      ...(status === undefined ? {} : { http_status: status }),
      retryable: method === "GET" && (code === "NETWORK_ERROR" || code === "REQUEST_TIMEOUT"),
      ...(method === "POST" ? { acceptance_unknown: true } : {}),
    });
  }

  #withUnknownAcceptance(message: string): string {
    return message + this.#text(
      "处理结果可能未知。请先核对调用记录，避免重复提交。",
      " The outcome may be unknown. Check the call record before submitting again.",
    );
  }

  #text(zh: string, en: string): string {
    return this.#english ? en : zh;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function isTenant(tenant: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(tenant);
}

function isMissingAccessor(error: unknown): boolean {
  return error instanceof AdpApiError && error.details.code === "INVALID_API_KEY" && error.details.http_status === 404;
}

function officialRegion(origin: string): AdpRegion | undefined {
  const hostname = new URL(origin).hostname;
  if (hostname === "adp.laiye.com") return "cn";
  if (hostname === "adp-global.laiye.com") return "global";
  return undefined;
}

function parseObject(raw: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function isSuccessCode(value: unknown): boolean {
  return value === "success" || value === 200;
}

function getDocumentedDetailCode(value: unknown): keyof typeof documentedErrorFixes | undefined {
  if (typeof value === "string" && Object.hasOwn(documentedErrorFixes, value)) {
    return value as keyof typeof documentedErrorFixes;
  }
  return undefined;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-date allows the preferred GMT form and two legacy forms.
  const httpDate = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  const legacyDate = /^[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
  const asctime = /^[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  if (!(httpDate.test(value) || legacyDate.test(value) || asctime.test(value))) return undefined;
  const date = Date.parse(value.endsWith(" GMT") ? value : `${value} GMT`);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function hasInsufficientCredits(result: JsonObject): boolean {
  const data = asObject(result.data);
  const messages = [result.detail, result.message, result.tips, data?.message, data?.error,
    asObject(result.error)?.message, asObject(data?.error)?.message];
  return messages.some((value) => typeof value === "string"
    && /积分(?:余额)?不足|insufficient\s+credits?\b/i.test(value));
}
