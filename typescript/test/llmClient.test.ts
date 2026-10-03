/**
 * LLMClient / callLLM unit tests (no API key required, uses mock server)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LLMClient, callLLM } from "../src/index.js";

describe("LLMClient (Mocked Server)", () => {
  let server: http.Server;
  let serverUrl: string;
  let receivedRequests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];

  before(async () => {
    server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) {
        bodyText += chunk;
      }
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;
      receivedRequests.push({
        url: req.url || "",
        headers: req.headers,
        body: parsedBody,
      });

      // Response per endpoint
      if (req.url?.includes("generateContent")) {
        // Gemini mock
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Gemini response text" }],
                },
              },
            ],
          })
        );
      } else if (req.url?.includes("/chat/completions")) {
        // OpenAI mock
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: "OpenAI response text" },
              },
            ],
          })
        );
      } else if (req.url?.includes("/messages")) {
        // Anthropic mock
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ text: "Anthropic response text" }],
          })
        );
      } else if (req.url?.includes("/api/generate")) {
        // Ollama mock
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            response: "Ollama response text",
          })
        );
      } else {
        res.writeHead(404);
        res.end("Not Found");
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

  it("Can verify OpenAI provider call, headers, and parameters", async () => {
    receivedRequests = [];
    const client = new LLMClient({
      provider: "openai",
      apiKey: "test-openai-key",
      baseUrl: serverUrl,
      model: "gpt-test-model",
    });

    const res = await client.call({
      prompt: "Hello OpenAI",
      systemPrompt: "You are a test assistant",
      temperature: 0.5,
      jsonMode: true,
    });

    assert.equal(res, "OpenAI response text");
    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.headers.authorization, "Bearer test-openai-key");
    assert.equal(req.body.model, "gpt-test-model");
    assert.equal(req.body.temperature, 0.5);
    assert.deepEqual(req.body.response_format, { type: "json_object" });
    assert.equal(req.body.messages.length, 2);
    assert.equal(req.body.messages[0].role, "system");
    assert.equal(req.body.messages[1].content, "Hello OpenAI");
  });

  it("Can verify Ollama provider call and parameters", async () => {
    receivedRequests = [];
    const client = new LLMClient({
      provider: "ollama",
      baseUrl: serverUrl,
      model: "llama-test",
    });

    const res = await client.generate("Hello Ollama", "System prompt");
    assert.equal(res, "Ollama response text");
    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.body.model, "llama-test");
    assert.equal(req.body.prompt, "Hello Ollama");
    assert.equal(req.body.system, "System prompt");
  });

  it("callLLM standalone function can directly override the provider", async () => {
    receivedRequests = [];
    const res = await callLLM(
      {
        prompt: "Direct call",
        provider: "openai",
        baseUrl: serverUrl,
        apiKey: "override-key",
      }
    );

    assert.equal(res, "OpenAI response text");
    assert.equal(receivedRequests[0].headers.authorization, "Bearer override-key");
  });

  it("Can verify xAI (Grok) provider call, headers, and parameters (primary: xai, alias: grok)", async () => {
    // 1. Verify primary xai
    receivedRequests = [];
    const clientXAI = new LLMClient({
      provider: "xai",
      apiKey: "test-xai-key",
      baseUrl: serverUrl,
      model: "grok-2-latest",
    });

    const res1 = await clientXAI.call({
      prompt: "Hello xAI",
      systemPrompt: "You are Grok",
      temperature: 0.7,
      jsonMode: true,
    });

    assert.equal(res1, "OpenAI response text");
    assert.equal(receivedRequests.length, 1);
    const req1 = receivedRequests[0];
    assert.equal(req1.headers.authorization, "Bearer test-xai-key");
    assert.equal(req1.body.model, "grok-2-latest");
    assert.equal(req1.body.temperature, 0.7);
    assert.deepEqual(req1.body.response_format, { type: "json_object" });
    assert.equal(req1.body.messages.length, 2);
    assert.equal(req1.body.messages[0].role, "system");
    assert.equal(req1.body.messages[1].content, "Hello xAI");

    // 2. Verify alias grok
    receivedRequests = [];
    const clientGrok = new LLMClient({
      provider: "grok",
      apiKey: "test-grok-key",
      baseUrl: serverUrl,
      model: "grok-beta",
    });

    const res2 = await clientGrok.call({
      prompt: "Hello Grok Alias",
    });

    assert.equal(res2, "OpenAI response text");
    assert.equal(receivedRequests.length, 1);
    const req2 = receivedRequests[0];
    assert.equal(req2.headers.authorization, "Bearer test-grok-key");
    assert.equal(req2.body.model, "grok-beta");
    assert.equal(req2.body.messages[0].content, "Hello Grok Alias");
  });

  it("An appropriate error is thrown when the API key is not set", async () => {
    const client = new LLMClient({ provider: "openai", apiKey: "" });
    // Also clear environment variables
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALLEVITAS_LLM_API_KEY;

    try {
      await assert.rejects(
        async () => {
          await client.call({ prompt: "Test without key" });
        },
        {
          name: "Error",
          message: "OPENAI_API_KEY is not set.",
        }
      );
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }

    const xaiClient = new LLMClient({ provider: "xai", apiKey: "" });
    const origXAIKey = process.env.XAI_API_KEY;
    const origGrokKey = process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.ALLEVITAS_LLM_API_KEY;

    try {
      await assert.rejects(
        async () => {
          await xaiClient.call({ prompt: "Test without key" });
        },
        {
          name: "Error",
          message: "XAI_API_KEY or GROK_API_KEY is not set.",
        }
      );
    } finally {
      if (origXAIKey) process.env.XAI_API_KEY = origXAIKey;
      if (origGrokKey) process.env.GROK_API_KEY = origGrokKey;
    }
  });
});
