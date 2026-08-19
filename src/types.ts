export type JsonObject = Record<string, unknown>;

export type JsonSchema = JsonObject;

export type HttpMethod = "GET" | "POST";

export type AuthKind = "adp";

export type BodyMode = "json" | "multipart" | "none";

export interface Operation {
  name: string;
  title: string;
  operationId: string;
  description: string;
  method: HttpMethod;
  path: string;
  asyncPath?: string;
  fallbackPath?: string;
  auth: AuthKind;
  bodyMode: BodyMode;
  inputSchema: JsonSchema;
  annotations?: JsonObject;
  metadata?: JsonObject;
  appId?: string;
  appIdField?: string;
  mode?: "extract" | "recognize";
  bodyFields?: string[];
  pathParams?: string[];
  usesTenant?: boolean;
  usesAcceptLanguage?: boolean;
}

export interface RequestConfig {
  baseUrl: string;
  apiKey: string | undefined;
  tenantName: string;
  acceptLanguage: string;
}
