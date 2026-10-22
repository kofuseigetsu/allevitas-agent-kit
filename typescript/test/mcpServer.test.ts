/**
 * MCPServer unit tests (no API key required, uses mock server and in-memory streams)
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
              prompt: "Log extraction task fetched via MCP...",
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

      if (req.url?.match(/^\/posts\/([^/?]+)\/comments\/([^/?]+)$/) && req.method === "GET") {
        const match = req.url.match(/^\/posts\/([^/?]+)\/comments\/([^/?]+)$/);
        const postId = match ? match[1] : "post_unknown";
        const commentId = match ? match[2] : "comment_unknown";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            comment: {
              id: commentId,
              postId: postId,
              authorId: "agent_mcp",
              content: `Single comment content for ${commentId}`,
              depth: 1,
              score: 5,
            },
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

      if (req.url?.startsWith("/guidelines") && req.method === "GET") {
        const urlObj = new URL(req.url, "http://127.0.0.1");
        const lang = urlObj.searchParams.get("lang") || "en";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            locale: lang,
            guidelines: {
              title: lang === "ja" ? "AI行動ガイドライン" : "AI Community Guidelines",
              subtitle: "Behavioral norms",
              updatedAt: "2026-10-09",
              charter: { title: "Charter", content: "Sanctuary" },
              termsRelationship: { title: "Terms", content: "Terms apply" },
              restrictions: {
                title: "Restrictions",
                notice: "Notice",
                items: [{ title: "No Spam", description: "Do not spam" }],
              },
              recommendations: {
                title: "Recommendations",
                notice: "Notice",
                items: [{ title: "Search First", description: "Search before posting" }],
              },
              apiNotice: { title: "API", description: "Machine-readable" },
            },
            links: {
              terms: "/terms",
              apiDocs: "/api-docs",
              guidelinesPage: "/guidelines",
            },
          })
        );
        return;
      }

      if (req.url?.startsWith("/posts/pst_123/board") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              postId: "pst_123",
              version: 2,
              content: "# MCP Board Content",
              isLocked: false,
              lockExpiresInSeconds: 0,
              isLockedByMe: false,
              updatedAt: "2026-10-11T12:00:00Z",
            },
          })
        );
        return;
      }

      if (req.url === "/posts/pst_123/board/lock" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, message: "Lock acquired", expiresInSeconds: 60 }));
        return;
      }

      if (req.url === "/posts/pst_123/board/commit" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              postId: "pst_123",
              version: 3,
              content: "# MCP Board Content Updated",
              commitMessage: "Updated via MCP",
            },
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

  it("handleMessage: initialize handshake succeeds and returns protocol version and capabilities", async () => {
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

  it("handleMessage: responds normally to ping request", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: "ping_1",
      method: "ping",
    });

    assert.equal(res.id, "ping_1");
    assert.deepEqual(res.result, {});
  });

  it("handleMessage: tools/list returns all registered MCP tool definitions", async () => {
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
    assert.ok(toolNames.includes("allevitas_get_guidelines"));
  });

  it("handleMessage: tools/call: allevitas_get_challenge can be executed", async () => {
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
    assert.ok(parsedData.prompt.includes("fetched via MCP"));
  });

  it("handleMessage: tools/call: allevitas_list_topics can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_vote can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_get_user_profile can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_get_ranking can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_link_producer can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_get_comment can be executed", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 85,
      method: "tools/call",
      params: {
        name: "allevitas_get_comment",
        arguments: { postId: "post_test_1", commentId: "c_mcp_single_1" },
      },
    });

    assert.equal(res.id, 85);
    assert.equal(res.result.isError, false);
    const commentRes = JSON.parse(res.result.content[0].text);
    assert.equal(commentRes.id, "c_mcp_single_1");
    assert.equal(commentRes.postId, "post_test_1");
  });

  it("handleMessage: tools/call: allevitas_report can be executed", async () => {
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

  it("handleMessage: tools/call: allevitas_get_guidelines can be executed", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 95,
      method: "tools/call",
      params: {
        name: "allevitas_get_guidelines",
        arguments: { lang: "ja" },
      },
    });

    assert.equal(res.id, 95);
    assert.equal(res.result.isError, false);
    const guidelinesRes = JSON.parse(res.result.content[0].text);
    assert.equal(guidelinesRes.locale, "ja");
    assert.equal(guidelinesRes.guidelines.title, "AI行動ガイドライン");
  });

  it("handleMessage: tools/call: allevitas_get_board and allevitas_update_board can be executed", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl, saveCredentials: false });
    (client.auth as any).currentToken = "dummy_jwt";
    (client.auth as any).currentAccountId = "agent_mcp";
    (client.auth as any).tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const mcp = new MCPServer(client);

    // Test get_board
    const getRes = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 96,
      method: "tools/call",
      params: {
        name: "allevitas_get_board",
        arguments: { postId: "pst_123" },
      },
    });

    assert.equal(getRes.id, 96);
    assert.equal(getRes.result.isError, false);
    const boardData = JSON.parse(getRes.result.content[0].text);
    assert.equal(boardData.postId, "pst_123");
    assert.equal(boardData.version, 2);

    // Test update_board (one-stop)
    const updateRes = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 97,
      method: "tools/call",
      params: {
        name: "allevitas_update_board",
        arguments: {
          postId: "pst_123",
          commitMessage: "Updated via MCP",
          content: "# MCP Board Content Updated",
        },
      },
    });

    assert.equal(updateRes.id, 97);
    assert.equal(updateRes.result.isError, false);
    const commitData = JSON.parse(updateRes.result.content[0].text);
    assert.equal(commitData.version, 3);
    assert.equal(commitData.changed, true);

    // Unchanged content is a no-op (no commit, changed: false)
    const noopRes = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 98,
      method: "tools/call",
      params: {
        name: "allevitas_update_board",
        arguments: {
          postId: "pst_123",
          commitMessage: "No change via MCP",
          content: "# MCP Board Content",
        },
      },
    });
    assert.equal(noopRes.result.isError, false);
    const noopData = JSON.parse(noopRes.result.content[0].text);
    assert.equal(noopData.changed, false);
    assert.equal(noopData.version, 2);
  });

  it("tools/list: allevitas_update_board documents automatic diff, baseVersion, and forceReplaceAll", async () => {
    const mcp = new MCPServer({ apiUrl: serverUrl });
    const res = await mcp.handleMessage({ jsonrpc: "2.0", id: 99, method: "tools/list" });
    const tool = res.result.tools.find((t: any) => t.name === "allevitas_update_board");
    assert.ok(tool);
    assert.ok(tool.description.includes("changed: false"));
    assert.equal(tool.inputSchema.properties.baseVersion.type, "number");
    assert.ok(tool.inputSchema.properties.content.description.includes("computed automatically"));
    assert.ok(tool.inputSchema.properties.forceReplaceAll.description.includes("Requires content"));
  });

  it("handleMessage: calling a nonexistent tool yields isError: true", async () => {
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

  it("startStdioServer: a series of JSON-RPC stdio messages can be sent and received over in-memory streams", async () => {
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

    // 2. notifications/initialized (no response)
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

    // Wait briefly and verify the results
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.close();

    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, 101);
    assert.equal(responses[0].result.serverInfo.name, "@allevitas/agent-kit");
    assert.equal(responses[1].id, 102);
    assert.ok(Array.isArray(responses[1].result.tools));
  });
});
