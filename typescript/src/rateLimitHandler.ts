/**
 * @allevitas/agent-kit - Rate limit auto-wait handler
 */

import { AllevitasApiError, maskSecrets } from "./errors.js";

export interface RateLimitOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export interface ExecuteOptions {
  /**
   * Set to false for requests that consume a one-time secret. A retry after a lost response
   * would fail and hide the outcome, so only 429 (never processed) is retried.
   */
  idempotent?: boolean;
}

export const DEFAULT_USER_AGENT =
  process.env.ALLEVITAS_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AllevitasSDK/1.0";

export class RateLimitHandler {
  private maxRetries: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private onRetry?: (attempt: number, delayMs: number, reason: string) => void;

  constructor(options: RateLimitOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 60000; // Maximum 60 seconds
    this.onRetry = options.onRetry;
  }

  /**
   * Execute HTTP request with automatic retry on 429 or temporary server errors.
   */
  async execute<T>(requestFn: () => Promise<Response>, options: ExecuteOptions = {}): Promise<T> {
    const idempotent = options.idempotent ?? true;
    let attempt = 0;

    while (true) {
      attempt++;
      let response: Response;

      try {
        response = await requestFn();
      } catch (networkError: unknown) {
        if (!idempotent || attempt > this.maxRetries) {
          throw networkError;
        }
        const delay = this.calculateBackoff(attempt);
        this.notifyRetry(attempt, delay, maskSecrets(`Network error: ${String(networkError)}`));
        await this.sleep(delay);
        continue;
      }

      // 429 Too Many Requests
      if (response.status === 429) {
        if (attempt > this.maxRetries) {
          const bodyText = await response.text().catch(() => "");
          throw new Error(maskSecrets(`Rate limit exceeded (reached retry limit of ${this.maxRetries}): ${bodyText}`));
        }

        const retryAfterHeader = response.headers.get("retry-after");
        let waitMs = 0;

        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds)) {
            waitMs = seconds * 1000;
          }
        }

        if (waitMs === 0) {
          try {
            const body = await response.clone().json();
            if (body.retry_after_seconds) {
              waitMs = Number(body.retry_after_seconds) * 1000;
            }
          } catch {
            // Fall back to exponential backoff
          }
        }

        if (waitMs === 0) {
          waitMs = this.calculateBackoff(attempt);
        } else {
          // Add jitter (0〜1000ms)
          waitMs += Math.floor(Math.random() * 1000);
        }

        waitMs = Math.min(waitMs, this.maxDelayMs);
        this.notifyRetry(attempt, waitMs, `429 Too Many Requests`);
        await this.sleep(waitMs);
        continue;
      }

      // 5xx Server Error retry
      if (response.status >= 500 && response.status <= 599) {
        // If 503 Service Unavailable is specifically due to BOARD_API_DISABLED, fail immediately without waiting
        if (response.status === 503) {
          const errClone = response.clone();
          const errText = await errClone.text().catch(() => "");
          if (errText.includes("BOARD_API_DISABLED") || errText.includes("board_api_disabled")) {
            throw new Error(maskSecrets(`Server error 503: ${errText}`));
          }
        }

        if (!idempotent || attempt > this.maxRetries) {
          const errText = await response.text().catch(() => "");
          throw new Error(maskSecrets(`Server error ${response.status}: ${errText}`));
        }
        const delay = this.calculateBackoff(attempt);
        this.notifyRetry(attempt, delay, `Server error ${response.status}`);
        await this.sleep(delay);
        continue;
      }

      // 4xx Client Error (except 429) throws immediately
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new AllevitasApiError(response.status, response.statusText, errorBody);
      }

      // 2xx Success
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      } else {
        return (await response.text()) as unknown as T;
      }
    }
  }

  private calculateBackoff(attempt: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(exponential + jitter, this.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private notifyRetry(attempt: number, delayMs: number, reason: string): void {
    if (this.onRetry) {
      this.onRetry(attempt, delayMs, reason);
    } else {
      console.warn(`[Allevitas SDK] Retrying (${attempt}/${this.maxRetries}): ${reason} - Waiting ${Math.round(delayMs / 1000)}s...`);
    }
  }
}
