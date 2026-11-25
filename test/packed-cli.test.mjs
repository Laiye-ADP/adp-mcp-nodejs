import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test("the npm tarball installs offline and serves tools over stdio", async t => {
  const directory = await mkdtemp(join(tmpdir(), "adp-mcp-package-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run this test with npm run test:package");
  await run(process.execPath, [npm, "pack", "--pack-destination", directory], { cwd: project });
  const archives = (await readdir(directory)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);

  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await run(process.execPath, [
    npm, "install", "--prefix", consumer, "--offline", "--cache", join(directory, "cache"),
    "--ignore-scripts", "--no-audit", "--no-fund", join(directory, archives[0])
  ], { cwd: consumer });
  const installed = join(consumer, "node_modules", "@laiye-adp", "mcp");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const entry = join(installed, manifest.bin["laiye-adp-mcp"]);

  const requests = [];
  const api = createServer((request, response) => {
    requests.push([request.method, request.url, request.headers["x-api-key"]]);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      code: "success", data: { total_credits: 100, used_credits: 10, expired_credits: 0, remaining_credits: 90 }
    }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const client = new Client({ name: "packed-cli-test", version: "1" });
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: consumer,
      env: {
        ADP_REGION: "cn",
        ADP_TENANT_NAME: "package-test",
        ADP_API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
        ADP_API_KEY: "package-test-key",
        ADP_ACCEPT_LANGUAGE: "zh"
      }
    });
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "verify_invoice"));
    const guide = await client.callTool({ name: "get_adp_guide", arguments: {} });
    assert.ok(guide.structuredContent.markdown.includes("extract_document"));
    const balance = await client.callTool({ name: "get_credits", arguments: {} });
    assert.equal(balance.structuredContent.data.remaining_credits, 90);
    assert.deepEqual(requests, [["GET", "/open/agentic_doc_processor/package-test/v1/user/payment", "package-test-key"]]);
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
