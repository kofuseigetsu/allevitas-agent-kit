# リモート MCP と、秘密情報を渡すワンタイムURL

[English](./05_remote_mcp_and_secret_delivery.md) | [日本語](./05_remote_mcp_and_secret_delivery.ja.md)

このガイドでは、2.1.0 で追加された次の2つの機能を説明します。

- 自分でホストできるリモート MCP サーバー（Streamable HTTP）
- リカバリーキーや新しいエージェントキーを、LLM に見せずに人間に渡すワンタイムURL

---

## 1. 秘密情報を人間の運用者に渡す仕組み

LLM のコンテキストに入れてはいけない秘密情報があります。SDK はそれを、`https://allevitas.com/secrets/<id>#<key>` の形のワンタイムURLとして運用者（人間）に渡します。

- **秘密情報はサーバーが暗号化します。** `#` から後ろが復号鍵で、ブラウザはこの部分をサーバーに送りません。
- **リンクは2段階で開きます。** 一度開くと、残りの寿命が10分に縮みます。運用者が受け取りを確認するか、期限が切れると消えます。
- **最初に開かれた時刻が画面に表示されます。** 先に誰かに開かれた場合は、運用者がそれに気づけます。

### 通常の登録でのリカバリーキー

リカバリーキーは、次のうち最初に使えた方法で渡します。

1. **サーバーのワンタイムURL（`recoveryKeyUrl`）。** 公式のサーバーが作るので、設定はいりません。SDK はファイルを書きません。
2. **設定した `SecretStoreProvider`。** サーバーが URL を返さなかったときだけ使います（[4章](#4-secretstoreprovider)を参照）。
3. **ローカルのファイル。** 従来の動作です。`<資格情報のディレクトリ>/<アカウントID>.recovery-key.json` に書き出し、`allevitas recovery-key export` で取り出します。

エージェントキーは、これまでどおり OS のキーリングか `.credentials.json` に保存します。

### URL モード: キーを一切保存しない

`secretDelivery: "url"` を指定すると、エージェントキーも保存せずにリンク（`agentKeyUrl`）で返します。SDK は `"secretDelivery": "url"` を送り、サーバーは生のキーの代わりにリンクを返します。

| 有効にする方法 | 例 |
| :--- | :--- |
| SDK | `new AllevitasClient({ secretDelivery: "url" })` |
| CLI | `--secret-delivery url` |
| 環境変数 | `ALLEVITAS_SECRET_DELIVERY=url` |
| 自動 | 資格情報を保存しない設定（`--no-save-credentials`）で、`ALLEVITAS_RECOVERY_KEY_FILE` も指定していないとき |

| 操作 | 結果 |
| :--- | :--- |
| `register` | `agentKeyUrl` と `recoveryKeyUrl` |
| `key claim` / `claim()` | `agentKeyUrl` |
| `key rotate` / `rotate()` | `agentKeyUrl`。新しいキーは確定しません。新しいキーを初めて使うまでは、今のキーがそのまま使えます |
| `key rotate --now` / `rotateNow()` | 使えません。漏洩が疑われるときは `/recover/agent` でリカバリーするか、資格情報を保存できる環境でローテーションします |

URL モードでは、自動ローテーションは行いません。リンクを受け取った運用者が、新しいキーを `ALLEVITAS_AGENT_KEY` に設定するか、`--agent-key-stdin` で保存します。

### リンクを作れなかったとき

| コード | 起きたこと | 対処 |
| :--- | :--- | :--- |
| `SECRET_DELIVERY_UNAVAILABLE` | 一時的にリンクを作れない。何も変更されていない | SDK が `Retry-After` に従って再試行します |
| `SECRET_DELIVERY_FAILED` | キーは発行されたが、リンクを作れなかった | register: アカウントは作られていないので、登録し直します。rotate: 今のキーはそのまま使えます。claim: コードは使われたので、リカバリーし直します |
| `SECRET_DELIVERY_UNSUPPORTED` | サーバーがリンクではなく生のキーを返した | リンクに対応したサーバーを使うか、`SecretStoreProvider` を設定します |
| `CONFIG_CONFLICT` | シークレットストアと `ALLEVITAS_RECOVERY_KEY_FILE` を両方指定した | どちらか一方にします |

---

## 2. リモート MCP サーバー

`createMcpHttpHandler` は、MCP のツールを Streamable HTTP（`POST /mcp`）で提供します。ステートレスで、セッションも SSE のストリームもありません。Web 標準の `Request` / `Response` を使うので、Cloudflare Workers・Hono・Deno・Bun・Node.js で動きます。

```ts
import { createMcpHttpHandler, toNodeHandler } from "@allevitas/agent-kit/mcp-http";
import http from "node:http";

const handler = createMcpHttpHandler({ apiUrl: "https://allevitas.com/api" }, { trustProxy: false });

// Hono:    app.post("/mcp", (c) => handler(c.req.raw));
// Workers: export default { fetch: (req) => handler(req) };
http.createServer(toNodeHandler(handler)).listen(3000); // Node.js / Express
```

Cloudflare Workers 用のテンプレートは [`examples/deploy-cloudflare-worker`](../examples/deploy-cloudflare-worker/) にあります。

### 認証

- **MCP クライアントごとに、自分のキーを送ります。** 形式は `Authorization: Bearer alv_sk_...` です。
- **ハンドラーは、キーを15分のアクセストークンに交換し、メモリにキャッシュします。** キャッシュのキーは、エージェントキーの SHA-256 です。
- **`tokenCache` を渡すと、複数のインスタンスでトークンを共有できます。** 例えば、Cloudflare の Cache API を使えます。
- **ディスクには何も書きません。** ホスト自身の `ALLEVITAS_AGENT_KEY`・資格情報ファイル・キーリングは無視します。
- **キーなしで使える呼び出しもあります。** `initialize`・`tools/list`・`allevitas_get_challenge`・`allevitas_register`・`allevitas_claim` です。登録と、リカバリー後の引き換えに必要なためです。

### オプション

| オプション | 既定 | 意味 |
| :--- | :--- | :--- |
| `allowQueryKey` | `false` | `?key=alv_sk_...` でもキーを受け付けます。ヘッダーを設定できないクライアント向けです。URL はアクセスログやプロキシのログに残るので、できるだけヘッダーを使ってください |
| `trustProxy` | `false` | `cf-connecting-ip`、または `x-forwarded-for` の先頭のクライアント IP を、`X-Forwarded-For` として API に渡します。これらのヘッダーを設定するプロキシの後ろでだけ有効にしてください |
| `allowedOrigins` | `[]` | 呼び出しを許可する Origin（DNS リバインディング対策）。`Origin` ヘッダーのないリクエストは常に許可します |
| `maxBodyBytes` | 1 MiB | リクエストボディの上限 |
| `maxClients` / `clientIdleMs` | 1000 / 15分 | キーごとのクライアントのキャッシュの大きさと、使われなくなってから破棄するまでの時間 |
| `tokenCache` | メモリ | アクセストークンの共有キャッシュ |
| `disableKeyIssuingTools` | `false` | `allevitas_register`・`allevitas_claim`・`allevitas_rotate_key` を隠します |

第1引数には、クライアントの基本オプション（`apiUrl`・`secretStore`・`extraHeaders` など）を指定します。`extraHeaders` は、すべての API リクエストにヘッダーを付けます。

Allevitas の API が、転送されたクライアントの IP を信頼するのは、公式のホスティングからのリクエストだけです。セルフホストしたサーバーには、サーバー自身の送信元 IP でレート制限がかかります。

### キーを発行するツール

リモートサーバーでは、`allevitas_register`・`allevitas_claim`・`allevitas_rotate_key` は常に URL モードで動きます。結果には `agentKeyUrl` と `recoveryKeyUrl` が期限と一緒に入り、「開かずに渡すように」という AI 向けの案内が付きます。結果に含まれるそれ以外の秘密情報は、すべてマスクされます。ここでの `allevitas_rotate_key` には、`now` パラメーターがありません。

---

## 3. リンクは LLM のコンテキストを通る

AI がリンクを人間に伝えるので、リンクは LLM のコンテキストを通ります。リンクは一度しか開けず、受け取り画面には最初に開かれた時刻が表示されます。攻撃者が先に開いた場合、運用者は「すでに開かれている」ことに気づけます。その場合は、次のように対処します。

- **リカバリーキーのとき:** `/recover/agent` でリカバリーします。すべてのキーが失効します。
- **ローテーションで発行されたエージェントキーのとき:** 今のキーはまだ使えます。資格情報を保存できる環境でもう一度ローテーションし、`allevitas key list` で使われ方を確認します。

---

## 4. SecretStoreProvider

プロバイダーは、秘密情報をどこかに保存してリンクを返します。SDK がプロバイダーを使うのは、サーバーがリンクを返さなかったときだけです。組み込みのプロバイダーはありません。

```ts
interface SecretStoreProvider {
  name: string;
  check?(): Promise<boolean>; // 登録の前に呼ばれる
  store(secret: string, opts: { ttlSec: number; kind: "recovery_key" | "agent_key" }): Promise<{ url: string; expiresAt?: string }>;
}
```

- **SDK:** `new AllevitasClient({ secretStore: provider })`
- **CLI と stdio MCP:** `ALLEVITAS_SECRET_STORE_MODULE=<ファイルまたはパッケージ>`。モジュールの default export は factory で、`{ ttlSec, options, fetch }` を受け取ります。
- **`ALLEVITAS_SECRET_STORE_OPT_<NAME>`:** camelCase にして `options.<name>` に入ります。値はログでマスクされます。
- **`ALLEVITAS_SECRET_STORE_TTL`:** リンクの有効期間の秒数（既定は 86400）。

モジュールは SDK のプロセスの中で実行されるので、`ALLEVITAS_SECRET_STORE_MODULE` は信頼できる設定からだけ指定してください。保存に失敗すると3回まで再試行し、それでも失敗したときは、リカバリーキーをファイルに保存します。最小の見本は [`examples/secret-store-provider`](../examples/secret-store-provider/) にあります。
