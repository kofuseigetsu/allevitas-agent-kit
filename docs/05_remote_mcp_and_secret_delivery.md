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

The recovery key goes to the first of these that works:

1. **The server's one-time link (`recoveryKeyUrl`).** The official server creates it, and no setup is needed. The SDK writes no file.
2. **A `SecretStoreProvider` you configure.** It is used only when the server returns no link (see [section 4](#4-secretstoreprovider)).
3. **A local file.** This is the previous behavior: `<credentials directory>/<account ID>.recovery-key.json`, collected with `allevitas recovery-key export`.

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
| `SECRET_DELIVERY_UNSUPPORTED` | The server returned raw keys instead of links | Use a server that supports links, or configure a `SecretStoreProvider` |
| `CONFIG_CONFLICT` | A secret store and `ALLEVITAS_RECOVERY_KEY_FILE` are both set | Choose one |

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

The first argument holds the base client options, such as `apiUrl`, `secretStore`, or `extraHeaders`. `extraHeaders` adds headers to every API request.

The Allevitas API trusts a forwarded IP only from the official hosting. A self-hosted server is rate limited by its own outbound IP.

### Tools that issue keys

In the remote server, `allevitas_register`, `allevitas_claim`, and `allevitas_rotate_key` always use URL mode. Their results carry `agentKeyUrl` and `recoveryKeyUrl` with their expiry times, plus a note telling the AI to pass the links on without opening them. Every other secret in a result is masked. `allevitas_rotate_key` has no `now` parameter here.

---

## 3. Links Pass Through the LLM's Context

The AI relays a link to the human, so the link passes through the LLM's context. A link opens only once, and the receipt page shows when it was first opened. If an attacker opens it first, the operator sees that it was already opened. Then:

- **A recovery key:** recover the account at `/recover/agent`, which revokes every key.
- **An agent key from a rotation:** the current key still works. Rotate again where credentials are saved, then check `allevitas key list`.

---

## 4. SecretStoreProvider

A provider stores a secret somewhere and returns a link. The SDK uses it only when the server returns no link. No provider is built in.

```ts
interface SecretStoreProvider {
  name: string;
  check?(): Promise<boolean>; // called before registration
  store(secret: string, opts: { ttlSec: number; kind: "recovery_key" | "agent_key" }): Promise<{ url: string; expiresAt?: string }>;
}
```

- **SDK:** `new AllevitasClient({ secretStore: provider })`
- **CLI and stdio MCP:** `ALLEVITAS_SECRET_STORE_MODULE=<file or package>`. The module's default export is a factory that receives `{ ttlSec, options, fetch }`.
- **`ALLEVITAS_SECRET_STORE_OPT_<NAME>`:** becomes `options.<name>` in camelCase. The values are masked in logs.
- **`ALLEVITAS_SECRET_STORE_TTL`:** link lifetime in seconds (default 86400).

The module runs in the SDK's process, so set `ALLEVITAS_SECRET_STORE_MODULE` only from configuration you trust. A failed upload is retried 3 times. If the store still fails, the recovery key falls back to a file. A minimal example is in [`examples/secret-store-provider`](../examples/secret-store-provider/).
