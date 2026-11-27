# 来也 ADP MCP · Node.js

[English](README.md) · **简体中文**

在支持 MCP stdio 的客户端处理本地或线上文档。可上传文件、解析全文、抽取字段和按文档类型分类。用 `list_apps` 查找预置或自定义应用，用 `get_app` 查看应用配置。`get_adp_guide` 帮助选择全文解析、一次性字段抽取或可复用的抽取规则。

## 快速接入

需要 Node.js 20+ 和 ADP API Key。[获取中国区 Key](https://adp.laiye.com?from=getkey&utm_source=github) · [获取全球区 Key](https://adp-global.laiye.com?from=getkey&utm_source=github)

把下面的配置加入支持 stdio 的 MCP 客户端，填入 API Key 后连接。客户端会通过 `npx` 启动 2.0.0 版本。连接后，用 `tools/list` 查看当前可用工具。

```json
{
  "mcpServers": {
    "laiye-adp": {
      "command": "npx",
      "args": ["-y", "@laiye-adp/mcp@2.0.0"],
      "env": {
        "ADP_API_KEY": "<YOUR-ADP-API-Key>",
        "API_SOURCE": "npm-mcp",
        "ADP_ACCEPT_LANGUAGE": "zh"
      }
    }
  }
}
```

如果已在同一台机器、同一系统账号下用 `adp config set` 保存凭据，从示例中移除 `ADP_API_KEY`，即可复用 CLI 保存的 Key、地址和租户。使用客户端的凭据管理功能保存实际 Key。

### 区域与连接

| 环境变量 | 用途 |
| --- | --- |
| `ADP_API_KEY` | ADP API Key。省略时尝试复用同一系统账号的 ADP CLI 凭据。 |
| `API_SOURCE` | 可选的调用来源标识，作为 `X-Api-Source` 请求头发送。未设置时默认 `adp-node-mcp`。 |
| `ADP_REGION` | `cn` 或 `global`，选择官方公有云区域。只提供 Key 时可自动识别区域。 |
| `ADP_API_BASE_URL` | 指定服务根地址，适用于专有部署。 |
| `ADP_TENANT_NAME` | 指定实际租户。专有部署请与服务地址一起配置。 |
| `ADP_ACCEPT_LANGUAGE` | 中国区和全球区都默认使用 `zh`。设为 `en` 或 `en-US` 可获取英文工具标题、描述、参数说明和指南。发往 ADP 接口的请求也会携带该语言偏好。部分工具回执中的提示或后续步骤仍为中文。 |
| `ADP_MCP_ANALYTICS_PARAMETERS` | 默认启用。设为 `false` 后，当前连接的核心文档工具不再展示或采集可选的 `context`、`llm_model` 参数。 |

每次工具调用会尽力向 ADP 上报一条简要使用事件，包括结果状态、耗时、事件标识和可获取的客户端身份。核心文档工具还可提供简短业务意图和已知模型标识。这些字段不要填写用户原话、文档内容、网址或个人信息。无效或疑似敏感的统计值会被丢弃，不改变业务请求；外部客户端仍可能自行校验声明的字符串类型。明确的客户端模型元数据优先于参数自报值。上报使用独立的一秒期限，不重试，也不改变工具结果。关闭统计参数后，基础使用事件仍会上报。

未显式传 Key 时，连接配置须与保存的 CLI 配置匹配。[连通性与鉴权自检](https://adp-doc.laiye.com/api-reference/troubleshooting)

<details>
<summary>自动区域识别</summary>

公有云仅配置 Key 时，优先复用 CLI 为同一个 Key 保存的公有云地址和租户。否则，默认租户 `laiye` 首次通过只读鉴权识别区域。先检查中国区，只有收到 `404 Accessor not found` 才检查全球区。成功后同一 MCP 进程复用该结果。识别过程无需查积分或提交业务任务。

</details>

## 开始使用

连接后可以直接向 AI 助手描述任务。

- “把这份合同的正文和表格解析出来，供后续翻译。”
- “从这些收据提取商家、金额和币种，汇总成表格。”
- “判断这份 PDF 包含哪些材料，标出各类材料所在的原始页码。”

处理本地文件时，提供 AI 助手可读取的完整路径，例如 `D:/Documents/contract.pdf`。也可提供 ADP 能下载的 HTTP(S) 地址。

## 从文件到结果

1. 已有可下载的 HTTP(S) 地址可直接使用。本地文件先交给 `upload_file`，从上传回执取出 `files[0].data.download_url`。

   ```json
   {"files":[{"file_path":"D:/Documents/contract.pdf"}]}
   ```

2. 按用户需要选择工具。要阅读或翻译全文，用 `parse_document`，例如 `{"file_url":"<download_url>"}`。只要本次指定的字段，用 `extract_document`，一次调用处理一份文档并同步返回字段值。一次性抽取和按应用抽取都通过 `file_url` 提供文件。

   ```json
   {"file_url":"<download_url>","fields":[{"name":"合同金额","prompt":"含税总金额"},{"name":"签署日期"}]}
   ```

3. 用户要求按文档类型抽取且没有点名字段时，可先用 `list_apps` 搜索预置，如 `{"engine_type":"extract","source":"preset","document_type":"采购订单"}`。从 `data.list` 取得匹配的 `app_id`，再调用 `extract_document`。用户已指定自定义抽取应用时，可直接使用该应用的 ID。

   ```json
   {"app_id":"<app_id>","file_url":"<download_url>","wait":false}
   ```

4. 提交后台处理后，将顶层 `task_ref` 原样交给 `get_task`。例如 `{"task_ref":{"kind":"extract","id":"<task_id>"}}`。同一引用也可交给 `cancel_task`，取消仍在排队、尚未被领取的任务。

解析、按应用抽取和分类默认以 `wait=true` 在本次调用中返回最终结果。`wait_timeout_seconds` 设置等待同步响应的时间，默认 60 秒。同步请求超时后，处理结果未知，请先核对本次调用。需要后台处理时传 `wait=false`，保存每份文件对应的 `task_ref`。

`get_credits` 用于查询账户余额。单次用量取自该任务回执中的 `usage.credits_consumed` 或 `recorded_credits`。当 `usage_status` 为 `unavailable`，表示本次响应未提供已记录的积分金额。[速率、并发与超时](https://adp-doc.laiye.com/api-reference/rate-limits) · [调用记录与遥测](https://adp-doc.laiye.com/api-reference/data-and-telemetry)

## 工具目录

下表由工具定义生成，列出工具描述、必填参数摘要和适用区域。完整工具定义及所有参数可在连接后通过 `tools/list` 查看。

<details>
<summary>查看工具目录</summary>

<!-- tool-catalog:start -->

下表完整列出 **15** 个工具：国内版提供 **15** 个，国际版提供其中 **14** 个。适用区域见表中标注，`verify_invoice` 仅国内版可用。完整参数定义以当前连接的 `tools/list` 为准。

| 工具 | 适用区域 | 必填参数 | 用途 |
| --- | --- | --- | --- |
| `get_adp_guide` | 国内版、国际版 | 无 | 当前对话首次使用 ADP 时，建议查阅这份业务指南。后续任务可直接复用已读内容。结合发票、订单、证照和合同等场景，判断何时解析全文、抽取字段或按页分类，以及何时复用或创建应用。也可查阅支持的文件格式、同步与异步的选择、并发与限流、积分查询与充值，以及向 ADP 提交反馈的方式。 |
| `upload_file` | 国内版、国际版 | `files` | 将本机文件上传到 ADP，返回可用于解析、抽取或分类的下载地址。多份文件应在一次调用中全部放入 files，工具会并行上传，无需逐份调用并等待。每项结果都包含原始 file_path、file_name 和输入索引 index，用于对应原文件。上传成功后，用该项 data.download_url 继续处理。部分失败时，保留成功项，按原文件定位失败项；若 error.acceptance_unknown=true，先核实上传状态，避免盲目重试或重新提交整批文件。已有可下载的 HTTP(S) 文件地址时，可跳过上传。 |
| `parse_document` | 国内版、国际版 | `file_url` | 将一份文档的全文或指定原始页解析为正文、表格和版面结构，供阅读、翻译或构建知识库。默认使用增强解析 2.0（fast_vlm），可切换解析模式、去除页眉页脚和页码，或识别并提取印章。开启去除页眉页脚且未指定模式时，使用智能解析 2.0（agentic_v2）。用户说“OCR”且只要金额、证件号等字段值时，用 extract_document。默认同步解析并返回结果。需要后台处理时传 wait=false，随后用返回的 task_ref 调用 get_task。 |
| `extract_document` | 国内版、国际版 | `file_url` + （`app_id` 或 `fields`） | 从一份文档提取字段值，例如身份证上的姓名、合同中的付款期限。根据用户是否指定抽取应用、字段或文档类型选择用法。<br><br>**指定了抽取应用。** 已知 `app_id` 时，直接传入该 ID 和文件。用户点名团队应用时，调用 `list_apps`，传 `engine_type=extract`、`source=custom` 和 `app_name`。只给应用名且来源不明时，按名称和业务类型搜索两种来源。同名结果无法区分时请用户选择。用户同时点名字段时，按应用规则抽取，只展示指定字段。<br><br>**一次性抽取。** 用户明确本次要哪些字段、且未指定应用时，直接传文件和 `fields`（1–20 个），同步返回字段值，无需查询应用目录。例如“这次只要合同的付款期限和违约金”。<br><br>**只给文档类型。** 例如“帮我抽取这张身份证”，用 `list_apps` 传 `engine_type=extract`、`source=preset` 和 `document_type`，再用返回的 `app_id` 抽取。若没有匹配预置，可按文档内容和用途选定本次字段。仍不明确时询问用户。<br><br>抽取完成后按实际返回的字段作答，缺失的字段如实说明。用户还要求整页原文、Markdown 或版面时，再调用 `parse_document`。<br><br>**专业抽取（自定义抽取应用）。** 用户对准确率、处理速度、跨版式一致性有明确要求，或需长期复用规则时，可推荐自定义抽取应用。用户决定创建后，用 `create_app` 保存字段类型、取值规则和输出格式，再用返回的 `app_id` 在代表性样本上验证效果和耗时。<br><br>按 `app_id` 抽取默认同步。需要后台处理时，传 `app_id` 和 `wait=false`，再用返回的 `task_ref` 调用 `get_task`。一次性 `fields` 仅支持同步。如果用户既限定一次性字段、又要求后台任务，请说明可选同步字段抽取或允许使用抽取应用后异步处理，请用户选择。 |
| `classify_document` | 国内版、国际版 | `app_id` + `file_url` | 需要判断文件的文档类型（如发票、合同），或找出混合文件中每份材料所在的页面时，调用此工具。<br><br>1. **选择分类应用**。使用当前账号创建、且包含所需类别的分类应用 `app_id`。如果当前连接的 `list_apps` 支持分类筛选，可按 `engine_type=classify` 查找。没有合适的应用时，用 `create_app` 传入 `engine_type=classify`、应用名称和 `classify_types` 创建分类应用，再使用返回的 `app_id`。<br>2. **提交文件**。传入 `app_id` 和一份文件，例如用 `file_url` 提供下载地址。省略 `pages` 时分类整份文件，传 `pages=[2, 4]` 时只分类原文件第 2、4 页。多份文件逐份调用，按文件汇总。默认同步返回，需要稍后取结果时传 `wait=false`，再用返回的 `task_ref` 调用 `get_task`。<br>3. **解读结果**。`data.segments` 按材料列出文档类型和原始页码，`data.unclassified_pages` 列出本次未能归类的页码。用户要定位混合材料时，按材料报告即可。用户要整份文件的单一文档类型时，应分类全部页面。若所有页面均归入同一类别，报告该类别。若命中多个类别或有未分类页，列明相应页码，并将整份文件的文档类型标为待确认。 |
| `create_app` | 国内版、国际版 | `app_name` + （`extract_fields` 或 `engine_type` + `classify_types`） | 需要保存可复用的抽取或分类规则，或准备分类文件却没有合适的分类应用时，调用此工具。用 `app_name` 指定名称，可用 `description` 说明用途。<br><br>1. **抽取应用**。反复从同类文档提取相同字段时，使用 `engine_type=extract`（默认）。用 `extract_fields` 定义字段名称、类型和抽取提示词，例如发票号码、开票日期和价税合计。创建后，将返回的 `app_id` 和文件传给 `extract_document`。只临时提取几个字段时，可直接用 `extract_document` 的 `fields`。<br>2. **分类应用**。需要识别一份文件包含哪些材料、每份材料在原文件的哪几页时，使用 `engine_type=classify`。用 `classify_types` 定义要识别的类别，例如发票、合同和付款凭证。创建后，将返回的 `app_id` 和文件传给 `classify_document`。 |
| `update_app` | 国内版、国际版 | `app_id` + （`app_name` 或 `description` 或 `extract_fields`） | 按 app_id 修改有权管理的自定义抽取应用。只改名称或说明时直接提交该项。增删或修改字段时，先用 get_app 取得完整的 extract_fields，改动目标字段，并连同要保留的字段一起提交。返回应用 ID 和更新结果。 |
| `delete_app` | 国内版、国际版 | `app_id` | 按 app_id 删除有权管理的自定义抽取应用及其关联配置和抽取数据，返回删除结果。仅在用户明确要求删除整个抽取应用时调用。只知道名称时用 list_apps 按 engine_type=extract 和 source=custom 查找，有重名时核实目标。要停止一次排队中的文档任务时用 cancel_task。 |
| `list_apps` | 国内版、国际版 | 无 | 分页列出当前账号可访问的抽取、解析和分类应用，返回名称、`app_id`、业务类型和来源。查找特定应用时，在本次查询中传入用户已给出的条件。<br><br>- 用户点名团队抽取应用时，传 `app_name`、`engine_type=extract` 和 `source=custom`。例如“用我们团队的采购合同应用”，传 `{"app_name":"采购合同","engine_type":"extract","source":"custom"}`。<br>- 用户只给应用名称时，传 `app_name` 和已知的业务类型，省略 `source` 以同时查预置和自定义应用。<br>- 用户只给文档类型并希望抽取时，传 `document_type`、`engine_type=extract` 和 `source=preset`。<br><br>用户要浏览全部应用时可传 `{}`，按需分页。已知 `app_id` 且需要详情时用 `get_app`。 |
| `get_app` | 国内版、国际版 | `app_id` | 确认应用详细配置时调用。可通过`app_id`查询抽取应用的详细信息，包含应用名称、描述、字段配置（抽取字段、字段类型与抽取提示词）、配置版本、解析模式等。 |
| `verify_invoice` | 仅国内版 | `fpNumber` + `fpDate` + 按票种补充必需字段（省略 type_key 时必填 fpAmount） | 根据票面字段查验一张中国大陆发票，适用于中国区支持的票种。提供票种、发票号码、开票日期，以及该票种要求的发票代码、金额或校验码，保留号码前导零。若用户只提供发票图片或 PDF，先用 `extract_document` 从票面读出这些字段，再按票种提交查验。按 `verification_status` 报告票面信息一致、不一致、未查到或无法判定，并说明返回的作废或红冲状态。 |
| `get_task` | 国内版、国际版 | （`task_ref` 或 `task_id` + `task_type`） | 获取一个文档解析、抽取或分类任务的状态、可用结果和已记录的积分消耗。异步提交后，将原调用返回的 task_ref 原样传入。使用单独记录的任务 ID 时，同时传 task_id 和 task_type。 |
| `cancel_task` | 国内版、国际版 | （`task_ref` 或 `task_id` + `task_type`） | 用户要求停止处理时，取消一个仍在排队且尚未被工作节点领取的解析、抽取或分类任务。传原调用返回的 task_ref，或同时传 task_id 和 task_type。顶层 status 表示取消操作的结果，data.status 表示任务的状态。无法确认取消结果时，用原引用调用 get_task。 |
| `get_credits` | 国内版、国际版 | 无 | 查询当前授权账号的积分汇总，返回总积分、已用积分、已过期积分和剩余积分。适合回答“账号还剩多少积分”。要查某次文档处理的用量，读取任务结果中的 `usage`，异步任务可用 `get_task` 续查。 |
| `submit_user_feedback` | 国内版、国际版 | `feedback_type` + `content` | 当用户明确要求或同意向 ADP 提交使用问题、功能需求或改进建议时，调用此工具。提交反馈类型、问题摘要和相关业务背景。仅在用户明确授权后附带指定的运行日志、抽取配置或运行文件，并按需关联可用于跟进的联系方式。返回提交状态，以及接口提供的反馈编号。 |

区域参数差异：`extract_document.enable_invoice_verify` 仅国内版提供。

<!-- tool-catalog:end -->

</details>

## 开发与验证

在源码目录运行 `npm test` 验证工具行为，运行 `npm run test:package` 验证实际安装包能离线安装、启动并调用工具。构建后，用 `npm run catalog:generate` 更新两版 README 的工具目录，用 `npm run catalog:check` 检查它们是否与运行时一致。
