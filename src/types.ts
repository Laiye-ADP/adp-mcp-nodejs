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
  auth: AuthKind;
  bodyMode: BodyMode;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: JsonObject;
  metadata?: JsonObject;
  appId?: string;
  appIdField?: string;
  mode?: "extract" | "recognize";
  bodyFields?: string[];
  pathParams?: string[];
  queryParams?: string[];
  validateInput?: boolean;
  validateOutput?: boolean;
  responseIdentityFields?: string[];
  usesTenant?: boolean;
  usesAcceptLanguage?: boolean;
}

export interface RequestConfig {
  baseUrl: string;
  apiKey: string | undefined;
  apiSource: string;
  tenantName: string;
  acceptLanguage: string;
}
