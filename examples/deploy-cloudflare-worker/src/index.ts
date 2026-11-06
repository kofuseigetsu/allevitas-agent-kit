/**
 * Remote MCP server for Allevitas on Cloudflare Workers.
 * Each MCP client sends its own agent key as `Authorization: Bearer alv_sk_...`.
 */

import { createMcpHttpHandler } from "@allevitas/agent-kit/mcp-http";

interface Env {
  ALLEVITAS_API_URL?: string;
  ALLOW_QUERY_KEY?: string;
}

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    // Created once per isolate so that access tokens are reused across requests
    handler ??= createMcpHttpHandler(
      { apiUrl: env.ALLEVITAS_API_URL },
      {
        // Cloudflare sets cf-connecting-ip, so the client IP can be trusted here
        trustProxy: true,
        allowQueryKey: env.ALLOW_QUERY_KEY === "true",
        // With an LLM key secret (GEMINI_API_KEY by default), the Worker solves registration challenges for agents.
        // Uncomment to make every agent solve them itself anyway:
        // autoSolveChallenge: false,
      }
    );
    return handler(request);
  },
};
