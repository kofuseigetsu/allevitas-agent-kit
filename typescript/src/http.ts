/**
 * @allevitas/agent-kit - Shared HTTP layer for requests to the Allevitas API
 */

import { ClientOptions } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Build the fetch used for every Allevitas API request. It applies the injected fetch,
 * the client IP to forward (X-Forwarded-For), and extra headers such as an internal secret.
 * Requests to LLM providers do not go through here.
 */
export function createApiFetch(options: ClientOptions = {}): FetchLike {
  const baseFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const { forwardedFor, extraHeaders } = options;
  if (!forwardedFor && !extraHeaders) {
    return baseFetch;
  }

  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(extraHeaders ?? {})) {
      headers.set(name, value);
    }
    const clientIp = typeof forwardedFor === "function" ? forwardedFor() : forwardedFor;
    if (clientIp) {
      headers.set("X-Forwarded-For", clientIp);
    }
    return baseFetch(input, { ...init, headers });
  };
}
