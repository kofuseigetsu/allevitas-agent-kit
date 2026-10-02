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

      if (req.url === "/votes" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            currentScore: 1,
            message: "Vote recorded",
          })
        );
        return;
      }

      if (req.url?.startsWith("/users/") && req.method === "GET") {
        const username = req.url.split("/users/")[1];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "usr_123",
            username,
            displayName: "Test Agent",
            karmaScore: 42,
          })
        );
        return;
      }

      if (req.url?.startsWith("/ranking") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ranking: [
              { rank: 1, accountId: "agent_alpha", karma: 100, postCount: 5, commentCount: 10 },
              { rank: 2, accountId: "agent_beta", karma: 80, postCount: 3, commentCount: 6 },
            ],
            total: 2,
            page: 1,
            limit: 20,
          })
        );
        return;
      }

      if (req.url === "/ai/producer-link" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Linked to producer",
          })
        );
        return;
      }

      if (req.url === "/reports" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Report accepted",
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

  it("handleMessage: tools/call で allevitas_vote を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    (mcp as any).client.auth.currentToken = "fake-token";
    (mcp as any).client.auth.tokenExpiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "allevitas_vote",
        arguments: {
          targetType: "post",
          targetId: "post_123",
          voteType: "up",
        },
      },
    });

    assert.equal(res.id, 5);
    assert.equal(res.result.isError, false);
    const voteRes = JSON.parse(res.result.content[0].text);
    assert.equal(voteRes.success, true);
    assert.equal(voteRes.currentScore, 1);
  });

  it("handleMessage: tools/call で allevitas_get_user_profile を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "allevitas_get_user_profile",
        arguments: { username: "agent_alpha" },
      },
    });

    assert.equal(res.id, 6);
    assert.equal(res.result.isError, false);
    const profile = JSON.parse(res.result.content[0].text);
    assert.equal(profile.username, "agent_alpha");
    assert.equal(profile.karmaScore, 42);
  });

  it("handleMessage: tools/call で allevitas_get_ranking を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    (mcp as any).client.auth.currentToken = "fake-token";
    (mcp as any).client.auth.tokenExpiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "allevitas_get_ranking",
        arguments: { page: 1, limit: 10 },
      },
    });

    assert.equal(res.id, 7);
    assert.equal(res.result.isError, false);
    const rankingRes = JSON.parse(res.result.content[0].text);
    assert.equal(rankingRes.ranking.length, 2);
    assert.equal(rankingRes.ranking[0].rank, 1);
  });

  it("handleMessage: tools/call で allevitas_link_producer を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    (mcp as any).client.auth.currentToken = "fake-token";
    (mcp as any).client.auth.tokenExpiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "allevitas_link_producer",
        arguments: { invitationKey: "inv_12345" },
      },
    });

    assert.equal(res.id, 8);
    assert.equal(res.result.isError, false);
    const linkRes = JSON.parse(res.result.content[0].text);
    assert.equal(linkRes.success, true);
  });

  it("handleMessage: tools/call で allevitas_report を実行できる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    (mcp as any).client.auth.currentToken = "fake-token";
    (mcp as any).client.auth.tokenExpiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "allevitas_report",
        arguments: {
          targetType: "post",
          targetId: "post_123",
          reason: "spam",
          detail: "Spam content",
        },
      },
    });

    assert.equal(res.id, 9);
    assert.equal(res.result.isError, false);
    const reportRes = JSON.parse(res.result.content[0].text);
    assert.equal(reportRes.success, true);
  });

  it("handleMessage: 存在しないツールを呼び出した場合は isError: true となる", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "unknown_dummy_tool",
        arguments: {},
      },
    });

    assert.equal(res.id, 10);
    assert.equal(res.result.isError, true);
    assert.ok(res.result.content[0].text.includes("Unsupported tool name"));
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
