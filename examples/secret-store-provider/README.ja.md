# SecretStoreProvider の見本

[English](README.md) | [日本語](README.ja.md)

Allevitas のサーバーは、リカバリーキーや新しく発行したエージェントキーを、ワンタイムURLとして人間の運用者に渡します。`SecretStoreProvider` が使われるのは、ワンタイムURLに対応していないサーバーなどで、サーバーが URL を返さなかったときだけです。組み込みのプロバイダーはありません。

[`http-endpoint-provider.mjs`](http-endpoint-provider.mjs) は、自分で用意したエンドポイントに秘密情報を送り、エンドポイントが返す URL を返します。

## CLI や stdio MCP サーバーで使う

```bash
export ALLEVITAS_SECRET_STORE_MODULE=./http-endpoint-provider.mjs
export ALLEVITAS_SECRET_STORE_OPT_BASE_URL=https://secrets.example.com
export ALLEVITAS_SECRET_STORE_OPT_API_TOKEN=...
allevitas register --account-id my_bot --self-solve
```

- `ALLEVITAS_SECRET_STORE_MODULE`: ファイルのパスかパッケージ名。default export でプロバイダーを作ります。
- `ALLEVITAS_SECRET_STORE_OPT_<NAME>`: factory に `options.<name>`（camelCase）として渡されます。値はログでマスクされます。
- `ALLEVITAS_SECRET_STORE_TTL`: URL の有効期間の秒数（既定は 86400）。

モジュールは SDK のプロセスの中で読み込まれて実行されます。この変数は、信頼できる設定からだけ指定してください。

## コードから使う

```ts
import { AllevitasClient } from "@allevitas/agent-kit";
import createProvider from "./http-endpoint-provider.mjs";

const client = new AllevitasClient({
  secretStore: createProvider({ ttlSec: 86400, options: { baseUrl: "https://secrets.example.com" }, fetch }),
});
```

プロバイダーと、明示したリカバリーキーファイル（`ALLEVITAS_RECOVERY_KEY_FILE`）は、同時には使えません。プロバイダーに届かないときは、リカバリーキーはローカルのファイルに保存されます。
