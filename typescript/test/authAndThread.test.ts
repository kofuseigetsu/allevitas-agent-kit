/**
 * AllevitasAuth, ThreadClient, RateLimitHandler integration tests (no API key required, uses mock server)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AllevitasClient, RateLimitHandler, CommentDepthExceededError, QueueTimeoutError } from "../src/index.js";

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

      // 1. Endpoint for rate limit tests
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

      // 2. Auth: /auth/login
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

      // 3. Board: /topics
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

      // 3.1. Guidelines: /guidelines
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

      // 3.4. Single comment endpoint: /posts/:postId/comments/:commentId
      const singleCommentMatch = req.url?.match(/^\/posts\/([^/?]+)\/comments\/([^/?]+)$/);
      if (singleCommentMatch && req.method === "GET") {
        const [, targetPostId, targetCommentId] = singleCommentMatch;
        if (targetCommentId === "c_non_existent" || targetCommentId === "404") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Comment not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            comment: {
              id: targetCommentId,
              postId: targetPostId,
              author: { accountId: "AgentA" },
              content: `Single comment ${targetCommentId}`,
              depth: 1,
              parentId: null,
              score: 10,
              replyCount: 0,
              createdAt: "2026-10-01T00:00:00Z",
            },
          })
        );
        return;
      }

      // 3.5. Board comments: /posts/:id/comments
      if (req.url?.startsWith("/posts/post_list_comments/comments") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const urlObj = new URL(req.url, "http://127.0.0.1");
        const fmt = urlObj.searchParams.get("format") || "flat";

        if (fmt === "tree") {
          res.end(
            JSON.stringify([
              {
                id: "c1",
                postId: "post_list_comments",
                parentId: null,
                author: { accountId: "AgentA" },
                content: "Root comment 1",
                score: 5,
                depth: 1,
                replyCount: 1,
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
                replies: [
                  {
                    id: "c1_reply1",
                    postId: "post_list_comments",
                    parentId: "c1",
                    author: { accountId: "AgentB" },
                    content: "Reply comment 1",
                    score: 2,
                    depth: 2,
                    replies: [],
                  },
                ],
              },
            ])
          );
        } else {
          res.end(
            JSON.stringify([
              {
                id: "c1",
                postId: "post_list_comments",
                parentId: null,
                author: { accountId: "AgentA" },
                content: "Root comment 1",
                score: 5,
                depth: 1,
                replyCount: 1,
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
              },
              {
                id: "c1_reply1",
                postId: "post_list_comments",
                parentId: "c1",
                author: { accountId: "AgentB" },
                content: "Reply comment 1",
                score: 2,
                depth: 2,
                replyCount: 0,
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-01T00:00:00Z",
              },
            ])
          );
        }
        return;
      }

      if (req.url?.startsWith("/posts/post_dict_comments/comments") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const urlObj = new URL(req.url, "http://127.0.0.1");
        const fmt = urlObj.searchParams.get("format") || "flat";

        if (fmt === "tree") {
          res.end(
            JSON.stringify({
              comments: [
                {
                  id: "c2",
                  postId: "post_dict_comments",
                  parentId: null,
                  authorId: "AgentC",
                  content: "Root comment 2",
                  score: 1,
                  depth: 1,
                  replies: [],
                },
              ],
            })
          );
        } else {
          res.end(
            JSON.stringify({
              comments: [
                {
                  id: "c2",
                  postId: "post_dict_comments",
                  parentId: null,
                  authorId: "AgentC",
                  content: "Root comment 2",
                  score: 1,
                  depth: 1,
                  replyCount: 0,
                },
              ],
            })
          );
        }
        return;
      }

      // 3.6. Board comment list (generic): /posts/:id/comments
      if (req.url?.match(/^\/posts\/([^/]+)\/comments(\?.*)?$/) && req.method === "GET") {
        const match = req.url.match(/^\/posts\/([^/]+)\/comments/);
        const targetPostId = match ? match[1] : "post_unknown";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: `c_${targetPostId}_01`,
              postId: targetPostId,
              parentId: null,
              author: { accountId: "AgentReviewer" },
              content: `Comment for ${targetPostId}`,
              score: 3,
              depth: 1,
              createdAt: "2026-10-01T00:00:00Z",
            },
            {
              id: "c_new_ts_01",
              postId: targetPostId,
              parentId: null,
              author: { accountId: "ValidBot" },
              content: "New comment with Wait",
              score: 0,
              depth: 1,
              createdAt: "2026-10-01T00:00:00Z",
            },
          ])
        );
        return;
      }

      // Post comment: /posts/:id/comments
      if (req.url?.match(/^\/posts\/[^/]+\/comments$/) && req.method === "POST") {
        if (parsedBody?.parentId === "c_reply_nested") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Comments are limited to 2 levels. Cannot reply to a nested comment.",
            })
          );
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            id: "c_new_ts_01",
            status: "accepted",
            message: "Comment created",
          })
        );
        return;
      }

      // 4. Board detail: /posts/:id
      const postDetailMatch = req.url?.match(/^\/posts\/([^/?]+)$/);
      if (postDetailMatch && req.method === "GET") {
        const targetPostId = postDetailMatch[1];
        if (targetPostId === "post_non_existent" || targetPostId === "404") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Post not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            post: {
              id: targetPostId,
              topicId: "top_1",
              title: `Thread ${targetPostId}`,
              content: "Full content of the thread for testing purposes.",
              author: { accountId: "AnotherBot" },
              score: 10,
              createdAt: "2026-10-01T00:00:00Z",
            },
          })
        );
        return;
      }

      // 4.5. Board list: /posts
      if ((req.url === "/posts" || req.url?.startsWith("/posts?")) && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            posts: [
              { id: "post_01", title: "Test Thread 1", content: "Hello world 1", authorId: "AnotherBot" },
              { id: "post_02", title: "Test Thread 2", content: "Hello world 2", authorId: "AnotherBot" },
            ],
            total: 2,
            page: 1,
            totalPages: 1,
          })
        );
        return;
      }

      // 5. Board: /posts (new post)
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

      // 5. Reverse CAPTCHA: /challenge
      if (req.url === "/challenge" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            challenge: {
              id: "chal_auth_retry",
              puzzleType: "LOG_FILTERING",
              prompt: "Log analysis task",
              expiresAt: Date.now() + 40000,
            },
          })
        );
        return;
      }

      // 6. Registration: /auth/register
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

  it("RateLimitHandler automatically retries on 429 and eventually succeeds", async () => {
    rateLimitAttemptCount = 0;
    const handler = new RateLimitHandler({ maxRetries: 2, baseDelayMs: 200 });
    const result = await handler.execute<any>(() =>
      fetch(`${serverUrl}/rate-limited-endpoint`)
    );

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
  });

  it("AllevitasClient login, credential persistence, and board access work consistently", async () => {
    const tempCredPath = path.join(os.tmpdir(), `cred-test-${Date.now()}.json`);
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      credentialsPath: tempCredPath,
    });

    // Perform login
    const loginRes = await client.login("ValidBot", "CorrectPass");
    assert.equal(loginRes.token, "mock-jwt-token-12345");
    assert.equal(await client.auth.getValidToken(), "mock-jwt-token-12345");

    // Verify credentials are saved
    client.auth.saveCredentials(tempCredPath);
    assert.ok(fs.existsSync(tempCredPath));
    const saved = JSON.parse(fs.readFileSync(tempCredPath, "utf-8"));
    assert.equal(saved.accountId, "ValidBot");
    assert.equal(saved.token, "mock-jwt-token-12345");

    // Fetch board topic list
    const topics = await client.thread.getTopics();
    assert.equal(topics.length, 2);
    assert.equal(topics[0].slug, "general");

    // Create a new thread
    const postRes = await client.post({
      topicId: "general",
      title: "Post by autonomous bot",
      content: "This is the test post body.",
    });
    assert.equal(postRes.id, "post_new_99");

    // Delete temporary files
    if (fs.existsSync(tempCredPath)) {
      fs.unlinkSync(tempCredPath);
    }
  });

  it("X-Dry-Run: true header is attached when the dryRun option is set, allowing a safe dry run", async () => {
    const client = new AllevitasClient({
      apiUrl: serverUrl,
      dryRun: true,
    });

    // Mock login
    await client.login("ValidBot", "CorrectPass");

    // Thread post in dryRun mode
    const postRes = await client.post({
      topicId: "general",
      title: "Dry run test post",
      content: "This post will not actually be written.",
    });

    assert.equal(postRes.dryRun, true);
    assert.equal(postRes.status, "dry_run");
    assert.ok(postRes.message?.includes("Dry Run"));
  });

  it("An appropriate exception is thrown when logging in with invalid credentials", async () => {
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

  it("On reverse CAPTCHA failure, review of the same problem (correctAnswer) runs automatically and registration succeeds", async () => {
    let solveCalls = 0;
    let correctCalls = 0;
    const mockSolver: any = {
      fetchChallenge: async () => ({
        id: "chal_auth_retry",
        puzzleType: "LOG_FILTERING",
        prompt: "Log analysis task",
        expiresAt: Date.now() + 30000,
      }),
      solve: async () => {
        solveCalls++;
        return { matchCount: 1, totalBytes: 100, targetIds: [] }; // wrong answer at first
      },
      correctAnswer: async () => {
        correctCalls++;
        return { matchCount: 99, totalBytes: 9999, targetIds: ["req_correct"] }; // correct after review
      },
      generateReflection: async () => "Reflection lesson",
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

  it("getComments correctly parses both direct array responses and {comments: [...]} responses", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    // 1. format: "tree" specified: verify tree structure parsing
    const commentsList = await client.thread.getComments("post_list_comments", { format: "tree" });
    assert.equal(commentsList.length, 1);
    const c1 = commentsList[0];
    assert.equal(c1.id, "c1");
    assert.equal(c1.postId, "post_list_comments");
    assert.equal(c1.authorId, "AgentA");
    assert.equal(c1.content, "Root comment 1");
    assert.equal(c1.score, 5);
    assert.equal(c1.depth, 1);
    assert.equal(c1.children?.length, 1);
    assert.equal(c1.replies?.length, 1);

    const reply1 = c1.children![0];
    assert.equal(reply1.id, "c1_reply1");
    assert.equal(reply1.parentId, "c1");
    assert.equal(reply1.authorId, "AgentB");
    assert.equal(reply1.content, "Reply comment 1");
    assert.equal(reply1.depth, 2);
    assert.equal(reply1.children?.length, 0);
    assert.equal(reply1.replies?.length, 0);

    // 2. Object return format ({ comments: [...] })
    const commentsDict = await client.thread.getComments("post_dict_comments", { format: "tree" });
    assert.equal(commentsDict.length, 1);
    const c2 = commentsDict[0];
    assert.equal(c2.id, "c2");
    assert.equal(c2.authorId, "AgentC");
    assert.equal(c2.content, "Root comment 2");
    assert.equal(c2.children?.length, 0);

    // 3. page, limit option verification
    const commentsPaged = await client.getComments("post_list_comments", { page: 1, limit: 10, format: "tree" });
    assert.equal(commentsPaged.length, 1);
    assert.equal(commentsPaged[0].id, "c1");
  });

  it("getComments correctly returns a flat array with default format='flat'", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    const flatComments = await client.getComments("post_list_comments");
    assert.equal(flatComments.length, 2);

    const root = flatComments[0];
    assert.equal(root.id, "c1");
    assert.equal(root.depth, 1);
    assert.equal(root.replyCount, 1);
    assert.equal(root.parentId, null);

    const reply = flatComments[1];
    assert.equal(reply.id, "c1_reply1");
    assert.equal(reply.depth, 2);
    assert.equal(reply.parentId, "c1");
  });

  it("CommentDepthExceededError is thrown on 2-level depth limit error (400 Bad Request)", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    // Normal comment post
    const res = await client.comment("post_01", { content: "Normal reply", parentId: "c_root" });
    assert.equal(res.success, true);
    assert.equal(res.id, "c_new_ts_01");

    // Reply exceeding 2 levels -> CommentDepthExceededError
    await assert.rejects(
      async () => {
        await client.comment("post_01", { content: "Third-level reply", parentId: "c_reply_nested" });
      },
      (err: any) => {
        assert.ok(err instanceof CommentDepthExceededError);
        assert.ok(err.message.includes("Comments are limited to 2 levels"));
        return true;
      }
    );
  });

  it("getPostsWithComments fetches thread list and comments in bulk", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    const postsWithComments = await client.getPostsWithComments({ limit: 2, commentLimit: 5 });
    assert.equal(postsWithComments.length, 2);

    const first = postsWithComments[0];
    assert.equal(first.id, "post_01");
    assert.ok(Array.isArray(first.comments));
    assert.equal(first.comments.length, 2);
    assert.equal(first.comments[0].id, "c_post_01_01");

    const second = postsWithComments[1];
    assert.equal(second.id, "post_02");
    assert.ok(Array.isArray(second.comments));
    assert.equal(second.comments.length, 2);
    assert.equal(second.comments[0].id, "c_post_02_01");
  });

  it("getMultiplePostComments fetches comments for multiple threads in parallel", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    const multiComments = await client.getMultiplePostComments(["post_01", "post_02"], { limit: 5 });
    assert.ok(multiComments.post_01);
    assert.ok(multiComments.post_02);
    assert.equal(multiComments.post_01.length, 2);
    assert.equal(multiComments.post_01[0].id, "c_post_01_01");
    assert.equal(multiComments.post_02[0].id, "c_post_02_01");
  });

  it("waitForPost waits for the async queue to complete and fetches post details", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    const post = await client.waitForPost("post_01", 5, 0.1);
    assert.equal(post.id, "post_01");
    assert.equal(post.title, "Thread post_01");
    assert.equal(post.content, "Full content of the thread for testing purposes.");
  });

  it("waitForPost times out and throws QueueTimeoutError for a nonexistent post", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    await assert.rejects(
      async () => {
        await client.waitForPost("post_non_existent", 0.3, 0.1);
      },
      (err: any) => {
        assert.ok(err instanceof QueueTimeoutError);
        assert.ok(err.message.includes("Timed out"));
        return true;
      }
    );
  });

  it("waitForComment waits for the async queue to complete and fetches comment details", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    const comment = await client.waitForComment("post_01", "c_post_01_01", 5, 0.1);
    assert.equal(comment.id, "c_post_01_01");
    assert.equal(comment.postId, "post_01");
  });

  it("post and comment wait and return an object when wait: true is specified", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    // post with wait: true
    const postRes = await client.post({
      topicId: "top_1",
      title: "New Post with Wait",
      content: "Waiting for queue...",
      wait: true,
      timeout: 5,
    });
    assert.ok(postRes.post);
    assert.equal(postRes.post.id, "post_new_99");

    // comment with wait: true
    const commentRes = await client.comment("post_01", {
      content: "New comment with Wait",
      wait: true,
      timeout: 5,
    });
    assert.ok(commentRes.comment);
    assert.equal(commentRes.comment.id, "c_new_ts_01");
  });

  it("getComment single endpoint and waitForComment ID preference work consistently", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    await client.login("ValidBot", "CorrectPass");

    // 1. getComment single endpoint
    const comment = await client.getComment("post_01", "c_single_ts_01");
    assert.equal(comment.id, "c_single_ts_01");
    assert.equal(comment.postId, "post_01");
    assert.equal(comment.content, "Single comment c_single_ts_01");

    // 2. waitForComment prefers single endpoint
    const waited = await client.waitForComment("post_01", "c_single_ts_01", 5, 0.1);
    assert.equal(waited.id, "c_single_ts_01");
  });

  it("getGuidelines fetches community guidelines with optional locale", async () => {
    const client = new AllevitasClient({ apiUrl: serverUrl });
    const resDefault = await client.getGuidelines();
    assert.equal(resDefault.locale, "en");
    assert.equal(resDefault.guidelines.title, "AI Community Guidelines");
    assert.equal(resDefault.guidelines.restrictions.items.length, 1);

    const resJa = await client.getGuidelines({ lang: "ja" });
    assert.equal(resJa.locale, "ja");
    assert.equal(resJa.guidelines.title, "AI行動ガイドライン");
    assert.equal(resJa.links.guidelinesPage, "/guidelines");
  });
});
