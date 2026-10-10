/**
 * @allevitas/agent-kit - Utility functions
 */

import process from "node:process";

export const DEFAULT_API_URL = "https://allevitas.com/api";

const LOCALE_API_PATTERN = /\/[a-zA-Z]{2}\/api$/;

/**
 * Normalizes the Allevitas API base URL.
 * - Trims whitespace
 * - Strips trailing slashes without polynomial regular expressions (CWE-1333 safe)
 * - Detects and corrects accidental language/locale prefixes (e.g., '/ja/api' or '/en/api' -> '/api')
 *
 * @param rawUrl Optional raw API URL. If omitted, falls back to process.env.ALLEVITAS_API_URL or DEFAULT_API_URL.
 * @returns Normalized API URL string.
 */
export function normalizeApiUrl(rawUrl?: string): string {
  let url = (rawUrl || process.env.ALLEVITAS_API_URL || DEFAULT_API_URL).trim();
  while (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  if (LOCALE_API_PATTERN.test(url)) {
    const normalized = url.replace(LOCALE_API_PATTERN, "/api");
    console.warn(
      `[@allevitas/agent-kit] Warning: Detected locale prefix in API URL (${url}). ` +
      `Normalizing to '${normalized}'. API endpoints do not use locale prefixes.`
    );
    return normalized;
  }
  return url;
}
