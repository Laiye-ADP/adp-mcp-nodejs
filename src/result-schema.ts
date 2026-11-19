import type { JsonSchemaType as Schema } from "@modelcontextprotocol/sdk/validation";

type ResultOptions = { task?: boolean; batch?: boolean; usage?: Schema };
type ObjectSchema = Schema & { type: "object" };

const text: Schema = { type: "string", minLength: 1 };
const textOrNull: Schema = { type: ["string", "null"] };
const number: Schema = { type: "number", minimum: 0 };
const array: Schema = { type: "array" };
const openObject: Schema = { type: "object", additionalProperties: true };
const error: Schema = {
  type: "object",
  required: ["message"],
  properties: {
    message: text,
    code: text,
    http_status: { type: "integer" },
    api_code: text,
    fix: text,
    retryable: { type: "boolean" },
    retry_after_ms: number,
    acceptance_unknown: { type: "boolean" }
  },
  additionalProperties: true
};
const nextSteps: Schema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["message"],
    additionalProperties: false,
    properties: { message: text, tool: text, arguments: openObject }
  }
};
const billingCategories = ["recognition", "extraction", "split_classification", "collaboration", "invoice_verification"];
const documentUsage = usageSchema(billingCategories);
const workflowUsage = usageSchema(["recognition", "extraction", "split_classification", "invoice_verification", "model_usage"]);
const parseData = dataFields({
  task_id: text, response_type: { const: "recognize" }, status: { type: "integer" }, doc_recognize_result: array
}, ["task_id"]);
const extractData = dataFields({
  task_id: text, response_type: { const: "extract" }, status: { type: "integer" }, extraction_result: array
}, ["task_id"]);
const classifyData = dataFields({
  task_id: text, response_type: { const: "classify" }, status: text, segments: array, unclassified_pages: array
}, ["task_id"]);
const workflowData = dataFields({
  run_id: text, status: text, output: { type: ["object", "null"] }, error: textOrNull
}, ["run_id"]);
const taskData = { parse: parseData, extract: extractData, classify: classifyData, workflow: workflowData };

export function resultSchemas(taskReference: ObjectSchema) {
  const meteredBatch = { usage: documentUsage, batch: true };
  const taskBatch = { ...meteredBatch, task: true };
  return {
    get_adp_guide: toolResult({ version: text, markdown: text }, ["version", "markdown"]),
    upload_temporary_file: toolResult({
      data: dataFields({ id: text, download_url: text, file_name: text, content_type: text, file_size: number }, ["download_url"])
    }, ["data"], { batch: true }),
    parse_document: toolResult({ data: parseData }, ["data"], taskBatch),
    extract_document: toolResult({ data: extractData }, ["data"], taskBatch),
    extract_custom_document: toolResult({
      data: dataFields({ extraction_result: array }, ["extraction_result"])
    }, ["data"], meteredBatch),
    run_workflow: toolResult({ data: workflowData }, ["data"], { usage: workflowUsage, task: true }),
    route_document: toolResult({ data: classifyData }, ["data"], taskBatch),
    task: {
      ...toolResult({ data: openObject, action: { type: "string", enum: ["query", "cancel"] } }, ["data"], { usage: openObject, task: true }),
      allOf: [
        {
          if: matchesTaskKind("workflow"),
          then: { properties: { usage: workflowUsage } },
          else: { properties: { usage: documentUsage } }
        },
        {
          if: { required: ["action"], properties: { action: { const: "cancel" } } },
          then: { properties: { data: dataFields({
              task_id: text,
              status: { type: "string", enum: ["cancelled", "running", "succeeded", "failed"] },
              cancelled: { type: "boolean" }, already_cancelled: { type: "boolean" }
            }, ["task_id", "status", "cancelled", "already_cancelled"]) } },
          else: { allOf: Object.entries(taskData).map(([kind, data]) => ({
            if: matchesTaskKind(kind), then: { properties: { data } }
          })) }
        }
      ]
    },
    submit_user_feedback: toolResult({
      data: dataFields({ id: text, created_at: text }, ["id", "created_at"])
    }, ["data"])
  };

  function toolResult(payload: Record<string, Schema>, successRequired: string[], options: ResultOptions = {}): ObjectSchema {
    const statuses = options.task ? ["succeeded", "failed", "pending", "cancelled"] : ["succeeded", "failed"];
    const properties: Record<string, Schema> = {
      status: { type: "string", enum: statuses },
      ...payload,
      error,
      next_steps: nextSteps,
      ...(options.usage ? {
        usage_status: { type: "string", enum: ["available", "unavailable"] },
        usage: options.usage,
        recorded_credits: number
      } : {})
    };
    if (options.task) {
      Object.assign(properties, {
        task_ref: taskReference,
        wait_status: { type: "string", enum: ["timeout", "query_failed", "paused"] },
        query_error: error,
        message: text
      });
    }
    const variants = [
      statusVariant("succeeded", options.task ? [...successRequired, "task_ref"] : successRequired),
      statusVariant("failed", ["error"]),
      ...(options.task ? [
        statusVariant("pending", ["task_ref", "data", "next_steps"]),
        statusVariant("cancelled", ["task_ref", "data"])
      ] : [])
    ];
    const single: ObjectSchema = {
      type: "object", properties, required: ["status"], additionalProperties: false, oneOf: variants
    };
    if (!options.batch) return single;

    const batch: ObjectSchema = {
      type: "object",
      properties: {
        status: { type: "string", enum: [...statuses, "partial_success"] },
        files: {
          type: "array",
          minItems: 1,
          items: {
            ...single,
            properties: { ...properties, index: { type: "integer", minimum: 0 }, name: text },
            required: ["status", "index"]
          }
        },
        next_steps: nextSteps
      },
      required: ["status", "files"],
      additionalProperties: false
    };
    return {
      type: "object",
      properties: { ...properties, ...batch.properties },
      oneOf: [single, batch]
    };
  }
}

function usageSchema(categories: string[]): Schema {
  return {
    type: "object",
    properties: {
      num_pages: { type: "integer", minimum: 0 },
      credits_consumed: number,
      billing_breakdown: {
        type: "object", propertyNames: { enum: categories }, additionalProperties: number
      }
    },
    additionalProperties: true
  };
}

function matchesTaskKind(kind: string): Schema {
  return {
    required: ["task_ref"],
    properties: {
      task_ref: { type: "object", required: ["kind"], properties: { kind: { const: kind } } }
    }
  };
}

function dataFields(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: true };
}

function statusVariant(status: string, required: string[]): Schema {
  return { properties: { status: { const: status } }, required };
}
