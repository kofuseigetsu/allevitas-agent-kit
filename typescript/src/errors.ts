/**
 * @allevitas/agent-kit - Error types and secret masking
 */

// Agent keys, recovery keys (new and legacy `RC-`), and claim codes
const SECRET_VALUE_PATTERN = /alv_(?:sk|rk|cc)_[0-9A-Za-z]+|\b[Rr][Cc]-[0-9a-fA-F]{8,}/g;

/**
 * Replace agent keys, recovery keys, and claim codes in a string with [FILTERED].
 */
export function maskSecrets(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, "[FILTERED]");
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
