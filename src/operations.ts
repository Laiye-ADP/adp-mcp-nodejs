import type { Operation } from "./types.js";
import {
  customExtractInputSchema,
  emptyInputSchema,
  fileInputSchema,
  taskInputSchema,
  uploadTemporaryFileInputSchema
} from "./schema.js";

interface PresetTool {
  name: string;
  title: string;
  description: string;
  appId: string;
  labels: string[];
  mode: "extract" | "recognize";
}

const presetTools: PresetTool[] = [
  {
    name: "extract_china_invoice",
    title: "中国票据",
    description:
      "覆盖中国地区 30+ 种常见票据：支持全电发票、普通发票、专用发票、出租车票、火车票、飞机行程单、财政发票等财务场景常见票据。可从票据中提取发票号码、开票日期、金额、购买方、销售方等关键信息，以及支持判断发票真假。",
    appId: "ootb_v9x2y5z8a1b4c7d0e3f6h9j1k4m7",
    labels: ["国内通用多票据", "多票据识别", "财务报销", "全票种识别", "发票组件", "发票验真"],
    mode: "extract"
  },
  {
    name: "extract_vehicle_cert",
    title: "车辆合格证",
    description:
      "从机动车整车出厂合格证图片中提取关键字段（合格证编号、车辆品牌、型号、车辆识别代号 VIN、发动机号、制造日期等）。适用于车辆上户、二手车交易、车辆资产管理等场景。",
    appId: "ootb_d9m2p5q8r1t4v7w0x3y6z9a2b5c",
    labels: ["车辆合格证", "车辆凭证", "车辆管理", "证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_account_permit",
    title: "开户许可证",
    description:
      "从企业开户许可证图片中提取关键字段（企业名称、基本账户账号、开户银行、核准号、发证日期等）。适用于对公收款账户校验、企业财务审核、应付账款收款方信息核对等场景。",
    appId: "ootb_e5k8n1p4q7r0t3v6w9x2y5z8a1b",
    labels: ["开户许可证", "银行凭证", "企业开户", "金融证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_driver_license",
    title: "驾驶证",
    description:
      "从中国机动车驾驶证图片中提取关键字段（姓名、性别、国籍、出生日期、驾驶证号、准驾车型、初次领证日期、有效期等），支持正副页识别。适用于驾驶员资质核验、网约车/货运司机准入审核等场景。",
    appId: "ootb_f2m5n8p1q4r7t0v3w6x9y2z5a8b",
    labels: ["驾驶证", "机动车驾照", "交通管理", "证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_business_license",
    title: "营业执照",
    description:
      "从中国企业营业执照图片中提取关键字段（企业名称、统一社会信用代码、法定代表人、注册资本、成立日期、经营范围、注册地址等）。适用于企业开户、商户入驻、供应商资质审核、企业实名认证等场景。",
    appId: "ootb_g8k2n5p1q4r7t0v3w6x9y2z5a8b",
    labels: ["营业执照", "企业资质", "工商凭证", "商业证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_passport_cn",
    title: "护照-中国",
    description:
      "从中华人民共和国护照图片中提取关键字段（中文姓名、姓名拼音、性别、出生日期、护照号、国籍、签发日期、有效期、签发机关等）。适用于出境业务、跨境身份核验、签证办理等场景；外国护照不在支持范围内。",
    appId: "ootb_h5m8n1p4q7r0t3v6w9x2y5z8a1b4",
    labels: ["护照-中国", "旅行凭证", "出入境证件", "个人证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_vehicle_license",
    title: "行驶证",
    description:
      "从中国机动车行驶证图片中提取关键字段（车牌号、车辆类型、所有人、车辆识别代号 VIN、发动机号、注册日期、发证日期等），支持正副页识别。适用于车辆登记、保险投保、网约车/货运车辆准入等场景。",
    appId: "ootb_j2k5n8p1q4r7t0v3w6x9y2z5a8b1",
    labels: ["行驶证", "机动车行驶证", "交通管理", "证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_org_code_cert",
    title: "组织机构代码证",
    description:
      "从组织机构代码证图片中提取关键字段（机构名称、组织机构代码、法定代表人、地址、发证日期、有效期等）。适用于历史档案数字化、存量企业资质核验等场景；新办企业建议使用营业执照工具，组织机构代码已并入统一社会信用代码。",
    appId: "ootb_k8m2n5p1q4r7t0v3w6x9y2z5a8b4",
    labels: ["组织机构代码证", "商业证件", "证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_id_card",
    title: "身份证",
    description:
      "从中国大陆居民身份证图片中提取关键字段（姓名、性别、民族、出生日期、身份证号、住址、签发机关、有效期等），支持正反面识别。适用于实名认证、用户注册等场景；港澳台、护照等其他证件请使用对应工具。",
    appId: "ootb_b7k2m5n8p1q4r7t0v3w6x9y2z5",
    labels: ["身份证", "大陆居民身份证", "身份凭证", "个人证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_household_book",
    title: "户口本",
    description:
      "从中国居民户口本图片中提取关键字段（户号、户别、住址、家庭成员列表，含成员姓名、身份证号、与户主关系等），支持首页与个人页两种页面类型。适用于户籍核验、亲属关系认证、社保业务等场景。",
    appId: "ootb_l5k8n1p4q7r0t3v6w9x2y5z8a1b7",
    labels: ["户口本", "户籍凭证", "人口管理", "家庭证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_bank_card",
    title: "银行卡",
    description:
      "从银行卡正面图片中提取关键字段（卡号、所属银行、卡种类型、有效期等）。适用于绑卡、收款账户录入、支付渠道配置等场景。注意：仅识别卡面公开信息，不涉及 CVV 等敏感字段。",
    appId: "ootb_c2h5k8n1p4q7r0t3v6w9x2y5z8",
    labels: ["银行卡", "银行服务", "支付工具", "个人证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_hk_macao_permit",
    title: "港澳通行证",
    description:
      "从港澳通行证（往来港澳通行证）图片中提取关键字段（姓名、性别、出生日期、证件号、签发日期、有效期、签发机关等）。适用于出入境业务、酒店登记、票务实名等场景。",
    appId: "ootb_n2m5n8p1q4r7t0v3w6x9y2z5a8b1c",
    labels: ["港澳通行证", "旅行凭证", "出入境证件", "个人证件", "信息提取"],
    mode: "extract"
  },
  {
    name: "extract_purchase_order",
    title: "订单",
    description:
      "从 PDF 或图片格式的采购订单、销售订单中提取关键字段（订单号、买卖双方信息、下单日期、商品明细、数量、单价、总金额、收货地址等）。适用于电商订单录入、供应链对账、出入库管理自动化等场景。",
    appId: "ootb_m9n2p5q8r1t4v7w0x3y6z9a2b5",
    labels: ["订单", "电商物流", "出入库管理", "信息提取"],
    mode: "extract"
  },
  {
    name: "parse_document",
    title: "通用文档解析",
    description:
      "对 PDF、图片、Word、Excel、PPT 等文档进行版面解析，返回结构化的文本块、表格、阅读顺序与页面坐标。适用于不确定文档类型、需要先获取原始结构再做后续处理的场景；如已确认是发票、证件等特定类型，请优先使用对应的专用提取工具。",
    appId: "ootb_k7m2x9p4v1n8w3q6r5t0y2b4",
    labels: ["文档解析", "图片提取", "OCR", "结构化解析", "批量解析"],
    mode: "recognize"
  },
  {
    name: "extract_global_invoice",
    title: "海外发票/收据",
    description:
      "从 PDF 或图片格式的海外发票、收据、票据中提取关键字段（发票号、开票日期、金额、税额、币种、明细行等）。适用于跨境贸易、报销、应付账款自动化等场景；中国大陆增值税发票请使用专门的国内发票工具。",
    appId: "ootb_a3f8h1j5k9n2p7q4w6x0y3b5c8d1",
    labels: ["发票", "收据"],
    mode: "extract"
  },
  {
    name: "extract_global_invoice_fast",
    title: "海外发票/收据（高速模式）",
    description:
      "从 PDF 或图片格式的海外发票、收据中高速提取关键字段（发票号、开票日期、金额、税额、币种、明细行等）。跳过 OCR 阶段，直接使用 VLM 提取，速度更快；适用于对延迟敏感的批量处理场景；中国大陆增值税发票请使用国内票据工具。",
    appId: "ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2",
    labels: ["发票", "收据", "全球发票", "高准确度", "高速抽取"],
    mode: "extract"
  },
  {
    name: "extract_sea_invoice_fast",
    title: "海外发票/收据（高速模式-东南亚版）",
    description:
      "从 PDF 或图片格式的东南亚地区发票、收据中高速提取关键字段，支持 WHT（预扣税）等东南亚特有字段。跳过 OCR 阶段，直接使用 VLM 提取；适用于泰国、越南、印尼等东南亚国家的发票处理场景。",
    appId: "ootb_u2v5w8x1y4z7a0b3c6d9e2f5g8",
    labels: ["发票", "收据", "票据", "东南亚发票", "高准确度", "高速抽取"],
    mode: "extract"
  }
];

function createPresetOperation(preset: PresetTool): Operation {
  const isRecognize = preset.mode === "recognize";

  return {
    name: preset.name,
    title: preset.title,
    operationId: preset.name,
    description: preset.description,
    method: "POST",
    path: isRecognize
      ? "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/recognize"
      : "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract",
    asyncPath: isRecognize
      ? "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/recognize/create/task"
      : "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract/create/task",
    auth: "adp",
    bodyMode: "json",
    inputSchema: fileInputSchema,
    annotations: {
      title: preset.title,
      readOnlyHint: false,
      app_id: preset.appId,
      labels: preset.labels
    },
    metadata: {
      app_id: preset.appId,
      labels: preset.labels
    },
    appId: preset.appId,
    mode: preset.mode,
    usesTenant: true,
    usesAcceptLanguage: true
  };
}

export const operations: Operation[] = [
  ...presetTools.map(createPresetOperation),
  {
    name: "upload_temporary_file",
    title: "上传临时文件",
    operationId: "uploadTemporaryFile",
    description:
      "上传临时文件并返回 file_url。返回的 data.file_url 可以直接作为解析、抽取工具的 file 入参。文件固定按临时策略过期。",
    method: "POST",
    path: "/open/agentic_doc_processor/{tenant_name}/files/upload",
    auth: "adp",
    bodyMode: "multipart",
    inputSchema: uploadTemporaryFileInputSchema,
    annotations: {
      readOnlyHint: false
    },
    usesTenant: true
  },
  {
    name: "list_custom_extract_apps",
    title: "列出自定义抽取应用",
    operationId: "listCustomExtractApps",
    description:
      "列出当前用户创建的所有自定义文档抽取应用，返回每个应用的 ID、名称、描述、标签和输出字段定义。可用于查找 execute_custom_extract_app 所需的 app_id。",
    method: "GET",
    path: "/open/agentic_doc_processor/laiye/v1/app-list?app_type=0",
    auth: "adp",
    bodyMode: "none",
    inputSchema: emptyInputSchema,
    annotations: {
      readOnlyHint: true
    }
  },
  {
    name: "execute_custom_extract_app",
    title: "执行自定义抽取应用",
    operationId: "executeCustomExtractApp",
    description: "使用指定的自定义文档抽取应用处理文件。需先通过 list_custom_extract_apps 获取可用的 app_id。",
    method: "POST",
    path: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract",
    asyncPath: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract/create/task",
    auth: "adp",
    bodyMode: "json",
    inputSchema: customExtractInputSchema,
    annotations: {
      readOnlyHint: false
    },
    appIdField: "app_id",
    mode: "extract",
    usesTenant: true,
    usesAcceptLanguage: true
  },
  {
    name: "query_task",
    title: "查询任务状态",
    operationId: "queryTask",
    description: "查询文档处理任务的当前状态",
    method: "GET",
    path: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract/query/task/{task_id}",
    fallbackPath: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/recognize/query/task/{task_id}",
    auth: "adp",
    bodyMode: "none",
    inputSchema: taskInputSchema,
    annotations: {
      readOnlyHint: true
    },
    usesTenant: true,
    usesAcceptLanguage: true,
    pathParams: ["task_id"]
  },
  {
    name: "get_result",
    title: "获取任务结果",
    operationId: "getResult",
    description: "获取已完成的文档处理任务的完整结果",
    method: "GET",
    path: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/extract/query/task/{task_id}",
    fallbackPath: "/open/agentic_doc_processor/{tenant_name}/v1/app/doc/recognize/query/task/{task_id}",
    auth: "adp",
    bodyMode: "none",
    inputSchema: taskInputSchema,
    annotations: {
      readOnlyHint: true
    },
    usesTenant: true,
    usesAcceptLanguage: true,
    pathParams: ["task_id"]
  }
];
