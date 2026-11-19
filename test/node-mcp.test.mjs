import assert from "node:assert/strict";
import { once } from "node:events";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { AdpClient } from "../dist/adp-client.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const documentPrefix = "/open/agentic_doc_processor/test-tenant/v1/app/doc";
const workflowPrefix = "/open/agentic_engine/test-tenant";
const cnOrigin = "https://adp.laiye.com";
const globalOrigin = "https://adp-global.laiye.com";
const discoveryPath = "/open/agentic_doc_processor/laiye/v1/webhook/events";
const fileUrl = "https://example.invalid/invoice.pdf";
const domesticBill = "ootb_v9x2y5z8a1b4c7d0e3f6h9j1k4m7";
const overseasFast = "ootb_r3s6t9u2v5w8x1y4z7a0b3c6d9e2";
const recordedUsage = {
  credits_consumed: 0.8,
  num_pages: 1,
  billing_breakdown: { extraction: 0.8 }
};
const ok = data => ({ code: "success", message: "", data });

async function connect(t, respond, apiKey = "test-key", environment = {}) {
  const calls = [];
  const api = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const contentType = request.headers["content-type"];
      const call = {
        method: request.method,
        path: request.url,
        key: request.headers["x-api-key"],
        source: request.headers["x-api-source"],
        receivedAt: performance.now(),
        contentType,
        body: contentType?.startsWith("application/json") && raw ? JSON.parse(raw) : raw
      };
      calls.push(call);
      const payload = await respond(call, response);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "fixture_error", message: String(error) }));
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const client = new Client({ name: "adp-v2-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ADP_API_KEY: apiKey,
      ADP_API_BASE_URL: baseUrl,
      ADP_TENANT_NAME: "test-tenant",
      ADP_ACCEPT_LANGUAGE: "zh",
      ...environment
    },
    stderr: "pipe"
  });
  t.after(async () => {
    await client.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  });
  await client.connect(transport);
  return { client, calls, baseUrl };
}

function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

test("stdio registers the eight Node tools and delivers the guide without a key", async t => {
  const profile = await cliProfile(t);
  const { client, calls } = await connect(t, () => {
    throw new Error("Unexpected upstream request");
  }, "", { USERPROFILE: profile.profileDir });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "extract_custom_document", "extract_document", "get_adp_guide", "parse_document",
    "route_document", "submit_user_feedback", "task", "upload_temporary_file"
  ]);
  assert.ok(tools.every(tool => tool.description && tool.outputSchema?.type === "object"));
  const inputs = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]));
  assert.deepEqual(inputs.get_adp_guide.properties, {});
  assert.deepEqual(inputs.get_adp_guide.required ?? [], []);
  for (const [name, required, itemRequired, itemKeys] of [
    ["upload_temporary_file", ["files"], "file_path", ["file_path"]],
    ["parse_document", ["files"], "url", ["name", "url"]],
    ["extract_document", ["app_id", "files"], "url", ["name", "url"]],
    ["extract_custom_document", ["fields", "files"], "url", ["url"]],
    ["route_document", ["app_id", "files"], "url", ["name", "url"]]
  ]) {
    const schema = inputs[name];
    assert.equal(schema.oneOf, undefined, name);
    assert.deepEqual([...schema.required].sort(), required, name);
    assert.equal(schema.properties.file_url, undefined, name);
    assert.equal(schema.properties.file_path, undefined, name);
    assert.equal(schema.properties.files.type, "array", name);
    assert.equal(schema.properties.files.minItems, 1, name);
    assert.equal(schema.properties.files.items.type, "object", name);
    assert.deepEqual(schema.properties.files.items.required, [itemRequired], name);
    assert.deepEqual(Object.keys(schema.properties.files.items.properties).sort(), itemKeys, name);
  }
  assert.deepEqual(inputs.task.required, []);
  assert.equal(inputs.task.oneOf, undefined);
  assert.equal(inputs.task.anyOf, undefined);
  assert.deepEqual(inputs.task.properties.action.enum, ["query", "cancel"]);
  assert.equal(inputs.task.properties.action.default, "query");
  assert.deepEqual(inputs.task.properties.task_type.enum, ["parse", "extract", "classify"]);
  assert.equal(tools.find(tool => tool.name === "task").annotations.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === "task").annotations.destructiveHint, true);
  const taskOutput = new AjvJsonSchemaValidator().getValidator(tools.find(tool => tool.name === "task").outputSchema);
  const result = { status: "succeeded", task_ref: { kind: "parse", id: "parse-1" },
    data: { task_id: "parse-1", response_type: "recognize", status: 4 } };
  assert.equal(taskOutput(result).valid, true);
  assert.equal(taskOutput({ ...result, data: { ...result.data, response_type: "extract" } }).valid, false);
  assert.equal(taskOutput({ ...result, task_ref: { kind: "workflow", id: "parse-1" } }).valid, false);
  assert.equal(taskOutput({ ...result, usage: { billing_breakdown: { recognition: 0.5 } } }).valid, true);
  assert.equal(taskOutput({ ...result, usage: { billing_breakdown: { model_usage: 0.5 } } }).valid, false);
  assert.equal(taskOutput({ ...result, usage: { billing_breakdown: { unexpected_category: 0.5 } } }).valid, false);
  const workflowResult = { status: "succeeded", task_ref: { kind: "workflow", id: "run-1" },
    data: { run_id: "run-1", status: "succeeded" } };
  assert.equal(taskOutput({ ...workflowResult, usage: { billing_breakdown: { model_usage: 0.5 } } }).valid, true);
  assert.equal(taskOutput({ ...workflowResult, usage: { billing_breakdown: { collaboration: 0.5 } } }).valid, false);
  assert.equal(taskOutput({ ...workflowResult, usage: { billing_breakdown: { unexpected_category: 0.5 } } }).valid, false);
  const guide = await call(client, "get_adp_guide");
  assert.match(guide.structuredContent.markdown, /国内通用票据/);
  for (const id of [domesticBill, overseasFast]) {
    assert.ok(guide.structuredContent.markdown.includes(id), id);
  }
  assert.doesNotMatch(guide.structuredContent.markdown, /run_workflow|template_key|wftp_app_|financial_report_extraction|finance_payable|expense_reimbursement/);
  assert.equal(guide.content[0].text, guide.structuredContent.markdown);
  assert.match(guide.content[0].text, /adp\.laiye\.com\?from=getkey&utm_source=github/);
  assert.match(guide.content[0].text, /adp-global\.laiye\.com\?from=getkey&utm_source=github/);
  const missingKey = await call(client, "parse_document", { file_url: fileUrl });
  assert.equal(missingKey.isError, true);
  assert.match(missingKey.content[0].text, /adp\.laiye\.com\?from=getkey&utm_source=github/);
  assert.equal(calls.length, 0);
});

test("the guide follows the configured language and accepts a legacy override", async t => {
  const { client, calls } = await connect(t, () => {
    throw new Error("Unexpected upstream request");
  }, "", { ADP_ACCEPT_LANGUAGE: "en-US" });
  const english = await call(client, "get_adp_guide");
  assert.match(english.structuredContent.markdown, /Global invoices and receipts/);
  assert.doesNotMatch(english.structuredContent.markdown, /run_workflow|template_key|wftp_app_|financial_report_extraction|finance_payable|expense_reimbursement/);
  const chinese = await call(client, "get_adp_guide", { language: "zh-CN" });
  assert.match(chinese.structuredContent.markdown, /国内通用票据/);
  assert.equal(calls.length, 0);
});

test("parse waits on its original task and extraction can be queried later with usage", async t => {
  const { client, calls } = await connect(t, ({ method, path }) => {
    if (method === "POST" && path === `${documentPrefix}/recognize/create/task`) return ok({ task_id: "parse-1" });
    if (method === "GET" && path === `${documentPrefix}/recognize/query/task/parse-1`) {
      return { ...ok({ task_id: "parse-1", status: 4 }), usage: { num_pages: 1, credits_consumed: 0 } };
    }
    if (method === "POST" && path === `${documentPrefix}/extract/create/task`) return ok({ task_id: "extract-1" });
    if (method === "GET" && path === `${documentPrefix}/extract/query/task/extract-1`) {
      return { ...ok({ task_id: "extract-1", status: 4 }), usage: {
        ...recordedUsage, credits_consumed: 1.3, billing_breakdown: { extraction: 0.8, collaboration: 0.5 }
      } };
    }
    if (method === "GET" && path === `${documentPrefix}/extract/query/task/extract-pages-only`) {
      return { ...ok({ task_id: "extract-pages-only", status: 4 }), usage: { num_pages: 1 } };
    }
    throw new Error("Unexpected endpoint");
  });
  const parsed = (await call(client, "parse_document", { file_url: fileUrl })).structuredContent;
  assert.equal(parsed.status, "succeeded");
  assert.deepEqual(parsed.usage, { num_pages: 1, credits_consumed: 0 });
  assert.equal(calls[0].body.app_id, "ootb_k7m2x9p4v1n8w3q6r5t0y2b4");
  const submitted = (await call(client, "extract_document", { app_id: domesticBill, file_url: fileUrl, wait: false })).structuredContent;
  assert.deepEqual(submitted.task_ref, { kind: "extract", id: "extract-1" });
  const nextQuery = submitted.next_steps.find(step => step.tool === "task");
  assert.deepEqual(nextQuery.arguments, { task_ref: submitted.task_ref });
  assert.equal(calls.length, 3);
  const queried = (await call(client, "task", { task_ref: submitted.task_ref })).structuredContent;
  assert.equal(queried.status, "succeeded");
  assert.deepEqual(queried.usage, {
    ...recordedUsage, credits_consumed: 1.3, billing_breakdown: { extraction: 0.8, collaboration: 0.5 }
  });
  const pageOnly = (await call(client, "task", { task_ref: { kind: "extract", id: "extract-pages-only" } })).structuredContent;
  assert.deepEqual(pageOnly.usage, { num_pages: 1 });
  assert.equal(pageOnly.usage_status, "unavailable");
  assert.ok(calls.every(item => item.key === "test-key"));
  assert.ok(calls.every(item => item.source === "adp-node-mcp"));
});

test("parse accepts a file array and forwards both the selected pages and parsing mode", async t => {
  const { client, calls } = await connect(t, () => ok({ task_id: "parse-pages" }));
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === "parse_document").inputSchema;
  assert.deepEqual(schema.required, ["files"]);
  assert.equal(schema.properties.pages.minItems, undefined);
  assert.deepEqual(schema.properties.pages.default, []);
  assert.deepEqual(schema.properties.recognize_mode.enum, ["standard", "advance", "agentic_v2", "thai_ocr"]);
  for (const files of [[], [{}]]) {
    const invalid = await call(client, "parse_document", { files, wait: false });
    assert.equal(invalid.isError, true);
  }
  for (const recognize_mode of ["agentic", "fast_vlm"]) {
    for (const input of [{ files: [{ url: fileUrl }] }, { file_url: fileUrl }]) {
      const invalid = await call(client, "parse_document", { ...input, recognize_mode, wait: false });
      assert.equal(invalid.isError, true);
    }
  }
  assert.equal(calls.length, 0);
  const response = await call(client, "parse_document", {
    files: [{ url: fileUrl, name: "invoice.pdf" }], pages: [2, 4], recognize_mode: "agentic_v2", wait: false
  });
  assert.deepEqual(response.structuredContent.files[0].task_ref, { kind: "parse", id: "parse-pages" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    app_id: "ootb_k7m2x9p4v1n8w3q6r5t0y2b4",
    file_url: fileUrl,
    file_name: "invoice.pdf",
    model_params: { pages: [2, 4], recognize_config: { recognize_mode: "agentic_v2", enable_pdf_parse: false } }
  });
  for (const optionalPages of [{}, { pages: [] }]) {
    const result = await call(client, "parse_document", {
      files: [{ url: fileUrl }], ...optionalPages, wait: false
    });
    assert.equal(result.structuredContent.files[0].status, "pending");
    assert.equal(Object.hasOwn(calls.at(-1).body, "model_params"), false);
  }
  const modeOnly = await call(client, "parse_document", {
    files: [{ url: fileUrl }], pages: [], recognize_mode: "thai_ocr", wait: false
  });
  assert.equal(modeOnly.structuredContent.files[0].status, "pending");
  assert.deepEqual(calls.at(-1).body.model_params, { recognize_config: { recognize_mode: "thai_ocr" } });
  const invalid = await call(client, "parse_document", { files: [{ url: fileUrl }], pages: [0], wait: false });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 4);
});

test("preset extraction and classification accept omitted or empty pages and forward selected pages", async t => {
  const { client, calls } = await connect(t, () => ok({ task_id: "document-pages" }));
  const { tools } = await client.listTools();
  const documentTools = [
    { name: "extract_document", kind: "extract", appId: domesticBill },
    { name: "route_document", kind: "classify", appId: "owned-classifier" }
  ];
  for (const { name, kind, appId } of documentTools) {
    const schema = tools.find(tool => tool.name === name).inputSchema;
    assert.deepEqual(schema.required, ["files", "app_id"]);
    assert.equal(schema.properties.pages.minItems, undefined);
    assert.deepEqual(schema.properties.pages.default, []);

    const input = { app_id: appId, files: [{ url: fileUrl }], wait: false };
    const body = { app_id: appId, file_url: fileUrl };
    const start = calls.length;
    for (const pageOption of [{}, { pages: [] }, { pages: [2, 4] }]) {
      const result = await call(client, name, { ...input, ...pageOption });
      assert.deepEqual(result.structuredContent.files[0].task_ref, { kind, id: "document-pages" });
    }
    const requests = calls.slice(start);
    assert.ok(requests.every(request => request.path === `${documentPrefix}/${kind}/create/task`));
    assert.deepEqual(requests.map(request => request.body), [body, body, { ...body, model_params: { pages: [2, 4] } }]);
  }
});

test("domestic preset preserves the per-request invoice verification override", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    assert.equal(path, `${documentPrefix}/extract/create/task`);
    return ok({ task_id: "domestic-extract" });
  }, "test-key", { API_SOURCE: "npm-mcp" });
  const input = { app_id: domesticBill, file_url: fileUrl, wait: false };
  for (const enable_invoice_verify of [true, false, null]) {
    const with_rec_result = enable_invoice_verify === true;
    const result = await call(client, "extract_document", { ...input, enable_invoice_verify, with_rec_result });
    assert.equal(result.structuredContent.status, "pending");
    assert.equal(calls.at(-1).body.enable_invoice_verify, enable_invoice_verify);
    assert.equal(calls.at(-1).body.with_rec_result, with_rec_result);
  }
  await call(client, "extract_document", input);
  assert.equal(Object.hasOwn(calls.at(-1).body, "enable_invoice_verify"), false);
  assert.equal(Object.hasOwn(calls.at(-1).body, "with_rec_result"), false);
  const unrelated = await call(client, "extract_document", { ...input, app_id: overseasFast, enable_invoice_verify: true });
  assert.equal(unrelated.isError, true);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(item => item.source === "npm-mcp"));
});

test("uploads local bytes, maps custom fields, and calls classification only", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    switch (path) {
      case `${workflowPrefix}/files/upload`: return ok({ download_url: fileUrl });
      case `${documentPrefix}/extract/direct-fast`: return ok({ extraction_result: [{ name: "发票号码", value: "123" }] });
      case `${documentPrefix}/classify/create/task`: return ok({ task_id: "classify-1" });
      case `${documentPrefix}/classify/query/task/classify-1`:
        return ok({ task_id: "classify-1", status: "success", segments: [{ category_name: "票据", pages: [1] }] });
      default: throw new Error("Unexpected endpoint");
    }
  });
  const file = join(tmpdir(), `adp-v2-${randomUUID()}.txt`);
  await writeFile(file, "ADP multipart test");
  t.after(() => unlink(file));
  const uploaded = await call(client, "upload_temporary_file", { file_path: file });
  assert.notEqual(uploaded.isError, true);
  const uploadGuidance = JSON.stringify(uploaded.structuredContent.next_steps);
  assert.match(uploadGuidance, /download_url/);
  assert.ok(!uploadGuidance.includes(fileUrl));
  assert.match(calls[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(calls[0].body, /name="chunk"/);
  assert.match(calls[0].body, /ADP multipart test/);
  assert.match(calls[0].body, /name="sharing_scope"\r\n\r\nuser/);
  assert.doesNotMatch(calls[0].body, /name="application_id"/);
  const fields = [{ name: "发票号码", prompt: "票据顶部的号码" }];
  const custom = await call(client, "extract_custom_document", { file_url: fileUrl, fields });
  assert.notEqual(custom.isError, true);
  assert.deepEqual(calls[1].body, { file: { url: fileUrl }, fields });
  assert.equal(custom.structuredContent.usage_status, "unavailable");
  const invalid = await call(client, "extract_custom_document", { file_url: fileUrl, fields, app_id: domesticBill });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 2);
  const classified = await call(client, "route_document", { app_id: "owned-classifier", file_url: fileUrl });
  assert.equal(classified.structuredContent.status, "succeeded");
  assert.equal(calls[2].body.app_id, "owned-classifier");
  assert.deepEqual(classified.structuredContent.data.segments[0].pages, [1]);
  const localUri = pathToFileURL(file).href;
  const mixed = await call(client, "upload_temporary_file", { file_path: localUri, files: [{}] });
  assert.equal(mixed.isError, true);
  assert.equal(calls.length, 4);
  const fileArray = await call(client, "upload_temporary_file", { files: [{ file_path: localUri }] });
  assert.equal(fileArray.structuredContent.files[0].data.download_url, fileUrl);
  assert.match(calls[4].body, /ADP multipart test/);
  const customArray = await call(client, "extract_custom_document", { files: [{ url: fileUrl }], fields });
  assert.equal(customArray.structuredContent.files[0].status, "succeeded");
  assert.deepEqual(calls[5].body, { file: { url: fileUrl }, fields });
});

test("removed workflow runner is rejected without any business request", async t => {
  const { client, calls } = await connect(t, () => {
    throw new Error("Unexpected upstream request");
  });
  const removed = await call(client, "run_workflow", { files: [{ url: fileUrl }], wait: false });
  assert.equal(removed.isError, true);
  assert.equal(removed.structuredContent.status, "failed");
  assert.equal(calls.length, 0);
});

test("existing workflow task queries return the model usage billing breakdown", async t => {
  const usage = { credits_consumed: 2.5, billing_breakdown: { extraction: 1, model_usage: 1.5 } };
  const { client, calls } = await connect(t, ({ method, path }) => {
    if (method === "GET" && path === `${workflowPrefix}/v1/app/run/query/task/run-1`) {
      return { ...ok({ run_id: "run-1", status: "succeeded", output: {} }), usage };
    }
    throw new Error("Unexpected endpoint");
  });
  const ref = { kind: "workflow", id: "run-1" };
  for (const args of [{ task_ref: ref }, { run_id: ref.id }]) {
    const result = (await call(client, "task", args)).structuredContent;
    assert.equal(result.status, "succeeded");
    assert.equal(result.usage_status, "available");
    assert.deepEqual(result.usage, usage);
  }
  assert.deepEqual(calls.map(item => item.method), ["GET", "GET"]);
});

test("wait timeout keeps the accepted task reference without submitting again", async t => {
  const { client, calls } = await connect(t, ({ method }) =>
    method === "POST" ? ok({ task_id: "parse-long" }) : ok({ task_id: "parse-long", status: 2 }));
  const result = (await call(client, "parse_document", { file_url: fileUrl, wait_timeout_seconds: 1 })).structuredContent;
  assert.equal(result.status, "pending");
  assert.deepEqual(result.task_ref, { kind: "parse", id: "parse-long" });
  assert.deepEqual(result.next_steps.find(step => step.tool === "task").arguments, { task_ref: result.task_ref });
  assert.equal(calls.filter(item => item.method === "POST").length, 1);
  assert.ok(calls.filter(item => item.method === "GET").every(item => item.path.endsWith("/parse-long")));
});

test("a batch preserves successful files and reports terminal insufficient credits for the original task", async t => {
  const { client, calls } = await connect(t, ({ method, path, body }) => {
    if (method === "POST") {
      return ok({ task_id: body.file_url === fileUrl ? "extract-ok" : "extract-no-credit" });
    }
    if (path.endsWith("/extract-ok")) {
      return { ...ok({ task_id: "extract-ok", status: 4 }), usage: recordedUsage };
    }
    return ok({ task_id: "extract-no-credit", status: 5, message: "配额积分不足，需要充值" });
  });
  const result = await call(client, "extract_document", {
    app_id: domesticBill,
    files: [{ url: fileUrl, name: "one.pdf" }, { url: "https://example.invalid/two.pdf", name: "two.pdf" }]
  });
  assert.notEqual(result.isError, true);
  const { status, files } = result.structuredContent;
  assert.equal(status, "partial_success");
  assert.deepEqual(files.map(file => [file.name, file.status]), [["one.pdf", "succeeded"], ["two.pdf", "failed"]]);
  assert.deepEqual(files[0].usage, recordedUsage);
  assert.deepEqual(files[1].task_ref, { kind: "extract", id: "extract-no-credit" });
  assert.equal(files[1].error.code, "INSUFFICIENT_CREDITS");
  assert.match(files[1].error.message, /https:\/\/adp\.laiye\.com/);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ path }) => path.startsWith(`${documentPrefix}/extract/`)));
});

test("feedback uses its multipart endpoint and only submits explicitly authorized attachments", async t => {
  const receipt = { id: "feedback-1", created_at: "2026-11-12T09:30:00Z" };
  const { client, calls } = await connect(t, ({ method, path }, response) => {
    assert.equal(method, "POST");
    assert.equal(path, "/open/agentic_doc_processor/test-tenant/user-feedback");
    response.statusCode = 201;
    return ok(receipt);
  });
  const summary = { feedback_type: "issue", content: "  发票号码识别有误。  " };
  const textOnly = await call(client, "submit_user_feedback", summary);
  assert.equal(textOnly.structuredContent.status, "succeeded");
  assert.deepEqual(textOnly.structuredContent.data, receipt);
  assert.ok(textOnly.structuredContent.next_steps?.length);
  assert.match(calls[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(calls[0].body, /name="feedback_type"\r\n\r\nissue/);
  assert.match(calls[0].body, /name="content"\r\n\r\n发票号码识别有误。\r\n/);
  assert.match(calls[0].body, /name="allow_follow_up"\r\n\r\ntrue/);
  assert.doesNotMatch(calls[0].body, /name="attachments"/);
  const emptyAttachments = await call(client, "submit_user_feedback", { ...summary, attachment_paths: [] });
  assert.equal(emptyAttachments.structuredContent.status, "succeeded");
  assert.doesNotMatch(calls[1].body, /name="attachments"/);

  const credential = await call(client, "submit_user_feedback", { ...summary, content: "Do not send test-key." });
  assert.equal(credential.isError, true);
  assert.equal(credential.structuredContent.error.code, "CREDENTIAL_IN_FEEDBACK");
  assert.doesNotMatch(credential.content[0].text, /test-key/);
  const file = join(tmpdir(), `adp-v2-feedback-${randomUUID()}.txt`);
  const withoutApproval = await call(client, "submit_user_feedback", { ...summary, attachment_paths: [file] });
  assert.equal(withoutApproval.structuredContent.error.code, "ATTACHMENT_AUTHORIZATION_REQUIRED");
  assert.equal(calls.length, 2);

  await writeFile(file, "Synthetic feedback attachment");
  t.after(() => unlink(file));
  const approved = await call(client, "submit_user_feedback", {
    ...summary, allow_follow_up: false, attachment_paths: [file], attachments_authorized: true
  });
  assert.deepEqual(approved.structuredContent.data, receipt);
  assert.match(calls[2].body, /name="allow_follow_up"\r\n\r\nfalse/);
  assert.match(calls[2].body, /name="attachments"; filename="/);
  assert.match(calls[2].body, /Synthetic feedback attachment/);
  assert.doesNotMatch(calls[2].body, /name="attachments_authorized"/);
  assert.equal(calls.length, 3);
});

test("region and language are independent, with explicit API origin taking precedence", async t => {
  const settings = ["ADP_REGION", "ADP_API_BASE_URL", "ADP_BASE_URL", "ADP_ACCEPT_LANGUAGE", "ADP_API_KEY"];
  const original = Object.fromEntries(settings.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of settings) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url.origin, options.headers.get("Accept-Language")]);
    return Response.json(ok({}));
  });
  const cases = [
    [{ ADP_REGION: "cn", ADP_ACCEPT_LANGUAGE: "en" }, [cnOrigin, "en"]],
    [{ ADP_REGION: "global", ADP_ACCEPT_LANGUAGE: "zh" }, ["https://adp-global.laiye.com", "zh"]],
    [{ ADP_REGION: "global", ADP_API_BASE_URL: "http://127.0.0.1:8000", ADP_ACCEPT_LANGUAGE: "en" },
      ["http://127.0.0.1:8000", "en"]]
  ];
  for (const [env, expected] of cases) {
    for (const key of settings) delete process.env[key];
    Object.assign(process.env, { ...env, ADP_API_KEY: "test-key" });
    const client = new AdpClient();
    await client.request(client.documentPath("/v1/webhook/events"));
    assert.deepEqual(requests.at(-1), expected);
  }
  delete process.env.ADP_API_BASE_URL;
  process.env.ADP_REGION = "unknown";
  const invalid = new AdpClient();
  await assert.rejects(async () => invalid.request(invalid.documentPath("/v1/webhook/events")), /ADP_REGION/);
  assert.equal(requests.length, 3);
});

test("a standalone Key discovers China once per key and does not repeat a business submission", async t => {
  const profile = await cliProfile(t);
  const cachedRegions = new Map();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ origin: url.origin, path: url.pathname, method: options.method,
      key: new Headers(options.headers).get("X-API-KEY") });
    if (url.pathname === discoveryPath) return Response.json(ok({ events: [] }));
    return Response.json({ detail: "Accessor not found" }, { status: 404 });
  });

  const env = { USERPROFILE: profile.profileDir, ADP_API_KEY: "china-key", ADP_TENANT_NAME: "laiye" };
  const client = new AdpClient(env, cachedRegions);
  assert.equal(await client.prepareConnection(), "cn");
  assert.equal(await new AdpClient(env, cachedRegions).getCatalogRegion(), "cn");
  const businessPath = client.documentPath("/v1/app/doc/extract/create/task");
  await assert.rejects(() => client.request(businessPath, { method: "POST", body: { file_url: fileUrl } }));
  assert.equal(await new AdpClient({ ...env, ADP_API_KEY: "new-key" }, cachedRegions).prepareConnection(), "cn");
  assert.deepEqual(requests, [
    { origin: cnOrigin, path: discoveryPath, method: "GET", key: "china-key" },
    { origin: cnOrigin, path: businessPath, method: "POST", key: "china-key" },
    { origin: cnOrigin, path: discoveryPath, method: "GET", key: "new-key" }
  ]);
});

test("only the China credential miss triggers Global discovery and overlapping callers share it", async t => {
  const profile = await cliProfile(t);
  await profile.write("different-cli-key", cnOrigin);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ origin: url.origin, path: url.pathname, method: options.method,
      key: new Headers(options.headers).get("X-API-KEY") });
    if (url.pathname !== discoveryPath) return Response.json(ok({ task_id: "global-extract" }));
    if (url.origin === cnOrigin) return Response.json({ detail: "Accessor not found" }, { status: 404 });
    return Response.json(ok({ events: [] }));
  });

  const env = { USERPROFILE: profile.profileDir, ADP_API_KEY: "global-key" };
  const cachedRegions = new Map();
  const firstClient = new AdpClient(env, cachedRegions);
  const businessClient = new AdpClient(env, cachedRegions);
  const businessPath = businessClient.documentPath("/v1/app/doc/extract/create/task");
  const [region, result] = await Promise.all([
    firstClient.getCatalogRegion(),
    businessClient.request(businessPath, { method: "POST", body: { file_url: fileUrl } })
  ]);
  assert.equal(region, "global");
  assert.deepEqual(result.data, { task_id: "global-extract" });
  assert.equal(await new AdpClient(env, cachedRegions).prepareConnection(), "global");
  assert.deepEqual(requests, [
    { origin: cnOrigin, path: discoveryPath, method: "GET", key: "global-key" },
    { origin: globalOrigin, path: discoveryPath, method: "GET", key: "global-key" },
    { origin: globalOrigin, path: businessPath, method: "POST", key: "global-key" }
  ]);
});

test("discovery does not switch regions on other errors and does not cache a failed probe", async t => {
  const profile = await cliProfile(t);
  const requests = [];
  const answers = [
    () => Response.json({ detail: "Accessor not found" }, { status: 401 }),
    () => Response.json({ detail: "Unexpected not found" }, { status: 404 }),
    () => new Response("Accessor not found", { status: 404, headers: { "Content-Type": "text/html" } }),
    () => Response.json({ detail: "Accessor not found" }, { status: 429 }),
    () => Response.json({ detail: "Accessor not found" }, { status: 503 }),
    () => Response.redirect("https://redirect.invalid"),
    () => Response.json(ok({})),
    () => Response.json({ code: 200, data: { events: [] } }),
    () => Response.json({ code: "forbidden", data: { events: [] } }),
    () => { throw new TypeError("disconnected"); },
    () => Response.json(ok({ events: [] }))
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(["manual", "error"].includes(options.redirect));
    requests.push([url.origin, url.pathname]);
    return answers.shift()();
  });

  const env = { USERPROFILE: profile.profileDir, ADP_API_KEY: "uncached-key" };
  const cachedRegions = new Map();
  for (let index = 0; index < 9; index++) {
    await assert.rejects(() => new AdpClient(env, cachedRegions).prepareConnection());
    assert.equal(requests.length, index + 1);
  }
  assert.equal(await new AdpClient(env, cachedRegions).getCatalogRegion(), "cn");
  assert.equal(await new AdpClient(env, cachedRegions).prepareConnection(), "cn");
  assert.deepEqual(requests, Array.from({ length: 11 }, () => [cnOrigin, discoveryPath]));
});

test("an unknown Key in both regions leaves the guide available and sends no business request", async t => {
  const profile = await cliProfile(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url.origin, url.pathname, options.method]);
    return Response.json({ detail: "Accessor not found" }, { status: 404 });
  });

  const client = new AdpClient({ USERPROFILE: profile.profileDir, ADP_API_KEY: "unknown-key" });
  assert.equal(await client.getCatalogRegion(), "cn");
  assert.equal(client.catalogRegionConfirmed, false);
  const path = client.documentPath("/v1/app/doc/extract/create/task");
  await assert.rejects(() => client.request(path, { method: "POST", body: { file_url: fileUrl } }),
    error => error.details.code === "INVALID_API_KEY" && error.details.http_status === 404);
  assert.deepEqual(requests, [cnOrigin, globalOrigin, cnOrigin, globalOrigin].map(origin => [origin, discoveryPath, "GET"]));
});

test("explicit region, explicit origin, a custom tenant and matching CLI credentials skip discovery", async t => {
  const profile = await cliProfile(t);
  await profile.write("saved-key", globalOrigin);
  const clientEnvironment = { USERPROFILE: profile.profileDir };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url.origin, url.pathname, options.method]);
    return Response.json(ok({ task_id: "configured-task" }));
  });

  for (const [settings, origin, tenant, region] of [
    [{ ADP_API_KEY: "test-key", ADP_REGION: "global" }, globalOrigin, "laiye", "global"],
    [{ ADP_API_KEY: "test-key", ADP_API_BASE_URL: cnOrigin }, cnOrigin, "laiye", "cn"],
    [{ ADP_API_KEY: "test-key", ADP_TENANT_NAME: "custom" }, cnOrigin, "custom", "cn"],
    [{ ADP_API_KEY: "saved-key" }, globalOrigin, "laiye", "global"],
    [{}, globalOrigin, "laiye", "global"]
  ]) {
    const client = new AdpClient({ ...clientEnvironment, ...settings });
    const path = `/open/agentic_doc_processor/${tenant}/v1/app/doc/extract/create/task`;
    assert.equal(await client.prepareConnection(), region);
    await client.request(path, { method: "POST", body: { file_url: fileUrl } });
    assert.deepEqual(requests.at(-1), [origin, path, "POST"]);
  }
  assert.equal(requests.length, 5);
});

test("stdio uses the same discovered region for tools, guide and business calls", async t => {
  const profile = await cliProfile(t);
  const preload = `
    let probes = 0;
    globalThis.fetch = async (url, options) => {
      if (url.pathname === ${JSON.stringify(discoveryPath)} && options.method === 'GET') {
        probes++;
        if (probes === 1 && url.origin === ${JSON.stringify(cnOrigin)}) {
          return Response.json({ detail: 'Accessor not found' }, { status: 404 });
        }
        if (probes === 2 && url.origin === ${JSON.stringify(globalOrigin)}) {
          return Response.json({ code: 'success', data: { events: [] } });
        }
      }
      if (probes === 2 && url.origin === ${JSON.stringify(globalOrigin)}
          && url.pathname === '/open/agentic_doc_processor/laiye/v1/app/doc/extract/create/task'
          && options.method === 'POST' && JSON.parse(options.body).app_id === ${JSON.stringify(overseasFast)}) {
        return Response.json({ code: 'success', data: { task_id: 'global-extract' } });
      }
      throw new Error('Unexpected request in region discovery fixture');
    };
  `;
  const client = new Client({ name: "adp-v2-region-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry],
    env: { USERPROFILE: profile.profileDir, ADP_API_KEY: "standalone-key", ADP_ACCEPT_LANGUAGE: "zh" },
    stderr: "pipe"
  });
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  const appId = tools.find(tool => tool.name === "extract_document").inputSchema.properties.app_id;
  assert.ok(appId.enum.includes(overseasFast));
  assert.ok(!appId.enum.includes(domesticBill));
  const guide = await call(client, "get_adp_guide");
  assert.match(guide.structuredContent.markdown, /服务区域为全球区/);
  const rejected = await call(client, "extract_document", { app_id: domesticBill, file_url: fileUrl, wait: false });
  assert.equal(rejected.isError, true);
  const accepted = await call(client, "extract_document", { app_id: overseasFast, file_url: fileUrl, wait: false });
  assert.deepEqual(accepted.structuredContent.task_ref, { kind: "extract", id: "global-extract" });
});

test("global tools advertise and accept only the presets available in that region", async t => {
  const { client, calls } = await connect(t, () => ok({ task_id: "global-extract" }), "test-key", { ADP_REGION: "global" });
  const { tools } = await client.listTools();
  const input = tools.find(tool => tool.name === "extract_document").inputSchema.properties;
  const globalPresets = [overseasFast, "ootb_u2v5w8x1y4z7a0b3c6d9e2f5g8", "ootb_a3f8h1j5k9n2p7q4w6x0y3b5c8d1",
    "ootb_m9n2p5q8r1t4v7w0x3y6z9a2b5"];
  const domesticCard = "ootb_b7k2m5n8p1q4r7t0v3w6x9y2z5";
  assert.deepEqual(input.app_id.enum, globalPresets);
  assert.equal(input.enable_invoice_verify, undefined);

  const guide = await call(client, "get_adp_guide");
  assert.match(guide.structuredContent.markdown, /服务区域为全球区/);
  for (const id of globalPresets) assert.ok(guide.structuredContent.markdown.includes(id), id);
  assert.doesNotMatch(guide.structuredContent.markdown, /国内通用票据|身份证|enable_invoice_verify/);
  for (const app_id of [domesticBill, domesticCard]) {
    assert.equal((await call(client, "extract_document", { app_id, file_url: fileUrl, wait: false })).isError, true);
  }
  assert.equal(calls.length, 0);
  const accepted = await call(client, "extract_document", { app_id: overseasFast, file_url: fileUrl, wait: false });
  assert.equal(accepted.structuredContent.status, "pending");
  assert.equal(calls[0].body.app_id, overseasFast);
});

test("documented API errors keep their stable code, HTTP status and repair guidance", async t => {
  const fix = "请使用同类异步创建接口返回的 task_id，并核对账号、租户和区域；不要自动重新提交处理任务。";
  const { client, calls } = await connect(t, () => ({
    code: "http_server_error",
    message: "Synthetic upstream diagnostics are private",
    error: { code: "TASK_NOT_AVAILABLE", retryable: false, fix }
  }));
  const ref = { kind: "extract", id: "absent" };
  const reply = await call(client, "task", { task_ref: ref });
  assert.equal(reply.isError, true);
  assert.deepEqual(reply.structuredContent.task_ref, ref);
  const error = reply.structuredContent.error;
  assert.equal(error.code, "TASK_NOT_AVAILABLE");
  assert.equal(error.api_code, "http_server_error");
  assert.equal(error.http_status, 200);
  assert.equal(error.retryable, false);
  assert.equal(error.fix, fix);
  assert.doesNotMatch(reply.content[0].text, /Synthetic upstream diagnostics/);
  assert.equal(calls.length, 1);
});

test("task resolves each identifier form and rejects mixed or incomplete forms before requesting", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    if (path.startsWith(`${workflowPrefix}/v1/app/run/query/task/`)) {
      return { ...ok({ run_id: "run-query", status: "succeeded", output: {} }), usage: { credits_consumed: 1.2 } };
    }
    const id = path.split("/").at(-1);
    return { ...ok({ task_id: id, status: path.includes("/classify/") ? "success" : 4 }), usage: recordedUsage };
  });
  for (const [args, ref, path] of [
    [{ task_ref: { kind: "parse", id: "parse-query" } }, { kind: "parse", id: "parse-query" }, `${documentPrefix}/recognize/query/task/parse-query`],
    [{ action: "query", task_id: "extract-query", task_type: "extract" }, { kind: "extract", id: "extract-query" }, `${documentPrefix}/extract/query/task/extract-query`],
    [{ task_id: "classify-query", task_type: "classify" }, { kind: "classify", id: "classify-query" }, `${documentPrefix}/classify/query/task/classify-query`],
    [{ run_id: "run-query" }, { kind: "workflow", id: "run-query" }, `${workflowPrefix}/v1/app/run/query/task/run-query`]
  ]) {
    const reply = await call(client, "task", args);
    assert.notEqual(reply.isError, true);
    assert.equal(reply.structuredContent.action, "query");
    assert.equal(reply.structuredContent.status, "succeeded");
    assert.deepEqual(reply.structuredContent.task_ref, ref);
    assert.equal(calls.at(-1).path, path);
    assert.equal(calls.at(-1).method, "GET");
    assert.ok(reply.structuredContent.usage.credits_consumed > 0);
  }
  for (const args of [
    {}, { task_id: "extract-query" }, { task_type: "extract" },
    { task_ref: { kind: "parse", id: "parse-query" }, run_id: "run-query" },
    { task_ref: { kind: "parse", id: "parse-query" }, task_type: "parse" },
    { run_id: "run-query", task_id: "extract-query", task_type: "extract" },
    { run_id: "run-query", task_type: "parse" },
    { task_id: "extract-query", task_type: "workflow" },
    { run_id: "../run-query" }, { task_ref: { kind: "parse", id: "bad/id" } },
    { run_id: "run-query", reason: "Query cannot cancel" },
    { action: "cancel", task_id: "parse-query", task_type: "parse", reason: "Document reason is unsupported" }
  ]) {
    const reply = await call(client, "task", args);
    assert.equal(reply.isError, true, JSON.stringify(args));
    assert.equal(reply.structuredContent.status, "failed");
  }
  assert.equal(calls.length, 4);
});

test("task cancellation preserves actual states, is idempotent, and sends each POST only once", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    const task_id = path.split("/").at(-1);
    const status = task_id === "doc-running" ? "running" : task_id === "doc-succeeded" ? "succeeded"
      : task_id === "doc-failed" ? "failed" : "cancelled";
    return ok({ task_id, status, cancelled: status === "cancelled", already_cancelled: task_id === "doc-repeat" });
  });
  for (const [task_type, route] of [["parse", "recognize"], ["extract", "extract"], ["classify", "classify"]]) {
    const reply = await call(client, "task", { action: "cancel", task_id: `doc-${task_type}`, task_type });
    assert.notEqual(reply.isError, true);
    assert.deepEqual(reply.structuredContent, {
      status: "succeeded", action: "cancel", task_ref: { kind: task_type, id: `doc-${task_type}` },
      data: { task_id: `doc-${task_type}`, status: "cancelled", cancelled: true, already_cancelled: false }
    });
    assert.equal(calls.at(-1).path, `${documentPrefix}/${route}/cancel/task/doc-${task_type}`);
    assert.equal(calls.at(-1).body, "");
  }
  const repeat = await call(client, "task", { action: "cancel", task_ref: { kind: "parse", id: "doc-repeat" } });
  assert.notEqual(repeat.isError, true);
  assert.equal(repeat.structuredContent.data.already_cancelled, true);
  for (const status of ["running", "succeeded", "failed"]) {
    const ref = { kind: "extract", id: `doc-${status}` };
    const reply = await call(client, "task", { action: "cancel", task_ref: ref });
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.status, "failed");
    assert.equal(reply.structuredContent.data.status, status);
    assert.equal(reply.structuredContent.error.code, "TASK_NOT_CANCELLABLE");
    assert.deepEqual(reply.structuredContent.task_ref, ref);
    assert.deepEqual(reply.structuredContent.next_steps[0].arguments, { task_ref: ref });
    assert.equal(reply.structuredContent.next_steps[0].tool, "task");
    assert.equal(reply.structuredContent.usage, undefined);
  }
  for (const args of [{ run_id: "run-unsupported" }, { task_ref: { kind: "workflow", id: "run-unsupported" } }]) {
    const workflow = await call(client, "task", { action: "cancel", ...args });
    assert.equal(workflow.isError, true);
    assert.equal(workflow.structuredContent.error.code, "TASK_CANCELLATION_UNSUPPORTED");
    assert.deepEqual(workflow.structuredContent.task_ref, { kind: "workflow", id: "run-unsupported" });
    assert.deepEqual(workflow.structuredContent.next_steps[0].arguments, { task_ref: workflow.structuredContent.task_ref });
    assert.equal(workflow.structuredContent.next_steps[0].tool, "task");
    assert.equal(workflow.structuredContent.data, undefined);
  }
  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ method }) => method === "POST"));
});

test("task queries cancelled tasks without a tool error and keeps available recorded usage", async t => {
  const { client, calls } = await connect(t, ({ method, path }) => {
    if (method === "POST") return ok({ task_id: "cancelled" });
    if (path.includes("/run/")) return { ...ok({ run_id: "cancelled", status: "cancelled" }), usage: { credits_consumed: 0.5 } };
    return { ...ok({ task_id: "cancelled", status: path.includes("/classify/") ? "cancelled" : 6 }), usage: recordedUsage };
  });
  for (const kind of ["parse", "extract", "classify", "workflow"]) {
    const reply = await call(client, "task", { task_ref: { kind, id: "cancelled" } });
    assert.notEqual(reply.isError, true);
    assert.equal(reply.structuredContent.status, "cancelled");
    assert.equal(reply.structuredContent.error, undefined);
    assert.equal(reply.structuredContent.usage_status, "available");
    assert.ok(reply.structuredContent.usage.credits_consumed > 0);
  }
  const parsed = await call(client, "parse_document", { files: [{ url: fileUrl }] });
  assert.notEqual(parsed.isError, true);
  assert.equal(parsed.structuredContent.status, "cancelled");
  assert.equal(parsed.structuredContent.files[0].status, "cancelled");
  assert.equal(parsed.structuredContent.files[0].error, undefined);
  assert.equal(calls.length, 6);
});

test("task treats malformed cancellation receipts as unconfirmed and never repeats the cancellation", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    const id = path.split("/").at(-1);
    const base = { task_id: id, status: "cancelled", cancelled: true, already_cancelled: false };
    if (id === "wrong-id") return ok({ ...base, task_id: "other" });
    if (id === "missing-data") return ok(null);
    if (id === "missing-boolean") return ok({ task_id: id, status: "cancelled" });
    if (id === "inconsistent") return ok({ ...base, cancelled: false });
    if (id === "inconsistent-repeat") return ok({ ...base, status: "running", cancelled: false, already_cancelled: true });
    return ok({ ...base, status: "unknown" });
  });
  const ids = ["wrong-id", "missing-data", "missing-boolean", "inconsistent", "inconsistent-repeat", "unknown"];
  for (const id of ids) {
    const ref = { kind: "parse", id };
    const reply = await call(client, "task", { action: "cancel", task_ref: ref });
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.error.acceptance_unknown, true);
    assert.equal(reply.structuredContent.error.retryable, false);
    assert.deepEqual(reply.structuredContent.task_ref, ref);
    assert.equal(reply.structuredContent.usage, undefined);
    assert.equal(reply.structuredContent.next_steps[0].tool, undefined);
  }
  assert.equal(calls.length, ids.length);
  assert.ok(calls.every(({ method }) => method === "POST"));
});

test("wait polling honors Retry-After while a rejected submission stays a single POST", async t => {
  let queryCount = 0;
  const { client, calls } = await connect(t, ({ method, body }, response) => {
    if (method === "POST" && body.file_url === fileUrl) return ok({ task_id: "parse-rate-limited" });
    if (method === "GET" && ++queryCount > 1) return ok({ task_id: "parse-rate-limited", status: 4 });
    response.statusCode = 429;
    response.setHeader("Retry-After", method === "GET" ? "1" : "0");
    return { detail: "Too many requests" };
  });
  const waited = await call(client, "parse_document", { file_url: fileUrl, wait_timeout_seconds: 4 });
  assert.equal(waited.structuredContent.status, "succeeded");
  assert.deepEqual(calls.map(item => item.method), ["POST", "GET", "GET"]);
  assert.ok(calls[2].receivedAt - calls[1].receivedAt >= 900);
  const rejected = await call(client, "parse_document", { file_url: "https://example.invalid/rate-limited.pdf" });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.http_status, 429);
  assert.equal(rejected.structuredContent.error.retryable, false);
  assert.equal(calls.length, 4);
});

test("Retry-After beyond the waiting budget returns the original reference", async t => {
  const { client, calls } = await connect(t, ({ method }, response) => {
    if (method === "POST") return ok({ task_id: "parse-deferred" });
    response.statusCode = 429;
    response.setHeader("Retry-After", "20");
    return { detail: "Too many requests" };
  });
  const reply = await call(client, "parse_document", { file_url: fileUrl, wait_timeout_seconds: 1 });
  const result = reply.structuredContent;
  assert.equal(result.status, "pending");
  assert.deepEqual(result.task_ref, { kind: "parse", id: "parse-deferred" });
  assert.equal(result.query_error.retry_after_ms, 20_000);
  const next = result.next_steps.find(step => step.tool === "task");
  assert.deepEqual(next.arguments, { task_ref: result.task_ref });
  assert.match(next.message, /等待至少 20 秒/);
  assert.deepEqual(calls.map(item => item.method), ["POST", "GET"]);
});

test("batch submission bounds in-flight requests and preserves file order", async t => {
  let active = 0;
  let peak = 0;
  const { client, calls } = await connect(t, async ({ body }) => {
    active++;
    peak = Math.max(peak, active);
    const fileIndex = Number(new URL(body.file_url).pathname.split(".")[0].slice(1));
    await delay(30 + 10 * (fileIndex % 3));
    active--;
    return ok({ task_id: `parse-${fileIndex}` });
  });
  const files = Array.from({ length: 8 }, (_, index) => ({
    url: `https://example.invalid/${index}.pdf`, name: `${index}.pdf`
  }));
  const reply = await call(client, "parse_document", { files, wait: false });
  const result = reply.structuredContent;
  assert.equal(result.status, "pending");
  assert.equal(peak, 3);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(item => item.method === "POST"));
  assert.deepEqual(result.files.map(file => [file.name, file.task_ref.id]),
    files.map(({ name }, index) => [name, `parse-${index}`]));
});

async function cliProfile(t) {
  const profileDir = await mkdtemp(join(tmpdir(), "adp-v2-cli-test-"));
  const configDir = join(profileDir, ".adp");
  await mkdir(configDir);
  const configFile = join(configDir, "config.json");
  const keyFile = join(configDir, "key.enc");
  t.after(async () => {
    await rm(configFile, { force: true });
    await rm(keyFile, { force: true });
    await rmdir(configDir);
    await rmdir(profileDir);
  });
  return {
    profileDir,
    configFile,
    keyFile,
    async write(apiKey, baseUrl, tenant) {
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([nonce, cipher.update(apiKey, "utf8"), cipher.final(), cipher.getAuthTag()]);
      const config = JSON.stringify({ api_key: encrypted.toString("hex"), api_base_url: baseUrl, tenant_name: tenant });
      await writeFile(keyFile, key, { mode: 0o600 });
      await writeFile(configFile, config, { mode: 0o600 });
      return config;
    }
  };
}

test("stdio automatically reuses CLI credentials and picks up changes between calls without writing the profile", async t => {
  const profile = await cliProfile(t);
  const { client, calls, baseUrl } = await connect(t, ({ path }) => {
    assert.equal(path, "/open/agentic_doc_processor/cli-tenant/v1/app/doc/recognize/query/task/parse-1");
    return ok({ task_id: "parse-1", status: 4 });
  }, "", {
    USERPROFILE: profile.profileDir,
    ADP_API_BASE_URL: "",
    ADP_TENANT_NAME: ""
  });
  const task_ref = { kind: "parse", id: "parse-1" };
  const guide = await call(client, "get_adp_guide");
  assert.equal(guide.structuredContent.status, "succeeded");
  const missing = await call(client, "task", { task_ref });
  assert.equal(missing.structuredContent.error.code, "MISSING_API_KEY");
  assert.match(missing.structuredContent.error.message, /adp\.laiye\.com\?from=getkey&utm_source=github/);
  assert.equal(calls.length, 0);

  await writeFile(profile.configFile, JSON.stringify({ api_base_url: baseUrl, tenant_name: "cli-tenant" }));
  const incomplete = await call(client, "task", { task_ref });
  assert.equal(incomplete.structuredContent.error.code, "MISSING_API_KEY");
  assert.equal(calls.length, 0);

  const config = await profile.write("synthetic-cli-key-one", baseUrl, "cli-tenant");
  const keyBytes = await readFile(profile.keyFile);
  const result = await call(client, "task", { task_ref });
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(calls[0].key, "synthetic-cli-key-one");
  assert.equal(await readFile(profile.configFile, "utf8"), config);
  assert.deepEqual(await readFile(profile.keyFile), keyBytes);

  await profile.write("synthetic-cli-key-two", baseUrl, "cli-tenant");
  const rotated = await call(client, "task", { task_ref });
  assert.equal(rotated.structuredContent.status, "succeeded");
  assert.equal(calls[1].key, "synthetic-cli-key-two");
  assert.doesNotMatch(JSON.stringify(rotated), /synthetic-cli-key/);

  const corrupted = JSON.parse(await readFile(profile.configFile, "utf8"));
  const lastByte = Number.parseInt(corrupted.api_key.slice(-2), 16);
  corrupted.api_key = corrupted.api_key.slice(0, -2) + (lastByte ^ 1).toString(16).padStart(2, "0");
  await writeFile(profile.configFile, JSON.stringify(corrupted));
  const invalid = await call(client, "task", { task_ref });
  assert.equal(invalid.structuredContent.error.code, "CLI_CREDENTIALS_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(invalid), /synthetic-cli-key/);
  assert.equal(calls.length, 2);
});

test("CLI credentials stay bound to their address and tenant, with explicit Key taking precedence", async t => {
  const profile = await cliProfile(t);
  await profile.write("synthetic-cli-key", "https://adp-global.laiye.com/");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: url.href, key: options.headers.get("X-API-KEY") });
    return Response.json(ok({}));
  });
  const query = async environment => {
    const client = new AdpClient({ USERPROFILE: profile.profileDir, ...environment });
    return client.request(client.documentPath("/v1/webhook/events"));
  };
  await query({});
  assert.deepEqual(requests[0], {
    url: "https://adp-global.laiye.com/open/agentic_doc_processor/laiye/v1/webhook/events",
    key: "synthetic-cli-key"
  });
  await query({ ADP_API_KEY: "synthetic-cli-key" });
  assert.deepEqual(requests[1], requests[0]);
  await query({ ADP_API_KEY: "another-key", ADP_REGION: "cn" });
  assert.equal(new URL(requests[2].url).hostname, "adp.laiye.com");
  assert.equal(requests[2].key, "another-key");
  for (const conflict of [
    { ADP_REGION: "cn" },
    { ADP_API_BASE_URL: "https://adp.laiye.com" },
    { ADP_BASE_URL: "https://adp.laiye.com" },
    { ADP_TENANT_NAME: "another-tenant" }
  ]) {
    await assert.rejects(() => query(conflict), error => error.details.code === "CLI_CREDENTIAL_TARGET_MISMATCH");
  }
  assert.equal(requests.length, 3);

  await rm(profile.keyFile);
  await query({ ADP_API_KEY: "explicit-key", ADP_REGION: "cn", ADP_TENANT_NAME: "own-tenant" });
  assert.deepEqual(requests[3], {
    url: "https://adp.laiye.com/open/agentic_doc_processor/own-tenant/v1/webhook/events",
    key: "explicit-key"
  });
});
