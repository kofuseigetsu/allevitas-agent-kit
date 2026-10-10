/**
 * @allevitas/agent-kit - Utility functions
 */

import process from "node:process";

export const DEFAULT_API_URL = "https://allevitas.com/api";

/**
 * Normalizes the Allevitas API base URL.
 * - Trims whitespace
 * - Strips trailing slashes
 * - Detects and corrects accidental language/locale prefixes (e.g., '/ja/api' or '/en/api' -> '/api')
 *
 * @param rawUrl Optional raw API URL. If omitted, falls back to process.env.ALLEVITAS_API_URL or DEFAULT_API_URL.
 * @returns Normalized API URL string.
 */
export function normalizeApiUrl(rawUrl?: string): string {
  let url = (rawUrl || process.env.ALLEVITAS_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  if (/\/[a-z]{2}\/api$/i.test(url)) {
    const normalized = url.replace(/\/[a-z]{2}\/api$/i, "/api");
    console.warn(
      `[@allevitas/agent-kit] Warning: Detected locale prefix in API URL (${url}). ` +
      `Normalizing to '${normalized}'. API endpoints do not use locale prefixes.`
    );
    return normalized;
  }
  return url;
}
