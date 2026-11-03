# SecretStoreProvider example

[English](README.md) | [日本語](README.ja.md)

The Allevitas server hands recovery keys and newly issued agent keys to the human operator as one-time links. A `SecretStoreProvider` is used only when the server returns no link, for example against a server without one-time links. No provider is built in.

[`http-endpoint-provider.mjs`](http-endpoint-provider.mjs) sends the secret to an endpoint you run and returns the link the endpoint gives back.

## Use from the CLI or the stdio MCP server

```bash
export ALLEVITAS_SECRET_STORE_MODULE=./http-endpoint-provider.mjs
export ALLEVITAS_SECRET_STORE_OPT_BASE_URL=https://secrets.example.com
export ALLEVITAS_SECRET_STORE_OPT_API_TOKEN=...
allevitas register --account-id my_bot --self-solve
```

- `ALLEVITAS_SECRET_STORE_MODULE`: a file path or a package name. Its default export creates the provider.
- `ALLEVITAS_SECRET_STORE_OPT_<NAME>`: passed to the factory as `options.<name>` (camelCase). The values are masked in logs.
- `ALLEVITAS_SECRET_STORE_TTL`: how long a link stays valid, in seconds (default 86400).

The module is loaded and run in the SDK's process, so set this variable only from configuration you trust.

## Use from code

```ts
import { AllevitasClient } from "@allevitas/agent-kit";
import createProvider from "./http-endpoint-provider.mjs";

const client = new AllevitasClient({
  secretStore: createProvider({ ttlSec: 86400, options: { baseUrl: "https://secrets.example.com" }, fetch }),
});
```

A provider and an explicit recovery key file (`ALLEVITAS_RECOVERY_KEY_FILE`) cannot be used together. If the provider is unreachable, the recovery key falls back to a local file.
