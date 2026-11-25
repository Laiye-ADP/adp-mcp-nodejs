import assert from "node:assert/strict";
import { once } from "node:events";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdpClient } from "../dist/adp-client.js";
import { callTool } from "../dist/tools.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const documentPrefix = "/open/agentic_doc_processor/test-tenant/v1/app/doc";
const catalogDetail = "/open/agentic_doc_processor/test-tenant/v1/app-catalog/detail";
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
const presetDetail = app_id => ok({ app_id, source: "preset", engine_type: "extract" });

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

test("tool discovery publishes the reviewed catalog and guide in both locales", async t => {
  const expected = JSON.parse(await readFile(new URL("../catalog/tools.zh-CN.json", import.meta.url), "utf8"));
  const { client, calls } = await connect(t, () => assert.fail("Unexpected business request"), "", { ADP_REGION: "cn" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools, expected);
  assert.equal(tools.length, 15);
  function checkForm(schema, path) {
    assert.equal(typeof schema.type, "string", path);
    for (const key of ["anyOf", "oneOf", "allOf", "if", "then", "not", "$ref"]) {
      assert.ok(!(key in schema), path + "." + key);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assert.ok(property.title && property.description, path + "." + name);
      checkForm(property, path + "." + name);
    }
    if (schema.items) checkForm(schema.items, path + "[]");
  }
  for (const tool of tools) checkForm(tool.inputSchema, tool.name);
  const extractProperties = tools.find(tool => tool.name === "extract_document").inputSchema.properties;
  assert.ok("file_url" in extractProperties && "file_base64" in extractProperties);
  assert.ok(!("file" in extractProperties));
  const guide = await call(client, "get_adp_guide");
  assert.match(guide.content[0].text, /按指定字段同步抽取/);
  assert.match(guide.content[0].text, /用户明确要求或同意提交后，再调用 `submit_user_feedback`/);
  assert.match(guide.content[0].text, /对比预置应用和自定义抽取应用/);
  assert.match(guide.content[0].text, /upload_file.*data\.download_url/);
  assert.match(guide.content[0].text, /attachment_paths.*attachments_authorized=true/);
  assert.doesNotMatch(guide.content[0].text, /prepare_file_upload|model_params\.pages/);
  assert.doesNotMatch(guide.content[0].text, /ootb_|files\[\]/);
  const english = await connect(t, () => assert.fail("Unexpected business request"), "",
    { ADP_REGION: "global", ADP_ACCEPT_LANGUAGE: "en" });
  const enGuide = await call(english.client, "get_adp_guide");
  assert.match(enGuide.content[0].text, /The request waits for the result/);
  assert.match(guide.content[0].text, /当前请求会等待结果/);
  assert.match(enGuide.content[0].text, /compare.*field accuracy/);
  for (const topic of [
    "Typical business scenarios and tool selection", "Core advantages of ADP MCP", "Supported document formats",
    "Recommended steps", "Choose synchronous or asynchronous processing", "How many documents can run at once?",
    "Handle user feedback"
  ]) assert.ok(enGuide.content[0].text.includes(topic), "missing English guide topic: " + topic);
  assert.match(enGuide.content[0].text, /upload_file.*data\.download_url/);
  assert.match(enGuide.content[0].text, /attachment_paths.*attachments_authorized=true/);
  assert.doesNotMatch(enGuide.content[0].text, /prepare_file_upload|model_params\.pages|verify_invoice|mainland China invoices/);
  assert.doesNotMatch(enGuide.content[0].text, /submits a background task and waits/);
  assert.doesNotMatch(guide.content[0].text, /先提交后台任务，再等待/);
  for (const reply of [guide, enGuide]) {
    const markdown = reply.structuredContent.markdown;
    assert.equal(markdown, reply.content[0].text);
    for (const term of ["Laiye Agentic Document Processing", "wait=true", "wait=false", "fields", "status=pending",
      "task_ref", "get_task", "retry_after_ms", "get_credits", "INSUFFICIENT_CREDITS", "recorded_credits"]) {
      assert.ok(markdown.includes(term), "missing guide term: " + term);
    }
    assert.doesNotMatch(markdown, /\{portal_link\}|\{credit_action\}|<!-- china-invoice -->/);
    assert.match(markdown, /\| 15 \| 15 \|/);
    assert.match(markdown, /\| 35 \| 35 \|/);
  }
  const zhGuide = await call(english.client, "get_adp_guide", { language: "zh-CN" });
  assert.match(zhGuide.content[0].text, /按指定字段同步抽取/);
  assert.doesNotMatch(zhGuide.content[0].text, /verify_invoice|对符合条件的发票进行验真/);
  assert.equal((await english.client.listTools()).tools.length, 14);
  assert.equal(calls.length + english.calls.length, 0);
});

test("English discovery localizes both regions without changing tool arguments or calls", async t => {
  const chinese = JSON.parse(await readFile(new URL("../catalog/tools.zh-CN.json", import.meta.url), "utf8"));
  function machineContract(value) {
    if (Array.isArray(value)) return value.map(machineContract);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "title" && key !== "description")
      .map(([key, item]) => [key, machineContract(item)]));
  }
  function checkEnglishText(value) {
    if (Array.isArray(value)) return value.forEach(checkEnglishText);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "title" || key === "description") && typeof item === "string") {
        assert.doesNotMatch(item, /[一-鿿]/u);
      } else {
        checkEnglishText(item);
      }
    }
  }
  for (const region of ["cn", "global"]) {
    const { client, calls } = await connect(t, ({ path }) => {
      assert.equal(path, "/open/agentic_doc_processor/test-tenant/v1/user/payment");
      return ok({ total_credits: 100, used_credits: 10, expired_credits: 0, remaining_credits: 90 });
    }, "test-key", { ADP_REGION: region, ADP_ACCEPT_LANGUAGE: "en-US" });
    const { tools } = await client.listTools();
    const expected = structuredClone(chinese).filter(({ name }) => region === "cn" || name !== "verify_invoice");
    if (region === "global") {
      delete expected.find(tool => tool.name === "extract_document").inputSchema.properties.enable_invoice_verify;
    }
    assert.deepEqual(machineContract(tools), machineContract(expected));
    checkEnglishText(tools);
    assert.equal(tools.find(tool => tool.name === "upload_file").title, "Upload files");
    assert.equal(tools.find(tool => tool.name === "parse_document").title, "Parse a document");
    assert.match(tools.find(tool => tool.name === "extract_document").description, /one-off/i);
    const result = await call(client, "get_credits");
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.data.remaining_credits, 90);
    assert.equal(calls.length, 1);
  }
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

test("feedback rejects invalid inputs and reports an inconclusive receipt without retrying", async t => {
  const { client, calls } = await connect(t, () => ok({ id: "no-date" }));
  const summary = { feedback_type: "suggestion", content: "Add a category search." };
  for (const args of [
    { ...summary, feedback_type: "other" }, { ...summary, content: "   " }, { ...summary, content: "x".repeat(1001) },
    { ...summary, attachment_paths: Array(6).fill("file.txt"), attachments_authorized: true }
  ]) {
    const reply = await call(client, "submit_user_feedback", args);
    assert.equal(reply.structuredContent.error.code, "INVALID_ARGUMENTS");
  }
  assert.equal(calls.length, 0);
  const reply = await call(client, "submit_user_feedback", summary);
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.error.code, "FEEDBACK_RECEIPT_MISSING");
  assert.equal(reply.structuredContent.error.acceptance_unknown, true);
  assert.equal(reply.structuredContent.error.retryable, false);
  assert.equal(calls.length, 1);
});

test("credit guidance follows the configured workspace even when the guide language differs", async t => {
  const { profileDir } = await cliProfile(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("Workspace guidance must not make a billing or network request"));
  const targets = [
    [{ ADP_API_BASE_URL: cnOrigin, ADP_ACCEPT_LANGUAGE: "en" }, cnOrigin, /Account Management/, [globalOrigin]],
    [{ ADP_REGION: "global", ADP_ACCEPT_LANGUAGE: "zh" }, globalOrigin, /联系来也/, [cnOrigin]],
    [{ ADP_REGION: "cn", ADP_API_BASE_URL: "https://private.example", ADP_ACCEPT_LANGUAGE: "zh" },
      "本部署", /管理员/, [cnOrigin, globalOrigin]],
    [{ ADP_ACCEPT_LANGUAGE: "en" }, "region", /balance/i, [cnOrigin, globalOrigin]],
    [{ ADP_REGION: "invalid" }, "区域", /余额/, [cnOrigin, globalOrigin]]
  ];
  for (const [settings, destination, action, excluded] of targets) {
    const client = new AdpClient({ USERPROFILE: profileDir, ...settings });
    const result = await callTool("get_adp_guide", {}, client, "test");
    assert.equal(result.status, "succeeded");
    assert.ok(result.markdown.includes(destination));
    assert.match(result.markdown, action);
    for (const origin of excluded) assert.ok(!result.markdown.includes(origin));
  }
});

test("parse_document allows four explicit modes and chooses a default for both recognition endpoints", async t => {
  const { client, calls } = await connect(t, ({ path }) => path.endsWith("/create/task")
    ? ok({ task_id: "parse-job" }) : ok({ status: 4, doc_recognize_result: ["text"] }));
  const modes = ["agentic", "fast_vlm", "agentic_v2", "thai_ocr"];
  const catalog = (await client.listTools()).tools.find(tool => tool.name === "parse_document");
  assert.deepEqual(catalog.inputSchema.properties.recognize_mode.enum, modes);
  assert.ok(!Object.hasOwn(catalog.inputSchema.properties.recognize_mode, "default"));
  assert.match(catalog.description, /默认使用增强解析 2.0（fast_vlm）/);
  for (const key of ["recognize_mode", "remove_header_footer", "enable_highlight"]) {
    assert.doesNotMatch(catalog.inputSchema.properties[key].description, /\b(?:standard|advance)\b/);
  }
  assert.equal(catalog.inputSchema.properties.enable_highlight.type, "integer");
  assert.deepEqual(catalog.inputSchema.properties.enable_highlight.enum, [0, 1]);

  for (const wait of [true, false]) {
    for (const recognize_mode of ["standard", "advance"]) {
      const count = calls.length;
      const result = await call(client, "parse_document", { file_url: fileUrl, recognize_mode, wait });
      assert.equal(result.isError, true, recognize_mode);
      assert.equal(result.structuredContent.error.code, "INVALID_ARGUMENTS");
      assert.equal(calls.length, count);
    }
    for (const recognize_mode of modes) {
      const enable_highlight = recognize_mode === "thai_ocr" ? 0 : 1;
      const remove_header_footer = ["agentic", "agentic_v2"].includes(recognize_mode);
      const config = { recognize_mode, enable_highlight, remove_header_footer };
      const result = await call(client, "parse_document", { file_url: fileUrl, ...config, wait });
      assert.equal(result.structuredContent.status, wait ? "succeeded" : "pending");
      assert.equal(calls.at(-1).path, documentPrefix + (wait ? "/recognize" : "/recognize/create/task"));
      assert.deepEqual(calls.at(-1).body.model_params.recognize_config, config);
    }
  }
  for (const args of [
    { enable_highlight: 1, recognize_mode: "thai_ocr" }, { recognize_mode: "thai_ocr", remove_header_footer: true },
    { recognize_mode: "fast_vlm", remove_header_footer: true }, { enable_highlight: true }, { enable_highlight: 2 }
  ]) {
    const result = await call(client, "parse_document", { file_url: fileUrl, ...args });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 2 * modes.length);
  }
  for (const wait of [true, false]) {
    for (const [input, expectedParams] of [
      [{}, { recognize_config: { recognize_mode: "fast_vlm" } }],
      [{ remove_header_footer: false, enable_highlight: 0 }, { recognize_config: {
        recognize_mode: "fast_vlm", remove_header_footer: false, enable_highlight: 0
      } }],
      [{ enable_highlight: 1, enable_stamp_recognition: true, pages: [3] }, { pages: [3], recognize_config: {
        recognize_mode: "fast_vlm", enable_highlight: 1, enable_stamp_recognition: true, enable_pdf_parse: false
      } }],
      [{ remove_header_footer: true }, { recognize_config: { recognize_mode: "agentic_v2", remove_header_footer: true } }]
    ]) {
      const result = await call(client, "parse_document", { file_url: fileUrl, ...input, wait });
      assert.equal(result.structuredContent.status, wait ? "succeeded" : "pending");
      assert.equal(calls.at(-1).path, documentPrefix + (wait ? "/recognize" : "/recognize/create/task"));
      assert.deepEqual(calls.at(-1).body.model_params, expectedParams);
    }
  }
});

test("document tools use their OpenAPI single-file bodies and reject mixed shapes before submission", async t => {
  const { client, calls } = await connect(t, ({ path }) => path.endsWith("/direct-fast")
    ? ok({ extraction_result: [{ name: "客户", value: "ACME" }] }) : ok({ task_id: "accepted" }));
  const file_base64 = "cGRm";
  for (const [name, args] of [
    ["parse_document", { files: [{ url: fileUrl }] }],
    ["parse_document", { file_url: fileUrl, file_base64 }],
    ["parse_document", { file_url: fileUrl, remove_header_footer: true, recognize_mode: "thai_ocr" }],
    ["extract_document", { app_id: "custom-app", files: [{ url: fileUrl }] }],
    ["extract_document", { file_url: fileUrl, fields: [], pages: [], wait: true, wait_timeout_seconds: 60 }],
    ["extract_document", { file_url: fileUrl, file_base64, fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: fileUrl, file: { url: fileUrl }, fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: fileUrl, wait: false, fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: fileUrl, wait_timeout_seconds: 120, fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: fileUrl, pages: [1], fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: fileUrl, file_name: "name.pdf", fields: [{ name: "客户" }] }],
    ["extract_document", { file_url: "jobid://00112233445566778899aabbccddeeff", fields: [{ name: "客户" }] }],
    ["extract_document", { file: { url: fileUrl, base64: file_base64 }, fields: [{ name: "客户" }] }],
    ["extract_document", { file: { url: fileUrl }, fields: [{ name: "客户" }], wait: false }],
    ["extract_document", { file: { url: fileUrl }, fields: [{ name: "A" }, { name: "a" }] }],
    ["extract_document", { app_id: "custom-app", fields: [{ name: "客户" }], file_url: fileUrl }],
    ["extract_document", { app_id: "a", file_url: "jobid://00112233445566778899aabbccddeeff", file_base64 }],
    ["classify_document", { app_id: "classify-app", files: [{ url: fileUrl }] }],
    ["classify_document", { app_id: "classify-app", file_base64, pages: [1, 1] }],
  ]) {
    const result = await call(client, name, args);
    assert.equal(result.isError, true, name + JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  const parsed = (await call(client, "parse_document", {
    file_name: "notes.pdf", file_base64, pages: [2, 4], remove_header_footer: true, enable_stamp_recognition: true, wait: false
  })).structuredContent;
  assert.deepEqual(parsed.task_ref, { kind: "parse", id: "accepted" });
  assert.deepEqual(calls.at(-1).body, {
    app_id: "ootb_k7m2x9p4v1n8w3q6r5t0y2b4", file_name: "notes.pdf", file_base64,
    model_params: { pages: [2, 4], recognize_config: { recognize_mode: "agentic_v2",
      remove_header_footer: true, enable_stamp_recognition: true, enable_pdf_parse: false } }
  });
  const enhanced = await call(client, "parse_document", { file_url: fileUrl, recognize_mode: "fast_vlm", wait: false });
  assert.equal(enhanced.structuredContent.status, "pending");
  assert.deepEqual(calls.at(-1).body.model_params, { recognize_config: { recognize_mode: "fast_vlm" } });
  const jobid = "jobid://00112233445566778899aabbccddeeff";
  for (const input of [{ file_url: jobid }, { file_url: fileUrl, file_base64 }]) {
    const r = await call(client, "extract_document", { app_id: "team-contract", ...input, fields: [], pages: [3], wait: false });
    assert.equal(r.structuredContent.status, "pending");
    assert.deepEqual(calls.at(-1).body, { app_id: "team-contract", ...input, model_params: { pages: [3] } });
  }
  const fields = [{ name: "客户", prompt: null }];
  for (const [input, expectedFile] of [
    [{ file_url: fileUrl, pages: [], wait: true, wait_timeout_seconds: 60 }, { url: fileUrl }],
    [{ file_base64, file_name: "" }, { base64: file_base64 }],
    [{ file: { base64: file_base64 } }, { base64: file_base64 }],
  ]) {
    const direct = (await call(client, "extract_document", { ...input, fields })).structuredContent;
    assert.equal(direct.status, "succeeded");
    assert.equal(direct.task_ref, undefined);
    assert.equal(calls.at(-1).path, documentPrefix + "/extract/direct-fast");
    assert.deepEqual(calls.at(-1).body, { file: expectedFile, fields });
  }
  const classify = (await call(client, "classify_document", { file_base64, app_id: "classify", pages: [2, 3], wait: false })).structuredContent;
  assert.deepEqual(classify.task_ref, { kind: "classify", id: "accepted" });
  assert.deepEqual(calls.at(-1).body, { file_base64, app_id: "classify", model_params: { pages: [2, 3] } });
  const allPages = await call(client, "classify_document", { file_base64, app_id: "classify", pages: [], wait: false });
  assert.equal(allPages.structuredContent.status, "pending");
  assert.deepEqual(calls.at(-1).body, { file_base64, app_id: "classify" });
});

for (const language of ["zh", "en-US"]) {
  test(`rejected document inputs explain how to correct the next stdio call (${language})`, async t => {
    const { client, calls } = await connect(t, ({ path }) => {
      switch (path) {
        case documentPrefix + "/recognize/create/task": return ok({ task_id: "accepted" });
        case documentPrefix + "/recognize/query/task/accepted":
          return ok({ task_id: "accepted", status: 4, doc_recognize_result: [] });
        case documentPrefix + "/extract/direct-fast": return ok({ extraction_result: [{ name: "total", value: "7" }] });
        default: assert.fail("Unexpected request " + path);
      }
    }, "test-key", { ADP_ACCEPT_LANGUAGE: language });
    const messages = language === "zh" ? {
      missing_file_source: /缺少待处理文件.*file_url 或 file_base64/,
      incomplete_task_ref: /task_ref（包含 kind 和 id）.*同时传入 task_type 和 task_id/,
      file_name_not_supported_with_fields: /移除 file_name，保留文件来源和 fields/
    } : {
      missing_file_source: /Provide one file using file_url or file_base64/,
      incomplete_task_ref: /task_ref containing kind and id.*both task_type and task_id/,
      file_name_not_supported_with_fields: /remove file_name and retry with the file source and fields/
    };
    async function rejected(name, args, reason) {
      const before = calls.length;
      const result = await call(client, name, args);
      assert.equal(result.isError, true);
      const error = result.structuredContent.error;
      assert.equal(error.code, "INVALID_ARGUMENTS");
      assert.equal(error.reason, reason);
      assert.match(error.message, messages[reason]);
      assert.equal(calls.length, before);
    }
    await rejected("parse_document", { wait: false }, "missing_file_source");
    const submitted = await call(client, "parse_document", { file_url: fileUrl, wait: false });
    const ref = submitted.structuredContent.task_ref;
    assert.deepEqual(ref, { kind: "parse", id: "accepted" });

    await rejected("get_task", { task_ref: {} }, "incomplete_task_ref");
    const queried = await call(client, "get_task", { task_ref: ref });
    assert.equal(queried.structuredContent.status, "succeeded");
    const split = await call(client, "get_task", { task_ref: {}, task_type: ref.kind, task_id: ref.id });
    assert.equal(split.structuredContent.status, "succeeded");

    const fields = [{ name: "total" }];
    const input = { fields, file_url: fileUrl };
    await rejected("extract_document", { ...input, file_name: "invoice.pdf" }, "file_name_not_supported_with_fields");
    const extracted = await call(client, "extract_document", input);
    assert.equal(extracted.structuredContent.status, "succeeded");
    assert.deepEqual(calls.at(-1).body, { file: { url: fileUrl }, fields });

    await rejected("cancel_task", { task_ref: { kind: "parse" } }, "incomplete_task_ref");
    await rejected("get_task", { task_type: "extract" }, "incomplete_task_ref");
    await rejected("classify_document", { app_id: "classification" }, "missing_file_source");
    await rejected("extract_document", { app_id: "saved" }, "missing_file_source");
    await rejected("extract_document", { fields }, "missing_file_source");
    for (const [name, args] of [
      ["parse_document", { file_url: fileUrl, file_base64: "cGRm" }],
      ["extract_document", { fields, file: { wrong_key: "value" } }],
      ["get_task", { task_ref: { kind: "workflow", id: "unused" } }]
    ]) {
      const other = await call(client, name, args);
      assert.equal(other.isError, true);
      assert.equal(other.structuredContent.error.reason, undefined);
    }
    assert.equal(calls.length, 4);
  });
}

test("app discovery, extraction configuration and credits follow the tenant-scoped OpenAPI", async t => {
  const base = "/open/agentic_doc_processor/test-tenant/v1";
  const app = { app_id: "app-a", app_name: "合同", source: "custom", engine_type: "extract" };
  const fields = [{ field_key: "amount", field_name: "金额", field_type: "number" }];
  const credit = { total_credits: 12, used_credits: 3, expired_credits: 0, remaining_credits: 9 };
  const { client, calls } = await connect(t, ({ path }) => {
    const url = new URL(path, "http://fixture.invalid");
    if (url.pathname === base + "/app-catalog/detail") return ok({ ...app, extract_fields: fields, config_version: "v1" });
    if (url.pathname === base + "/app-catalog") return ok({ list: [app], range: { offset: 0, size: 1, total: 1 } });
    if (url.pathname === base + "/app-manage/create") return ok({ ...app, config_version: "v1" });
    if (url.pathname === base + "/app-catalog/extraction/update") return ok({ ...app, config_version: "v2" });
    if (url.pathname === base + "/app-catalog/extraction/delete") return ok({ success: true, message: "" });
    if (url.pathname === base + "/user/payment") return { user_id: "discard", payment_type: "free", ...credit };
    assert.fail(path);
  });
  const query = { engine_type: "extract", source: "preset", app_name: "中文&test=1", document_type: "身份证" };
  const listed = (await call(client, "list_apps", query)).structuredContent;
  assert.equal(listed.status, "succeeded");
  assert.deepEqual(Object.fromEntries(new URL(calls.at(-1).path, "http://fixture.invalid").searchParams), query);
  const detail = (await call(client, "get_app", { app_id: "app-a", config_version: "v1" })).structuredContent;
  assert.deepEqual(detail.data.extract_fields, fields);
  const created = (await call(client, "create_extraction_app", { app_name: "合同", extract_fields: fields, timeout_seconds: 20 })).structuredContent;
  assert.equal(created.config_version, "v1");
  assert.deepEqual(calls.at(-1).body, { ai_function: 1425, app_name: "合同", extract_fields: fields });
  const update = { app_id: detail.data.app_id, extract_fields: detail.data.extract_fields, config_version: "v1" };
  const updated = (await call(client, "update_extraction_app", update)).structuredContent;
  assert.equal(updated.config_version, "v2");
  assert.equal(calls.at(-1).path, base + "/app-catalog/extraction/update");
  assert.deepEqual(calls.at(-1).body, update);
  const deleted = (await call(client, "delete_extraction_app", { app_id: "app-a" })).structuredContent;
  assert.equal(deleted.success, true);
  assert.equal(calls.at(-1).path, base + "/app-catalog/extraction/delete");
  assert.deepEqual(calls.at(-1).body, { app_id: "app-a" });
  assert.deepEqual((await call(client, "get_credits")).structuredContent, { status: "succeeded", data: credit });
  assert.deepEqual(calls.map(c => c.method), ["GET", "GET", "POST", "POST", "POST", "GET"]);
  const defaultList = (await call(client, "list_apps", { offset: 0, limit: 1 })).structuredContent;
  assert.equal(defaultList.status, "succeeded");
  const filters = Object.fromEntries(new URL(calls.at(-1).path, "http://fixture.invalid").searchParams);
  assert.deepEqual(filters, { engine_type: "document", offset: "0", limit: "1" });
  for (const hiddenType of ["workflow", "document"]) {
    assert.equal((await call(client, "list_apps", { engine_type: hiddenType })).isError, true);
  }
  assert.equal((await call(client, "update_extraction_app", { app_id: "app-a" })).isError, true);
  assert.equal(calls.length, 7);
});

test("create_extraction_app creates a reusable classifier and its ID can classify a file", async t => {
  const config = {
    ai_function: 1426, app_name: "报销材料", description: "识别报销附件",
    classify_types: [
      { category_key: "invoice", type_name: "发票" },
      { category_key: "proof", type_name: "付款凭证", description: "包含付款方、收款方和实付金额" }
    ]
  };
  const { client, calls } = await connect(t, ({ method, path, body }) => {
    assert.equal(method, "POST");
    if (path.endsWith("/app-manage/create")) {
      assert.deepEqual(body, config);
      return ok({ ...body, app_id: "class-app", config_version: "v1",
        classify_types: body.classify_types.map(item => ({ description: null, ...item })) });
    }
    assert.equal(path, documentPrefix + "/classify");
    assert.deepEqual(body, { app_id: "class-app", file_url: fileUrl });
    return ok({ status: "success", segments: [{ category_key: "invoice", category_name: "发票", pages: [1] }],
      unclassified_pages: [] });
  });
  const created = await call(client, "create_extraction_app", { ...config, timeout_seconds: 20, extract_fields: [],
    app_label: [], classify_types: [{ category_key: "invoice", type_name: " 发票 " }, config.classify_types[1]] });
  assert.notEqual(created.isError, true);
  assert.equal(created.structuredContent.ai_function, 1426);
  assert.equal(created.structuredContent.config_version, "v1");
  const classified = await call(client, "classify_document", { app_id: created.structuredContent.app_id, file_url: fileUrl });
  assert.equal(classified.structuredContent.status, "succeeded");
  assert.deepEqual(classified.structuredContent.data.segments[0].pages, [1]);
  assert.equal(calls.length, 2);
});

test("application creation validates the selected type before submitting a write", async t => {
  const { client, calls } = await connect(t, () => ok({ app_id: "extract-id", app_name: "字段", config_version: "v1" }));
  const category = { category_key: "invoice", type_name: "Invoice" };
  const field = { field_key: "amount", field_name: "金额", field_type: "number" };
  const classify = { ai_function: 1426, classify_types: [category] };
  for (const options of [
    {}, { classify_types: [category] }, { ...classify, ai_function: 1401 }, { ...classify, ai_function: 1425 },
    { ...classify, extract_fields: [field] }, { ...classify, classify_types: [] },
    { ...classify, app_code: "tag" }, { ...classify, enable_highlight: false },
    { ...classify, classify_types: [{ ...category, category_key: "0bad" }] },
    { ...classify, classify_types: [{ ...category, type_name: " UNCLASSIFIED " }] },
    { ...classify, classify_types: [category, { ...category, type_name: "合同" }] },
    { ...classify, classify_types: [category, { category_key: "other", type_name: " invoice " }] },
    { ...classify, classify_types: Array.from({ length: 11 }, (_, i) => ({ category_key: "c" + i, type_name: "t" + i })) }
  ]) {
    const reply = await call(client, "create_extraction_app", { app_name: "规则", ...options });
    assert.equal(reply.structuredContent.error.code, "INVALID_ARGUMENTS", JSON.stringify(options));
  }
  assert.equal(calls.length, 0);
  const created = await call(client, "create_extraction_app", { app_name: "字段", ai_function: 1425,
    extract_fields: [field], classify_types: [] });
  assert.equal(created.structuredContent.app_id, "extract-id");
  assert.deepEqual(calls[0].body, { ai_function: 1425, app_name: "字段", extract_fields: [field] });
});

test("classifier creation requires confirmation of the requested application type and categories", async t => {
  const config = { app_name: "报销包", ai_function: 1426, classify_types: [{ category_key: "bill", type_name: "票据" }] };
  const receipt = { app_id: "a", app_name: "报销包", config_version: "v1" };
  const invalid = [receipt, { ...receipt, ai_function: 1425 }, { ...receipt, ai_function: 1426 },
    { ...receipt, ai_function: 1426, classify_types: [] },
    { ...receipt, ai_function: 1426, classify_types: [{ type_name: "票据" }] }];
  let index = 0;
  const { client, calls } = await connect(t, () => ok(invalid[index++]));
  for (const _case of invalid) {
    const reply = await call(client, "create_extraction_app", config);
    assert.equal(reply.structuredContent.error.acceptance_unknown, true);
  }
  assert.equal(calls.length, invalid.length);
});

test("extraction app forms normalize empty placeholders while preserving field and format changes", async t => {
  const app = { app_id: "app-a", app_name: "合同", source: "custom", engine_type: "extract" };
  const { client, calls } = await connect(t, () => ok({ ...app, config_version: "v1" }));
  const amount = { field_key: "amount", field_name: "金额", field_type: "number" };
  const date = { field_key: "date", field_name: "日期", field_type: "date" };
  const table = { field_key: "rows", field_name: "明细", field_type: "table" };
  for (const [name, args] of [
    ["update_extraction_app", { app_id: "app-a", extract_fields: [] }],
    ["update_extraction_app", { app_id: "app-a", app_name: "合同", config_version: "v1", extract_fields: [] }],
    ["create_extraction_app", { app_name: "合同", extract_fields: [{ ...table, sub_fields: [] }] }],
    ["create_extraction_app", { app_name: "合同", extract_fields: [{ field_name: "金额", field_type: "number" }] }],
    ["create_extraction_app", { app_name: "合同", extract_fields: [{ ...amount, format: { mode: "preset", preset: "date_iso" } }] }],
    ["update_extraction_app", { app_id: "app-a", config_version: "v1", extract_fields: [{ ...amount, sub_fields: [date] }] }],
  ]) {
    assert.equal((await call(client, name, args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  const created = await call(client, "create_extraction_app", {
    app_name: "合同", extract_fields: [
      { ...amount, format: {}, sub_fields: [] }, { ...table, format: {}, sub_fields: [{ ...date, format: {} }] },
    ],
  });
  assert.notEqual(created.isError, true);
  assert.deepEqual(calls.at(-1).body, { ai_function: 1425, app_name: "合同", extract_fields: [amount, { ...table, sub_fields: [date] }] });
  const metadata = { app_id: "app-a", description: "" };
  assert.notEqual((await call(client, "update_extraction_app", { ...metadata, extract_fields: [] })).isError, true);
  assert.deepEqual(calls.at(-1).body, metadata);
  const update = { app_id: "app-a", config_version: "v1" };
  for (const [format, expected] of [[{}, amount], [null, { ...amount, format: null }]]) {
    const reply = await call(client, "update_extraction_app", { ...update, extract_fields: [{ ...amount, format }] });
    assert.notEqual(reply.isError, true);
    assert.deepEqual(calls.at(-1).body, { ...update, extract_fields: [expected] });
  }
});

test("incomplete account or mutation receipts stay unknown and no POST is repeated", async t => {
  const { client, calls } = await connect(t, ({ path }) => path.endsWith("/user/payment") ? {} : ok({}));
  const balance = (await call(client, "get_credits")).structuredContent;
  assert.equal(balance.status, "failed");
  assert.equal(balance.data, undefined);
  const creation = await call(client, "create_extraction_app", {
    app_name: "X", extract_fields: [{ field_name: "Id", field_key: "id", field_type: "string" }]
  });
  assert.equal(creation.structuredContent.error.acceptance_unknown, true);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("older deployments never receive fallback writes or report a mismatched application as updated", async t => {
  const { client, calls } = await connect(t, ({ path, body }, response) => {
    if (path.endsWith("/app-catalog/extraction/update") && body.app_id === "updated") return ok({ app_id: "other" });
    response.statusCode = 404;
    return { detail: "Not Found" };
  });
  for (const [tool, args] of [
    ["update_extraction_app", { app_id: "unavailable", app_name: "new" }],
    ["delete_extraction_app", { app_id: "unavailable" }],
    ["update_extraction_app", { app_id: "updated", app_name: "new" }]
  ]) {
    const result = await call(client, tool, args);
    assert.equal(result.isError, true);
    if (args.app_id === "updated") assert.equal(result.structuredContent.error.acceptance_unknown, true);
    else assert.equal(result.structuredContent.error.http_status, 404);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === "POST" && call.path.includes("/app-catalog/extraction/")));
});

test("China advertises a flat standalone invoice tool and preserves the original verification data", async t => {
  const data = { result: { fpVerification: "查验成功发票一致", fpVerificationMsg: "", fpIsVoided: "未作废",
    fpNumber: "0000123", fpItems: [{ name: "服务费", amount: "100.00" }] },
    metadata: { trace_id: "trace-1", attempt_verify_page_count: 1, actual_consume_page_count: 1, billable_pages: 1 } };
  const { client, calls } = await connect(t, () => ok(data), "test-key", { ADP_REGION: "cn" });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 15);
  const tool = tools.find(({ name }) => name === "verify_invoice");
  assert.equal(tool.title, "发票验真");
  assert.deepEqual(tool.inputSchema.required, ["fpNumber", "fpDate"]);
  assert.equal(tool.inputSchema.oneOf, undefined);
  assert.equal(tool.inputSchema.anyOf, undefined);
  assert.equal(tool.inputSchema.properties.type_key.default, "vat_electronic_invoice_new");
  assert.equal(tool.inputSchema.properties.type_key.enum.length, 11);
  for (const key of tool.inputSchema.properties.type_key.enum) assert.ok(tool.inputSchema.properties.type_key.description.includes(key));
  assert.ok(Object.values(tool.inputSchema.properties).every(({ description }) => description));
  const reply = await call(client, "verify_invoice", {
    fpNumber: "0000123", fpDate: "2026-06-01", fpAmount: "100.00"
  });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.structuredContent.verification_status, "consistent");
  assert.deepEqual(reply.structuredContent.data, data);
  assert.equal(reply.structuredContent.usage_status, "unavailable");
  assert.equal(reply.structuredContent.usage, undefined);
  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [{
    method: "POST", path: "/open/agentic_doc_processor/test-tenant/v1/app/invoice/verify",
    body: { type_key: "vat_electronic_invoice_new", fpNumber: "0000123", fpDate: "2026-06-01", fpAmount: "100.00" }
  }]);
  const guide = await call(client, "get_adp_guide");
  assert.match(guide.structuredContent.markdown, /用 `verify_invoice` 查验符合条件的中国大陆发票/);
  assert.match(guide.structuredContent.markdown, /对符合条件的发票进行验真/);
});

test("standalone invoice verification enforces each type's nonempty required strings without inventing formats", async t => {
  const { client, calls } = await connect(t, () => ok({ result: { fpVerification: "查验成功发票一致" } }), "test-key", { ADP_REGION: "cn" });
  const matrix = [
    ["vat_special_invoice", ["fpCode", "fpNoTaxAmount"]],
    ["vat_electronic_special_invoice", ["fpCode", "fpNoTaxAmount"]],
    ["vat_common_invoice", ["fpCode", "fpCRC"]],
    ["vat_electronic_invoice", ["fpCode", "fpCRC"]],
    ["vat_roll_invoice", ["fpCode", "fpCRC"]],
    ["vat_electronic_special_invoice_new", ["fpAmount"]],
    ["vat_electronic_invoice_new", ["fpAmount"]],
    ["motor_vehicle_sale_invoice", ["fpCode", "fpNoTaxAmount"]],
    ["used_car_purchase_invoice", ["fpCode", "fpAmount"]],
    ["electronic_air_transport", ["fpAmount"]],
    ["electronic_train_ticket", ["fpAmount"]]
  ];
  const values = { fpNumber: "0000123", fpDate: "2026/06/01", fpCode: "000001", fpAmount: "100.001", fpNoTaxAmount: "90.001", fpCRC: "000123456789" };
  for (const [type_key, fields] of matrix) {
    const input = { type_key, fpNumber: values.fpNumber, fpDate: values.fpDate,
      ...Object.fromEntries(fields.map(field => [field, values[field]])) };
    for (const field of fields) {
      const before = calls.length;
      const incomplete = { ...input };
      delete incomplete[field];
      const reply = await call(client, "verify_invoice", incomplete);
      assert.equal(reply.isError, true);
      assert.equal(reply.structuredContent.error.code, "INVOICE_VERIFICATION_INPUT_REQUIRED");
      assert.equal(calls.length, before);
    }
    const valid = await call(client, "verify_invoice", input);
    assert.notEqual(valid.isError, true);
    assert.deepEqual(calls.at(-1).body, input);
  }
  const before = calls.length;
  for (const args of [
    { fpNumber: "1", fpDate: "2026-06-01" },
    { fpNumber: "1", fpDate: "2026-06-01", fpAmount: "  " },
    { fpNumber: "1", fpDate: "2026-06-01", fpAmount: 100 },
    { fpNumber: 1, fpDate: "2026-06-01", fpAmount: "100" },
    { fpNumber: "1", fpDate: "2026-06-01", fpAmount: "100", type_key: "unknown" }
  ]) assert.equal((await call(client, "verify_invoice", args)).isError, true);
  assert.equal(calls.length, before);
});

test("invoice conclusions distinguish a completed check from consistency and never retry inconclusive results", async t => {
  const answers = new Map([
    ["consistent", ["查验成功发票一致", undefined]], ["inconsistent", ["查验成功发票不一致", undefined]],
    ["not_found", ["发票不存在", undefined]], ["unverifiable", ["未能查验", "INVOICE_UNVERIFIABLE"]],
    ["unsupported", ["不支持查验", "INVOICE_VERIFICATION_UNSUPPORTED"]],
    ["unknown", ["新增状态", "INVOICE_VERIFICATION_UNKNOWN"]], ["prototype", ["constructor", "INVOICE_VERIFICATION_UNKNOWN"]],
    ["spaced", [" 查验成功发票一致 ", undefined]]
  ]);
  const { client, calls } = await connect(t, ({ body }) => ({
    ...ok({ result: { fpVerification: answers.get(body.fpNumber)[0], fpIsVoided: "已作废", extra: "preserved" }, metadata: { billable_pages: 1 } }),
    ...(body.fpNumber === "consistent" ? { usage: recordedUsage } : {})
  }), "test-key", { ADP_REGION: "cn" });
  for (const [key, [rawStatus, errorCode]] of answers) {
    const reply = await call(client, "verify_invoice", { fpNumber: key, fpDate: "2026-06-01", fpAmount: "100" });
    const result = reply.structuredContent;
    assert.equal(result.verification_status, key === "prototype" ? "unknown" : key === "spaced" ? "consistent" : key);
    assert.equal(result.status, errorCode ? "failed" : "succeeded");
    assert.equal(reply.isError === true, !!errorCode);
    assert.equal(result.data.result.fpVerification, rawStatus);
    assert.equal(result.data.result.fpIsVoided, "已作废");
    assert.equal(result.data.result.extra, "preserved");
    assert.deepEqual(result.data.metadata, { billable_pages: 1 });
    if (errorCode) {
      assert.equal(result.error.code, errorCode);
      assert.equal(result.error.retryable, false);
    }
    if (key === "consistent") assert.deepEqual(result.usage, recordedUsage);
    else {
      assert.equal(result.usage_status, "unavailable");
      assert.equal(result.usage, undefined);
    }
  }
  assert.equal(calls.length, answers.size);
  assert.ok(calls.every(({ method }) => method === "POST"));
});

test("Global and unconfirmed custom targets hide invoice verification and reject direct calls without HTTP", async t => {
  for (const environment of [{ ADP_REGION: "global" }, {}]) {
    const { client, calls } = await connect(t, () => { throw new Error("Unexpected upstream request"); }, "test-key", environment);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    assert.equal(tools.some(({ name }) => name === "verify_invoice"), false);
    const reply = await call(client, "verify_invoice", { fpNumber: "1", fpDate: "2026-06-01", fpAmount: "100" });
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.error.code, "INVOICE_VERIFICATION_REGION_UNSUPPORTED");
    assert.equal(calls.length, 0);
  }
});

test("invoice visibility recognizes explicit China and confirmed China but never a failed discovery fallback", async t => {
  const profile = await cliProfile(t);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ path: url.pathname, method: options.method });
    return new Headers(options.headers).get("X-API-KEY") === "confirmed-key"
      ? Response.json(ok({ events: [] })) : Response.json({ detail: "unavailable" }, { status: 503 });
  });
  const common = { USERPROFILE: profile.profileDir };
  const unconfigured = new AdpClient(common);
  assert.equal(await unconfigured.getCatalogRegion(), "cn");
  assert.equal(unconfigured.domesticInvoiceRegionConfirmed, false);
  for (const target of [{ ADP_REGION: "cn" }, { ADP_API_BASE_URL: cnOrigin }]) {
    const explicit = new AdpClient({ ...common, ...target });
    assert.equal(await explicit.getCatalogRegion(), "cn");
    assert.equal(explicit.domesticInvoiceRegionConfirmed, true);
    const missing = await callTool("verify_invoice", { fpNumber: "1", fpDate: "2026-06-01", fpAmount: "100" }, explicit, "test");
    assert.equal(missing.status, "failed");
    assert.equal(missing.error.code, "MISSING_API_KEY");
  }
  assert.equal(requests.length, 0);
  const confirmed = new AdpClient({ ...common, ADP_API_KEY: "confirmed-key" });
  assert.equal(await confirmed.getCatalogRegion(), "cn");
  assert.equal(confirmed.domesticInvoiceRegionConfirmed, true);
  const failed = new AdpClient({ ...common, ADP_API_KEY: "unconfirmed-key" });
  assert.equal(await failed.getCatalogRegion(), "cn");
  assert.equal(failed.guideWorkspace, "unknown");
  assert.equal(failed.domesticInvoiceRegionConfirmed, false);
  await assert.rejects(() => callTool("verify_invoice", { fpNumber: "1", fpDate: "2026-06-01", fpAmount: "100" }, failed, "test"),
    error => error.details.http_status === 503);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ path, method }) => path === discoveryPath && method === "GET"));
  const invalid = new AdpClient({ ...common, ADP_REGION: "invalid" });
  assert.equal(await invalid.getCatalogRegion(), "cn");
  assert.equal(invalid.domesticInvoiceRegionConfirmed, false);
  await profile.write("saved-key", cnOrigin);
  const saved = new AdpClient(common);
  assert.equal(await saved.getCatalogRegion(), "cn");
  assert.equal(saved.guideWorkspace, "cn");
  assert.equal(saved.domesticInvoiceRegionConfirmed, true);
  assert.equal(requests.length, 3);
});

test("default parsing returns the synchronous OpenAPI result and async extraction can be queried later with usage", async t => {
  const { client, calls } = await connect(t, ({ method, path }) => {
    if (method === "GET" && path === `${catalogDetail}?app_id=${domesticBill}`) return presetDetail(domesticBill);
    if (method === "POST" && path === `${documentPrefix}/recognize`) {
      return { ...ok({ task_id: "parse-1", status: 4, doc_recognize_result: ["text"] }), usage: { num_pages: 1, credits_consumed: 0 } };
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
  assert.equal(parsed.task_ref, undefined);
  assert.deepEqual(parsed.data.doc_recognize_result, ["text"]);
  assert.deepEqual(parsed.usage, { num_pages: 1, credits_consumed: 0 });
  assert.equal(calls[0].body.app_id, "ootb_k7m2x9p4v1n8w3q6r5t0y2b4");
  const submitted = (await call(client, "extract_document", { app_id: domesticBill, file_url: fileUrl, wait: false })).structuredContent;
  assert.deepEqual(submitted.task_ref, { kind: "extract", id: "extract-1" });
  const nextQuery = submitted.next_steps.find(step => step.tool === "get_task");
  assert.deepEqual(nextQuery.arguments, { task_ref: submitted.task_ref });
  assert.equal(calls.length, 3);
  const queried = (await call(client, "get_task", { task_ref: submitted.task_ref })).structuredContent;
  assert.equal(queried.status, "succeeded");
  assert.deepEqual(queried.usage, {
    ...recordedUsage, credits_consumed: 1.3, billing_breakdown: { extraction: 0.8, collaboration: 0.5 }
  });
  const pageOnly = (await call(client, "get_task", { task_ref: { kind: "extract", id: "extract-pages-only" } })).structuredContent;
  assert.deepEqual(pageOnly.usage, { num_pages: 1 });
  assert.equal(pageOnly.usage_status, "unavailable");
  assert.ok(calls.every(item => item.key === "test-key"));
  assert.ok(calls.every(item => item.source === "adp-node-mcp"));
});

test("domestic preset preserves the per-request invoice verification override", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    if (path === `${catalogDetail}?app_id=${domesticBill}`) return presetDetail(domesticBill);
    if (path === `${catalogDetail}?app_id=${overseasFast}`) return presetDetail(overseasFast);
    assert.equal(path, `${documentPrefix}/extract/create/task`);
    return ok({ task_id: "domestic-extract" });
  }, "test-key", { API_SOURCE: "npm-mcp", ADP_REGION: "cn" });
  const input = { app_id: domesticBill, file_url: fileUrl, wait: false };
  for (const enable_invoice_verify of [true, false]) {
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
  assert.deepEqual(calls.map(c => c.method), ["GET", "POST", "GET", "POST", "GET", "POST", "GET"]);
  assert.ok(calls.every(item => item.source === "npm-mcp"));
});

test("invoice verification checks account app capability before submitting true or false overrides", async t => {
  let detail;
  const app_id = "account-domestic";
  const { client, calls } = await connect(t, ({ method, path, body }) => {
    if (method === "GET") {
      assert.equal(path, `${catalogDetail}?app_id=${app_id}`);
      return ok(detail);
    }
    assert.equal(path, `${documentPrefix}/extract/create/task`);
    assert.equal(body.app_id, app_id);
    return ok({ task_id: "accepted" });
  }, "test-key", { ADP_REGION: "cn" });
  for (const enable_invoice_verify of [true, false]) {
    for (const [candidate, accepted] of [
      [{ app_id, source: "custom", engine_type: "extract", ai_function: 1410 }, true],
      [{ app_id, source: "custom", engine_type: "extract", ai_function: 1425 }, false],
      [{ app_id, source: "custom", engine_type: "parse", ai_function: 1410 }, false],
      [{ app_id: "another-app", source: "custom", engine_type: "extract", ai_function: 1410 }, false],
      [{ app_id, source: "custom", engine_type: "extract" }, false],
    ]) {
      detail = candidate;
      const before = calls.length;
      const result = await call(client, "extract_document", { app_id, file_url: fileUrl, enable_invoice_verify, wait: false });
      assert.equal(result.isError === true, !accepted);
      assert.deepEqual(calls.slice(before).map(item => item.method), accepted ? ["GET", "POST"] : ["GET"]);
      if (accepted) assert.equal(calls.at(-1).body.enable_invoice_verify, enable_invoice_verify);
    }
  }
});

test("preset extraction submits only after the tenant catalog confirms the requested extraction preset", async t => {
  const newPreset = "ootb_newly_published";
  const { client, calls } = await connect(t, ({ method, path, key }, response) => {
    const url = new URL(path, "http://fixture.invalid");
    assert.equal(key, "tenant-key");
    if (method === "GET") {
      assert.equal(url.pathname, catalogDetail);
      const id = url.searchParams.get("app_id");
      if (id === newPreset) return presetDetail(id);
      if (id === "ootb_other_id") return presetDetail(newPreset);
      if (id === "ootb_not_preset") return ok({ app_id: id, source: "custom", engine_type: "extract" });
      if (id === "ootb_parser") return ok({ app_id: id, source: "preset", engine_type: "parse" });
      if (id === "ootb_incomplete") return ok({ app_id: id, source: "preset" });
      response.statusCode = 404;
      return { code: "app_not_found", message: "unavailable" };
    }
    assert.equal(path, `${documentPrefix}/extract/create/task`);
    return ok({ task_id: "accepted" });
  }, "tenant-key", { ADP_REGION: "global" });
  for (const app_id of [domesticBill, "ootb_unknown", "ootb_other_id", "ootb_not_preset", "ootb_parser", "ootb_incomplete"]) {
    const result = await call(client, "extract_document", { app_id, file_url: fileUrl, wait: false });
    assert.equal(result.isError, true, app_id);
    assert.equal(calls.at(-1).path, catalogDetail + "?app_id=" + app_id);
  }
  assert.ok(calls.every(c => c.method === "GET" && !c.body));
  for (const [app_id, expected] of [[newPreset, ["GET", "POST"]], ["team-contract", ["POST"]]]) {
    const before = calls.length;
    const result = await call(client, "extract_document", { app_id, file_url: fileUrl, wait: false });
    assert.deepEqual(result.structuredContent.task_ref, { kind: "extract", id: "accepted" });
    assert.deepEqual(calls.slice(before).map(c => c.method), expected);
    assert.equal(calls.at(-1).body.app_id, app_id);
  }
});

test("uploads local bytes, maps custom fields, and calls classification only", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    switch (path) {
      case `${workflowPrefix}/files/upload`: return ok({ download_url: fileUrl });
      case `${documentPrefix}/extract/direct-fast`: return ok({ extraction_result: [{ name: "发票号码", value: "123" }] });
      case `${documentPrefix}/classify`:
        return ok({ task_id: "classify-1", status: "success", segments: [{ category_key: "receipt", category_name: "票据", pages: [1] }], unclassified_pages: [] });
      default: throw new Error("Unexpected endpoint");
    }
  });
  const file = join(tmpdir(), `adp-v2-${randomUUID()}.txt`);
  await writeFile(file, "ADP multipart test");
  t.after(() => unlink(file));
  const uploaded = await call(client, "upload_file", { files: [{ file_path: file }] });
  assert.notEqual(uploaded.isError, true);
  const uploadGuidance = JSON.stringify(uploaded.structuredContent.files[0].next_steps);
  assert.match(uploadGuidance, /download_url/);
  assert.ok(!uploadGuidance.includes(fileUrl));
  assert.match(calls[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(calls[0].body, /name="chunk"/);
  assert.match(calls[0].body, /ADP multipart test/);
  assert.match(calls[0].body, /name="sharing_scope"\r\n\r\nuser/);
  assert.doesNotMatch(calls[0].body, /name="application_id"/);
  const fields = [{ name: "发票号码", prompt: "票据顶部的号码" }];
  const custom = await call(client, "extract_document", { file: { url: fileUrl }, fields });
  assert.notEqual(custom.isError, true);
  assert.deepEqual(calls[1].body, { file: { url: fileUrl }, fields });
  assert.equal(custom.structuredContent.usage_status, "unavailable");
  const invalid = await call(client, "extract_document", { file: { url: fileUrl }, fields, app_id: domesticBill });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 2);
  const classified = await call(client, "classify_document", { app_id: "owned-classifier", file_url: fileUrl });
  assert.equal(classified.structuredContent.status, "succeeded");
  assert.equal(calls[2].body.app_id, "owned-classifier");
  assert.deepEqual(classified.structuredContent.data.segments[0].pages, [1]);
  const localUri = pathToFileURL(file).href;
  const mixed = await call(client, "upload_file", { file_path: localUri, files: [{}] });
  assert.equal(mixed.isError, true);
  assert.equal(calls.length, 3);
  const fileArray = await call(client, "upload_file", { files: [{ file_path: localUri }] });
  assert.equal(fileArray.structuredContent.files[0].data.download_url, fileUrl);
  assert.match(calls[3].body, /ADP multipart test/);
  const customArray = await call(client, "extract_document", { files: [{ url: fileUrl }], fields });
  assert.equal(customArray.isError, true);
  assert.equal(calls.length, 4);
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

test("each document capability uses its synchronous POST by default and only creates tasks on wait=false", async t => {
  const cases = [
    { name: "parse_document", route: "recognize", kind: "parse", app: {}, data: { status: 4, task_id: "receipt-1", doc_recognize_result: ["text"] } },
    { name: "extract_document", route: "extract", kind: "extract", app: { app_id: "custom" },
      data: { status: 4, extraction_result: [{ name: "ID", value: 7 }], output_result: [{ name: "ID", value: 7 }], tickets: [] } },
    { name: "classify_document", route: "classify", kind: "classify", app: { app_id: "classifier" },
      data: { status: "success", task_id: "receipt-3", segments: [], unclassified_pages: [1] } }
  ];
  const { client, calls } = await connect(t, ({ path }) => {
    if (path.endsWith("/create/task")) return ok({ task_id: "async-job" });
    const item = cases.find(c => path === documentPrefix + "/" + c.route);
    assert.ok(item, path);
    return { ...ok(item.data), usage: recordedUsage };
  });
  for (const item of cases) {
    for (const mode of [{}, { wait: true }]) {
      const result = await call(client, item.name, { ...item.app, file_url: fileUrl, ...mode });
      assert.equal(result.structuredContent.status, "succeeded");
      assert.deepEqual(result.structuredContent.data, item.data);
      assert.equal(result.structuredContent.task_ref, undefined);
      assert.deepEqual(result.structuredContent.usage, recordedUsage);
      assert.equal(calls.at(-1).path, documentPrefix + "/" + item.route);
    }
    const queued = await call(client, item.name, { ...item.app, file_url: fileUrl, wait: false });
    assert.equal(queued.structuredContent.status, "pending");
    assert.deepEqual(queued.structuredContent.task_ref, { kind: item.kind, id: "async-job" });
    assert.equal(calls.at(-1).path, documentPrefix + "/" + item.route + "/create/task");
  }
  assert.equal(calls.length, 9);
  assert.ok(calls.every(c => c.method === "POST" && !Object.hasOwn(c.body, "wait")));
});

test("native synchronous HTTP deadline reports an unknown outcome without enqueueing or retrying", async t => {
  const { client, calls } = await connect(t, async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return ok({ status: 4, doc_recognize_result: ["finished"] });
  });
  const reply = await call(client, "parse_document", { file_url: fileUrl, wait_timeout_seconds: 1 });
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.status, "failed");
  assert.equal(reply.structuredContent.error.code, "REQUEST_TIMEOUT");
  assert.equal(reply.structuredContent.error.http_status, 504);
  assert.equal(reply.structuredContent.error.acceptance_unknown, true);
  assert.equal(reply.structuredContent.error.retryable, false);
  assert.equal(reply.structuredContent.task_ref, undefined);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [["POST", documentPrefix + "/recognize"]]);
});

test("upstream timeouts have the same unknown-outcome contract without resubmission", async t => {
  const { client, calls } = await connect(t, ({ body }, response) => {
    response.statusCode = Number(new URL(body.file_url).pathname.slice(1));
    return response.statusCode === 200 ? { code: "timeout" } : { detail: "Timeout" };
  });
  for (const status of [408, 504, 200]) {
    const reply = await call(client, "parse_document", { file_url: "https://example.invalid/" + status });
    const result = reply.structuredContent;
    assert.equal(reply.isError, true);
    assert.equal(result.error.code, "REQUEST_TIMEOUT");
    assert.equal(result.error.http_status, status);
    assert.equal(result.error.acceptance_unknown, true);
    assert.equal(result.error.retryable, false);
    assert.equal(result.task_ref, undefined);
  }
  assert.deepEqual(calls.map(c => c.path), Array(3).fill(documentPrefix + "/recognize"));
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
          && url.pathname === '/open/agentic_doc_processor/laiye/v1/app-catalog/detail'
          && options.method === 'GET' && url.searchParams.get('app_id') === ${JSON.stringify(overseasFast)}) {
        return Response.json(${JSON.stringify(presetDetail(overseasFast))});
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
  assert.equal(appId.enum, undefined);
  assert.ok(!tools.some(tool => tool.name === "verify_invoice"));
  const guide = await call(client, "get_adp_guide");
  assert.match(guide.structuredContent.markdown, /按指定字段同步抽取/);
  assert.ok(guide.structuredContent.markdown.includes(globalOrigin));
  assert.ok(!guide.structuredContent.markdown.includes(cnOrigin));
  const rejected = await call(client, "extract_document", { app_id: domesticBill, file_url: fileUrl, enable_invoice_verify: true, wait: false });
  assert.equal(rejected.isError, true);
  const accepted = await call(client, "extract_document", { app_id: overseasFast, file_url: fileUrl, wait: false });
  assert.deepEqual(accepted.structuredContent.task_ref, { kind: "extract", id: "global-extract" });
});

test("documented API errors keep their stable code, HTTP status and repair guidance", async t => {
  const fix = "请使用同类异步创建接口返回的 task_id，并核对账号、租户和区域；不要自动重新提交处理任务。";
  const { client, calls } = await connect(t, () => ({
    code: "http_server_error",
    message: "Synthetic upstream diagnostics are private",
    error: { code: "TASK_NOT_AVAILABLE", retryable: false, fix }
  }));
  const ref = { kind: "extract", id: "absent" };
  const reply = await call(client, "get_task", { task_ref: ref });
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
    [{ task_id: "extract-query", task_type: "extract" }, { kind: "extract", id: "extract-query" }, `${documentPrefix}/extract/query/task/extract-query`],
    [{ task_ref: {}, task_id: "classify-query", task_type: "classify" }, { kind: "classify", id: "classify-query" }, `${documentPrefix}/classify/query/task/classify-query`],
  ]) {
    const reply = await call(client, "get_task", args);
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
    { task_ref: {} }, { task_ref: { kind: "parse" } }, { task_ref: { id: "missing-type" } },
    { task_ref: { kind: "parse" }, task_id: "extract-query", task_type: "extract" },
    { task_ref: { kind: "parse", id: "parse-query" }, run_id: "run-query" },
    { task_ref: { kind: "parse", id: "parse-query" }, task_type: "parse" },
    { run_id: "run-query", task_id: "extract-query", task_type: "extract" },
    { run_id: "run-query", task_type: "parse" },
    { task_id: "extract-query", task_type: "workflow" },
    { run_id: "../run-query" }, { task_ref: { kind: "parse", id: "bad/id" } },
    { run_id: "run-query", reason: "Query cannot cancel" },
    { action: "cancel", task_id: "parse-query", task_type: "parse", reason: "Document reason is unsupported" }
  ]) {
    const reply = await call(client, "get_task", args);
    assert.equal(reply.isError, true, JSON.stringify(args));
    assert.equal(reply.structuredContent.status, "failed");
  }
  assert.equal(calls.length, 3);
});

test("task cancellation preserves actual states, is idempotent, and sends each POST only once", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    const task_id = path.split("/").at(-1);
    const status = task_id === "doc-running" ? "running" : task_id === "doc-succeeded" ? "succeeded"
      : task_id === "doc-failed" ? "failed" : "cancelled";
    return ok({ task_id, status, cancelled: status === "cancelled", already_cancelled: task_id === "doc-repeat" });
  });
  for (const [task_type, route] of [["parse", "recognize"], ["extract", "extract"], ["classify", "classify"]]) {
    const reply = await call(client, "cancel_task", { task_ref: {}, task_id: `doc-${task_type}`, task_type });
    assert.notEqual(reply.isError, true);
    assert.deepEqual(reply.structuredContent, {
      status: "succeeded", action: "cancel", task_ref: { kind: task_type, id: `doc-${task_type}` },
      data: { task_id: `doc-${task_type}`, status: "cancelled", cancelled: true, already_cancelled: false }
    });
    assert.equal(calls.at(-1).path, `${documentPrefix}/${route}/cancel/task/doc-${task_type}`);
    assert.equal(calls.at(-1).body, "");
  }
  const repeat = await call(client, "cancel_task", { task_ref: { kind: "parse", id: "doc-repeat" } });
  assert.notEqual(repeat.isError, true);
  assert.equal(repeat.structuredContent.data.already_cancelled, true);
  for (const status of ["running", "succeeded", "failed"]) {
    const ref = { kind: "extract", id: `doc-${status}` };
    const reply = await call(client, "cancel_task", { task_ref: ref });
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.status, "failed");
    assert.equal(reply.structuredContent.data.status, status);
    assert.equal(reply.structuredContent.error.code, "TASK_NOT_CANCELLABLE");
    assert.deepEqual(reply.structuredContent.task_ref, ref);
    assert.deepEqual(reply.structuredContent.next_steps[0].arguments, { task_ref: ref });
    assert.equal(reply.structuredContent.next_steps[0].tool, "get_task");
    assert.equal(reply.structuredContent.usage, undefined);
  }
  for (const args of [{ run_id: "run-unsupported" }, { task_ref: { kind: "workflow", id: "run-unsupported" } }]) {
    const workflow = await call(client, "cancel_task", { ...args });
    assert.equal(workflow.isError, true);
    assert.equal(workflow.structuredContent.error.code, "INVALID_ARGUMENTS");
    assert.equal(workflow.structuredContent.data, undefined);
  }
  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ method }) => method === "POST"));
});

test("task queries cancelled tasks without a tool error and keeps available recorded usage", async t => {
  const { client, calls } = await connect(t, ({ method, path }) => {
    if (method === "POST") return ok({ task_id: "cancelled", status: 6 });

    return { ...ok({ task_id: "cancelled", status: path.includes("/classify/") ? "cancelled" : 6 }), usage: recordedUsage };
  });
  for (const kind of ["parse", "extract", "classify"]) {
    const reply = await call(client, "get_task", { task_ref: { kind, id: "cancelled" } });
    assert.notEqual(reply.isError, true);
    assert.equal(reply.structuredContent.status, "cancelled");
    assert.equal(reply.structuredContent.error, undefined);
    assert.equal(reply.structuredContent.usage_status, "available");
    assert.ok(reply.structuredContent.usage.credits_consumed > 0);
  }
  const parsed = await call(client, "parse_document", { file_url: fileUrl });
  assert.notEqual(parsed.isError, true);
  assert.equal(parsed.structuredContent.status, "cancelled");
  assert.equal(parsed.structuredContent.error, undefined);
  assert.equal(parsed.structuredContent.task_ref, undefined);
  assert.equal(calls.length, 4);
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
    const reply = await call(client, "cancel_task", { task_ref: ref });
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

test("rate limits on native processing and task queries preserve Retry-After without issuing another request", async t => {
  const { client, calls } = await connect(t, (_request, response) => {
    response.statusCode = 429;
    response.setHeader("Retry-After", "2");
    return { detail: "Too many requests" };
  });
  const ref = { kind: "parse", id: "existing-async-task" };
  const sync = await call(client, "parse_document", { file_url: fileUrl });
  assert.equal(sync.isError, true);
  assert.equal(sync.structuredContent.error.http_status, 429);
  assert.equal(sync.structuredContent.error.retryable, false);
  assert.equal(sync.structuredContent.error.retry_after_ms, 2000);
  assert.equal(sync.structuredContent.task_ref, undefined);
  const read = await call(client, "get_task", { task_ref: ref });
  assert.deepEqual(read.structuredContent.task_ref, ref);
  assert.equal(read.structuredContent.error.retryable, true);
  assert.equal(read.structuredContent.error.retry_after_ms, 2000);
  assert.deepEqual(read.structuredContent.next_steps[0].arguments, { task_ref: ref });
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", documentPrefix + "/recognize"], ["GET", documentPrefix + "/recognize/query/task/" + ref.id]
  ]);
});

test("sync extraction and task queries preserve the upstream error message verbatim", async t => {
  const reason = "  BadRequestError: The provided messages input is invalid.\nUnexpected item type in content.\r\n";
  const privateMessage = "private diagnostic from provider";
  const ref = { kind: "extract", id: "extract-1" };
  const { client } = await connect(t, ({ path }) => {
    assert.ok([documentPrefix + "/extract", documentPrefix + "/extract/query/task/" + ref.id].includes(path));
    return {
      ...ok({ task_id: ref.id, response_type: "extract", status: 5, message: privateMessage, error: { message: privateMessage } }),
      message: privateMessage, tips: reason, usage: recordedUsage
    };
  });
  for (const [tool, args] of [["extract_document", { app_id: "custom", file_url: fileUrl }], ["get_task", { task_ref: ref }]]) {
    const result = await call(client, tool, args);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent.error, { code: "TASK_FAILED", retryable: false, message: reason });
    assert.deepEqual(result.structuredContent.data, { task_id: ref.id, response_type: "extract", status: 5 });
    assert.deepEqual(result.structuredContent.task_ref, tool === "get_task" ? ref : undefined);
    assert.deepEqual(result.structuredContent.usage, recordedUsage);
    assert.equal(JSON.parse(result.content[0].text).error.message, reason);
    assert.ok(!JSON.stringify(result).includes(privateMessage));
  }
});

test("task failures retain credit handling and use the localized fallback without a public reason", async t => {
  const { client } = await connect(t, ({ path }) => {
    const id = path.split("/").at(-1);
    const data = { task_id: id, status: 5, message: id === "credit" ? "Insufficient credits" : "private diagnostic" };
    if (id !== "missing-type") data.response_type = "extract";
    const envelope = ok(data);
    if (id === "empty") envelope.tips = " ";
    if (id === "object") envelope.tips = { diagnostic: "private diagnostic" };
    if (id === "credit") envelope.tips = "This request could not run.";
    if (id === "english") envelope.tips = "The extraction service could not process this type of document.";
    if (id === "missing-type" || id === "other-route") envelope.tips = "private diagnostic";
    return envelope;
  }, "test-key", { ADP_ACCEPT_LANGUAGE: "en" });
  for (const id of ["legacy", "empty", "object", "missing-type", "other-route", "credit", "english"]) {
    const result = await call(client, "get_task", { task_ref: { kind: id === "other-route" ? "parse" : "extract", id } });
    const error = result.structuredContent.error;
    assert.equal(error.code, id === "credit" ? "INSUFFICIENT_CREDITS" : "TASK_FAILED");
    if (id === "credit") assert.match(error.message, /Insufficient credits/);
    else if (id === "english") assert.equal(error.message, "The extraction service could not process this type of document.");
    else assert.equal(error.message, "The task did not complete successfully.");
    assert.ok(!JSON.stringify(result).includes("private diagnostic"));
  }
});

test("async extraction submission keeps its task reference without exposing unreviewed submission tips", async t => {
  const { client, calls } = await connect(t, ({ path }) => {
    assert.equal(path, documentPrefix + "/extract/create/task");
    return { ...ok({ response_type: "extract", task_id: "new-extract", status: 5 }), tips: "private submission diagnostic" };
  });
  const result = await call(client, "extract_document", { app_id: "custom", file_url: fileUrl, wait: false });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.message, "任务未成功完成。");
  assert.equal(result.structuredContent.error.code, "TASK_FAILED");
  assert.deepEqual(result.structuredContent.task_ref, { kind: "extract", id: "new-extract" });
  assert.ok(!JSON.stringify(result).includes("private submission diagnostic"));
  assert.equal(calls.length, 1);
});

test("a synchronous business failure or nonterminal receipt is never turned into an async task", async t => {
  const { client, calls } = await connect(t, ({ body, path }) => {
    if (path === documentPrefix + "/classify") return ok({ task_id: "receipt-only", status: "success", segments: [] });
    if (body.file_url === fileUrl) return { ...ok({ status: 5, message: "Processing failed" }), usage: recordedUsage };
    return ok({ task_id: "receipt-only", status: 2 });
  });
  const failed = await call(client, "parse_document", { file_url: fileUrl });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.status, "failed");
  assert.equal(failed.structuredContent.error.code, "TASK_FAILED");
  assert.deepEqual(failed.structuredContent.usage, recordedUsage);
  assert.equal(failed.structuredContent.task_ref, undefined);
  const invalid = await call(client, "parse_document", { file_url: "https://example.invalid/new.pdf" });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.acceptance_unknown, true);
  assert.equal(invalid.structuredContent.task_ref, undefined);
  const incomplete = await call(client, "classify_document", { app_id: "classifier", file_url: fileUrl });
  assert.equal(incomplete.structuredContent.status, "failed");
  assert.equal(incomplete.structuredContent.task_ref, undefined);
  for (const response of [invalid, incomplete]) {
    assert.equal(response.structuredContent.error.code, "RECEIPT_MISSING");
    assert.equal(response.structuredContent.error.http_status, 502);
    assert.equal(response.structuredContent.error.retryable, false);
    assert.equal(response.structuredContent.error.acceptance_unknown, true);
  }
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", documentPrefix + "/recognize"], ["POST", documentPrefix + "/recognize"], ["POST", documentPrefix + "/classify"]
  ]);
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
  const missing = await call(client, "get_task", { task_ref });
  assert.equal(missing.structuredContent.error.code, "MISSING_API_KEY");
  assert.match(missing.structuredContent.error.message, /adp\.laiye\.com\?from=getkey&utm_source=github/);
  assert.equal(calls.length, 0);

  await writeFile(profile.configFile, JSON.stringify({ api_base_url: baseUrl, tenant_name: "cli-tenant" }));
  const incomplete = await call(client, "get_task", { task_ref });
  assert.equal(incomplete.structuredContent.error.code, "MISSING_API_KEY");
  assert.equal(calls.length, 0);

  const config = await profile.write("synthetic-cli-key-one", baseUrl, "cli-tenant");
  const keyBytes = await readFile(profile.keyFile);
  const result = await call(client, "get_task", { task_ref });
  assert.equal(result.structuredContent.status, "succeeded");
  assert.equal(calls[0].key, "synthetic-cli-key-one");
  assert.equal(await readFile(profile.configFile, "utf8"), config);
  assert.deepEqual(await readFile(profile.keyFile), keyBytes);

  await profile.write("synthetic-cli-key-two", baseUrl, "cli-tenant");
  const rotated = await call(client, "get_task", { task_ref });
  assert.equal(rotated.structuredContent.status, "succeeded");
  assert.equal(calls[1].key, "synthetic-cli-key-two");
  assert.doesNotMatch(JSON.stringify(rotated), /synthetic-cli-key/);

  const corrupted = JSON.parse(await readFile(profile.configFile, "utf8"));
  const lastByte = Number.parseInt(corrupted.api_key.slice(-2), 16);
  corrupted.api_key = corrupted.api_key.slice(0, -2) + (lastByte ^ 1).toString(16).padStart(2, "0");
  await writeFile(profile.configFile, JSON.stringify(corrupted));
  const invalid = await call(client, "get_task", { task_ref });
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
