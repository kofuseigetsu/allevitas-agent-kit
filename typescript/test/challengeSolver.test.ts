/**
 * ChallengeSolver ユニットテスト (APIキー不要・モック使用)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ChallengeSolver, ChallengeData } from "../src/index.js";

describe("ChallengeSolver (Mocked)", () => {
  let server: http.Server;
  let serverUrl: string;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/challenge" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            challenge: {
              id: "chal_test_123",
              puzzleType: "LOG_FILTERING",
              prompt: "以下のログから条件に合う件数を抽出してください...",
              expiresAt: Date.now() + 30000,
            },
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
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

  it("fetchChallenge でサーバーから逆CAPTCHA課題を正しく取得できる", async () => {
    const solver = new ChallengeSolver(serverUrl);
    const challenge = await solver.fetchChallenge();

    assert.equal(challenge.id, "chal_test_123");
    assert.equal(challenge.puzzleType, "LOG_FILTERING");
    assert.ok(challenge.prompt.includes("以下のログ"));
    assert.ok(challenge.expiresAt > Date.now());
  });

  it("Self-Solve モードでエージェント独自の解答コールバックが機能する", async () => {
    const solver = new ChallengeSolver(serverUrl, {
      llmProvider: "self",
      customSolver: async (ch) => {
        assert.equal(ch.id, "chal_test_123");
        return {
          matchCount: 4,
          totalBytes: 1024,
          targetIds: ["req_01", "req_02"],
        };
      },
    });

    const challenge: ChallengeData = {
      id: "chal_test_123",
      puzzleType: "LOG_FILTERING",
      prompt: "test prompt",
      expiresAt: Date.now() + 30000,
    };

    const answer = await solver.solve(challenge);
    assert.deepEqual(answer, {
      matchCount: 4,
      totalBytes: 1024,
      targetIds: ["req_01", "req_02"],
    });
  });

  it("有効期限が残り5秒未満のチャレンジはエラーとして弾かれる", async () => {
    const solver = new ChallengeSolver(serverUrl, {
      llmProvider: "self",
      customSolver: async () => ({ matchCount: 0, totalBytes: 0, targetIds: [] }),
    });

    const expiredChallenge: ChallengeData = {
      id: "chal_expired",
      puzzleType: "LOG_FILTERING",
      prompt: "expired",
      expiresAt: Date.now() + 2000, // 残り2秒
    };

    await assert.rejects(
      async () => {
        await solver.solve(expiredChallenge);
      },
      {
        name: "Error",
        message: "Challenge has expired or is nearing expiration. Please fetch a new challenge.",
      }
    );
  });

  it("マークダウンコードブロックや前後の挨拶が含まれるLLM応答から正しくJSONを抽出できる", async () => {
    // LLMClient の call をモックするダミーオブジェクト
    const mockLlmClient: any = {
      call: async () => {
        return "はい、課題を解析しました。\n```json\n{\"matchCount\": 5, \"totalBytes\": 2048, \"targetIds\": [\"req_05\"]}\n```\nご確認のほどよろしくお願いいたします。";
      },
    };

    const solver = new ChallengeSolver(serverUrl, { llmProvider: "gemini" }, mockLlmClient);
    const challenge: ChallengeData = {
      id: "chal_md_test",
      puzzleType: "LOG_FILTERING",
      prompt: "markdown test prompt",
      expiresAt: Date.now() + 30000,
    };

    const answer = await solver.solve(challenge);
    assert.deepEqual(answer, {
      matchCount: 5,
      totalBytes: 2048,
      targetIds: ["req_05"],
    });
  });

  it("correctAnswer で前回の誤答を踏まえた見直しプロンプトが渡り再解答できる", async () => {
    let capturedPrompt = "";
    const mockLlmClient: any = {
      call: async (args: any) => {
        capturedPrompt = args.prompt;
        return JSON.stringify({ matchCount: 3, totalBytes: 1500, targetIds: ["req_01"] });
      },
    };

    const solver = new ChallengeSolver(serverUrl, { llmProvider: "gemini" }, mockLlmClient);
    const challenge: ChallengeData = {
      id: "chal_retry_test",
      puzzleType: "LOG_FILTERING",
      prompt: "filter prompt",
      expiresAt: Date.now() + 30000,
    };

    const previousAnswer = { matchCount: 2, totalBytes: 1000, targetIds: [] };
    const corrected = await solver.correctAnswer(challenge, previousAnswer, 2);

    assert.ok(capturedPrompt.includes("先ほど以下の逆CAPTCHA課題に対して解答を提出しましたが、不正解"));
    assert.ok(capturedPrompt.includes("前回の誤答"));
    assert.ok(capturedPrompt.includes('"matchCount":2'));
    assert.equal(corrected.matchCount, 3);
  });

  it("generateReflection で教訓が抽出され、reflectionKnowledge に蓄積されて次の推論に注入される", async () => {
    let callCount = 0;
    let lastPrompt = "";
    const mockLlmClient: any = {
      call: async (args: any) => {
        callCount++;
        lastPrompt = args.prompt;
        if (args.jsonMode === false) {
          // generateReflection の呼び出し
          return "「ステータス200かつレスポンス時間が300msを超える条件を厳密にAND判定すること」";
        }
        return JSON.stringify({ matchCount: 4, totalBytes: 2000, targetIds: ["req_02"] });
      },
    };

    const solver = new ChallengeSolver(serverUrl, { llmProvider: "gemini" }, mockLlmClient);
    const challenge: ChallengeData = {
      id: "chal_reflection_test",
      puzzleType: "LOG_FILTERING",
      prompt: "filter prompt 2",
      expiresAt: Date.now() + 30000,
    };

    const failedAnswer = { matchCount: 1, totalBytes: 500, targetIds: [] };
    const lesson = await solver.generateReflection(challenge, failedAnswer);

    assert.ok(lesson.includes("ステータス200かつレスポンス時間が300msを超える条件"));
    assert.deepEqual(solver.getReflectionKnowledge(), [
      "ステータス200かつレスポンス時間が300msを超える条件を厳密にAND判定すること",
    ]);

    // 次回の solve 実行時に教訓がプロンプトに含まれているか検証
    await solver.solve(challenge);
    assert.ok(lastPrompt.includes("【過去の誤答から得た教訓・反省点】"));
    assert.ok(lastPrompt.includes("ステータス200かつレスポンス時間が300msを超える条件"));
  });
});

