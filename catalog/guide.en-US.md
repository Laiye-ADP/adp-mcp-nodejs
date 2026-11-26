# ADP document processing guide

Laiye ADP (Laiye Agentic Document Processing) is an agent-native document processing platform developed by Laiye. It supports document classification, full-text parsing, field extraction, and system integration. Use preset apps for common documents such as invoices, orders, and identity documents. For company-specific forms or business rules, define custom extraction fields or use workflows in ADP to connect classification, extraction, and review.

With ADP MCP, an AI assistant can choose tools according to the result the user needs. For example, parse the full text before translating a contract, extract only the fields required to register an invoice, or identify the original pages of each material in a mixed document. This guide uses business scenarios to explain which tools to choose, how to use their results, and when to save processing rules as an app.

Learn more in the [ADP Open API documentation](https://adp-doc.laiye.com/en/products/adp-api).

## Typical business scenarios and tool selection

| Who it helps | What the user might ask | Suggested approach |
| --- | --- | --- |
| Cross-border ecommerce finance, accounts payable, and international procurement teams handling multilingual invoices and receipts in multiple currencies | “Organize the amounts and currencies on these overseas receipts.” | Call `extract_document` with the two requested one-off fields, amount and currency. Extract from each file and summarize the results. |
| Finance, tax compliance, and shared-service reviewers entering domestic invoices and checking their validity | “Read these invoices and verify them.” | Use `extract_document` to read the invoice fields, then use `verify_invoice` for supported mainland China invoices. If a verification result already exists, report it with any returned voided or credit-note status. | <!-- china-invoice -->
| Procurement, accounts payable, and supplier management teams entering purchase orders or comparing delivery notes and invoices | “Organize the items, quantities, and unit prices on these purchase orders.” | Extract the requested item, quantity, and unit-price fields. Keep each order's line items together for ERP entry or later document matching. |
| HR, qualification review, financial due diligence, and vehicle registration teams entering identity or certificate information | “Extract this ID card” or “I only need the name and expiry date.” | For the usual fields, first find a matching identity-document extraction app. When the user names the fields, use `extract_document` for those fields. |
| People translating or archiving contracts and reports, or adding material to a knowledge base | “Convert the whole contract to text so I can translate it.” | Use `parse_document` for the full document or selected pages. Return structured text and tables for reading, translation, storage, or retrieval. |
| Records and review teams classifying files or locating materials within mixed PDFs | “Which pages in this PDF are contracts and which are invoices?” | Use `classify_document` to obtain each material's category, original pages, and unclassified pages. If no suitable classification app exists, first create one with `create_app`, passing `engine_type=classify` and `classify_types`. Then parse selected pages or use extraction capabilities that support page selection. |
| Business teams handling nonstandard forms or applying team-specific contract rules | “Use our team's Purchase Contracts extraction app and show only the amount.” | Extract using the named app's existing definition of the amount and show only the requested fields. If no suitable app exists, specify fields for this request or save reusable rules as an app. |
| Accounts payable and finance reviewers comparing payment requests with contracts, invoices, and goods-receipt or acceptance records | “Check this payment request and its supporting documents.” | Extract parties, amounts, quantities, and payment references from each material. Compare them using the transaction type and company rules, then summarize discrepancies and items requiring review. |
| Expense accountants and travel approvers checking receipts, itineraries, and expense policies | “Check the tickets, hotel invoices, and approval form for this trip.” | Extract the required reimbursement fields, verify supported invoices, and check duplicates against available reimbursement records and company policy. Compare the traveler, itinerary, amounts, and reimbursement limits. | <!-- china-invoice -->
| Financial analysts, risk teams, and researchers organizing suppliers' or portfolio companies' financial statements | “Summarize assets, revenue, and operating cash flow from these financial statements.” | Use `extract_document` for fixed metrics. Use `parse_document` to read tables on relevant pages when the complete statements are needed. |

When the user only says “OCR this,” use the context to determine whether they want whole-page text or a few fields. Use `parse_document` for whole-page text and `extract_document` for field values. If the intent remains unclear, ask whether they want the full page text or specific fields.

**Professional extraction with a custom extraction app.** In ADP, professional extraction means using a custom extraction app. When recommending this approach, use the product name “custom extraction app,” explain which value-selection rules will be saved, and explain how to reuse them through `app_id`. If the user is only evaluating options, provide a comparison plan. A custom extraction app can be evaluated even when a preset exists for the same document type. For example, contracts from different suppliers may use different layouts, while finance requires the contract amount to always mean the tax-inclusive total and also cares about processing time. Save the selection rules and output format in a custom extraction app. Use the same representative contracts with known answers to compare the preset and custom app on field accuracy, consistency across layouts, and time per file. When the user is asking for advice, first propose the evaluation. Call `create_app` with `engine_type=extract` and `extract_fields` after the user decides to create an app.

## Core advantages of ADP MCP

- **Preset extraction templates reduce configuration work.** Templates cover domestic and overseas invoices, purchase orders, identity documents, and other common materials. An AI assistant can choose an existing app by document type and reuse its fields and rules.
- **Parsing strategies match document characteristics.** Choose an appropriate mode for clear electronic documents, scans, complex tables, or documents containing formulas. Field types and extraction prompts can clarify which information to extract and how to interpret each value.
- **Classification connects materials to the next processing step.** Identify a file's type or locate each material's pages using configured categories. The assistant can then select the next operation, such as invoice extraction for invoices or contract extraction for contracts.
- **Parsing and extraction options support different business needs.** Parsing can select pages, retain source positions, remove headers, footers, and page numbers, or recognize stamps. Extraction can reuse an app or define field names, descriptions, types, and prompts for temporary tasks or recurring work.
- **Process independent documents concurrently by default.** Make one call per document and use synchronous processing within the processing allowance. When the client supports parallel tool calls, the agent must issue multiple synchronous calls together in the same turn instead of waiting for each file, then combine results by file. If the client cannot wait for synchronous calls concurrently or the user wants background processing, submit full-text parsing, extraction by app, or classification as asynchronous tasks and query their results later.

## Supported document formats

| Document category | File formats |
| --- | --- |
| Images | `.jpeg`, `.jpg`, `.png`, `.bmp`, `.webp`, `.tif`, `.tiff` |
| Office documents | `.xls`, `.xlsx`, `.doc`, `.docx`, `.ppt`, `.pptx` |
| Other | `.pdf`, `.ofd`, `.html` |

## Recommended steps

```text
1. Prepare the file
   |_ Local files from the user — include all readable local paths in files in one upload_file call for parallel upload, then use data.download_url from each successful item as file_url
   |_ The user provided a URL accessible to ADP — use it directly

2. Choose a tool according to the requested result
   |_ Full text or tables from all or selected pages
   |  |_ Call parse_document and choose pages, parsing mode, and options as needed
   |
   |_ Field values such as amounts, names, or order numbers
   |  |_ A named app — extract with app_id. If only its name is known, search by name and engine_type=extract. Add source=custom for a named team app
   |  |_ Fields specified for this request without a chosen app — pass the file and fields directly to extract_document
   |  |_ Only a document type — use list_apps with engine_type=extract, source=preset, and document_type, then extract with the returned app_id
   |  |_ No matching preset — choose one-off fields from the visible content and intended use. Ask the user if the intent remains unclear
   |  |_ Requirements for quality, speed, consistency across layouts, or long-term reuse — recommend evaluating a custom extraction app
   |
   |_ Identify the file type or locate materials by page
      |_ A suitable classification app exists — pass app_id to classify_document
      |_ No suitable classification app exists — create one with create_app using engine_type=classify and classify_types, then submit the file
      |_ Classify the entire file — omit pages
      |_ Classify selected pages — pass top-level pages, such as [2, 4] for original pages 2 and 4

3. Obtain the processing result
   |_ Default execution — process independent files concurrently, one call per file with wait=true by default; issue multiple synchronous calls together in the same turn when supported, without waiting file by file, then summarize by file
   |_ The client cannot wait for synchronous calls concurrently, or the user wants background processing — use wait=false for full-text parsing, extraction by app, or classification
   |_ Multiple asynchronous tasks — submit concurrently when supported, or submit consecutively without waiting for an earlier task to finish; map each file to its task_ref and continue with get_task
   |_ One-off extraction with fields — synchronous only; follow the default concurrency policy for independent files and do not create an app solely for concurrency
```

## Choose synchronous or asynchronous processing

**Process independent documents concurrently by default.** Make one call per document and use synchronous processing (`wait=true`) within the processing allowance. When the client supports parallel tool calls, the agent must issue multiple synchronous calls together in the same turn without waiting for the previous file to finish before submitting the next. Combine results by the original file.

If the client cannot wait for synchronous calls concurrently or the user wants background processing, use asynchronous full-text parsing, extraction by app, or classification. Asynchronous submission does not guarantee simultaneous execution or faster completion.

| Common scenario | Recommended approach |
| --- | --- |
| “Extract this invoice so I can see the result now.” | **Synchronous processing.** Full-text parsing, extraction by app, and classification use `wait=true` by default. The request waits for the result, with a default limit of 60 seconds. Adjust the limit with `wait_timeout_seconds`. |
| “Submit these invoices now. I will check the results later.” | **Asynchronous processing.** Pass `wait=false` for full-text parsing, extraction by app, or classification. Submit each task concurrently when the client supports parallel tool calls. Otherwise, submit consecutively without waiting for a task to finish. Map each file to its `task_ref` and continue with `get_task`. `status=pending` means the task was accepted and its result is not ready. |
| “For this request, extract the payment deadline and penalty amount from the contract.” | **Synchronous one-off field extraction.** `extract_document` with `fields` supports synchronous processing only, so the waiting options can be omitted. Make one call per independent file and follow the default concurrency policy: when the client supports parallel tool calls, issue multiple calls together in the same turn and combine their results. Do not create an extraction app solely to enable concurrency. |

If the connection closes after submission or a synchronous request times out, ADP may still be processing the file. Query the original task when a `task_ref` is available. Otherwise, inspect the platform's run history before deciding whether to submit again to avoid duplicate processing and charges. Do not automatically resubmit a timed-out synchronous request as an asynchronous task.

## How many documents can run at once?

Batch upload and document processing are separate stages. For multiple local files, call `upload_file` once with all paths in `files`. The tool uploads them in parallel and returns the original `file_path`, `file_name`, and `index` for every item to identify its source file. Continue processing each successful item’s `data.download_url` within the separate parsing and extraction concurrency allowances. If some items fail, identify each failed source file without uploading successful items again. If `error.acceptance_unknown=true`, verify the upload status before retrying. The limits below apply to document processing, not file upload.

Within a tenant, parsing and extraction are counted **separately for each processing account**. Each executing document uses one slot regardless of its page count. Synchronous calls and asynchronous tasks that have started share the same allowance for their processing type. App-based extraction and one-off field extraction share the extraction allowance. A shared app's tasks may count against its owner's account.

| Default maximum tasks executing at once | Document parsing | Document extraction |
| --- | ---: | ---: |
| Account without usable paid or subscription credits | 15 | 15 |
| Account with usable paid or subscription credits | 35 | 35 |

These are service defaults. The deployment configuration determines the actual allowance. An asynchronous task enters the queue first and requests a slot when it starts executing. It may fail if the allowance is full at that point. For example, with one default parsing worker, eight accepted asynchronous tasks may consist of one executing task and seven waiting tasks.

- **Limit in-flight work.** When the allowance is unknown, start with at most five in-flight documents of each processing type, including submitted documents that are still queued. Add another when one finishes. Reduce this number when the account has other tasks or reports insufficient concurrency.
- **Control request frequency.** Both submission and polling generate requests. Slow them down on `RATE_LIMITED` (HTTP 429). Automatically retry only queries that are safe to repeat. If `retry_after_ms` is present, wait at least that many milliseconds. Otherwise, increase the interval progressively. Retry at most three times. When the waiting deadline is reached, keep the original reference and check later. Do not automatically resubmit processing tasks.

## Billing and credit top-ups

### Monthly free credits

Free users receive **100 free credits per month**, enough to parse 200 pages of documents or extract information from 125 single-page VAT invoices. If you use up your monthly allowance, a new allowance of 100 credits is automatically issued on the first day of the following month. Unused free credits expire at the end of each month and do not roll over.

### How many credits does each feature use?

| Feature | Credits consumed | Billing unit |
| --- | ---: | --- |
| Document parsing | 0.5 credits | Per page |
| Chinese ID and certificate extraction | 0.5 credits | Per page | <!-- china-invoice -->
| Purchase order extraction | 1.5 credits | Per page |
| Overseas invoice extraction | 1 credit | Per page |
| Chinese domestic invoice extraction | 0.8 credits | Per page | <!-- china-invoice -->
| Invoice verification | 0.5 credits | Per invoice | <!-- china-invoice -->
| Custom extraction | 1 credit | Per page |

**Invoice verification is billed per invoice.** Verifying a two-page invoice still costs 0.5 credits. If a 10-page file contains three invoices joined end to end, verifying all three costs 1.5 credits in total. <!-- china-invoice -->

### How do I check my credits?

You can ask your AI assistant: “How many ADP credits do I have left?” The assistant will call `get_credits` to check the currently authorized account's credit balance.

To check the credits consumed by a single processing request, read `usage.credits_consumed` or `recorded_credits` from the result.

### How do I add credits when I run out?

When your free credits run out, you can wait until the first day of the following month for a new allowance. To continue processing documents sooner, add credits through the option available for your account's region.

{credit_action}

On `INSUFFICIENT_CREDITS`, pause new submissions. After the balance is restored, continue only with files that have not been accepted. For tasks with an existing reference, query the original task first to avoid duplicate processing and charges.

## Handle user feedback

When the user reports inaccurate extraction, task failures, or other processing problems, or requests a capability ADP does not currently offer, first determine whether they want help resolving the issue or want to send feedback to ADP. Call `submit_user_feedback` after the user explicitly requests or agrees to submission.

1. **Choose the feedback type.** Errors, inaccurate results, and task problems are issues. Describe the expected result, actual result, and attempted remedies. New capabilities and improvements are suggestions. Describe the business scenario, current limitation, and requested capability.
2. **Prepare the summary.** Record the relevant file type, processing objective, and observed problem from the conversation. Preserve the user's wording for important details and distinguish confirmed facts from unverified interpretations. Include relevant information and remove API keys, other credentials, and unnecessary personal or financial information.
3. **Confirm attachments when needed.** Ask which local files the user agrees to include, such as exported run logs, extraction configuration, or the original document. After explicit approval, pass their readable paths in `attachment_paths` with `attachments_authorized=true`. Permission to upload a file for document processing applies to that processing request. If the user requires an original file that cannot be read, explain what is missing and wait for the file or their agreement to send text only.
4. **Submit and report the result.** Call `submit_user_feedback` with the summary and approved attachments. For follow-up, use the account's available contact details where possible and ask for them if needed. Include an existing feedback ID when providing additional context for the same issue. On success, provide the returned feedback ID. If attachment submission fails, explain what could not be submitted using the available error details. If the tool is unavailable, submission fails, or its status is unknown, report that status and keep the summary.

**Example when asking about attachments**

> I can send this issue to ADP. Would you like to include the run logs, extraction configuration, or original file to help with investigation? You can choose any of them or send text feedback only.
