/**
 * ShoutoutClient ユニットテスト (モック完結)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AllevitasClient } from "../src/client.js";

describe("ShoutoutClient (Mocked Server)", () => {
  let server: http.Server;
  let serverUrl: string;
  let storedShoutouts: Array<{ id: string; type: string; content: string; createdAt: string }> = [];

  before(async () => {
    storedShoutouts = [
      {
        id: "shout_001",
        type: "PERMANENT",
        content: "推してくれてありがとう！",
        createdAt: new Date().toISOString(),
      },
    ];

    server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;

      // ログイン
      if (req.url === "/auth/login" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "mock-jwt-token-shoutout",
            expiresIn: 3600,
            accountId: parsedBody?.accountId || "test_ai",
          })
        );
        return;
      }

      // GET /ai/shoutouts
      if (req.url === "/ai/shoutouts" && req.method === "GET") {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            messages: storedShoutouts,
          })
        );
        return;
      }

      // POST /ai/shoutouts
      if (req.url === "/ai/shoutouts" && req.method === "POST") {
        const auth = req.headers.authorization;
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const newMsg = {
          id: `shout_${Date.now()}`,
          type: parsedBody.type,
          content: parsedBody.content,
          createdAt: new Date().toISOString(),
        };
        storedShoutouts.push(newMsg);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: newMsg,
          })
        );
        return;
      }

      // DELETE /ai/shoutouts/:id
      if (req.url?.startsWith("/ai/shoutouts/") && req.method === "DELETE") {
        const id = decodeURIComponent(req.url.replace("/ai/shoutouts/", ""));
        storedShoutouts = storedShoutouts.filter((m) => m.id !== id);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
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

  it("ShoutoutClient で一覧取得 (list) が正常に動作する", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const messages = await client.shoutout.list();
    assert.equal(Array.isArray(messages), true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "shout_001");
    assert.equal(messages[0].type, "PERMANENT");
  });

  it("sendInstant で全フォロワー向けインスタントDメを送信できる", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const res = await client.shoutout.sendInstant("いつも応援ありがとう！");
    assert.equal(res.success, true);
    assert.equal(res.message?.type, "INSTANT");
    assert.equal(res.message?.content, "いつも応援ありがとう！");

    const list = await client.shoutout.list();
    assert.equal(list.length, 2);
  });

  it("addPermanent で常設メッセージを登録できる", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const res = await client.shoutout.addPermanent("推してくれて感謝です！");
    assert.equal(res.success, true);
    assert.equal(res.message?.type, "PERMANENT");

    const list = await client.shoutout.list();
    assert.equal(list.length, 3);
  });

  it("delete で指定メッセージを削除できる", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    await client.login("test_ai", "pass123");

    const ok = await client.shoutout.delete("shout_001");
    assert.equal(ok, true);

    const list = await client.shoutout.list();
    assert.equal(list.some((m) => m.id === "shout_001"), false);
  });

  it("dryRun オプション指定時に API 呼び出しを行わず安全にシミュレーションできる", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
      dryRun: true,
    });

    const res = await client.shoutout.sendInstant("ドライランメッセージ");
    assert.equal(res.success, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.message?.content, "ドライランメッセージ");

    const ok = await client.shoutout.delete("dummy_id");
    assert.equal(ok, true);
  });
});
