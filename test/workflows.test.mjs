import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callAdpOperation } from "../dist/adp-client.js";
import { operations } from "../dist/operations.js";
import { workflowTemplateApplicationIds } from "../dist/workflow-templates.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.ADP_API_KEY;
const originalLanguage = process.env.ADP_ACCEPT_LANGUAGE;
process.env.ADP_API_KEY = "unit-test-key";
delete process.env.ADP_ACCEPT_LANGUAGE;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  if (originalKey === undefined) delete process.env.ADP_API_KEY; else process.env.ADP_API_KEY = originalKey;
  if (originalLanguage === undefined) delete process.env.ADP_ACCEPT_LANGUAGE; else process.env.ADP_ACCEPT_LANGUAGE = originalLanguage;
});
const operation = name => {
  const result = operations.find(o => o.name === name);
  assert.ok(result, `Missing tool: ${name}`);
  return result;
};
const created = (key = "financial_report_extraction", overrides = {}) => ({
  code: "success", message: "", data: {
    template_key: key, template_version: "1.0.0", application_id: "created-account-app",
    application_name: "Financial report", release_version_id: "release-created",
    application_status: "published", can_run: true, ...overrides
  }
});
const run = (status = "succeeded", runId = "run-1") => ({
  code: "success", data: { run_id: runId, status, output: { statements: [] }, error: null }
});
function mockFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    assert.ok(responses.length, "Unexpected request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response;
    return Response.json(response);
  };
  return calls;
}

for (const key of ["finance_payable", "expense_reimbursement", "financial_report_extraction"]) {
  test(`create ${key} posts only template_key, without a catalog readiness prerequisite`, async () => {
    const calls = mockFetch(created(key));
    const result = await callAdpOperation(operation("create_workflow_application_from_template"), {
      template_key: key, accept_language: "zh", timeout_seconds: 10
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://adp.laiye.com/open/agentic_engine/laiye/v1/app/applications/create-from-template");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("X-API-KEY"), "unit-test-key");
    assert.equal(calls[0].headers.get("accept-language"), "zh");
    assert.deepEqual(JSON.parse(calls[0].body), { template_key: key });
    assert.equal(result.data.application_id, "created-account-app");
  });
}

test("template catalog forwards search and pagination without creating an app", async () => {
  const calls = mockFetch({ code: "success", data: { list: [{ template_key: "finance_payable", can_run: false }] } });
  await callAdpOperation(operation("list_workflow_templates"), { search: "财务应付", offset: 3, size: 2 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("search"), "财务应付");
  assert.equal(url.searchParams.get("offset"), "3");
  assert.equal(url.searchParams.get("size"), "2");
  assert.equal(calls[0].method, "GET");
});

test("creation honors the selected account region", async () => {
  const calls = mockFetch(created());
  await callAdpOperation(operation("create_workflow_application_from_template"), {
    template_key: "financial_report_extraction", accept_language: "en"
  });
  assert.equal(new URL(calls[0].url).origin, "https://adp-global.laiye.com");
  assert.equal(calls[0].headers.get("accept-language"), "en");
});

test("creation rejects unsupported keys, extra fields and missing keys before HTTP", async () => {
  const calls = mockFetch();
  for (const args of [{}, { template_key: "unknown" }, { template_key: "finance_payable", application_id: "catalog-id" }]) {
    await assert.rejects(callAdpOperation(operation("create_workflow_application_from_template"), args), /Invalid tool arguments/);
  }
  assert.equal(calls.length, 0);
});

test("creation rejects incomplete, unpublished and mismatched-template responses without retry", async () => {
  for (const changes of [{ can_run: false }, { application_status: "draft" }, { application_id: "" },
    { release_version_id: "" }, { template_key: "finance_payable" }]) {
    const calls = mockFetch(created("financial_report_extraction", changes));
    await assert.rejects(callAdpOperation(operation("create_workflow_application_from_template"), {
      template_key: "financial_report_extraction"
    }), /Do not automatically resubmit/);
    assert.equal(calls.length, 1);
  }
});

test("uncertain creation is not automatically retried", async () => {
  const calls = mockFetch(new Error("connection lost"));
  await assert.rejects(callAdpOperation(operation("create_workflow_application_from_template"), {
    template_key: "finance_payable"
  }), /connection lost/);
  assert.equal(calls.length, 1);
});

test("create -> application-scoped upload -> sync run uses the actual account app ID", async () => {
  const calls = mockFetch(created(), { code: "success", data: {
    id: "file-1", file_name: "report.pdf", file_size: 3,
    content_type: "application/pdf", download_url: "https://files.example.com/report.pdf"
  } }, run());
  const app = await callAdpOperation(operation("create_workflow_application_from_template"), {
    template_key: "financial_report_extraction"
  });
  const uploaded = await callAdpOperation(operation("upload_temporary_file"), {
    chunk: Buffer.from("pdf").toString("base64"), application_id: app.data.application_id, sharing_scope: "application", timeout_seconds: 10
  });
  const file = uploaded.data;
  await callAdpOperation(operation("execute_workflow_app"), {
    application_id: app.data.application_id, release_version_id: app.data.release_version_id,
    files: [{ url: file.download_url, name: file.file_name, mime_type: file.content_type, size: file.file_size }]
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.get("application_id"), "created-account-app");
  assert.equal(calls[1].body.get("sharing_scope"), "application");
  assert.equal(calls[1].body.has("timeout_seconds"), false);
  assert.equal(await calls[1].body.get("chunk").text(), "pdf");
  assert.ok(calls[2].url.endsWith("/v1/app/run"));
  const body = JSON.parse(calls[2].body);
  assert.equal(body.application_id, "created-account-app");
  assert.equal(body.release_version_id, "release-created");
  assert.equal(body.files[0].url, file.download_url);
  assert.equal(body.files[0].file_id, undefined);
  assert.equal(body.template_key, undefined);
});

test("workflow upload requires an application ID when sharing_scope=application", async () => {
  const calls = mockFetch();
  await assert.rejects(callAdpOperation(operation("upload_temporary_file"), {
    chunk: "cGRm", sharing_scope: "application"
  }), /Invalid tool arguments/);
  assert.equal(calls.length, 0);
});

test("existing temporary upload remains available without workflow fields", async () => {
  const calls = mockFetch({ code: "success", data: { download_url: "https://files.example.com/a.pdf" } });
  await callAdpOperation(operation("upload_temporary_file"), { chunk: "cGRm" });
  assert.equal(calls[0].body.has("application_id"), false);
  assert.equal(calls[0].body.has("sharing_scope"), false);
});

test("async execution uses the async endpoint and preserves public request fields", async () => {
  const calls = mockFetch(run("pending"));
  await callAdpOperation(operation("execute_workflow_app"), {
    application_id: "created-account-app", wait: false, inputs: { include_summary: false }, session_id: "session-1"
  });
  assert.ok(calls[0].url.endsWith("/app/run/create/task"));
  assert.deepEqual(JSON.parse(calls[0].body), {
    application_id: "created-account-app", inputs: { include_summary: false }, session_id: "session-1"
  });
});

for (const [template_key, application_id] of Object.entries(workflowTemplateApplicationIds)) {
  for (const wait of [true, false]) {
    test(`direct ${template_key} ${wait ? "sync" : "async"} maps to the fixed ID in a single run request`, async () => {
      const calls = mockFetch(run(wait ? "succeeded" : "pending"));
      const args = { template_key, inputs: { include_summary: false }, session_id: "session-direct", timeout_seconds: 10, accept_language: "en" };
      if (!wait) args.wait = false;
      const result = await callAdpOperation(operation("execute_workflow_app"), args);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://adp-global.laiye.com/open/agentic_engine/laiye/v1/app/run${wait ? "" : "/create/task"}`);
      assert.deepEqual(JSON.parse(calls[0].body), { application_id, inputs: { include_summary: false }, session_id: "session-direct" });
      assert.equal(result.data.run_id, "run-1");
    });
  }
  for (const wait of [true, false]) {
    test(`direct fixed ID for ${template_key} ${wait ? "sync" : "async"} is accepted without a create request`, async () => {
      const calls = mockFetch(run(wait ? "succeeded" : "pending"));
      await callAdpOperation(operation("execute_workflow_app"), { application_id, wait });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith(`/app/run${wait ? "" : "/create/task"}`));
      assert.deepEqual(JSON.parse(calls[0].body), { application_id });
    });
  }
}

test("execution rejects ambiguous, unsupported and versioned template targets before HTTP", async () => {
  const calls = mockFetch();
  for (const args of [
    {}, { template_key: "unknown" }, { template_key: "finance_payable", application_id: "app-1" },
    { template_key: "finance_payable", release_version_id: "version-1" },
    { application_id: "wftp_app_unknown" }, { application_id: "finance_payable", template_key: "finance_payable" },
    { application_id: " " }, { application_id: "app-1", unknown: true },
    ...Object.values(workflowTemplateApplicationIds).map(application_id => ({ application_id, release_version_id: "version-1" }))
  ]) await assert.rejects(callAdpOperation(operation("execute_workflow_app"), args), /Invalid tool arguments/);
  assert.equal(calls.length, 0);
});

test("execution rejects malformed workflow files", async () => {
  const calls = mockFetch();
  for (const args of [
    { application_id: "app-1", files: [{ file_id: "file-1" }] },
    { application_id: "app-1", files: [{ url: "file:///a.pdf", name: "a.pdf", mime_type: "application/pdf" }] }
  ]) await assert.rejects(callAdpOperation(operation("execute_workflow_app"), args), /Invalid tool arguments/);
  assert.equal(calls.length, 0);
});

test("direct template local-file upload uses user scope and performs only upload then run", async () => {
  const localFile = join(tmpdir(), `adp-mcp-test-${randomUUID()}.pdf`);
  await writeFile(localFile, "pdf");
  try {
    const calls = mockFetch({ code: "success", data: {
      id: "file-direct", file_name: "report.pdf", file_size: 3, content_type: "application/pdf",
      download_url: "https://files.example.com/report.pdf"
    } }, run());
    const uploaded = await callAdpOperation(operation("upload_temporary_file"), { chunk: localFile, sharing_scope: "user" });
    const file = uploaded.data;
    await callAdpOperation(operation("execute_workflow_app"), {
      template_key: "financial_report_extraction",
      files: [{ url: file.download_url, name: file.file_name, mime_type: file.content_type, size: file.file_size }]
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.get("sharing_scope"), "user");
    assert.equal(calls[0].body.has("application_id"), false);
    assert.equal(await calls[0].body.get("chunk").text(), "pdf");
    assert.deepEqual(JSON.parse(calls[1].body), {
      application_id: workflowTemplateApplicationIds.financial_report_extraction,
      files: [{ url: file.download_url, name: "report.pdf", mime_type: "application/pdf", size: 3 }]
    });
  } finally { await unlink(localFile); }
});

test("uploads reject known and unknown template IDs without reading files or sending HTTP", async () => {
  const calls = mockFetch();
  for (const application_id of [...Object.values(workflowTemplateApplicationIds), "wftp_app_unknown"]) {
    for (const sharing_scope of ["application", "user", undefined]) {
      await assert.rejects(callAdpOperation(operation("upload_temporary_file"), {
        chunk: "/nonexistent/never-read.pdf", application_id, ...(sharing_scope ? { sharing_scope } : {})
      }), /Template IDs cannot be used for uploads.*sharing_scope=user/);
    }
  }
  assert.equal(calls.length, 0);
});

test("uncertain direct runs and malformed responses are never retried", async () => {
  for (const response of [new Error("connection lost"), new DOMException("Request timeout", "AbortError"),
    new Response("Service unavailable", { status: 503 }), run("unknown"), { code: "success", data: { status: "succeeded" } }]) {
    const calls = mockFetch(response);
    await assert.rejects(callAdpOperation(operation("execute_workflow_app"), { template_key: "finance_payable" }));
    assert.equal(calls.length, 1);
  }
});

test("query uses only the workflow run endpoint and validates run identity", async () => {
  const calls = mockFetch(run(), run("succeeded", "different-run"));
  await callAdpOperation(operation("query_workflow_run"), { run_id: "run-1" });
  assert.ok(calls[0].url.endsWith("/app/run/query/task/run-1"));
  await assert.rejects(callAdpOperation(operation("query_workflow_run"), { run_id: "run-1" }), /run_id did not match/);
  assert.equal(calls.length, 2);
});

test("query rejects traversal and encoded separators before sending a request", async () => {
  const calls = mockFetch();
  for (const run_id of [".", "..", "../run", "a/b", "a\\b", "a?b", "a#b", "%2e%2e", "%252e%252e", "a%2fb", "a%5cb", "a\n", "a\u007f"])
    await assert.rejects(callAdpOperation(operation("query_workflow_run"), { run_id }), /Invalid tool arguments/);
  assert.equal(calls.length, 0);
});

test("existing extraction request options still preserve explicit false and null", async () => {
  const calls = mockFetch({ code: "success", data: {} });
  await callAdpOperation(operation("extract_china_invoice"), { file: "cGRm", enable_invoice_verify: null, wait: false });
  assert.ok(calls[0].url.endsWith("/app/doc/extract/create/task"));
  assert.equal(JSON.parse(calls[0].body).enable_invoice_verify, null);
});

test("stdio advertises the new workflow tools and calls creation through MCP", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./workflow-fetch-preload.mjs", import.meta.url).href, fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, ADP_API_KEY: "unit-test-key" }, stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name: "workflow-contract-test", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(client.getServerVersion().version, packageJson.version);
    const { tools } = await client.listTools();
    for (const name of ["list_workflow_templates", "create_workflow_application_from_template", "execute_workflow_app", "query_workflow_run"])
      assert.ok(tools.some(tool => tool.name === name));
    const result = await client.callTool({ name: "create_workflow_application_from_template", arguments: { template_key: "finance_payable" } });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.data.application_id, "stdio-created-app");
    const runTool = tools.find(tool => tool.name === "execute_workflow_app");
    assert.deepEqual(runTool.inputSchema.properties.template_key.enum, Object.keys(workflowTemplateApplicationIds));
    for (const [template_key, application_id] of Object.entries(workflowTemplateApplicationIds)) {
      const direct = await client.callTool({ name: "execute_workflow_app", arguments: { template_key } });
      assert.notEqual(direct.isError, true);
      assert.equal(direct.structuredContent.data.output.requested_application_id, application_id);
      const alias = await client.callTool({ name: "execute_workflow_app", arguments: { application_id, wait: false } });
      assert.notEqual(alias.isError, true);
      assert.equal(alias.structuredContent.data.status, "pending");
    }
    const ambiguous = await client.callTool({ name: "execute_workflow_app", arguments: { template_key: "finance_payable", application_id: "app-1" } });
    assert.equal(ambiguous.isError, true);
    const invalid = await client.callTool({ name: "create_workflow_application_from_template", arguments: { template_key: "unknown" } });
    assert.equal(invalid.isError, true);
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally { await client.close(); }
});
