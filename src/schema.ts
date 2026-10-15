import type { JsonSchema } from "./types.js";

const documentFileProperties = {
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
    description: "是否包含 OCR 中间结果",
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

export const overseasInvoiceInputSchema: JsonSchema = {
  type: "object",
  required: ["file"],
  properties: {
    ...documentFileProperties,
    enable_multi_ticket: {
      type: "boolean",
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
      description: "任务 ID"
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
    }
  },
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
      description: "是否包含 OCR 中间结果",
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
