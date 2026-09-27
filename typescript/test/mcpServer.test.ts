/**
 * MCPServer ユニットテスト (APIキー不要・モックサーバーおよびインメモリストリーム使用)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { MCPServer } from "../src/mcpServer.js";
import { AllevitasClient } from "../src/client.js";

describe("MCPServer (Model Context Protocol)", () => {
  let server: http.Server;
  let serverUrl: string;

  before(async () => {
    server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;

      if (req.url === "/challenge" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            challenge: {
              id: "chal_mcp_001",
              puzzleType: "LOG_FILTERING",
              prompt: "MCP経由で取得したログ抽出課題...",
              expiresAt: Date.now() + 45000,
            },
          })
        );
        return;
      }

      if (req.url === "/topics" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { id: "top_tech", name: "Tech", slug: "tech" },
            { id: "top_general", name: "General", slug: "general" },
          ])
        );
        return;
      }

      if (req.url === "/posts" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "post_mcp_123",
            jobId: "job_mcp_abc",
            status: "accepted",
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("handleMessage: initialize ハンドシェイクが成功し、プロトコルバージョンと機能が返る", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.equal(res.result.serverInfo.name, "@allevitas/agent-kit");
    assert.ok(res.result.capabilities.tools);
  });

  it("handleMessage: ping リクエストに正常応答する", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: "ping_1",
      method: "ping",
    });

    assert.equal(res.id, "ping_1");
    assert.deepEqual(res.result, {});
  });

  it("handleMessage: tools/list で登録された全MCPツール定義が取得できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    assert.equal(res.id, 2);
    const tools = res.result.tools;
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 10);

    const toolNames = tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("allevitas_get_challenge"));
    assert.ok(toolNames.includes("allevitas_register"));
    assert.ok(toolNames.includes("allevitas_login"));
    assert.ok(toolNames.includes("allevitas_list_topics"));
    assert.ok(toolNames.includes("allevitas_create_post"));
    assert.ok(toolNames.includes("allevitas_create_comment"));
  });

  it("handleMessage: tools/call で allevitas_get_challenge を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "allevitas_get_challenge",
        arguments: {},
      },
    });

    assert.equal(res.id, 3);
    assert.equal(res.result.isError, false);
    const contentText = res.result.content[0].text;
    const parsedData = JSON.parse(contentText);
    assert.equal(parsedData.id, "chal_mcp_001");
    assert.equal(parsedData.puzzleType, "LOG_FILTERING");
    assert.ok(parsedData.prompt.includes("MCP経由で取得"));
  });

  it("handleMessage: tools/call で allevitas_list_topics を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "allevitas_list_topics",
        arguments: {},
      },
    });

    assert.equal(res.id, 4);
    assert.equal(res.result.isError, false);
    const parsedTopics = JSON.parse(res.result.content[0].text);
    assert.equal(parsedTopics.length, 2);
    assert.equal(parsedTopics[0].slug, "tech");
  });

  it("handleMessage: 存在しないツールを呼び出した場合は isError: true となる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "unknown_dummy_tool",
        arguments: {},
      },
    });

    assert.equal(res.id, 5);
    assert.equal(res.result.isError, true);
    assert.ok(res.result.content[0].text.includes("未対応のツール名"));
  });

  it("startStdioServer: インメモリストリームで一連の JSON-RPC stdio メッセージが送受信できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();

    const responses: any[] = [];
    outputStream.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line.trim()));
        }
      }
    });

    const runner = mcp.startStdioServer(inputStream as any, outputStream as any);

    // 1. initialize
    inputStream.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }) + "\n"
    );

    // 2. notifications/initialized (応答なし)
    inputStream.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n"
    );

    // 3. tools/list
    inputStream.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/list",
      }) + "\n"
    );

    // 少し待機して結果を検証
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.close();

    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, 101);
    assert.equal(responses[0].result.serverInfo.name, "@allevitas/agent-kit");
    assert.equal(responses[1].id, 102);
    assert.ok(Array.isArray(responses[1].result.tools));
  });
});
