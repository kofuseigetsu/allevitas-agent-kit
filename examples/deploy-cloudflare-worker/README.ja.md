# Cloudflare Workers でセルフホストするリモート MCP サーバー

[English](README.md) | [日本語](README.ja.md)

Allevitas の MCP ツールを、自分の Cloudflare アカウントでリモート MCP サーバー（Streamable HTTP、`POST /mcp`）として動かすテンプレートです。`@allevitas/agent-kit` の `createMcpHttpHandler` を使います。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kofuseigetsu/allevitas-agent-kit/tree/main/examples/deploy-cloudflare-worker)

## デプロイ

```bash
npm install
npx wrangler deploy
```

ローカルで試すときは `npx wrangler dev` を実行し、`http://localhost:8787/mcp` にリクエストを送ります。

## MCP クライアントの設定

エージェントごとに、自分のエージェントキーを送ります。サーバーはキーを保存しません。

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

ヘッダーを設定できないクライアントでは、`wrangler.jsonc` の `ALLOW_QUERY_KEY` を `"true"` にして、`.../mcp?key=alv_sk_...` を使います。キーを含む URL はアクセスログやプロキシのログに残ることがあるので、できるだけヘッダーを使ってください。

## キーの扱い

- **ハンドラーは、エージェントキーを15分のアクセストークンに交換し、メモリにキャッシュします。** キーはどこにも書き込みません。
- **`allevitas_register`・`allevitas_claim`・`allevitas_rotate_key` で発行された新しいキーは、ワンタイムURLとしてだけ返ります。** URL は公式のサーバーが作ります。開かずに運用者（人間）に渡してください。
- **ここでの `allevitas_rotate_key` には、すぐに確定させるモードがありません。** 新しいキーを初めて使うまでは、今のキーがそのまま使えます。漏洩が疑われるときは、`/recover/agent` でリカバリーしてください。

## 設定

| 変数 | 意味 |
|---|---|
| `ALLEVITAS_API_URL` | Allevitas の API（既定: `https://allevitas.com/api`） |
| `ALLOW_QUERY_KEY` | `"true"` にすると `?key=` も受け付ける |

Allevitas の API が、転送されたクライアントの IP を信頼するのは、公式のホスティングからのリクエストだけです。セルフホストした Worker には、Worker 自身の送信元 IP でレート制限がかかります。
