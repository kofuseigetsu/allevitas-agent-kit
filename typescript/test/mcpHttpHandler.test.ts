/**
 * Remote MCP (Streamable HTTP) handler tests (no API key required, uses a mock server)
 */

import "./helpers/testEnv.js";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AllevitasClient,
  CachedToken,
  createMcpHttpHandler,
  McpHttpHandlerOptions,
  SDK_VERSION,
  TokenCache,
  toNodeHandler,
} from "../src/index.js";
import { AgentKeyMockServer, startAgentKeyMockServer } from "./helpers/agentKeyMockServer.js";

const KEY = "alv_sk_remotekeyvalue1";
const ENV_KEYS = ["ALLEVITAS_AGENT_KEY", "ALLEVITAS_RECOVERY_KEY_FILE", "ALLEVITAS_SECRET_DELIVERY", "ALLEVITAS_CREDENTIALS_PATH"];

describe("Remote MCP handler (Streamable HTTP)", () => {
  let mock: AgentKeyMockServer;
  const savedEnv: Record<string, string | undefined> = {};

  const handlerFor = (options: McpHttpHandlerOptions = {}) =>
    createMcpHttpHandler({ apiUrl: mock.url, maxRetries: 0 }, { logger: () => {}, ...options });

  const post = (
    handler: (req: Request) => Promise<Response>,
    body: unknown,
    { key = KEY as string | null, headers = {} as Record<string, string>, query = "" } = {}
  ) =>
    handler(
      new Request(`https://mcp.example/mcp${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  const callTool = async (handler: (req: Request) => Promise<Response>, name: string, args = {}, opts = {}) => {
    const res = await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, opts);
    const body: any = await res.json();
    return { status: res.status, body, text: body.result?.content?.[0]?.text as string, isError: body.result?.isError };
  };

  before(async () => {
    mock = await startAgentKeyMockServer();
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mock.state.keys.clear();
    mock.state.keys.set(KEY, "active");
    mock.state.claimCodes.clear();
    mock.state.links.clear();
    for (const list of [mock.state.tokenRequests, mock.state.registerRequests, mock.state.forwardedFor]) {
      list.length = 0;
    }
    Object.assign(mock.state, { tokenVersion: 0, ignoreSecretDelivery: false, secretDeliveryError: null, nextApiError: null });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe("protocol", () => {
    it("negotiates the protocol version and reports the package version", async () => {
      const handler = handlerFor();
      const known: any = await (await post(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { key: null })).json();
      assert.equal(known.result.protocolVersion, "2025-06-18");
      const unknown: any = await (await post(handler, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, { key: null })).json();
      assert.equal(unknown.result.protocolVersion, "2025-11-25");

      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
      assert.equal(known.result.serverInfo.version, pkg.version);
      assert.equal(SDK_VERSION, pkg.version);
    });

    it("returns the serverInfo and instructions it was given", async () => {
      const init = async (handler: (req: Request) => Promise<Response>) =>
        ((await (await post(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { key: null })).json()) as any).result;

      const plain = await init(handlerFor());
      assert.deepEqual(plain.serverInfo, { name: "allevitas", title: "Allevitas", version: SDK_VERSION });
      assert.ok(!("instructions" in plain));

      const custom = await init(handlerFor({ serverInfo: { title: "Allevitas Dev" }, instructions: "Use the allevitas_* tools." }));
      assert.deepEqual(custom.serverInfo, { name: "allevitas", title: "Allevitas Dev", version: SDK_VERSION });
      assert.equal(custom.instructions, "Use the allevitas_* tools.");
    });

    it("rejects invalid serverInfo when the handler is created", () => {
      assert.throws(() => handlerFor({ serverInfo: { name: "" } }), TypeError);
    });

    it("answers notifications with 202 and refuses GET, batches, and bad headers", async () => {
      const handler = handlerFor();
      assert.equal((await post(handler, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
      assert.equal((await handler(new Request("https://mcp.example/mcp", { method: "GET" }))).status, 405);
      assert.equal((await post(handler, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400);
      assert.equal((await post(handler, "{not json")).status, 400);
      assert.equal((await post(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { "MCP-Protocol-Version": "1999-01-01" } })).status, 400);
      assert.equal((await post(handler, { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { Accept: "text/html" } })).status, 406);
      assert.equal((await post(handlerFor({ maxBodyBytes: 10 }), { jsonrpc: "2.0", id: 1, method: "ping" })).status, 413);
    });

    it("allows only listed origins", async () => {
      const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
      assert.equal((await post(handlerFor(), ping, { headers: { Origin: "https://evil.example" } })).status, 403);
      const allowed = handlerFor({ allowedOrigins: ["https://app.example"] });
      assert.equal((await post(allowed, ping, { headers: { Origin: "https://app.example" } })).status, 200);
    });

    it("works through the Node.js adapter", async () => {
      const server = http.createServer(toNodeHandler(handlerFor()));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const { port } = server.address() as { port: number };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 7, result: {} });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("authentication", () => {
    it("requires a key for account tools but not for registration", async () => {
      const handler = handlerFor();
      const res = await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "allevitas_list_keys" } }, { key: null });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") || "", /^Bearer/);

      const listed: any = await (await post(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { key: null })).json();
      assert.ok(listed.result.tools.some((t: any) => t.name === "allevitas_register"));
    });

    it("rejects a malformed bearer value", async () => {
      const res = await post(handlerFor(), { jsonrpc: "2.0", id: 1, method: "ping" }, { key: "jwt-not-a-key" });
      assert.equal(res.status, 401);
    });

    it("reads ?key= only when allowed", async () => {
      const args = ["allevitas_list_keys", {}, { key: null, query: `?key=${KEY}` }] as const;
      assert.equal((await callTool(handlerFor(), ...args)).status, 401);
      const allowed = await callTool(handlerFor({ allowQueryKey: true }), ...args);
      assert.equal(allowed.status, 200);
      assert.equal(allowed.isError, false, allowed.text);
    });

    it("exchanges a key once and reuses the token", async () => {
      const handler = handlerFor();
      await callTool(handler, "allevitas_list_keys");
      await callTool(handler, "allevitas_list_keys");
      assert.equal(mock.state.tokenRequests.filter((r) => r.agentKey === KEY).length, 1);
    });

    it("shares tokens through the token cache", async () => {
      const entries = new Map<string, CachedToken>();
      const tokenCache: TokenCache = {
        get: (hash) => entries.get(hash) ?? null,
        set: (hash, value) => void entries.set(hash, value),
        delete: (hash) => void entries.delete(hash),
      };
      await callTool(handlerFor({ tokenCache }), "allevitas_list_keys");
      assert.equal(entries.size, 1);
      assert.ok(![...entries.keys()][0]!.includes(KEY));

      const second = await callTool(handlerFor({ tokenCache }), "allevitas_list_keys");
      assert.equal(second.isError, false, second.text);
      assert.equal(mock.state.tokenRequests.length, 1);
    });

    it("drops a client whose key was revoked", async () => {
      const handler = handlerFor();
      mock.state.keys.set(KEY, "RECOVERY");
      const revoked = await callTool(handler, "allevitas_list_keys");
      assert.equal(revoked.isError, true);
      assert.match(revoked.text, /recover/);

      mock.state.keys.set(KEY, "active");
      const again = await callTool(handler, "allevitas_list_keys");
      assert.equal(again.isError, false, again.text);
    });

    it("never uses the host's own key or credentials", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allevitas-remote-"));
      const credentialsPath = path.join(dir, "credentials.json");
      fs.writeFileSync(credentialsPath, JSON.stringify({ accountId: "host_bot", agentKey: "alv_sk_hostfilekey" }));
      process.env.ALLEVITAS_CREDENTIALS_PATH = credentialsPath;
      process.env.ALLEVITAS_AGENT_KEY = "alv_sk_hostenvkey";
      try {
        const client = new AllevitasClient({ apiUrl: mock.url, stateless: true });
        assert.equal(client.auth.getStatus().hasAgentKey, false);
        assert.equal(client.auth.secretDelivery, "url");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("client IP", () => {
    it("forwards the first X-Forwarded-For entry only behind a trusted proxy", async () => {
      const headers = { "X-Forwarded-For": "203.0.113.9, 10.0.0.1" };
      await callTool(handlerFor(), "allevitas_list_keys", {}, { headers });
      assert.equal(mock.state.forwardedFor.length, 0);

      await callTool(handlerFor({ trustProxy: true }), "allevitas_list_keys", {}, { headers });
      assert.ok(mock.state.forwardedFor.length > 0);
      assert.ok(mock.state.forwardedFor.every((ip) => ip === "203.0.113.9"));
    });

    it("prefers cf-connecting-ip", async () => {
      await callTool(handlerFor({ trustProxy: true }), "allevitas_list_keys", {}, {
        headers: { "CF-Connecting-IP": "198.51.100.4", "X-Forwarded-For": "203.0.113.9" },
      });
      assert.ok(mock.state.forwardedFor.every((ip) => ip === "198.51.100.4"));
    });
  });

  describe("tools that issue keys", () => {
    it("register returns both keys as links and nothing raw", async () => {
      const result = await callTool(
        handlerFor(),
        "allevitas_register",
        { accountId: "key_bot", challengeId: "c1", challengeAnswer: { matchCount: 1 } },
        { key: null }
      );
      assert.equal(result.isError, false, result.text);
      const data = JSON.parse(result.text);
      assert.match(mock.state.links.get(data.agentKeyUrl)!, /^alv_sk_/);
      assert.equal(mock.state.links.get(data.recoveryKeyUrl), "alv_rk_registered");
      assert.ok(data.agentKeyUrl.includes("#key"), "the link fragment must reach the operator");
      assert.ok(!result.text.includes("alv_sk_") && !result.text.includes("alv_rk_"));
      assert.equal(data.credentialsPath, undefined);
      assert.equal(mock.state.registerRequests[0].secretDelivery, "url");
    });

    it("claim returns the new key as a link", async () => {
      mock.state.claimCodes.set("alv_cc_good", "unused");
      const result = await callTool(handlerFor(), "allevitas_claim", { code: "alv_cc_good" }, { key: null });
      assert.equal(result.isError, false, result.text);
      assert.match(mock.state.links.get(JSON.parse(result.text).agentKeyUrl)!, /^alv_sk_/);
    });

    it("rotate_key keeps the current key and has no immediate mode", async () => {
      const handler = handlerFor();
      const listed: any = await (await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
      const rotateTool = listed.result.tools.find((t: any) => t.name === "allevitas_rotate_key");
      assert.equal(rotateTool.inputSchema.properties.now, undefined);

      const now = await callTool(handler, "allevitas_rotate_key", { now: true });
      assert.equal(now.isError, true);
      assert.match(now.text, /recover/);

      const rotated = await callTool(handler, "allevitas_rotate_key");
      assert.equal(rotated.isError, false, rotated.text);
      const data = JSON.parse(rotated.text);
      assert.equal(data.committed, false);
      assert.equal(mock.state.keys.get(mock.state.links.get(data.agentKeyUrl)!), "pending");
      assert.equal(mock.state.keys.get(KEY), "active");
    });

    it("can be hidden", async () => {
      const handler = handlerFor({ disableKeyIssuingTools: true });
      const listed: any = await (await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
      const names = listed.result.tools.map((t: any) => t.name);
      assert.ok(!names.includes("allevitas_register") && !names.includes("allevitas_claim") && !names.includes("allevitas_rotate_key"));
      const call = await callTool(handler, "allevitas_rotate_key");
      assert.equal(call.isError, true);
    });
  });

  describe("registration challenge", () => {
    const listTools = async (handler: (req: Request) => Promise<Response>) => {
      const listed: any = await (await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { key: null })).json();
      return Object.fromEntries(listed.result.tools.map((t: any) => [t.name, t]));
    };
    const withGeminiKey = async (fn: () => Promise<void>) => {
      process.env.GEMINI_API_KEY = "test-gemini-key";
      try {
        await fn();
      } finally {
        process.env.GEMINI_API_KEY = "";
      }
    };
    const assertManual = (tools: Record<string, any>) => {
      const register = tools.allevitas_register;
      assert.deepEqual(register.inputSchema.required, ["accountId", "challengeId", "challengeAnswer"]);
      assert.ok(!JSON.stringify(Object.values(tools)).includes("auto-solved"));
      assert.match(register.description, /does not solve the registration challenge/);
      assert.match(register.description, /one-time links/, "the link notice stays");
      assert.match(tools.allevitas_get_challenge.description, /Required for registration/);
    };

    it("requires the answer when no LLM is configured", async () => {
      assertManual(await listTools(handlerFor()));
    });

    it("keeps the optional answer when an LLM key is set", async () => {
      await withGeminiKey(async () => {
        const register = (await listTools(handlerFor())).allevitas_register;
        assert.deepEqual(register.inputSchema.required, ["accountId"]);
        assert.match(register.inputSchema.properties.challengeId.description, /auto-solved if omitted/);
      });
    });

    it("autoSolveChallenge: false requires the answer even with a key", async () => {
      await withGeminiKey(async () => {
        assertManual(await listTools(handlerFor({ autoSolveChallenge: false })));
      });
    });

    it("refuses a missing answer without calling the API or an LLM", async () => {
      const handler = handlerFor();
      const originalFetch = globalThis.fetch;
      const requested: string[] = [];
      globalThis.fetch = ((input: any, init?: any) => {
        requested.push(String(input?.url ?? input));
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        for (const args of [{ accountId: "key_bot" }, { accountId: "key_bot", challengeId: "c1" }]) {
          const result = await callTool(handler, "allevitas_register", args, { key: null });
          assert.equal(result.isError, true);
          assert.equal(
            result.text,
            "Error: This server does not solve the registration challenge for you. Call allevitas_get_challenge, solve the puzzle yourself, then call allevitas_register again with challengeId and challengeAnswer. Challenges expire quickly, so do this right away."
          );
          assert.ok(!/GEMINI|API_KEY/.test(result.text));
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.deepEqual(requested, []);
      assert.equal(mock.state.registerRequests.length, 0);
    });

    it("registers with an answer the agent solved", async () => {
      const result = await callTool(
        handlerFor(),
        "allevitas_register",
        { accountId: "key_bot", challengeId: "c1", challengeAnswer: { matchCount: 1 } },
        { key: null }
      );
      assert.equal(result.isError, false, result.text);
      assert.ok(JSON.parse(result.text).agentKeyUrl);
    });
  });
});
