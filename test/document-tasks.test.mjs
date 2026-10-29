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
process.env.ADP_API_KEY = "unit-test-key";
delete process.env.ADP_ACCEPT_LANGUAGE;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => {
  if (originalKey === undefined) delete process.env.ADP_API_KEY; else process.env.ADP_API_KEY = originalKey;
  if (originalLanguage === undefined) delete process.env.ADP_ACCEPT_LANGUAGE; else process.env.ADP_ACCEPT_LANGUAGE = originalLanguage;
});

const taskTools = [
  ["query_parse_task", "recognize", "doc_recognize_result"],
  ["query_extract_task", "extract", "extraction_result"]
];

for (const [name, route, resultField] of taskTools) {
  const operation = operations.find(tool => tool.name === name);

  test(`${name} queries only its task type and preserves pending, complete and failed results`, async () => {
    for (const status of [1, 4, 5]) {
      const calls = [];
      const payload = { code: "success", data: { task_id: "task-1", status,
        message: status === 5 ? "Processing failed" : "", [resultField]: status === 4 ? [{ value: "retained" }] : null } };
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), ...options });
        return Response.json(payload);
      };
      assert.deepEqual(await callAdpOperation(operation, { task_id: "task-1" }), payload);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `https://adp.laiye.com/open/agentic_doc_processor/laiye/v1/app/doc/${route}/query/task/task-1`);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].body, undefined);
      assert.equal(calls[0].headers.get("X-API-KEY"), "unit-test-key");
    }
  });

  test(`${name} preserves region and encodes the task ID`, async () => {
    let requestedUrl;
    globalThis.fetch = async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.headers.get("accept-language"), "en");
      return Response.json({ code: "success", data: { status: 1 } });
    };
    await callAdpOperation(operation, { task_id: "task/other?name=test", accept_language: "en" });
    assert.equal(requestedUrl, `https://adp-global.laiye.com/open/agentic_doc_processor/laiye/v1/app/doc/${route}/query/task/task%2Fother%3Fname%3Dtest`);
  });

  test(`${name} never switches endpoints after an HTTP or transport error`, async () => {
    for (const failure of [404, 403, 500, new Error("connection lost")]) {
      const calls = [];
      globalThis.fetch = async url => {
        calls.push(String(url));
        if (failure instanceof Error) throw failure;
        return Response.json({ code: "error", message: "Query failed" }, { status: failure });
      };
      await assert.rejects(callAdpOperation(operation, { task_id: "task-1" }), /HTTP|connection lost/);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes(`/doc/${route}/query/task/`));
    }
  });

  test(`${name} validates the task ID before requesting an API`, async () => {
    globalThis.fetch = async () => { throw new Error("Unexpected HTTP request"); };
    for (const args of [{}, { task_id: "" }, { task_id: 42 }, { task_id: "task-1", run_id: "run-1" }]) {
      await assert.rejects(callAdpOperation(operation, args), /Invalid tool arguments/);
    }
  });
}

test("stdio discovers parsing and extraction query tools and returns their full results", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./workflow-fetch-preload.mjs", import.meta.url).href,
      fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, ADP_API_KEY: "offline-protocol-test-key" },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name: "document-task-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.some(tool => ["query_task", "get_result"].includes(tool.name)), false);
    for (const [name, route, resultField] of taskTools) {
      const tool = tools.find(item => item.name === name);
      assert.ok(tool);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.deepEqual(tool.inputSchema.required, ["task_id"]);
      const result = await client.callTool({ name, arguments: { task_id: "stdio-task" } });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.data.status, 4);
      assert.deepEqual(result.structuredContent.data[resultField], [{ source: route }]);
    }
    for (const name of ["query_task", "get_result"]) {
      const result = await client.callTool({ name, arguments: { task_id: "stdio-task" } });
      assert.equal(result.isError, true);
    }
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    await client.close();
  }
});
