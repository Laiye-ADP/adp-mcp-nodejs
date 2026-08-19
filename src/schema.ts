import type { JsonSchema } from "./types.js";

export const fileInputSchema: JsonSchema = {
  type: "object",
  required: ["file"],
  properties: {
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
    },
    ref_id: {
      type: "string",
      description: "可选引用 ID",
      default: ""
    }
  },
  additionalProperties: false
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
