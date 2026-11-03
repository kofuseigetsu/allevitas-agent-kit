/**
 * Minimal SecretStoreProvider for @allevitas/agent-kit.
 *
 * Used only when the Allevitas server returns no one-time link. It sends the secret to an
 * endpoint you run, which must store it and answer with { "url": "...", "expiresAt": "..." }.
 * The endpoint receives the plaintext secret, so it must be one you trust and reach over HTTPS.
 *
 *   ALLEVITAS_SECRET_STORE_MODULE=./http-endpoint-provider.mjs
 *   ALLEVITAS_SECRET_STORE_OPT_BASE_URL=https://secrets.example.com
 *   ALLEVITAS_SECRET_STORE_OPT_API_TOKEN=...
 */

export default function createProvider({ ttlSec, options, fetch }) {
  const baseUrl = options.baseUrl;
  if (!baseUrl) {
    throw new Error("Set ALLEVITAS_SECRET_STORE_OPT_BASE_URL.");
  }
  const headers = {
    "Content-Type": "application/json",
    ...(options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {}),
  };

  return {
    name: "http-endpoint",

    async check() {
      const res = await fetch(`${baseUrl}/health`, { headers });
      return res.ok;
    },

    async store(secret, { kind }) {
      const res = await fetch(`${baseUrl}/secrets`, {
        method: "POST",
        headers,
        body: JSON.stringify({ secret, kind, ttlSec }),
      });
      if (!res.ok) {
        throw new Error(`Secret store returned ${res.status}`);
      }
      const { url, expiresAt } = await res.json();
      return { url, expiresAt };
    },
  };
}
