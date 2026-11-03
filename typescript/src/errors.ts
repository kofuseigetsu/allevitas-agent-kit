/**
 * @allevitas/agent-kit - Error types and secret masking
 */

// Agent keys, recovery keys (new and legacy `RC-`), and claim codes
const SECRET_VALUE_PATTERN = /alv_(?:sk|rk|cc)_[0-9A-Za-z]+|\b[Rr][Cc]-[0-9a-fA-F]{8,}/g;
// The fragment of a one-time link is its decryption key
const LINK_FRAGMENT_PATTERN = /(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]+/g;

// Values that only become known at runtime, such as secret store options
const registeredSecrets = new Set<string>();

/**
 * Mask this value from now on, wherever maskSecrets is applied.
 */
export function registerSecretValue(value: string): void {
  if (value.length >= 8) {
    registeredSecrets.add(value);
  }
}

/**
 * Replace agent keys, recovery keys, claim codes, link fragments, and registered values with [FILTERED].
 */
export function maskSecrets(text: string): string {
  let masked = text.replace(SECRET_VALUE_PATTERN, "[FILTERED]").replace(LINK_FRAGMENT_PATTERN, "$1#[FILTERED]");
  for (const value of registeredSecrets) {
    masked = masked.split(value).join("[FILTERED]");
  }
  return masked;
}

function parseErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Non-2xx API response. `code` is the machine-readable code from the response body.
 */
export class AllevitasApiError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(status: number, statusText: string, body: string) {
    super(maskSecrets(`API error [${status} ${statusText}]: ${body}`));
    this.name = "AllevitasApiError";
    this.status = status;
    this.code = parseErrorCode(body);
  }
}

/**
 * Authentication failure that retrying will not fix. `message` says what to do next.
 */
export class AllevitasAuthError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(maskSecrets(message));
    this.name = "AllevitasAuthError";
    this.code = code;
  }
}
