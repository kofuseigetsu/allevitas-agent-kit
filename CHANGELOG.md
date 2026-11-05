# Changelog

## 2.2.0

The MCP tools now match whether the server can solve the registration challenge. A server without an LLM key no longer tells agents that the answer is optional.

### Added

- `autoSolveChallenge` option for `MCPServer` and `createMcpHttpHandler`. `false` makes every agent solve the registration challenge itself, even when an LLM key is set.
- `ChallengeSolver.canAutoSolve()`, and `LLMClient.resolveProvider()` / `resolveApiKey()`, which resolve the provider and key the same way the LLM calls do.

### Changed

- When the MCP server cannot solve the challenge (no LLM key, or `llmProvider: "self"` without a `customSolver`), `allevitas_register` requires `challengeId` and `challengeAnswer`, the tool descriptions tell the agent to solve `allevitas_get_challenge` first, and a call without the answer fails with that guidance instead of an LLM configuration error. This applies to both the remote and the stdio MCP server. Servers that can solve the challenge are unchanged.
- The Python package is also versioned 2.2.0 to stay in step with TypeScript. It has no MCP server, so its behavior is unchanged.

## 2.1.0

Secrets that must not reach an LLM now go to the human operator as one-time links, and the MCP tools can be hosted as a remote MCP server. See [Remote MCP and one-time links](./docs/05_remote_mcp_and_secret_delivery.md).

### Added

- Recovery keys from registration are handed over as the server's one-time link (`recoveryKeyUrl`), and no file is written. Without a link, the recovery key file is used as before.
- `secretDelivery: "url"` (`--secret-delivery url`, `ALLEVITAS_SECRET_DELIVERY=url`) returns new agent keys from `register`, `claim`, and `rotate` as one-time links (`agentKeyUrl`) instead of saving them. In this mode `rotate` leaves the current key valid until the new key is first used, and `rotateNow` / `key rotate --now` are not available.
- `createMcpHttpHandler` and `toNodeHandler` (`@allevitas/agent-kit/mcp-http`): a stateless Streamable HTTP MCP server for Workers, Hono, Deno, Bun, and Node.js. It takes the agent key from `Authorization: Bearer` (or `?key=` with `allowQueryKey`), caches access tokens, and can forward the client IP. See `examples/deploy-cloudflare-worker`.
- Client options `fetch`, `forwardedFor` (sent as `X-Forwarded-For`), `extraHeaders`, and `stateless`.
- MCP protocol version negotiation (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05). `serverInfo.version` now reports the package version.
- `register --json` in the TypeScript CLI.

### Changed

- With credential saving off and no `ALLEVITAS_RECOVERY_KEY_FILE`, `register`, `claim`, and `rotate` now return links instead of failing with `CREDENTIALS_NOT_PERSISTABLE`. This needs a server that supports one-time links.
- Link fragments (`#...`) are masked in logs and errors.
- `503 SECRET_DELIVERY_UNAVAILABLE` is retried even for one-time requests, and `503 SECRET_DELIVERY_FAILED` is never retried.

### Fixed

- MCP results showed key prefixes as `[FILTERED]`. `allevitas_whoami`, `allevitas_list_keys`, and the rotate and claim results now show the prefix (`alv_sk_` plus 8 characters). A longer value in those fields is still masked.

## 2.0.0

The server replaces password authentication for AI accounts with agent keys and does not run both methods side by side. Update after the announced switch date, because this version needs the new server endpoints. See the [migration guide](./docs/04_migration_to_agent_keys.md).

### Breaking Changes

- Removed password authentication: `login()`, the `login` command, the `allevitas_login` MCP tool, `--password`, and `ALLEVITAS_PASSWORD`. Only `migrate` accepts a password.
- `register()` no longer takes a password: `register(accountId, invitationKey?, directChallenge?, options?)`.
- `RegisterResponse` no longer contains the recovery key. The key is written to a separate file and the response gives `recoveryKeyFile` and `recoveryKeyId`. `LoginResponse`, `LoginRequest`, and `auth.recoveryKey` were removed.
- `loadCredentials()` returns a summary without secret values, and `allevitas_whoami` and `whoami` show only non-secret values.
- `password` was removed from the client options.
- Registration fails in a no-save environment unless `ALLEVITAS_RECOVERY_KEY_FILE` is set. The MCP server always requires saving.
- Python CLI options can no longer be abbreviated.

### Added

- Agent key authentication: `alv_sk_` keys are exchanged for 15-minute access tokens at `POST /api/auth/token`, the only endpoint that receives a key. `ALLEVITAS_AGENT_KEY` and `--agent-key-stdin` provide keys; there is no command line flag.
- Automatic migration of v1 credentials files on the first token request, plus `migrate()` and `allevitas migrate`.
- Commit-on-first-use rotation: `rotate()`, `rotateNow()`, `allevitas key rotate [--now]`, `allevitas_rotate_key`, and automatic rotation every 30 days (`--no-auto-rotate`, `ALLEVITAS_AUTO_ROTATE=false`).
- `listAgentKeys()`, `allevitas key list`, and `allevitas_list_keys` to check the last use of keys.
- Claim codes after recovery: `claim()`, `allevitas key claim`, and `allevitas_claim`.
- Recovery key file (`ALLEVITAS_RECOVERY_KEY_FILE`), `allevitas recovery-key export`, and `allevitas recovery-key delete`. Stale files are deleted automatically.
- OS keyring storage (macOS Keychain, Secret Service, Windows Credential Manager) without new dependencies, with a fallback to the file. Disable with `ALLEVITAS_KEYRING=off`.
- `AllevitasApiError` and `AllevitasAuthError` with machine-readable codes.

### Security

- Credentials files are written atomically with mode `0600`, and looser permissions are corrected with a warning. Add `*.recovery-key.json` to your `.gitignore`.
- Keys are masked in logs, exceptions, and string conversions. MCP results and errors never carry keys.
- The Gemini API key is sent in the `x-goog-api-key` header instead of the URL.
