# 来也 ADP MCP · Node.js

在支持 MCP stdio 的客户端处理本地或线上文档。可上传文件、解析全文、抽取字段、按文种分类和运行官方工作流。工具 `get_adp_guide` 会列出当前区域可用的预制应用和调用示例。

## 快速接入

需要 Node.js 20+。把下面的配置加入 MCP 客户端，用现有 API Key 替换占位值并连接。通过 `get_adp_guide({})` 确认区域和可用预制应用。

```json
{
  "mcpServers": {
    "laiye-adp": {
      "command": "npx",
      "args": ["-y", "--package=@laiye-adp/mcp@beta", "laiye-adp-mcp"],
      "env": {
        "ADP_API_KEY": "<your-existing-api-key>",
        "ADP_ACCEPT_LANGUAGE": "zh"
      }
    }
  }
}
```

如果已在同一台机器、同一系统账号下用 `adp config set` 保存凭据，从示例中移除 `ADP_API_KEY`，即可复用 CLI 保存的 Key、地址和租户。使用客户端的凭据管理功能保存实际 Key。 [获取中国区 Key](https://adp.laiye.com?from=getkey&utm_source=github) · [获取全球区 Key](https://adp-global.laiye.com?from=getkey&utm_source=github)

### 区域与连接

- 公有云仅配置 Key 时，优先复用 CLI 为同一个 Key 保存的公有云地址和租户。否则，默认租户 `laiye` 首次通过只读鉴权识别区域。先检查中国区，只有收到 `404 Accessor not found` 才检查全球区。成功后同一 MCP 进程复用该结果。识别过程无需查积分或提交业务任务。
- 可用 `ADP_REGION=cn` 或 `ADP_REGION=global` 直接选择官方区域，也可用 `ADP_API_BASE_URL` 指定服务根地址。专有部署同时设置 `ADP_TENANT_NAME`。未显式传 Key 时，连接配置须与保存的 CLI 配置匹配。
- `ADP_ACCEPT_LANGUAGE` 控制响应语言。地区识别失败时，引导会标明区域尚未确认。 [连通性与鉴权自检](https://adp-doc.laiye.com/api-reference/troubleshooting)

## 示例：上传、抽取、续查

以下参数依次传给 MCP 客户端里的对应工具。已有可访问的 HTTP(S) 文件链接时，可以直接从第二步开始。

1. 调用 `upload_temporary_file`。本地路径和 `file:///` 地址均可。

   ```json
   {"files":[{"file_path":"D:/Documents/invoice.pdf"}]}
   ```

2. 用上传响应的 `files[0].data.download_url` 调用 `extract_document`。下例使用两区都支持的海外发票国际通用高速版。其他文种的 `app_id` 用 `get_adp_guide` 查。

   ```json
   {
     "app_id": "ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2",
     "files": [{"url": "<download_url>"}],
     "wait": false
   }
   ```

3. 将对应文件的 `files[i].task_ref` 完整传给 `get_task`。使用 `next_steps` 中的续查参数也可以。

   ```json
   {"task_ref":{"kind":"extract","id":"<id-from-task_ref>"}}
   ```

### 其他常见任务

- **解析全文**用 `parse_document`，支持 `standard`、`advance`、`agentic_v2` 和 `thai_ocr`。`pages` 选填，省略或传 `[]` 时处理全部页面。
- **按指定字段抽取**用 `extract_custom_document`，传 `files` 和 `fields`。每个字段填唯一的 `name`，可加 `prompt`，同步返回结果。
- **识别混合文种**用 `route_document`，传入已有分类应用的 `app_id` 和 `files`。返回各文种片段和页码。 [分类应用说明](https://adp-doc.laiye.com/api-reference/adp-api/document-classification/overview)
- **运行官方工作流**用 `run_workflow`。将同一业务的材料放入一个 `files`，用 `template_key` 选择 `financial_report_extraction`、`finance_payable` 或 `expense_reimbursement`。用上传回执的 `download_url`、`file_name`、`content_type` 填写 `url`、`name`、`mime_type`。全球区可复用已有的对应发布应用，目前无法从这些模板新建应用。
- **提交反馈**用 `submit_user_feedback`。传 `feedback_type` 和 `content`。经用户明确授权后可附本地材料。

两区都支持通用文档解析、采购订单及三种海外发票和收据预制抽取。中国区另外提供国内通用票据和卡证。发票验真选项 `enable_invoice_verify` 适用于国内通用票据。

### 批量、状态和用量

- 上传、解析、抽取和分类每次支持 1–20 份文件，每次调用最多 3 个 OpenAPI 请求同时进行，包含适用的任务轮询。结果按输入顺序放在 `files[]`。逐项查看 `status`、`data`、`task_ref` 或 `error`。抽取成功后从对应结果的 `data.extraction_result` 读业务内容。
- 工作流一次接收 1–20 份材料并启动一次运行，从响应顶层取 `task_ref`。解析、预制抽取、分类和工作流默认在提交后最多等待 60 秒。可用 `wait_timeout_seconds` 调整，或用 `wait: false` 在提交后返回任务引用。
- 用量以服务端返回为准。`usage` 可包含页数 `num_pages`、已记录积分 `credits_consumed` 和分项 `billing_breakdown`。`usage_status: "unavailable"` 表示该次响应没有可用的积分金额。账号并发与请求速率由 ADP 单独限制。 [速率、并发与超时](https://adp-doc.laiye.com/api-reference/rate-limits) · [调用记录与遥测](https://adp-doc.laiye.com/api-reference/data-and-telemetry)

## 工具目录

<!-- tool-catalog:start -->

版本 `2.0.0-beta.2`，中国区共 **9** 个工具。全球区预制应用和参数以当前连接的工具定义及引导说明为准。

| 工具 | 必填参数 | 用途 |
| --- | --- | --- |
| `get_adp_guide` | 无 | 获取与当前 MCP 连接版本和区域对应的 ADP 引导说明。正文包含预制应用名称与 app_id 对照表、文件上传步骤、官方工作流说明和调用示例。 |
| `upload_temporary_file` | `files` | 将本机路径放入 files，每项填写 file_path，单文件也传一项。上传成功后从 files[].data 取 download_url。已有可访问的 HTTP(S) 文件地址时可直接用于业务工具。 |
| `parse_document` | `files` | 需要阅读、检索或处理文档全文时使用。将文件地址放入 files，返回逐页文本和文档结构。可用 recognize_mode 选择解析模式，或用 pages 指定要解析的原始页码。 |
| `extract_document` | `files`、`app_id` | 已知文种且预制字段满足需求时使用。从 get_adp_guide 选取预制 app_id，传入文件地址，获取票据、卡证、采购订单等文档的结构化业务字段。海外发票默认使用国际通用高速版。附带解析结果、多票拆分、发票验真、字段值翻译、原文定位和字段置信度均为选填开关。无需覆盖时省略对应参数，显式 false 会关闭适用功能。发票验真仅适用于国内通用票据。 |
| `extract_custom_document` | `files`、`fields` | 预制应用未覆盖文种或所需字段时使用。传入文件地址和本次要抽取的 fields，每个字段提供 name，可选 prompt。同步返回这些字段的结构化结果。 |
| `run_workflow` | `template_key`、`files` | 用 template_key 直接启动金融财报、财务应付或费用报销。将同一笔业务的材料放入同一个 files 数组。已上传的文件优先使用回执中的下载地址、文件名和类型。 |
| `route_document` | `files`、`app_id` | 文种未知或同一文件混有多种文档时使用。传入已有分类应用的 app_id 和文件地址，返回分类片段的文种、原始页码及未分类页。需要继续抽取时，按分类结果选择抽取工具。 |
| `get_task` | `task_ref` | 原样传入业务工具返回的 task_ref，查询原任务的状态、可用结果和用量。适用于 wait=false 提交后或等待超时后的续查。 |
| `submit_user_feedback` | `feedback_type`、`content` | 提交用户的使用问题（issue）或改进建议（suggestion）。传入去除凭证和无关敏感信息的事实摘要，成功返回反馈编号。可附上用户明确同意提交的本地材料。 |

<!-- tool-catalog:end -->

## 版本与源码运行

- `2.0.0-beta.2` 带来现有 Key 自动选区、中国区和全球区预制目录、批量文件参数和结果续查说明，以及 60 秒默认等待。
- 使用 `@laiye-adp/mcp@beta` 跟随 Beta，或指定 `@laiye-adp/mcp@2.0.0-beta.2` 固定版本。更新或回退后重新连接 MCP。
- 可沿用已有的 API Key。下方源码运行和上方调用示例均使用当前版本。
- 从源码运行时，在仓库根目录执行 `npm ci` 和 `npm run build`，再用 `node` 启动 `dist/index.js` 的绝对路径。运行 `npm test` 验证工具行为。更新工具定义后执行 `npm run catalog:generate`，再用 `npm run catalog:check` 校验工具表。

## English quick start

Use Node.js 20+ and the stdio configuration above. Set `ADP_ACCEPT_LANGUAGE` to `en` for English guidance. Use an existing Key, or remove `ADP_API_KEY` to inherit the CLI profile on the same machine and OS account.

For a public-cloud Key without a matching CLI profile, MCP checks China first with a read-only request and checks Global only after an exact `404 Accessor not found`. A confirmed region is reused for the current process. Set `ADP_REGION` or `ADP_API_BASE_URL` to choose a target directly. Call `get_adp_guide` with `{}` for your region's presets, workflows and examples.

Use `upload_temporary_file` for local files. Copy each returned `files[i].data.download_url` into the next tool's `files[i].url`. Read each file's own result or pass its `task_ref` to `get_task`. A workflow takes all its input files in one call and returns a top-level `task_ref`. Document tools accept 1–20 files per call and allow up to 3 in-flight requests, including applicable polling. The default automatic wait after submission is 60 seconds.

The `beta` tag tracks the preview. Pin `@laiye-adp/mcp@2.0.0-beta.2` for this release. From source, run `npm ci`, `npm run build` and `npm test`. [Connectivity and authentication](https://adp-doc.laiye.com/en/api-reference/troubleshooting) · [Rate limits, concurrency and timeouts](https://adp-doc.laiye.com/en/api-reference/rate-limits)
