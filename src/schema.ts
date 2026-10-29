import type { JsonSchema } from "./types.js";
import { workflowTemplateIds, workflowTemplateKeys } from "./workflow-templates.js";
import { extractModelParamsSchema, resultSwitchProperties } from "./v119-operations.js";

const documentFileProperties = {
  file: {
    type: "string",
    description: "文件 URL 或 Base64 编码"
  },
  file_name: {
    type: "string",
    description: "文件名（可选，含扩展名）"
  },
  model_params: extractModelParamsSchema,
  with_rec_result: {
    type: "boolean",
    description: "是否返回文档解析结果；高速自定义抽取不返回解析结果",
    default: true
  },
  wait: {
    type: "boolean",
    description: "是否同步等待结果，默认 true",
    default: true
  },
  timeout_seconds: {
    type: "integer",
    description: "同步等待超时秒数，默认 300",
    default: 300
  },
  accept_language: {
    type: "string",
    enum: ["zh", "en"],
    description: "返回语言和接口区域。默认 zh，访问 https://adp.laiye.com；传 en 时访问 https://adp-global.laiye.com。",
    default: "zh"
  }
};

export const fileInputSchema: JsonSchema = {
  type: "object",
  required: ["file"],
  properties: documentFileProperties,
  additionalProperties: false
};

export const extractInputSchema: JsonSchema = {
  ...fileInputSchema,
  properties: { ...documentFileProperties, card_type: { type: "string", description: "仅适用于支持卡证类型选择的抽取应用。" } }
};

export const overseasInvoiceInputSchema: JsonSchema = {
  type: "object",
  required: ["file"],
  properties: {
    ...documentFileProperties,
    enable_multi_ticket: {
      type: ["boolean", "null"],
      description: "是否将同一文件中的多张票据拆分为独立结果。仅国际高速版和东南亚高速版生效；默认 true，仅影响本次调用，不修改应用配置。",
      default: true
    },
    enable_field_value_translation: {
      type: ["boolean", "null"],
      description: "是否仅为本次调用开启字段值翻译。不传或 null 时使用应用已保存配置，不修改应用配置。目标语言由 accept_language 参数或 ADP_ACCEPT_LANGUAGE 环境变量决定。"
    }
  },
  additionalProperties: false
};

export const fastInvoiceInputSchema: JsonSchema = {
  ...overseasInvoiceInputSchema,
  properties: { ...(overseasInvoiceInputSchema.properties as Record<string, unknown>), ...resultSwitchProperties }
};

export const chinaInvoiceInputSchema: JsonSchema = {
  type: "object",
  required: ["file"],
  properties: {
    ...documentFileProperties,
    enable_invoice_verify: {
      type: ["boolean", "null"],
      description: "是否为本次国内通用票据抽取开启发票验真。true 开启、false 关闭；不传或 null 使用应用已保存配置，不修改应用配置。"
    }
  },
  additionalProperties: false
};

export const taskInputSchema: JsonSchema = {
  type: "object",
  required: ["task_id"],
  properties: {
    task_id: {
      type: "string",
      minLength: 1,
      description: "同类型异步任务 ID：parse_document 用 query_parse_task；票据/卡证/execute_custom_extract_app 用 query_extract_task；classify_document 用 query_classify_task；extract_routed_document 用 query_routed_task。"
    },
    accept_language: {
      type: "string",
      enum: ["zh", "en"],
      description: "返回语言和接口区域。默认 zh，访问 https://adp.laiye.com；传 en 时访问 https://adp-global.laiye.com。",
      default: "zh"
    }
  },
  additionalProperties: false
};

export const emptyInputSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};

export const uploadTemporaryFileInputSchema: JsonSchema = {
  type: "object",
  required: ["chunk"],
  properties: {
    chunk: {
      type: "string",
      description: "上传的文件。本地文件路径、file:// 地址或 Base64 编码"
    },
    application_id: {
      type: "string",
      minLength: 1,
      description: "创建响应中的账号工作流应用 ID，不接受模板固定 ID；直接运行模板时使用 user 范围上传并省略 application_id。"
    },
    sharing_scope: {
      type: "string",
      enum: ["user", "application"],
      description: "已创建的工作流应用使用 application 并提供账号 application_id；直接运行模板前使用 user 并省略 application_id，让当前用户创建或复用的应用访问文件。"
    },
    accept_language: documentFileProperties.accept_language,
    timeout_seconds: { type: "integer", minimum: 1, maximum: 900, default: 300 }
  },
  allOf: [
    {
      if: { properties: { sharing_scope: { const: "application" } }, required: ["sharing_scope"] },
      then: { required: ["application_id"] }
    }
  ],
  additionalProperties: false
};

export const uploadTemporaryFileOutputSchema: JsonSchema = {
  type: "object",
  required: ["code", "message", "data"],
  properties: {
    code: {
      type: "string",
      description: "业务状态码，成功时为 success"
    },
    message: {
      type: "string",
      description: "返回信息"
    },
    tips: {
      type: ["string", "null"],
      description: "补充提示信息"
    },
    data: {
      type: "object",
      required: ["id", "file_name", "file_size", "content_type", "download_url"],
      properties: {
        id: {
          type: "string",
          description: "文件 ID"
        },
        file_name: {
          type: "string",
          description: "文件名"
        },
        file_size: {
          type: "integer",
          description: "文件大小，单位字节"
        },
        content_type: {
          type: "string",
          description: "文件 MIME 类型"
        },
        download_url: {
          type: "string",
          description: "文件下载 URL，可直接传给解析/抽取工具的 file 参数"
        },
        status: {
          type: "string",
          description: "文件状态"
        }
      },
      additionalProperties: true
    }
  },
  additionalProperties: true
};

export const customExtractInputSchema: JsonSchema = {
  type: "object",
  required: ["app_id", "file"],
  properties: {
    model_params: extractModelParamsSchema,
    ...resultSwitchProperties,
    enable_multi_ticket: { type: ["boolean", "null"], description: "仅对支持多票处理的应用生效；省略/null 沿用接口默认行为。" },
    card_type: { type: "string", description: "仅对支持卡证类型选择的应用生效。" },
    app_id: {
      type: "string",
      description: "自定义抽取应用 ID"
    },
    file: {
      type: "string",
      description: "文件 URL 或 Base64 编码"
    },
    file_name: {
      type: "string",
      description: "文件名（可选，含扩展名）"
    },
    with_rec_result: {
      type: "boolean",
      description: "是否返回文档解析结果；高速自定义抽取不返回解析结果",
      default: true
    },
    wait: {
      type: "boolean",
      description: "是否同步等待结果，默认 true",
      default: true
    },
    timeout_seconds: {
      type: "integer",
      description: "同步等待超时秒数，默认 300",
      default: 300
    },
    accept_language: {
      type: "string",
      enum: ["zh", "en"],
      description: "返回语言和接口区域。默认 zh，访问 https://adp.laiye.com；传 en 时访问 https://adp-global.laiye.com。",
      default: "zh"
    }
  },
  additionalProperties: false
};

const workflowClientProperties = {
  accept_language: documentFileProperties.accept_language,
  timeout_seconds: { type: "integer", minimum: 1, maximum: 900, default: 300 }
};

export const workflowTemplateListInputSchema: JsonSchema = {
  type: "object",
  properties: {
    search: { type: "string", description: "模板名称搜索词。" },
    offset: { type: "integer", minimum: 0, default: 0 },
    size: { type: "integer", minimum: 1, maximum: 100, default: 100 },
    ...workflowClientProperties
  },
  additionalProperties: false
};

export const createWorkflowApplicationInputSchema: JsonSchema = {
  type: "object",
  required: ["template_key"],
  properties: {
    template_key: { type: "string", enum: workflowTemplateKeys, description: "官方业务工作流模板键。" },
    ...workflowClientProperties
  },
  additionalProperties: false
};

export const createWorkflowApplicationOutputSchema: JsonSchema = {
  type: "object",
  required: ["code", "data"],
  properties: {
    code: { const: "success" },
    data: {
      type: "object",
      required: ["template_key", "template_version", "application_id", "application_name", "release_version_id", "application_status", "can_run"],
      properties: {
        template_key: { type: "string", enum: workflowTemplateKeys },
        template_version: { type: "string", minLength: 1 },
        application_id: { type: "string", minLength: 1 },
        application_name: { type: "string", minLength: 1 },
        release_version_id: { type: "string", minLength: 1 },
        application_status: { const: "published" },
        can_run: { const: true }
      },
      additionalProperties: false
    }
  },
  additionalProperties: true
};

export const workflowRunInputSchema: JsonSchema = {
  type: "object",
  oneOf: [{ required: ["application_id"] }, { required: ["template_key"] }],
  properties: {
    application_id: {
      type: "string", minLength: 1,
      anyOf: [{ enum: workflowTemplateIds }, { pattern: "^(?!wftp_app_)\\S+$" }],
      description: "已发布账号应用 ID（推荐先从模板创建）；也支持三个官方模板的固定 ID 作为直接运行备选。与 template_key 二选一。"
    },
    template_key: {
      type: "string", enum: workflowTemplateKeys,
      description: "备选：直接运行官方模板，没有对应可运行应用时自动创建并发布，已有时复用。与 application_id 二选一，不能指定 release_version_id。"
    },
    release_version_id: { type: "string", minLength: 1, description: "账号应用可选的已发布版本 ID，不能自行推测；直接运行模板时不可传。" },
    session_id: { type: "string", minLength: 1 },
    inputs: { type: "object", additionalProperties: true, description: "按工作流配置和用户实际输入提供，不猜测字段。" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["url", "name", "mime_type"],
        properties: {
          url: { type: "string", pattern: "^https?://", description: "上传返回的 download_url 或可访问的文件 URL。" },
          name: { type: "string", minLength: 1 },
          mime_type: { type: "string", minLength: 1 },
          size: { type: "integer", minimum: 0 },
          metadata: { type: "object", additionalProperties: true }
        },
        additionalProperties: false
      }
    },
    wait: { type: "boolean", default: true, description: "默认同步；只有用户明确要求异步时传 false。" },
    ...workflowClientProperties
  },
  allOf: [{
    if: { anyOf: [
      { required: ["template_key"] },
      { properties: { application_id: { enum: workflowTemplateIds } }, required: ["application_id"] }
    ] },
    then: { not: { required: ["release_version_id"] } }
  }],
  additionalProperties: false
};

export const workflowQueryInputSchema: JsonSchema = {
  type: "object",
  required: ["run_id"],
  properties: {
    run_id: {
      type: "string",
      minLength: 1,
      pattern: "^(?!\\.{1,2}$)[^/\\\\?#%\\u0000-\\u001F\\u007F]+$",
      description: "工作流运行返回的 run_id，不是文档 task_id。"
    },
    ...workflowClientProperties
  },
  additionalProperties: false
};

export const workflowRunOutputSchema: JsonSchema = {
  type: "object",
  required: ["code", "data"],
  properties: {
    code: { const: "success" },
    data: {
      type: "object",
      required: ["run_id", "status"],
      properties: {
        run_id: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["pending", "running", "paused", "succeeded", "failed", "cancelled", "timeout"] }
      },
      additionalProperties: true
    }
  },
  additionalProperties: true
};
