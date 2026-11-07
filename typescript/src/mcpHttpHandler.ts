/**
 * @allevitas/agent-kit - Remote MCP server over Streamable HTTP
 *
 * A stateless request handler built on the Web standard Request/Response, so it runs on
 * Cloudflare Workers, Hono, Deno, Bun, or Node.js. Each caller authenticates with its own
 * agent key; the handler exchanges it for short-lived access tokens and caches them.
 * Newly issued keys leave the handler only as one-time links.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AllevitasClient } from "./client.js";
import { maskSecrets } from "./errors.js";
import { MCPServer, SUPPORTED_PROTOCOL_VERSIONS, type MCPServerInfo, type MCPServerOptions } from "./mcpServer.js";
import { ClientOptions } from "./types.js";

const AGENT_KEY_PATTERN = /^alv_sk_[0-9A-Za-z_-]+$/;
// Calls that work before the caller has a key: registering, and claiming a key after recovery
const KEYLESS_METHODS = new Set(["initialize", "ping", "tools/list"]);
const KEYLESS_TOOLS = new Set(["allevitas_get_challenge", "allevitas_register", "allevitas_claim"]);

export interface CachedToken {
  token: string;
  /** UNIX epoch milliseconds */
  expiresAt: number;
  /** Account the token belongs to. Without it, allevitas_whoami reports accountId: null until the token is renewed */
  accountId?: string;
}

/**
 * Shared access token cache, keyed by the SHA-256 of the agent key. The default lives in
 * memory; a Workers deployment can back it with the Cache API to share tokens across isolates.
 */
export interface TokenCache {
  get(keyHash: string): Promise<CachedToken | null> | CachedToken | null;
  set(keyHash: string, value: CachedToken): Promise<void> | void;
  delete(keyHash: string): Promise<void> | void;
}

export interface McpHttpHandlerOptions {
  /** Accept the agent key from `?key=` as well. URLs end up in access logs, so this is off by default. */
  allowQueryKey?: boolean;
  /** Read the client IP from cf-connecting-ip / x-forwarded-for and forward it to the API */
  trustProxy?: boolean;
  /**
   * Origins allowed to call the handler (DNS rebinding protection). Requests without an Origin
   * header, such as server-to-server MCP clients, are always allowed.
   */
  allowedOrigins?: string[];
  /** Largest accepted request body in bytes (default: 1 MiB) */
  maxBodyBytes?: number;
  /** Clients kept for reuse, one per agent key (default: 1000) */
  maxClients?: number;
  /** Drop a cached client after this long without use (default: 15 minutes) */
  clientIdleMs?: number;
  tokenCache?: TokenCache;
  /** Hide allevitas_register, allevitas_claim, and allevitas_rotate_key */
  disableKeyIssuingTools?: boolean;
  /**
   * Solve the registration challenge for agents that omit the answer (default: when an LLM is
   * configured, such as GEMINI_API_KEY). false makes every agent solve it itself.
   */
  autoSolveChallenge?: boolean;
  /** serverInfo returned by initialize. Each field given replaces its default (name: "allevitas", title: "Allevitas") */
  serverInfo?: MCPServerInfo;
  /** instructions returned by initialize, passed by the client to its model (default: none) */
  instructions?: string;
  logger?: (message: string) => void;
}

interface CachedClient {
  client: AllevitasClient;
  lastUsed: number;
}

class MemoryTokenCache implements TokenCache {
  private entries = new Map<string, CachedToken>();
  constructor(private readonly maxEntries: number) {}
  get(keyHash: string) {
    const entry = this.entries.get(keyHash);
    return entry && entry.expiresAt > Date.now() ? entry : null;
  }
  set(keyHash: string, value: CachedToken) {
    this.entries.delete(keyHash);
    this.entries.set(keyHash, value);
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
  delete(keyHash: string) {
    this.entries.delete(keyHash);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function rpcError(status: number, code: number, message: string, id: unknown = null, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { jsonrpc: "2.0", id, error: { code, message } }, headers);
}

function clientIpFrom(req: Request): string | undefined {
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) {
    return cfIp.trim();
  }
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}

/**
 * Create a Streamable HTTP handler (POST /mcp) that serves the Allevitas MCP tools.
 *
 * @param clientOptions Base options for the per-agent clients, such as apiUrl or extraHeaders.
 *   Credentials are never taken from them: each request brings its own agent key.
 */
export function createMcpHttpHandler(
  clientOptions: ClientOptions = {},
  options: McpHttpHandlerOptions = {}
): (req: Request) => Promise<Response> {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxClients = options.maxClients ?? 1000;
  const clientIdleMs = options.clientIdleMs ?? 15 * 60 * 1000;
  const tokenCache = options.tokenCache ?? new MemoryTokenCache(maxClients);
  const log = options.logger ?? ((message: string) => console.error(message));
  const requestContext = new AsyncLocalStorage<{ clientIp?: string }>();
  const clients = new Map<string, CachedClient>();

  const { agentKey: _agentKey, token: _token, accountId: _accountId, ...baseOptions } = clientOptions;
  const newClient = (extra: ClientOptions) =>
    new AllevitasClient({
      ...baseOptions,
      ...extra,
      stateless: true,
      autoRotate: false,
      recoveryKeyNotice: false,
      secretDelivery: "url",
      forwardedFor: () => requestContext.getStore()?.clientIp,
    });

  const serverOptions: MCPServerOptions = {
    mode: "remote",
    disableKeyIssuingTools: options.disableKeyIssuingTools,
    autoSolveChallenge: options.autoSolveChallenge,
    serverInfo: options.serverInfo,
    instructions: options.instructions,
    logger: log,
  };
  // Reject invalid serverInfo or instructions here rather than on every request
  new MCPServer(newClient({}), serverOptions);

  const clientFor = async (agentKey: string, keyHash: string): Promise<AllevitasClient> => {
    const now = Date.now();
    for (const [hash, entry] of clients) {
      if (now - entry.lastUsed > clientIdleMs) {
        clients.delete(hash);
      }
    }
    const cached = clients.get(keyHash);
    if (cached) {
      clients.delete(keyHash);
      clients.set(keyHash, { ...cached, lastUsed: now });
      return cached.client;
    }

    const shared = await tokenCache.get(keyHash);
    // A cached token skips /auth/token, which is otherwise the only place the account ID comes from
    const client = newClient({
      agentKey,
      ...(shared ? { token: shared.token, ...(shared.accountId ? { accountId: shared.accountId } : {}) } : {}),
    });
    clients.set(keyHash, { client, lastUsed: now });
    if (clients.size > maxClients) {
      clients.delete(clients.keys().next().value!);
    }
    return client;
  };

  const handle = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      // Stateless: no SSE stream to open (GET) and no session to end (DELETE)
      return rpcError(405, -32000, "Method not allowed. Send JSON-RPC requests with POST.", null, { Allow: "POST" });
    }

    const origin = req.headers.get("origin");
    if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
      return rpcError(403, -32000, "Origin not allowed.");
    }

    const accept = req.headers.get("accept");
    if (accept && !/application\/json|text\/event-stream|\*\/\*/.test(accept)) {
      return rpcError(406, -32000, "Accept must include application/json.");
    }

    const protocolVersion = req.headers.get("mcp-protocol-version");
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return rpcError(400, -32000, `Unsupported MCP-Protocol-Version: ${protocolVersion}`);
    }

    if (Number(req.headers.get("content-length") || 0) > maxBodyBytes) {
      return rpcError(413, -32000, "Request body too large.");
    }
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > maxBodyBytes) {
      return rpcError(413, -32000, "Request body too large.");
    }

    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return rpcError(400, -32700, "Parse error: Invalid JSON");
    }
    if (Array.isArray(message) || !message || typeof message !== "object") {
      return rpcError(400, -32600, "Invalid request: send one JSON-RPC message per request.");
    }
    // Notifications and responses from the client need no answer
    if (message.id === undefined || message.id === null || message.method === undefined) {
      return new Response(null, { status: 202 });
    }

    const agentKey = extractAgentKey(req, Boolean(options.allowQueryKey));
    if (agentKey === "invalid") {
      return rpcError(401, -32001, "Send an agent key (alv_sk_...) as Authorization: Bearer.", message.id, {
        "WWW-Authenticate": 'Bearer realm="allevitas"',
      });
    }
    const needsKey = !KEYLESS_METHODS.has(message.method) && !(message.method === "tools/call" && KEYLESS_TOOLS.has(message.params?.name));
    if (!agentKey && needsKey) {
      return rpcError(401, -32001, "This call needs an agent key. Send it as Authorization: Bearer alv_sk_...", message.id, {
        "WWW-Authenticate": 'Bearer realm="allevitas"',
      });
    }

    const keyHash = agentKey ? sha256Hex(agentKey) : null;
    const client = agentKey ? await clientFor(agentKey, keyHash!) : newClient({});
    const server = new MCPServer(client, serverOptions);

    const clientIp = options.trustProxy ? clientIpFrom(req) : undefined;
    const tokenBefore = client.auth.token;
    const result = await requestContext.run({ clientIp }, () => server.handleMessage(message));

    if (keyHash) {
      if (client.auth.fatalError) {
        // Revoked, expired, or banned: do not keep serving this key from cache
        clients.delete(keyHash);
        await tokenCache.delete(keyHash);
      } else if (client.auth.token && client.auth.token !== tokenBefore) {
        const expiresAt = (client.auth.getStatus().tokenExpiresAt ?? 0) * 1000;
        if (expiresAt > Date.now()) {
          const accountId = client.auth.accountId;
          await tokenCache.set(keyHash, { token: client.auth.token, expiresAt, ...(accountId ? { accountId } : {}) });
        }
      }
    }
    return jsonResponse(200, result);
  };

  return async (req: Request) => {
    try {
      return await handle(req);
    } catch (err: unknown) {
      log(`[Allevitas MCP HTTP] ${maskSecrets(String(err))}`);
      return rpcError(500, -32603, "Internal error");
    }
  };
}

/**
 * The agent key of the request, null when none was sent, or "invalid" for a malformed one.
 */
function extractAgentKey(req: Request, allowQueryKey: boolean): string | null | "invalid" {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    return match && AGENT_KEY_PATTERN.test(match[1]!) ? match[1]! : "invalid";
  }
  if (allowQueryKey) {
    const key = new URL(req.url).searchParams.get("key");
    if (key) {
      return AGENT_KEY_PATTERN.test(key) ? key : "invalid";
    }
  }
  return null;
}

/**
 * Adapt a Web standard handler to Node.js (http.createServer, Express).
 */
export function toNodeHandler(
  handler: (req: Request) => Promise<Response>
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const host = req.headers.host || "localhost";
    const request = new Request(`http://${host}${req.url || "/"}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });

    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
