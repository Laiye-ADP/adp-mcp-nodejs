import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callAdpOperation } from "../dist/adp-client.js";
import { operations } from "../dist/operations.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.ADP_API_KEY;
const originalLanguage = process.env.ADP_ACCEPT_LANGUAGE;
process.env.ADP_API_KEY = "offline-v119-key";
delete process.env.ADP_ACCEPT_LANGUAGE;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  if (originalKey === undefined) delete process.env.ADP_API_KEY; else process.env.ADP_API_KEY = originalKey;
  if (originalLanguage === undefined) delete process.env.ADP_ACCEPT_LANGUAGE; else process.env.ADP_ACCEPT_LANGUAGE = originalLanguage;
});
const operation = name => {
  const found = operations.find(item => item.name === name);
  assert.ok(found, `Missing operation ${name}`);
  return found;
};
function mockFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    assert.ok(responses.length, "Unexpected HTTP request");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  };
  return calls;
}
const task = (status = "success", data = {}) => ({ code: "success", message: "FORMAT_FALLBACK: amount", data: { task_id: "task-1", status, ...data } });
const appPage = (list, total) => ({ code: "success", message: "", data: { list, range: { offset: 0, limit: 1000, total } } });
const exportResult = (args = {}, data = {}) => ({ code: "success", message: "retained warning", data: {
  file_id: "file-1", download_url: "https://files.example.com/report", filename: "report", file_size: 1,
  format: args.format ?? "excel", report_mode: args.report_mode ?? "merged", total_runs: 1, included_runs: 1,
  skipped_runs: 0, run_summaries: [{ run_id: "run-1", status: "succeeded" }], export_time: "2026-10-29T00:00:00Z", ...data
} });

test("ordinary extraction preserves omitted, null and empty page selections without new-task limits", async () => {
  for (const model_params of [{}, { pages: null }, { pages: [] }]) {
    const calls = mockFetch({ code: "success", data: { status: 4, extraction_result: [] } });
    await callAdpOperation(operation("execute_custom_extract_app"), { app_id: "app", file: "cGRm", model_params });
    assert.deepEqual(JSON.parse(calls[0].body).model_params, model_params);
    assert.equal(calls.length, 1);
  }
});

test("single-app multi-ticket null is forwarded without forcing a boolean default", async () => {
  for (const name of ["extract_global_invoice_fast", "execute_custom_extract_app"]) {
    const calls = mockFetch({ code: "success", data: { status: 4, extraction_result: [] } });
    await callAdpOperation(operation(name), { ...(name === "execute_custom_extract_app" ? { app_id: "app" } : {}), file: "cGRm", enable_multi_ticket: null });
    assert.equal(JSON.parse(calls[0].body).enable_multi_ticket, null);
    assert.equal(calls.length, 1);
  }
});

test("explicit business rejections retain their original code and message without a retry", async () => {
  const rejected = { code: "permission_denied", message: "Application access denied", data: null };
  for (const [name, args] of [
    ["classify_document", { app_id: "app", file: "cGRm" }],
    ["extract_routed_document", { app_ids: ["app"], file: "cGRm" }],
    ["export_workflow_runs", { application_id: "app" }]
  ]) {
    const calls = mockFetch(rejected);
    assert.deepEqual(await callAdpOperation(operation(name), args), rejected);
    assert.equal(calls.length, 1);
  }
});

for (const [name, route, identity] of [
  ["classify_document", "classify", { app_id: "class-app" }],
  ["extract_routed_document", "extract/routed", { app_ids: ["custom-app", "invoice-app"] }]
]) {
  test(`${name} uses separate sync/async endpoints and forwards file metadata and nested params`, async () => {
    for (const wait of [true, false]) {
      const result = task(wait ? "success" : "pending");
      const calls = mockFetch(result);
      const model_params = route === "classify" ? { pages: [2, 4] } : { pages: [2, 4], enable_highlight: false, enable_confidence: null };
      assert.deepEqual(await callAdpOperation(operation(name), {
        ...identity, file: "data:application/pdf;base64,cGRm", file_name: "材料.pdf", model_params, wait,
        accept_language: "en", timeout_seconds: 1
      }), result);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://adp-global.laiye.com/open/agentic_doc_processor/laiye/v1/app/doc/${route}${wait ? "" : "/create/task"}`);
      assert.equal(calls[0].headers.get("accept-language"), "en");
      assert.equal(calls[0].headers.get("X-API-KEY"), "offline-v119-key");
      assert.deepEqual(JSON.parse(calls[0].body), { ...identity, file_base64: "cGRm", file_name: "材料.pdf", model_params });
    }
  });
  test(`${name} rejects invalid files/pages and ambiguous inputs before sending`, async () => {
    const calls = mockFetch();
    const args = { ...identity, file: "https://files.example.com/a.pdf" };
    for (const changes of [{ file: " " }, { model_params: { pages: [0] } }, { model_params: { pages: [1, 1] } },
      { model_params: { pages: [] } }, { file_url: "https://files.example.com/b.pdf" }, { enable_highlight: true }]) {
      await assert.rejects(callAdpOperation(operation(name), { ...args, ...changes }), /Invalid tool arguments/);
    }
    assert.equal(calls.length, 0);
  });
  test(`${name} does not resubmit after transport failure or an invalid accepted response`, async () => {
    for (const response of [new Error("connection lost"), { code: "success", data: { task_id: "task-1" } }]) {
      const calls = mockFetch(response);
      await assert.rejects(callAdpOperation(operation(name), { ...identity, file: "https://files.example.com/a.pdf", wait: false }), /connection lost|Do not automatically resubmit/);
      assert.equal(calls.length, 1);
    }
  });
}

test("routed candidates enforce 1–10 distinct IDs before HTTP", async () => {
  const calls = mockFetch();
  for (const app_ids of [[], ["a", "a"], [" "], Array.from({ length: 11 }, (_, i) => `a${i}`)]) {
    await assert.rejects(callAdpOperation(operation("extract_routed_document"), { app_ids, file: "cGRm" }), /Invalid tool arguments/);
  }
  assert.equal(calls.length, 0);
});

for (const [name, route, status] of [
  ["query_parse_task", "recognize", 4], ["query_extract_task", "extract", 4],
  ["query_classify_task", "classify", "success"], ["query_routed_task", "extract/routed", "partial_success"]
]) {
  test(`${name} preserves task results and never queries another task namespace`, async () => {
    const payload = task(status, { extraction_result: [{ retained: true }] });
    const calls = mockFetch(payload);
    assert.deepEqual(await callAdpOperation(operation(name), { task_id: "task-1" }), payload);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith(`/app/doc/${route}/query/task/task-1`));
    for (const response of [new Error("lost"), Response.json({ code: "failed" }, { status: 404 })]) {
      const failed = mockFetch(response);
      await assert.rejects(callAdpOperation(operation(name), { task_id: "task-1" }), /lost|HTTP 404/);
      assert.equal(failed.length, 1);
      assert.ok(failed[0].url.includes(`/app/doc/${route}/query/task/`));
    }
  });
}

test("new task queries reject a mismatched task identity and retain no false success", async () => {
  for (const name of ["query_classify_task", "query_routed_task"]) {
    const calls = mockFetch(task("success", { task_id: "different" }));
    await assert.rejects(callAdpOperation(operation(name), { task_id: "task-1" }), /did not match the request/);
    assert.equal(calls.length, 1);
  }
});

test("all four document query types reject dot path segments without changing endpoints", async () => {
  const calls = mockFetch();
  for (const name of ["query_parse_task", "query_extract_task", "query_classify_task", "query_routed_task"]) {
    for (const task_id of [".", ".."]) await assert.rejects(callAdpOperation(operation(name), { task_id }), /Invalid path parameter/);
  }
  assert.equal(calls.length, 0);
});

test("single-app extraction preserves false/null/omitted switches, native names, params and complete ticket results", async () => {
  for (const name of ["extract_global_invoice_fast", "extract_sea_invoice_fast", "execute_custom_extract_app"]) {
    for (const value of [false, null, undefined]) {
      const switches = value === undefined ? {} : { enable_highlight: value, enable_field_value_translation: value, enable_confidence: value };
      const model_params = { pages: [1], scale: 1.2, disable_collaboration: true, page_task_timeout_seconds: 0.5, enable_multi_ticket: false, card_type: "id" };
      const payload = task(4, { tickets: [{ ticket_id: "ticket-1" }], extraction_result: [{ field_key: "invoice_tickets", object_values: [{ ticket_id: "ticket-1" }] }],
        spreadsheet_billing: { units: 1 }, spreadsheet_manifest_url: "https://files.example.com/manifest" });
      const calls = mockFetch(payload);
      const args = { file: "cGRm", file_name: "native.xlsx", model_params, ...switches, ...(name === "execute_custom_extract_app" ? { app_id: "custom-app" } : {}) };
      assert.deepEqual(await callAdpOperation(operation(name), args), payload);
      const body = JSON.parse(calls[0].body);
      assert.equal(body.file_name, "native.xlsx");
      assert.deepEqual(body.model_params, model_params);
      for (const key of ["enable_highlight", "enable_field_value_translation", "enable_confidence"]) {
        assert.equal(Object.hasOwn(body, key), value !== undefined);
        if (value !== undefined) assert.equal(body[key], value);
      }
    }
  }
});

test("routed switches keep false/null/omitted values nested without changing single-app placement", async () => {
  for (const value of [false, null, undefined]) {
    const switches = value === undefined ? {} : { enable_highlight: value, enable_field_value_translation: value, enable_confidence: value };
    const calls = mockFetch(task());
    await callAdpOperation(operation("extract_routed_document"), { app_ids: ["a"], file: "cGRm", model_params: switches });
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.model_params, switches);
    for (const key of ["enable_highlight", "enable_field_value_translation", "enable_confidence"]) assert.equal(Object.hasOwn(body, key), false);
  }
});

test("legacy single-app pages do not inherit the new APIs' 260-page selection limit", async () => {
  const pages = Array.from({ length: 261 }, (_, i) => i + 1);
  const calls = mockFetch(task(4), task(4));
  await callAdpOperation(operation("execute_custom_extract_app"), { app_id: "classic", file: "cGRm", model_params: { pages } });
  await callAdpOperation(operation("execute_custom_extract_app"), { app_id: "classic", file: "cGRm", model_params: null });
  assert.equal(JSON.parse(calls[0].body).model_params.pages.length, 261);
  assert.equal(JSON.parse(calls[1].body).model_params, null);
  const blocked = mockFetch();
  await assert.rejects(callAdpOperation(operation("classify_document"), { app_id: "class", file: "cGRm", model_params: { pages } }), /Invalid tool arguments/);
  await assert.rejects(callAdpOperation(operation("extract_routed_document"), { app_ids: ["fast"], file: "cGRm", model_params: { pages } }), /Invalid tool arguments/);
  await assert.rejects(callAdpOperation(operation("extract_global_invoice"), { file: "cGRm", enable_confidence: false }), /Invalid tool arguments/);
  assert.equal(blocked.length, 0);
});

test("custom discovery scopes to owner and custom apps, reads all pages, excludes other capabilities and recomputes total", async () => {
  const apps = [
    { id: "classic", ai_function: 1406, output_schema: null, published_version_id: null },
    { id: "parse", ai_function: 1400 }, { id: "workflow", ai_function: 1501 },
    { id: "fast", ai_function: 1425, output_schema: { type: "object" } },
    { id: "invoice", ai_function: 1423 }, { id: "sea", ai_function: 1424 }
  ];
  const calls = mockFetch(appPage(apps.slice(0, 3), 6), appPage(apps.slice(3), 6));
  const result = await callAdpOperation(operation("list_custom_extract_apps"), {});
  assert.deepEqual(result.data.list.map(item => item.id), ["classic", "fast", "invoice", "sea"]);
  assert.equal(result.data.list[0].output_schema, null);
  assert.equal(result.data.range.total, 4);
  for (const [index, call] of calls.entries()) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("app_type"), "1");
    assert.equal(url.searchParams.get("owner_only"), "true");
    assert.equal(url.searchParams.get("published_only"), "false");
    assert.equal(url.searchParams.get("with_output_schema"), "true");
    assert.equal(url.searchParams.get("limit"), "1000");
    assert.equal(url.searchParams.get("offset"), String(index * 3));
    assert.equal(url.searchParams.has("ai_function"), false);
    assert.deepEqual(url.searchParams.getAll("sort[]"), ["created_at", "id"]);
  }
});

test("classification discovery always explicitly selects 1426 and permits empty results", async () => {
  for (const list of [[], [{ id: "class", ai_function: 1426 }]]) {
    const calls = mockFetch(appPage(list, list.length));
    const result = await callAdpOperation(operation("list_classification_apps"), { accept_language: "en" });
    const url = new URL(calls[0].url);
    assert.equal(url.origin, "https://adp-global.laiye.com");
    assert.equal(url.searchParams.get("ai_function"), "1426");
    assert.equal(url.searchParams.get("with_output_schema"), "false");
    assert.equal(result.data.range.total, list.length);
  }
});

test("discovery supports each extraction ability and rejects stale or malformed pagination", async () => {
  for (const ai_function of [1406, 1423, 1424, 1425]) {
    const calls = mockFetch(appPage([{ id: "app-1", ai_function }], 1));
    await callAdpOperation(operation("list_custom_extract_apps"), { ai_function });
    assert.equal(new URL(calls[0].url).searchParams.get("ai_function"), String(ai_function));
  }
  for (const responses of [[appPage([{ id: "a", ai_function: 1425 }], 3), appPage([{ id: "a", ai_function: 1425 }], 3)],
    [appPage([], 1)], [{ code: "success", data: { list: [], range: {} } }]]) {
    const calls = mockFetch(...responses);
    await assert.rejects(callAdpOperation(operation("list_custom_extract_apps"), {}), /pagination did not advance|valid application list/);
    assert.equal(calls.length, responses.length);
  }
});

test("export sends all public modes, format combinations, filters and locale without client fields", async () => {
  const variants = [
    { report_mode: "merged", format: "html", run_ids: null, node_ids: ["n"], node_types: ["extract"], variable_filters: { "invoice.number": "1" }, primary_key_variable: "id", include_failed_runs: true, max_text_length: 1 },
    { report_mode: "per_run", format: "json", run_ids: [] },
    { report_mode: "task_data", format: "excel", run_ids: ["run-1"], locale: "en-US", node_ids: [], variable_filters: {} },
    { report_mode: "task_package", format: "word", run_ids: ["run-1"], locale: "zh-CN" },
    { report_mode: "task_package", format: "markdown", run_ids: ["run-1"] },
    { report_mode: "task_package", format: "html", run_ids: ["run-1"] },
    { report_mode: "task_data", format: "json", run_ids: ["run-1"] }, {}
  ];
  for (const args of variants) {
    const expected = { application_id: "workflow-app", ...args };
    const payload = exportResult(args);
    const calls = mockFetch(payload);
    assert.deepEqual(await callAdpOperation(operation("export_workflow_runs"), { ...expected, accept_language: "en", timeout_seconds: 1 }), payload);
    assert.deepEqual(JSON.parse(calls[0].body), expected);
    assert.equal(calls[0].url, "https://adp-global.laiye.com/open/agentic_engine/laiye/v1/app/runs/export");
  }
});

test("export rejects invalid mode/format/filter/locale before HTTP", async () => {
  const calls = mockFetch();
  const taskArgs = { report_mode: "task_data", run_ids: ["run-1"] };
  for (const args of [
    { report_mode: "task_data" }, { ...taskArgs, run_ids: [] }, { ...taskArgs, run_ids: ["a", "b"] },
    { ...taskArgs, format: "html" }, { ...taskArgs, node_ids: ["n"] }, { ...taskArgs, node_types: ["n"] },
    { ...taskArgs, variable_filters: { a: 1 } }, { report_mode: "task_package", run_ids: ["run-1"] },
    { report_mode: "task_package", run_ids: ["run-1"], format: "excel" }, { locale: "en" },
    { max_text_length: 30001 }, { run_ids: [" "] }
  ]) await assert.rejects(callAdpOperation(operation("export_workflow_runs"), { application_id: "app", ...args }), /Invalid tool arguments/);
  assert.equal(calls.length, 0);
  const accepted = mockFetch(exportResult());
  await callAdpOperation(operation("export_workflow_runs"), { application_id: "app", run_ids: Array.from({ length: 200 }, (_, i) => `run-${i}`) });
  assert.equal(accepted.length, 1);
});

test("export refuses incomplete or mismatched success receipts without automatic retry", async () => {
  for (const data of [{ download_url: "file:///report" }, { format: "json" }, { report_mode: "per_run" },
    { file_id: "" }, { included_runs: -1 }, { total_runs: 201 }, { run_summaries: null }, { export_time: "bad" }]) {
    const calls = mockFetch(exportResult({}, data));
    await assert.rejects(callAdpOperation(operation("export_workflow_runs"), { application_id: "app" }), /Do not automatically resubmit/);
    assert.equal(calls.length, 1);
  }
});

test("generic export may report more than 200 skipped historical runs", async () => {
  const payload = exportResult({}, { total_runs: 302, included_runs: 2, skipped_runs: 300 });
  for (const selection of [{}, { run_ids: Array.from({ length: 302 }, (_, i) => `run-${i}`) }]) {
    const calls = mockFetch(payload);
    assert.deepEqual(await callAdpOperation(operation("export_workflow_runs"), { application_id: "app", ...selection }), payload);
    assert.equal(calls.length, 1);
    if (selection.run_ids) assert.deepEqual(JSON.parse(calls[0].body).run_ids, selection.run_ids);
  }
});

test("single-task exports reject a receipt for a different run or an inconsistent task count", async () => {
  const args = { application_id: "app", report_mode: "task_data", format: "json", run_ids: ["run-1"] };
  for (const data of [{ run_summaries: [{ run_id: "other-run", status: "succeeded" }] },
    { total_runs: 2, included_runs: 1, skipped_runs: 1 }]) {
    const calls = mockFetch(exportResult(args, data));
    await assert.rejects(callAdpOperation(operation("export_workflow_runs"), args), /Do not automatically resubmit/);
    assert.equal(calls.length, 1);
  }
});

test("real stdio discovers v1.19 tools and preserves partial/failed results while marking errors", async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", new URL("./v119-fetch-preload.mjs", import.meta.url).href, fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, ADP_API_KEY: "offline-stdio-key" }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "v119-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ["list_classification_apps", "classify_document", "query_classify_task", "extract_routed_document", "query_routed_task", "export_workflow_runs"]) assert.ok(tools.find(tool => tool.name === name));
    for (const name of ["list_classification_apps", "list_custom_extract_apps"]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.data.list.length, 1);
    }
    for (const wait of [true, false]) {
      const classified = await client.callTool({ name: "classify_document", arguments: { app_id: "class-app", file: "cGRm", wait } });
      assert.notEqual(classified.isError, true);
      assert.equal(classified.structuredContent.data.status, wait ? "success" : "pending");
      const routed = await client.callTool({ name: "extract_routed_document", arguments: { app_ids: ["app-1425"], file: "cGRm", wait } });
      assert.notEqual(routed.isError, true);
      assert.equal(routed.structuredContent.data.status, wait ? "success" : "pending");
    }
    for (const [file_name, status] of [["partial.pdf", "partial_success"], ["failed.pdf", "failed"], ["unclassified.pdf", "success"]]) {
      const result = await client.callTool({ name: "extract_routed_document", arguments: { app_ids: ["app-1425"], file: "cGRm", file_name } });
      assert.equal(result.isError === true, status !== "success");
      assert.equal(result.structuredContent.data.status, status);
      assert.equal(result.structuredContent.message, "format warning retained");
      if (status === "partial_success") {
        const instances = result.structuredContent.data.extraction_result[0].object_values;
        assert.equal(instances[0].extraction_result[0].field_values[0].field_value, "HT-1");
        assert.equal(instances[1].error.code, "extract_failed");
      }
      if (status === "success") assert.deepEqual(result.structuredContent.data.extraction_result, []);
    }
    for (const [name, route, task_id] of [
      ["query_parse_task", "recognize", "task-1"], ["query_extract_task", "extract", "task-1"],
      ["query_classify_task", "classify", "failed-task"], ["query_routed_task", "extract/routed", "partial-task"]
    ]) {
      const result = await client.callTool({ name, arguments: { task_id } });
      assert.equal(result.structuredContent.data.route, route);
      assert.equal(result.isError === true, task_id !== "task-1");
    }
    const exported = await client.callTool({ name: "export_workflow_runs", arguments: { application_id: "app", report_mode: "task_data", run_ids: ["run-1"], format: "json", locale: "en-US" } });
    assert.notEqual(exported.isError, true);
    assert.equal(exported.structuredContent.message, "saved report");
    assert.equal(exported.structuredContent.data.requested_body.locale, "en-US");
    for (const [name, args] of [
      ["classify_document", { app_id: "rejected-app", file: "cGRm" }],
      ["export_workflow_runs", { application_id: "rejected-app" }]
    ]) {
      const rejected = await client.callTool({ name, arguments: args });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent, undefined);
      const body = JSON.parse(rejected.content[0].text);
      assert.equal(body.code, "permission_denied");
      assert.equal(body.message, "Application access denied");
    }
  } catch (error) { throw new Error(`${error.message}\n${stderr}`); }
  finally { await client.close(); }
});
