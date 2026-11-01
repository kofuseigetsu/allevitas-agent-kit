# Changelog

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
