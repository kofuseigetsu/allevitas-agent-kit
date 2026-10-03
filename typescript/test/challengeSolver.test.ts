/**
 * ChallengeSolver unit tests (no API key required, uses mocks)
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
              prompt: "Please extract the number of entries matching the condition from the following log...",
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

  it("fetchChallenge correctly fetches a reverse CAPTCHA challenge from the server", async () => {
    const solver = new ChallengeSolver(serverUrl);
    const challenge = await solver.fetchChallenge();

    assert.equal(challenge.id, "chal_test_123");
    assert.equal(challenge.puzzleType, "LOG_FILTERING");
    assert.ok(challenge.prompt.includes("the following log"));
    assert.ok(challenge.expiresAt > Date.now());
  });

  it("In Self-Solve mode, the agent's custom answer callback works", async () => {
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

  it("A challenge with less than 5 seconds until expiry is rejected as an error", async () => {
    const solver = new ChallengeSolver(serverUrl, {
      llmProvider: "self",
      customSolver: async () => ({ matchCount: 0, totalBytes: 0, targetIds: [] }),
    });

    const expiredChallenge: ChallengeData = {
      id: "chal_expired",
      puzzleType: "LOG_FILTERING",
      prompt: "expired",
      expiresAt: Date.now() + 2000, // 2 seconds remaining
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

  it("JSON is correctly extracted from an LLM response containing markdown code blocks and surrounding greetings", async () => {
    // Dummy object that mocks LLMClient's call
    const mockLlmClient: any = {
      call: async () => {
        return "Yes, I have analyzed the task.\n```json\n{\"matchCount\": 5, \"totalBytes\": 2048, \"targetIds\": [\"req_05\"]}\n```\nPlease check it at your convenience.";
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

  it("correctAnswer passes a review prompt based on the previous wrong answer and allows re-answering", async () => {
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

    assert.ok(capturedPrompt.includes("You previously submitted an answer to the following reverse CAPTCHA puzzle, but it was incorrect"));
    assert.ok(capturedPrompt.includes("[Previous Incorrect Answer]"));
    assert.ok(capturedPrompt.includes('"matchCount":2'));
    assert.equal(corrected.matchCount, 3);
  });

  it("generateReflection extracts a lesson, accumulates it in reflectionKnowledge, and injects it into the next inference", async () => {
    let callCount = 0;
    let lastPrompt = "";
    const mockLlmClient: any = {
      call: async (args: any) => {
        callCount++;
        lastPrompt = args.prompt;
        if (args.jsonMode === false) {
          // generateReflection call
          return "\"Strictly AND-evaluate the conditions status 200 and response time exceeding 300ms\"";
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

    assert.ok(lesson.includes("status 200 and response time exceeding 300ms"));
    assert.deepEqual(solver.getReflectionKnowledge(), [
      "Strictly AND-evaluate the conditions status 200 and response time exceeding 300ms",
    ]);

    // Verify the lesson is included in the prompt on the next solve run
    await solver.solve(challenge);
    assert.ok(lastPrompt.includes("[Lessons from Previous Attempts]"));
    assert.ok(lastPrompt.includes("status 200 and response time exceeding 300ms"));
  });
});

