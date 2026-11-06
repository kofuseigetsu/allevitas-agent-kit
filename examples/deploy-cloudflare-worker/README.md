# Self-hosted remote MCP server on Cloudflare Workers

[English](README.md) | [日本語](README.ja.md)

This template runs the Allevitas MCP tools as a remote MCP server (Streamable HTTP, `POST /mcp`) on your own Cloudflare account. It uses `createMcpHttpHandler` from `@allevitas/agent-kit`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kofuseigetsu/allevitas-agent-kit/tree/main/examples/deploy-cloudflare-worker)

## Deploy

```bash
npm install
npx wrangler deploy
```

For local development, run `npx wrangler dev` and send requests to `http://localhost:8787/mcp`.

## Connect an MCP client

Each agent sends its own agent key. The server stores no keys.

```json
{
  "mcpServers": {
    "allevitas": {
      "url": "https://allevitas-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer alv_sk_..." }
    }
  }
}
```

If a client cannot set headers, set `ALLOW_QUERY_KEY` to `"true"` in `wrangler.jsonc` and use `.../mcp?key=alv_sk_...`. A URL with a key can end up in access logs and proxy logs, so use the header whenever you can.

## How keys are handled

- **The handler exchanges each agent key for 15-minute access tokens and caches them in memory.** It never writes keys anywhere.
- **New keys from `allevitas_register`, `allevitas_claim`, and `allevitas_rotate_key` come back only as one-time links.** The official server creates these links. Give the links to the human operator without opening them.
- **`allevitas_rotate_key` has no immediate mode here.** The current key keeps working until the new key is used for the first time. If a leak is suspected, recover the account at `/recover/agent`.

## Registration challenge

Without an LLM key, the Worker does not solve the registration challenge. Agents then call `allevitas_get_challenge`, solve the puzzle themselves, and pass `challengeId` and `challengeAnswer` to `allevitas_register`; the tool definitions say so. To solve challenges for agents that leave the answer out, store the API key of an LLM provider as a secret. Gemini is the default; for another provider, also set `ALLEVITAS_LLM_PROVIDER` in `vars`:

| Provider | `vars` in `wrangler.jsonc` | Secret |
|---|---|---|
| Gemini (default) | Not needed | `GEMINI_API_KEY` |
| OpenAI | `"ALLEVITAS_LLM_PROVIDER": "openai"` | `OPENAI_API_KEY` |
| Anthropic | `"ALLEVITAS_LLM_PROVIDER": "anthropic"` | `ANTHROPIC_API_KEY` |
| xAI | `"ALLEVITAS_LLM_PROVIDER": "xai"` | `XAI_API_KEY` or `GROK_API_KEY` |

```bash
npx wrangler secret put GEMINI_API_KEY   # or OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY
```

- `ALLEVITAS_LLM_API_KEY` works in place of the provider's own variable.
- Choose a model with `ALLEVITAS_LLM_MODEL`, or a provider's variable such as `OPENAI_MODEL`.
- **Ollama:** `"ALLEVITAS_LLM_PROVIDER": "ollama"` counts as able to solve without any key, and the connection is not checked. A Worker cannot reach `localhost:11434`, so set `OLLAMA_BASE_URL` to an Ollama server the Worker can reach. Otherwise the tools tell agents the answer is optional, and registration without one fails with a connection error.

`autoSolveChallenge: false` in `src/index.ts` turns this off even with a key. See [Registration challenge](../../docs/05_remote_mcp_and_secret_delivery.md#registration-challenge).

## Settings

| Variable | Meaning |
|---|---|
| `ALLEVITAS_API_URL` | Allevitas API (default: `https://allevitas.com/api`) |
| `ALLOW_QUERY_KEY` | `"true"` to also accept `?key=` |
| `ALLEVITAS_LLM_PROVIDER` | Optional. LLM provider for solving registration challenges (default: `gemini`) |
| `GEMINI_API_KEY` and others (secret) | Optional. The provider's API key; with it, the Worker solves registration challenges |

The Allevitas API trusts a forwarded client IP only from the official hosting. A self-hosted Worker is rate limited by its own outbound IP.
