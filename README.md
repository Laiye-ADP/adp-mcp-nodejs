# Laiye ADP MCP for Node.js

**English** · [简体中文](README_CN.md)

Process local or online documents from an MCP client that supports stdio. Use ADP to parse full text and tables, extract specific fields, or classify the pages of a document. Use `list_apps` to find a preset or custom app and `get_app` to inspect its configuration. The `get_adp_guide` tool helps you choose between full-text parsing, one-off extraction, and reusable extraction rules.

## Quick start

You need Node.js 20 or later and an ADP API key for your account’s region. [Get a key for China](https://adp.laiye.com?from=getkey&utm_source=github) · [Get a key for Global](https://adp-global.laiye.com?from=getkey&utm_source=github)

From the v2 source directory, build the local entry point:

```sh
npm ci
npm run build
```

Add the following configuration to your stdio-compatible MCP client. Replace the path in `args` with the absolute path to the generated `dist/index.js`, enter your API key, and connect. Call `tools/list` to see the tools available on that connection.

```json
{
  "mcpServers": {
    "laiye-adp": {
      "command": "node",
      "args": ["/absolute/path/to/laiye-adp-mcp-nodejs-v2/dist/index.js"],
      "env": {
        "ADP_API_KEY": "<your-existing-api-key>",
        "ADP_ACCEPT_LANGUAGE": "en"
      }
    }
  }
}
```

If you already have a v2 `.tgz` package, you can skip the build. Set `command` to `npx` and `args` to `["-y", "--package=/absolute/path/to/package.tgz", "laiye-adp-mcp"]`, substituting the path to your package.

If you saved credentials with `adp config set` on the same machine under the same OS account, omit `ADP_API_KEY` to reuse the CLI’s key, service URL, and tenant. Otherwise, store your key in your MCP client’s credential manager.

### Region and connection settings

| Environment variable | Purpose |
| --- | --- |
| `ADP_API_KEY` | ADP API key. If omitted, the server looks for ADP CLI credentials saved under the same OS account. |
| `ADP_REGION` | Set to `cn` or `global` to select an official cloud region. The server can detect the region when given only a key. |
| `ADP_API_BASE_URL` | Service root URL for a private deployment. |
| `ADP_TENANT_NAME` | Tenant name. For a private deployment, configure it together with the service URL. |
| `ADP_ACCEPT_LANGUAGE` | Defaults to `zh` in both regions. Set to `en` or `en-US` for English tool titles, descriptions, parameter help, and guides. ADP API requests also carry this language preference. Some tool results still include Chinese messages or next steps. |
| `ADP_MCP_ANALYTICS_PARAMETERS` | Enabled by default. Set to `false` to hide and stop collecting the optional `context` and `llm_model` parameters on the core document tools available on this connection. |

Each tool call attempts to report a small usage event to ADP with its outcome, duration, event ID, and client identity when available. Core document tools can also include a brief business intent and a known model identifier. Do not supply user quotations, document contents, URLs, or personal information in these fields. Invalid or sensitive analytics values are discarded without changing the business request; external clients may still validate their advertised string types. Model metadata from a recognized client field takes precedence over the self-reported parameter. Reporting has its own one-second deadline, is not retried, and never changes the tool result. Turning off analytics parameters leaves these basic usage events enabled.

When using saved CLI credentials, the connection settings must match the saved configuration. [Connectivity and authentication](https://adp-doc.laiye.com/en/api-reference/troubleshooting)

<details>
<summary>How cloud region detection works</summary>

When given only a key, the server first tries the cloud address and tenant saved by the CLI for that key. Otherwise, for the default tenant (`laiye`), it makes a read-only authentication request to the China region. It checks Global only if China returns `404 Accessor not found`. The MCP process reuses a successful result for later calls. Region detection does not query the credit balance or submit document tasks.

</details>

## Try it

Once connected, describe a task to your assistant:

- “Parse the text and tables in this contract so I can translate it.”
- “Extract the vendor, amount, and currency from these receipts and summarize them in a table.”
- “Identify the documents in this PDF and tell me which original pages belong to each one.”

For a local file, give the assistant an absolute path it can read, such as `D:/Documents/contract.pdf`. You can also supply an HTTP(S) URL that ADP can download.

## From file to result

1. If you have a downloadable URL, use it directly. For a local file, call `upload_file` and take `files[0].data.download_url` from the response.

   ```json
   {"files":[{"file_path":"D:/Documents/contract.pdf"}]}
   ```

2. Choose the tool for the result you need. For full text to read or translate, call `parse_document` with `{"file_url":"<download_url>"}`. For specific fields on this run, pass `fields` to `extract_document`. It processes one document per call and returns the field values synchronously. Both extraction modes accept `file_url`.

   ```json
   {"file_url":"<download_url>","fields":[{"name":"Contract amount","prompt":"Total including tax"},{"name":"Signing date"}]}
   ```

3. If the user names a document type without specifying fields, search for a preset with `list_apps`, for example `{"engine_type":"extract","source":"preset","document_type":"purchase order"}`. Use the matching `app_id` from `data.list` with `extract_document`. If the user has already selected a custom extraction app, use its ID directly.

   ```json
   {"app_id":"<app_id>","file_url":"<download_url>","wait":false}
   ```

4. For a background task, pass the returned top-level `task_ref` unchanged to `get_task`, for example `{"task_ref":{"kind":"extract","id":"<task_id>"}}`. Pass the same reference to `cancel_task` to cancel a queued task that a worker has yet to claim.

Parsing, app-based extraction, and classification default to `wait=true` and return the final result in the same call. `wait_timeout_seconds` sets how long to wait for a synchronous response and defaults to 60 seconds. If it expires, the outcome is unknown, so check the original request before retrying. For background processing, set `wait=false` and save the `task_ref` for each file.

Use `get_credits` to check the account balance. For an individual task, read `usage.credits_consumed` or `recorded_credits` from its result. A `usage_status` of `unavailable` means that the response did not include a recorded amount. [Rate limits, concurrency, and timeouts](https://adp-doc.laiye.com/en/api-reference/rate-limits) · [Request records and telemetry](https://adp-doc.laiye.com/en/api-reference/data-and-telemetry)

## Tool catalog

The table shows the descriptions and required parameters from the tool definitions. You can also call `tools/list` on your connection.

<details>
<summary>View the full tool catalog</summary>

<!-- tool-catalog:start -->

Version `2.0.0-beta.2` exposes **14 tools** in both regions. See the tool definitions on your connection for region-specific tools and parameters.

| Tool | Required inputs | Purpose |
| --- | --- | --- |
| `get_adp_guide` | None | Consult this guide when first using ADP in a conversation. Reuse it for subsequent tasks. Examples from invoices, orders, IDs, and contracts explain when to parse full text, use one-off field extraction, classify pages, or reuse or create an app. The guide also covers supported file formats, synchronous and asynchronous processing, concurrency and rate limits, checking and topping up credits, and sending feedback to ADP. |
| `upload_file` | `files` | Upload local files to ADP and return download URLs for parsing, extraction, or classification. For multiple files, include the entire batch in files in one call. The tool uploads them in parallel without waiting for separate calls one file at a time. Each result includes the original file_path, file_name, and input index to identify the source file. Continue processing successful items with data.download_url. If some files fail, keep the successful items and identify each failed source file. If error.acceptance_unknown=true, verify the upload status before retrying, and do not resubmit the whole batch. Skip upload when downloadable HTTP(S) URLs are already available. |
| `parse_document` | `file_url` | Parse an entire document or selected original pages into text, tables, and layout structure for reading, translation, or building a knowledge base. Enhanced Parsing 2.0 (fast_vlm) is the default. You can switch modes, remove headers, footers, and page numbers, or recognize and extract stamps. If header and footer removal is enabled and no mode is specified, Intelligent Parsing 2.0 (agentic_v2) is used. If the user asks for OCR but only needs values such as amounts or ID numbers, use extract_document. By default, parsing runs synchronously and returns the result. For background processing, pass wait=false, then use the returned task_ref with get_task. |
| `extract_document` | `file_url` + (`app_id` or `fields`) | Extract field values from one document, such as a name from an ID card or a payment deadline from a contract. Choose how to extract based on the app, fields, or document type the user specifies.<br><br>**Named extraction app.** Pass a known `app_id` with the file. To find a team app, call `list_apps` with `engine_type=extract`, `source=custom`, and `app_name`. If the user gives only an app name, search by name and engine type across both sources. Ask the user to choose if multiple matches remain. When the user names both an app and specific fields, use the app's rules and report only the requested fields.<br><br>**One-off extraction.** When the user names the fields for this request and has not chosen an app, pass the file and `fields` (1–20) directly. This returns the values synchronously and needs no catalog lookup. For example, extract just the payment deadline and late fee from this contract.<br><br>**Document type only.** For a request such as “extract this ID card”, call `list_apps` with `engine_type=extract`, `source=preset`, and `document_type`, then extract using the returned `app_id`. If no preset matches, choose fields from the visible document and its intended use, or ask which information matters if that is unclear.<br><br>Report the fields the extraction returned and identify any requested fields that were missing. Call `parse_document` for full-page text, Markdown, or layout when the user also asks for that output.<br><br>**Professional extraction (custom extraction app).** Recommend evaluating a custom extraction app when field accuracy, processing speed, consistency across layouts, or long-term reuse matters. Once the user chooses to create one, use `create_app` to save field types, extraction rules, and output formats. Use the returned `app_id` on representative samples to measure accuracy and processing time.<br><br>Extraction by `app_id` is synchronous by default. For background processing, pass `app_id` and `wait=false`, then query `get_task` with the returned `task_ref`. One-off `fields` supports synchronous extraction only. If the user asks for both one-off fields and a background task, offer synchronous field extraction or, with their agreement, background extraction using an app. |
| `classify_document` | `app_id` + `file_url` | Classify a file by document type, such as an invoice or contract, or locate each material by page in a mixed file.<br><br>1. **Choose a classification app.** Use the `app_id` of a classification app created by the current account whose categories cover the types you need. If this connection offers the classification filter in `list_apps`, search with `engine_type=classify`. If no suitable app exists, call `create_app` with `engine_type=classify`, an app name, and `classify_types`, then use the returned `app_id`.<br>2. **Submit one file.** Pass `app_id` and one file, for example a download URL in `file_url`. Omit `pages` to classify the whole file. Pass `pages=[2, 4]` to classify only original pages 2 and 4. For multiple files, call once per file and summarize by file. By default the result is returned synchronously. To collect it later, set `wait=false`, then pass the returned `task_ref` to `get_task`.<br>3. **Interpret the result.** Each entry in `data.segments` gives one material's document type and original page numbers. `data.unclassified_pages` lists the pages processed that matched no category. For a mixed file, report each material and its pages. If the user needs one type for the whole file, classify all pages. Report a single type only if every page matched the same category. If multiple categories matched or any pages were unclassified, report the corresponding pages and mark the whole-file type as needing confirmation. |
| `create_app` | `app_name` + (`extract_fields` or `engine_type` + `classify_types`) | Save reusable extraction or classification rules, or create a classification app before classifying a file when no suitable app exists. Set the name with `app_name` and optionally describe its purpose with `description`.<br><br>1. **Extraction app.** Use `engine_type=extract` (default) to repeatedly extract the same fields from similar documents. Use `extract_fields` to define field names, types, and extraction prompts, for example the invoice number, issue date, and total including tax. Pass the returned `app_id` and a file to `extract_document`. For a one-off request, specify `fields` directly in `extract_document`.<br>2. **Classification app.** Use `engine_type=classify` to identify the materials in a file and locate each by its original page numbers. Define the categories in `classify_types`, for example invoices, contracts, and proof of payment. Pass the returned `app_id` and a file to `classify_document`. |
| `update_app` | `app_id` + (`app_name` or `description` or `extract_fields`) | Update a custom extraction app you can manage by app_id. To change only its name or description, submit just that change. To edit fields, retrieve the full extract_fields with get_app, edit the affected fields and submit the full list to keep. Returns the app ID and update result. |
| `delete_app` | `app_id` | Delete a custom extraction app you can manage, including its associated configuration and extraction data. Call only when the user explicitly asks to delete the entire app. If only the name is known, find it with list_apps using engine_type=extract and source=custom and confirm the target if names collide. To stop one queued document task, use cancel_task. |
| `list_apps` | None | List accessible extraction, parsing, and classification apps by page. Returns the name, `app_id`, engine type, and source. When looking up a specific app, include the known filters in the lookup itself.<br><br>- For a named team extraction app, pass `app_name`, `engine_type=extract`, and `source=custom`. For example, for the team's “Purchase Contracts” app, pass `{"app_name":"Purchase Contracts","engine_type":"extract","source":"custom"}`.<br>- When only the app name is given, pass `app_name` and the engine type if known. Omit `source` to search both preset and custom apps.<br>- To extract by document type alone, pass `document_type`, `engine_type=extract`, and `source=preset`.<br><br>To browse all apps, pass `{}` and paginate as needed. To read details for a known `app_id`, use `get_app`. |
| `get_app` | `app_id` | Use this tool to confirm an app’s configuration. Look up an extraction app by `app_id` to inspect its name, description, field definitions (extraction fields, types and prompts), configuration version, parsing mode and other details. |
| `get_task` | (`task_ref` or `task_id` + `task_type`) | Retrieve the status, available results and recorded credits for one parsing, extraction or classification task. After asynchronous submission, pass the original task_ref unchanged. If using a separately recorded task ID, supply both task_id and task_type. |
| `cancel_task` | (`task_ref` or `task_id` + `task_type`) | When the user asks to stop processing, cancel a parsing, extraction or classification task that is still queued and unclaimed. Pass the original task_ref, or both task_id and task_type. The top-level status is the result of the cancellation attempt. data.status is the task state. If the outcome is uncertain, query the original reference with get_task. |
| `get_credits` | None | Get a credit summary for the currently authorized account, including total, used, expired, and remaining credits. Use this to answer questions such as ‘How many credits are left in my account?’ For usage from a specific document-processing request, read `usage` in the task result. Use `get_task` to continue checking an asynchronous task. |
| `submit_user_feedback` | `feedback_type` + `content` | Call this tool when the user explicitly asks or agrees to submit an ADP issue, feature request, or improvement suggestion. Provide the feedback type, issue summary, and relevant business context. Attach the specified run logs, extraction configuration, or processing files only with the user's explicit authorization, and include contact details for follow-up when needed. Returns the submission status and any feedback ID provided by the API. |

<!-- tool-catalog:end -->

</details>

## Development and verification

Run `npm test` to check tool behavior. Run `npm run test:package` to verify that the packed CLI installs offline, starts, and serves tool calls. After building, use `npm run catalog:generate` to update the tool tables in both READMEs and `npm run catalog:check` to compare them with the running server.
