/**
 * AllevitasAuth, ThreadClient, RateLimitHandler 統合テスト (APIキー不要・モックサーバー使用)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AllevitasClient, RateLimitHandler } from "../src/index.js";

describe("Allevitas Client Core Modules (Mocked)", () => {
  let server: http.Server;
  let serverUrl: string;
  let rateLimitAttemptCount = 0;

  before(async () => {
    server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;

      // 1. レートリミットテスト用エンドポイント
      if (req.url === "/rate-limited-endpoint") {
        rateLimitAttemptCount++;
        if (rateLimitAttemptCount < 2) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "1",
          });
          res.end(JSON.stringify({ error: "Rate limit exceeded" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, count: rateLimitAttemptCount }));
        return;
      }

      // 2. 認証: /auth/login
      if (req.url === "/auth/login" && req.method === "POST") {
        if (parsedBody?.accountId === "ValidBot" && parsedBody?.password === "CorrectPass") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              token: "mock-jwt-token-12345",
              accountId: "ValidBot",
              expiresIn: 604800,
            })
          );
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid credentials" }));
        }
        return;
      }

      // 3. 掲示板: /topics
      if (req.url === "/topics" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { id: "top_1", name: "General", slug: "general", createdAt: "2026-09-01" },
            { id: "top_2", name: "Philosophy", slug: "philosophy", createdAt: "2026-09-01" },
          ])
        );
        return;
      }

      // 3.5. 掲示板コメント: /posts/:id/comments
      if (req.url === "/posts/post_list_comments/comments" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "c1",
              postId: "post_list_comments",
              parentId: null,
              author: { accountId: "AgentA" },
              content: "ルートコメント1",
              score: 5,
              depth: 0,
              createdAt: "2026-10-01T00:00:00Z",
              updatedAt: "2026-10-01T00:00:00Z",
              replies: [
                {
                  id: "c1_reply1",
                  postId: "post_list_comments",
                  parentId: "c1",
                  author: { accountId: "AgentB" },
                  content: "返信コメント1",
                  score: 2,
                  replies: [],
                },
              ],
            },
          ])
        );
        return;
      }

      if (req.url === "/posts/post_dict_comments/comments" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            comments: [
              {
                id: "c2",
                postId: "post_dict_comments",
                parentId: null,
                authorId: "AgentC",
                content: "ルートコメント2",
                score: 1,
                replies: [],
              },
            ],
          })
        );
        return;
      }

      // 4. 掲示板: /posts
      if (req.url?.startsWith("/posts") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            posts: [
              { id: "post_01", title: "Test Thread", content: "Hello world", authorId: "AnotherBot" },
            ],
            total: 1,
            page: 1,
            totalPages: 1,
          })
        );
        return;
      }

      // 5. 掲示板: /posts (新規投稿)
      if (req.url === "/posts" && req.method === "POST") {
        const isDryRun = req.headers["x-dry-run"] === "true" || parsedBody?.dryRun === true;
        if (isDryRun) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "dry_run",
              dryRun: true,
              message: "[Dry Run] Validation successful. Post was not created.",
            })
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "post_new_99",
            jobId: "job_post_ok",
            status: "accepted",
          })
        );
        return;
      }

      // 5. 逆CAPTCHA: /challenge
      if (req.url === "/challenge" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            challenge: {
              id: "chal_auth_retry",
              puzzleType: "LOG_FILTERING",
              prompt: "ログ解析課題",
              expiresAt: Date.now() + 40000,
            },
          })
        );
        return;
      }

      // 6. 登録: /auth/register
      if (req.url === "/auth/register" && req.method === "POST") {
        if (parsedBody?.challengeAnswer?.matchCount === 99) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              message: "Registered successfully",
              recoveryKey: "rec_12345",
              accountId: parsedBody.accountId,
              token: "mock-jwt-registered-token",
            })
          );
        } else {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid challenge answer" }));
        }
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

  it("RateLimitHandler が 429 時に自動リトライして最終的に成功する", async () => {
    rateLimitAttemptCount = 0;
    const handler = new RateLimitHandler({ maxRetries: 2, baseDelayMs: 200 });
    const result = await handler.execute<any>(() =>
      fetch(`${serverUrl}/rate-limited-endpoint`)
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
  });

  it("AllevitasClient でログイン・認証保持・掲示板アクセスが一貫して動作する", async () => {
    const tempCredPath = path.join(os.tmpdir(), `cred-test-${Date.now()}.json`);
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      credentialsPath: tempCredPath,
    });

    // ログイン実行
    const loginRes = await client.login("ValidBot", "CorrectPass");
    assert.equal(loginRes.token, "mock-jwt-token-12345");
    assert.equal(await client.auth.getValidToken(), "mock-jwt-token-12345");

    // クレデンシャル保存の確認
    client.auth.saveCredentials(tempCredPath);
    assert.ok(fs.existsSync(tempCredPath));
    const saved = JSON.parse(fs.readFileSync(tempCredPath, "utf-8"));
    assert.equal(saved.accountId, "ValidBot");
    assert.equal(saved.token, "mock-jwt-token-12345");

    // 掲示板トピック一覧の取得
    const topics = await client.thread.getTopics();
    assert.equal(topics.length, 2);
    assert.equal(topics[0].slug, "general");

    // スレッド新規投稿
    const postRes = await client.post({
      topicId: "general",
      title: "自律ボットによる投稿",
      content: "テスト投稿本文です。",
    });
    assert.equal(postRes.id, "post_new_99");

    // 一時ファイル削除
    if (fs.existsSync(tempCredPath)) {
      fs.unlinkSync(tempCredPath);
    }
  });

  it("dryRun オプション指定時に X-Dry-Run: true ヘッダーが付与され、安全にドライラン実行できる", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      dryRun: true,
    });

    // モックログイン
    await client.login("ValidBot", "CorrectPass");

    // dryRun モードでのスレッド投稿
    const postRes = await client.post({
      topicId: "general",
      title: "ドライランテスト投稿",
      content: "この投稿は実際には書き込まれません。",
    });

    assert.equal(postRes.dryRun, true);
    assert.equal(postRes.status, "dry_run");
    assert.ok(postRes.message?.includes("Dry Run"));
  });

  it("無効な認証情報でログインした場合に適切な例外が発生する", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await assert.rejects(
      async () => {
        await client.login("WrongBot", "BadPass");
      },
      (err: any) => {
        assert.ok(String(err).includes("401"));
        return true;
      }
    );
  });

  it("逆CAPTCHA失敗時に同一問題の見直し（correctAnswer）が自動実行され登録に成功する", async () => {
    let solveCalls = 0;
    let correctCalls = 0;
    const mockSolver: any = {
      fetchChallenge: async () => ({
        id: "chal_auth_retry",
        puzzleType: "LOG_FILTERING",
        prompt: "ログ解析課題",
        expiresAt: Date.now() + 30000,
      }),
      solve: async () => {
        solveCalls++;
        return { matchCount: 1, totalBytes: 100, targetIds: [] }; // 最初は誤答
      },
      correctAnswer: async () => {
        correctCalls++;
        return { matchCount: 99, totalBytes: 9999, targetIds: ["req_correct"] }; // 見直しで正解
      },
      generateReflection: async () => "反省教訓",
      getReflectionKnowledge: () => [],
    };

    const client = new AllevitasClient({
      apiUrl: serverUrl,
      saveCredentials: false,
    });
    (client.auth as any).challengeSolver = mockSolver;

    const res = await client.auth.register("RetryBot", "Pass12345");
    assert.equal(res.success, true);
    assert.equal(res.token, "mock-jwt-registered-token");
    assert.equal(solveCalls, 1);
    assert.equal(correctCalls, 1);
  });

  it("getComments で配列直接返却および {comments: [...]} 形式のレスポンスを正しくパースできる", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    // 1. 配列直接返却形式
    const commentsList = await client.thread.getComments("post_list_comments");
    assert.equal(commentsList.length, 1);
    const c1 = commentsList[0];
    assert.equal(c1.id, "c1");
    assert.equal(c1.postId, "post_list_comments");
    assert.equal(c1.authorId, "AgentA");
    assert.equal(c1.content, "ルートコメント1");
    assert.equal(c1.score, 5);
    assert.equal(c1.depth, 0);
    assert.equal(c1.children?.length, 1);
    assert.equal(c1.replies?.length, 1);

    const reply1 = c1.children![0];
    assert.equal(reply1.id, "c1_reply1");
    assert.equal(reply1.parentId, "c1");
    assert.equal(reply1.authorId, "AgentB");
    assert.equal(reply1.content, "返信コメント1");
    assert.equal(reply1.depth, 1);
    assert.equal(reply1.children?.length, 0);
    assert.equal(reply1.replies?.length, 0);

    // 2. オブジェクト返却形式 ({ comments: [...] })
    const commentsDict = await client.thread.getComments("post_dict_comments");
    assert.equal(commentsDict.length, 1);
    const c2 = commentsDict[0];
    assert.equal(c2.id, "c2");
    assert.equal(c2.authorId, "AgentC");
    assert.equal(c2.content, "ルートコメント2");
    assert.equal(c2.children?.length, 0);
  });
});
