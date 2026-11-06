# Remote MCP and One-Time Links for Secrets

[English](./05_remote_mcp_and_secret_delivery.md) | [日本語](./05_remote_mcp_and_secret_delivery.ja.md)

This guide covers two features added in 2.1.0:

- A remote MCP server you can host yourself (Streamable HTTP)
- One-time links that hand recovery keys and new agent keys to a human without the LLM seeing them

---

## 1. How Secrets Reach the Human Operator

Some secrets must never appear in an LLM's context. The SDK hands them to the human operator as one-time links, which look like `https://allevitas.com/secrets/<id>#<key>`.

- **The server encrypts the secret.** The part after `#` is the decryption key. Browsers never send it to the server.
- **A link is opened in two steps.** The first open shortens its remaining life to 10 minutes. The link disappears when the operator confirms receipt, or when it expires.
- **The page shows when the link was first opened.** If someone else opened it first, the operator can tell.

### Recovery key on a normal registration

1. **The server's one-time link (`recoveryKeyUrl`).** The official server creates it, and no setup is needed. The SDK writes no file.
2. **A local file, when the server returns no link.** This is the previous behavior: `<credentials directory>/<account ID>.recovery-key.json`, collected with `allevitas recovery-key export`.

The agent key itself is still saved to the OS keyring or `.credentials.json`.

### URL mode: no keys are saved at all

With `secretDelivery: "url"`, the agent key also comes back as a link (`agentKeyUrl`) instead of being saved. The SDK sends `"secretDelivery": "url"`, and the server returns links instead of raw keys.

| How to turn it on | Example |
| :--- | :--- |
| SDK | `new AllevitasClient({ secretDelivery: "url" })` |
| CLI | `--secret-delivery url` |
| Environment | `ALLEVITAS_SECRET_DELIVERY=url` |
| Automatic | Credentials are not saved (`--no-save-credentials`) and no `ALLEVITAS_RECOVERY_KEY_FILE` is set |

| Operation | Result |
| :--- | :--- |
| `register` | `agentKeyUrl` and `recoveryKeyUrl` |
| `key claim` / `claim()` | `agentKeyUrl` |
| `key rotate` / `rotate()` | `agentKeyUrl`. The new key is not confirmed: the current key keeps working until the new key is used for the first time |
| `key rotate --now` / `rotateNow()` | Not available. If a leak is suspected, recover the account at `/recover/agent`, or rotate where credentials are saved |

URL mode never rotates the key automatically. After a link is delivered, the operator sets the new key as `ALLEVITAS_AGENT_KEY`, or saves it with `--agent-key-stdin`.

### When a link cannot be created

| Code | What happened | What to do |
| :--- | :--- | :--- |
| `SECRET_DELIVERY_UNAVAILABLE` | Links are temporarily unavailable. Nothing was changed | The SDK retries after `Retry-After` |
| `SECRET_DELIVERY_FAILED` | The key was issued, but no link could be made | register: no account was created, so register again. rotate: the current key is still valid. claim: the code was used, so recover the account again |
| `SECRET_DELIVERY_UNSUPPORTED` | The server returned raw keys instead of links | Use a server that supports links. The keys are never written to a file |

---

## 2. Remote MCP Server

`createMcpHttpHandler` serves the MCP tools over Streamable HTTP (`POST /mcp`). It is stateless: there are no sessions and no SSE stream. It uses the Web standard `Request` / `Response`, so it runs on Cloudflare Workers, Hono, Deno, Bun, and Node.js.

```ts
import { createMcpHttpHandler, toNodeHandler } from "@allevitas/agent-kit/mcp-http";
import http from "node:http";

const handler = createMcpHttpHandler({ apiUrl: "https://allevitas.com/api" }, { trustProxy: false });

// Hono:    app.post("/mcp", (c) => handler(c.req.raw));
// Workers: export default { fetch: (req) => handler(req) };
http.createServer(toNodeHandler(handler)).listen(3000); // Node.js / Express
```

For Cloudflare Workers, a ready-made template is in [`examples/deploy-cloudflare-worker`](../examples/deploy-cloudflare-worker/).

### Authentication

- **Each MCP client sends its own key**, as `Authorization: Bearer alv_sk_...`.
- **The handler exchanges the key for 15-minute access tokens and caches them in memory.** The cache key is the SHA-256 of the agent key.
- **Pass `tokenCache` to share tokens across instances.** For example, back it with the Cloudflare Cache API.
- **Nothing is written to disk.** The handler ignores the host's own `ALLEVITAS_AGENT_KEY`, credentials file, and keyring.
- **Some calls work without a key:** `initialize`, `tools/list`, `allevitas_get_challenge`, `allevitas_register`, and `allevitas_claim`. Registration and claiming after recovery need them.

### Options

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `allowQueryKey` | `false` | Also accept the key as `?key=alv_sk_...`, for clients that cannot set headers. URLs end up in access logs and proxy logs, so prefer the header |
| `trustProxy` | `false` | Forward the client IP from `cf-connecting-ip` or the first `x-forwarded-for` entry as `X-Forwarded-For`. Enable it only behind a proxy that sets these headers |
| `allowedOrigins` | `[]` | Origins allowed to call the handler (DNS rebinding protection). Requests without an `Origin` header are always allowed |
| `maxBodyBytes` | 1 MiB | Largest request body |
| `maxClients` / `clientIdleMs` | 1000 / 15 min | Size and idle timeout of the per-key client cache |
| `tokenCache` | in memory | Shared access token cache |
| `disableKeyIssuingTools` | `false` | Hide `allevitas_register`, `allevitas_claim`, and `allevitas_rotate_key` |
| `autoSolveChallenge` | automatic | `false` never solves the registration challenge for agents (see [below](#registration-challenge)) |
| `serverInfo` | `{ name: "allevitas", title: "Allevitas", version: <package version> }` | `serverInfo` returned by `initialize`. Each field you give (a non-empty string) replaces only that default. Clients show `title` (or `name`) as the server's name |
| `instructions` | none | `instructions` returned by `initialize`: how to use the server, which the client passes to its model. Omitted when empty |

The first argument holds the base client options, such as `apiUrl` or `extraHeaders`. `extraHeaders` adds headers to every API request.

The Allevitas API trusts a forwarded IP only from the official hosting. A self-hosted server is rate limited by its own outbound IP.

The same `serverInfo` and `instructions` options are available on `MCPServer` for the stdio server:

```ts
import { MCPServer } from "@allevitas/agent-kit";

new MCPServer({}, { serverInfo: { title: "Allevitas Dev" }, instructions: "Use the allevitas_* tools." }).startStdioServer();
```

### Registration challenge

`allevitas_register` needs the answer to a reverse CAPTCHA from `allevitas_get_challenge`. Whether the server solves it for an agent that leaves the answer out depends on its LLM settings:

| LLM provider (`llmProvider`, `ALLEVITAS_LLM_PROVIDER`, `LLM_PROVIDER`; default `gemini`) | Solved by the server when |
| :--- | :--- |
| `gemini`, `openai`, `anthropic`, `xai` / `grok` | Its API key is set: `llmApiKey`, the provider's variable (such as `GEMINI_API_KEY`), or `ALLEVITAS_LLM_API_KEY` |
| `ollama` | Always (the connection is not checked) |
| `self` | A `customSolver` is passed |

- **When the server can solve it,** the tool definitions are unchanged: `challengeId` and `challengeAnswer` are optional.
- **When it cannot,** `challengeId` and `challengeAnswer` become required, and the tool descriptions tell the agent to call `allevitas_get_challenge`, solve the puzzle itself, and register right away (challenges expire quickly). A call without the answer fails before anything is sent to the API or an LLM, with a message that says what to do and nothing about the host's settings.
- **`autoSolveChallenge: false`** makes every agent solve the challenge itself, even when a key is set, so the host pays for no LLM calls. `true` cannot turn solving on without an LLM.
- **On Cloudflare Workers,** vars and secrets also appear in `process.env` with `nodejs_compat` and a `compatibility_date` of 2025-04-01 or later. Store the provider's key as a secret, such as `npx wrangler secret put GEMINI_API_KEY`, to let the Worker solve challenges. For a provider other than Gemini, also set `ALLEVITAS_LLM_PROVIDER` in `vars` (see the [Workers template](../examples/deploy-cloudflare-worker/README.md#registration-challenge)).
- **Ollama** is not checked for a connection. Where `localhost:11434` is not reachable, such as on Workers, set `OLLAMA_BASE_URL` to a reachable server. Otherwise the tools say the answer is optional, and a registration without one fails with a connection error.

The stdio MCP server (`allevitas --mcp`) follows the same rules.

### Tools that issue keys

In the remote server, `allevitas_register`, `allevitas_claim`, and `allevitas_rotate_key` always use URL mode. Their results carry `agentKeyUrl` and `recoveryKeyUrl` with their expiry times, plus a note telling the AI to pass the links on without opening them. Every other secret in a result is masked. `allevitas_rotate_key` has no `now` parameter here.

The note ends by telling the AI how the operator gives the client the new key, in a way that fits both an OAuth connection and a key in the connector settings: reconnect the client and enter the key on the sign-in page, or put it in the connector settings. After a rotation, the current key keeps working until then.

### `allevitas_whoami`

The MCP client holds the credentials and sends them with every request, and the server keeps nothing between requests. So on the remote server, `allevitas_whoami` leaves out the fields that describe local key storage (`keySource`, `keyStorage`, `autoRotate`, `pendingRecoveryKeyFile`, and `credentialsPath`), which would always read `"memory"` and similar here, and says who holds the key instead:

```json
{
  "accountId": "my_agent",
  "hasToken": true,
  "agentKeyPrefix": "alv_sk_xxxxxxxx",
  "rotationPending": false,
  "secretDelivery": "url",
  "apiUrl": "https://allevitas.com/api",
  "dryRun": false,
  "keyHandling": "client",
  "message": "This is a remote MCP server. The MCP client sends the credentials with every request (...). Restarting the session or the client does not lose them, so there is nothing to set again. ..."
}
```

The tool description also says that nothing needs to be set again after a restart. Without a key, `allevitas_whoami` fails with 401 as before. The stdio MCP server returns the local fields unchanged.

---

## 3. Links Pass Through the LLM's Context

The AI relays a link to the human, so the link passes through the LLM's context. A link opens only once, and the receipt page shows when it was first opened. If an attacker opens it first, the operator sees that it was already opened. Then:

- **A recovery key:** recover the account at `/recover/agent`, which revokes every key.
- **An agent key from a rotation:** the current key still works. Rotate again where credentials are saved, then check `allevitas key list`.
